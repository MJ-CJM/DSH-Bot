import type { DatabaseSync } from "node:sqlite";
import { digest } from "../src/host/proactive/wire.js";
import {
	noticeBatchSchema,
	noticeClaimSchema,
	noticeConfigSchema,
	noticeItemSchema,
	noticeReviseSchema,
	noticeScheduleSchema,
	noticeSettleSchema,
	type NoticeBatch,
	type NoticeClaim,
	type NoticeConfig,
	type NoticeItem,
	type NoticeRevise,
	type NoticeSchedule,
	type NoticeSettle,
} from "../src/shared/proactive/notices.js";
import { Rejection } from "./rejection.js";

/** Persistent business batching in the existing coordinator DB, with no transport
 * or background timer. The Host hydrates current content and uses Notifications. */
export function openDeferredNotices(
	db: DatabaseSync,
	options: Partial<NoticeConfig> & { now?: () => number } = {},
) {
	const { now = Date.now, ...input } = options;
	const config = noticeConfigSchema.parse(input);
	db.exec(`CREATE TABLE IF NOT EXISTS pb_deferred_notice (
		operation TEXT PRIMARY KEY, assignment TEXT NOT NULL UNIQUE, group_key TEXT NOT NULL,
		request_digest TEXT NOT NULL, payload TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS pb_deferred_notice_batch (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
	CREATE INDEX IF NOT EXISTS pb_deferred_notice_group ON pb_deferred_notice(group_key);`);
	let serial = 0;
	const atomic = <T>(fn: () => T): T => {
		const name = `pb_notices_${++serial}`;
		db.exec(`SAVEPOINT ${name}`);
		try {
			const result = fn();
			db.exec(`RELEASE ${name}`);
			return result;
		} catch (error) {
			db.exec(`ROLLBACK TO ${name}`);
			db.exec(`RELEASE ${name}`);
			throw error;
		}
	};
	const groupKey = (
		row: Pick<NoticeItem, "bot" | "policyId" | "policyDigest" | "targetDigest">,
	) => digest([row.bot, row.policyId, row.policyDigest, row.targetDigest]);
	const parse = (row: Record<string, unknown>) =>
		noticeItemSchema.parse(JSON.parse(String(row.payload)));
	const get = (id: string) => {
		const row = db
			.prepare("SELECT payload FROM pb_deferred_notice WHERE operation=?")
			.get(id);
		return row ? parse(row) : undefined;
	};
	const need = (id: string) => {
		const row = get(id);
		if (!row) throw new Rejection("stale");
		return row;
	};
	const save = (row: NoticeItem) => {
		const value = noticeItemSchema.parse(row);
		db.prepare(
			"UPDATE pb_deferred_notice SET group_key=?,payload=? WHERE operation=?",
		).run(groupKey(value), JSON.stringify(value), value.operationId);
		return value;
	};
	const batch = (id: string) => {
		const row = db
			.prepare("SELECT payload FROM pb_deferred_notice_batch WHERE id=?")
			.get(id);
		return row
			? noticeBatchSchema.parse(JSON.parse(String(row.payload)))
			: undefined;
	};
	const saveBatch = (row: NoticeBatch) => {
		const value = noticeBatchSchema.parse(row);
		db.prepare(
			"INSERT INTO pb_deferred_notice_batch VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
		).run(value.id, JSON.stringify(value));
		return value;
	};
	const intents = () =>
		db
			.prepare(
				"SELECT payload FROM pb_deferred_notice WHERE json_extract(payload,'$.state')='intent'",
			)
			.all()
			.map(parse);
	function expire(at: number) {
		let expired = 0;
		for (const row of intents())
			if (row.expiresAt <= at) {
				save({
					...row,
					revision: row.revision + 1,
					state: "suppressed",
					reason: "expired",
				});
				expired++;
			}
		return expired;
	}
	function schedule(input: NoticeSchedule) {
		const request = noticeScheduleSchema.parse(input);
		return atomic(() => {
			const old = db
				.prepare(
					"SELECT request_digest,payload FROM pb_deferred_notice WHERE operation=?",
				)
				.get(request.operationId);
			if (old) {
				if (old.request_digest !== digest(request))
					throw new Rejection("conflict");
				return parse(old);
			}
			if (
				db
					.prepare(
						"SELECT operation FROM pb_deferred_notice WHERE assignment=?",
					)
					.get(request.assignmentId)
			)
				throw new Rejection("conflict");
			const at = now();
			expire(at);
			const pending = intents();
			if (pending.length >= config.maxPending) throw new Rejection("forbidden");
			const key = groupKey(request);
			// New items join an unclaimed group's existing window without postponing
			// earlier work. A hard policy dueAt is never brought forward.
			const joined = pending
				.filter(
					(row) =>
						groupKey(row) === key &&
						row.dueAt >= Math.max(at, request.dueAt) &&
						row.expiresAt > row.dueAt,
				)
				.sort(
					(a, b) =>
						a.dueAt - b.dueAt || a.operationId.localeCompare(b.operationId),
				)[0];
			const dueAt =
				joined?.dueAt ?? Math.max(request.dueAt, at + config.mergeWindowMs);
			const expired = request.expiresAt <= Math.max(at, dueAt);
			const row = noticeItemSchema.parse({
				...request,
				dueAt,
				revision: 0,
				createdAt: at,
				state: expired ? "suppressed" : "intent",
				...(expired ? { reason: "expired" } : {}),
			});
			db.prepare("INSERT INTO pb_deferred_notice VALUES (?,?,?,?,?)").run(
				row.operationId,
				row.assignmentId,
				key,
				digest(request),
				JSON.stringify(row),
			);
			return row;
		});
	}
	function revise(input: NoticeRevise) {
		const request = noticeReviseSchema.parse(input);
		return atomic(() => {
			const row = need(request.operationId);
			if (row.state !== "intent" || row.revision !== request.expectedRevision)
				throw new Rejection("stale");
			const at = now();
			const expiresAt = Math.min(row.expiresAt, request.expiresAt);
			const dueAt = Math.max(at, request.dueAt);
			const expired = expiresAt <= dueAt;
			return save({
				...row,
				policyDigest: request.policyDigest,
				targetDigest: request.targetDigest,
				dueAt,
				expiresAt,
				revision: row.revision + 1,
				state: expired ? "suppressed" : "intent",
				...(expired ? { reason: "expired" } : {}),
			});
		});
	}
	function claim(input: NoticeClaim): { batch: NoticeBatch; fresh: boolean } {
		const request = noticeClaimSchema.parse(input);
		if (
			request.items.length > config.maxBatchItems ||
			new Set(request.items.map((item) => item.operationId)).size !==
				request.items.length
		)
			throw new Rejection("invalid");
		return atomic(() => {
			const at = now();
			const rows = request.items
				.map((item) => need(item.operationId))
				.sort((a, b) => a.operationId.localeCompare(b.operationId));
			const first = rows[0];
			if (!first) throw new Rejection("invalid");
			const id = `proactive-batch:${digest([rows.map((row) => row.operationId), first.bot, first.policyId, request.policyDigest, request.targetDigest])}`;
			const known = batch(id);
			if (known) return { batch: known, fresh: false };
			for (const row of rows) {
				const expected = request.items.find(
					(item) => item.operationId === row.operationId,
				);
				if (
					row.state !== "intent" ||
					row.revision !== expected?.expectedRevision ||
					row.dueAt > at ||
					row.expiresAt <= at ||
					row.policyDigest !== request.policyDigest ||
					row.targetDigest !== request.targetDigest ||
					groupKey(row) !== groupKey(first)
				)
					throw new Rejection("stale");
			}
			const items = rows.map((row) =>
				save({
					...row,
					state: "claimed",
					batchId: id,
					revision: row.revision + 1,
				}),
			);
			return {
				batch: saveBatch({
					id,
					bot: first.bot,
					policyId: first.policyId,
					policyDigest: request.policyDigest,
					targetDigest: request.targetDigest,
					items,
					claimedAt: at,
					state: "claimed",
				}),
				fresh: true,
			};
		});
	}
	function settle(input: NoticeSettle) {
		const request = noticeSettleSchema.parse(input);
		return atomic(() => {
			const current = batch(request.batchId);
			if (!current) throw new Rejection("stale");
			if (current.state !== "claimed") {
				if (
					current.state === request.state &&
					current.reason === request.reason
				)
					return current;
				throw new Rejection("conflict");
			}
			const items = current.items.map((item) => {
				const row = need(item.operationId);
				if (row.batchId !== current.id || row.state !== "claimed")
					throw new Rejection("stale");
				return save({
					...row,
					state: request.state,
					revision: row.revision + 1,
					...(request.reason ? { reason: request.reason } : {}),
				});
			});
			return saveBatch({
				...current,
				items,
				state: request.state,
				...(request.reason ? { reason: request.reason } : {}),
			});
		});
	}
	return {
		schedule,
		revise,
		claim,
		settle,
		get,
		batch,
		due(limit = config.maxPending) {
			if (!Number.isInteger(limit) || limit < 1 || limit > config.maxPending)
				throw new Rejection("invalid");
			return atomic(() => {
				const at = now();
				expire(at);
				return intents()
					.filter((row) => row.dueAt <= at)
					.sort(
						(a, b) =>
							a.dueAt - b.dueAt || a.operationId.localeCompare(b.operationId),
					)
					.slice(0, limit);
			});
		},
		recover() {
			return atomic(() => {
				const rows = db
					.prepare(
						"SELECT payload FROM pb_deferred_notice_batch WHERE json_extract(payload,'$.state')='claimed'",
					)
					.all();
				for (const row of rows) {
					const value = noticeBatchSchema.parse(
						JSON.parse(String(row.payload)),
					);
					settle({ batchId: value.id, state: "unknown", reason: "restart" });
				}
				return rows.length;
			});
		},
		cancel(
			operationId: string,
			expectedRevision: number,
			reason = "withdrawn",
		) {
			return atomic(() => {
				const row = need(operationId);
				if (row.state !== "intent" || row.revision !== expectedRevision)
					throw new Rejection("stale");
				return save({
					...row,
					state: "suppressed",
					reason,
					revision: row.revision + 1,
				});
			});
		},
		cancelSource(sourceId: string, generation: number) {
			return atomic(() => {
				let count = 0;
				for (const row of intents())
					if (row.sourceId === sourceId && row.sourceGeneration <= generation) {
						save({
							...row,
							state: "suppressed",
							reason: "source-revoked",
							revision: row.revision + 1,
						});
						count++;
					}
				return count;
			});
		},
	};
}
