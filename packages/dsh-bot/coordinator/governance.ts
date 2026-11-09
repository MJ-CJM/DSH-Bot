import type { Store } from "./core.mjs";
import { Rejection } from "./rejection.js";
import { digest } from "../src/host/proactive/wire.js";
import {
	workSchema,
	type ProactiveWork,
} from "../src/shared/proactive/work.js";
import {
	artifactPurgePlanSchema,
	artifactPurgeResultSchema,
	beginForgetSchema,
	finishForgetSchema,
	forgetBlockedReasonSchema,
	forgetReceiptSchema,
	governanceConfigSchema,
	type ArtifactPurgePlan,
	type ArtifactPurgeResult,
	type BeginForget,
	type FinishForget,
	type ForgetReceipt,
	type GovernanceConfig,
	type GovernanceSweep,
} from "../src/shared/proactive/governance.js";

type Ticket = NonNullable<ReturnType<Store["tickets"]["get"]>>;
const redacted = "[redacted]";
const terminal = (work: ProactiveWork) =>
	(["accepted", "failed", "denied", "cancelled"].includes(work.state) ||
		(work.state === "superseded" && work.supersededBy !== undefined)) &&
	work.groupRepairEvidence?.state !== "unknown" &&
	work.notice?.state !== "claim" &&
	work.notice?.state !== "unknown" &&
	work.groupReview?.state !== "claimed" &&
	work.groupReview?.state !== "unknown" &&
	work.groupReview?.followUp?.state !== "claimed" &&
	work.groupReview?.followUp?.state !== "unknown";
const active = (ticket: Ticket) =>
	!ticket.ended ||
	ticket.undelivered.length > 0 ||
	ticket.assignments.some(
		(item) => item.state === "pending" || item.state === "running",
	);

/** Uses only public core repositories for core aggregates. The SQL below owns
 * adapter tables and audit tombstones, never the vendored core's private schema. */
export function openGovernance(
	store: Store,
	input: Partial<GovernanceConfig> = {},
	options: { now?: () => number } = {},
) {
	const config = governanceConfigSchema.parse(input);
	const now = options.now ?? Date.now;
	const db = store.db;
	db.exec(`CREATE TABLE IF NOT EXISTS pb_governance_tombstone (
    kind TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, generation INTEGER NOT NULL,
    digest TEXT NOT NULL, at INTEGER NOT NULL, audit TEXT NOT NULL, PRIMARY KEY(kind,id)
  );
  CREATE TABLE IF NOT EXISTS pb_governance_forget (id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pb_governance_purge (id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT);
  CREATE TABLE IF NOT EXISTS pb_source_revocation (id TEXT PRIMARY KEY,generation INTEGER NOT NULL);`);
	const hasTable = (name: string) =>
		!!db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
			.get(name);
	const works = () =>
		hasTable("pb_work")
			? db
					.prepare("SELECT payload FROM pb_work")
					.all()
					.map((row) => workSchema.parse(JSON.parse(String(row.payload))))
			: [];
	const triggers = () =>
		hasTable("pb_event")
			? db
					.prepare("SELECT id FROM pb_event")
					.all()
					.flatMap((row) => {
						const trigger = store.triggers.get(String(row.id));
						return trigger ? [trigger] : [];
					})
			: [];
	const generation = (work: ProactiveWork) => {
		const value =
			work.responsibility?.binding.source.generation ??
			store.triggers.get(work.triggerId)?.meta.generation;
		return typeof value === "number" &&
			Number.isSafeInteger(value) &&
			value >= 0
			? value
			: undefined;
	};
	const marked = (kind: string, id: string) =>
		!!db
			.prepare("SELECT id FROM pb_governance_tombstone WHERE kind=? AND id=?")
			.get(kind, id);
	const mark = (
		kind: string,
		id: string,
		source: string,
		gen: number,
		value: unknown,
		audit: Record<string, unknown> = {},
	) => {
		db.prepare(
			"INSERT OR IGNORE INTO pb_governance_tombstone VALUES (?,?,?,?,?,?,?)",
		).run(kind, id, source, gen, digest(value), now(), JSON.stringify(audit));
	};
	const plan = (work: ProactiveWork, reason: ArtifactPurgePlan["reason"]) => {
		const gen = generation(work);
		if (gen === undefined) return undefined;
		const id = `purge:${digest([work.assignmentId, work.sourceId, gen])}`;
		const old = db
			.prepare("SELECT payload FROM pb_governance_purge WHERE id=?")
			.get(id);
		if (old)
			return artifactPurgePlanSchema.parse(JSON.parse(String(old.payload)));
		const value = artifactPurgePlanSchema.parse({
			id,
			assignmentId: work.assignmentId,
			sourceId: work.sourceId,
			generation: gen,
			namespaces: ["repair-artifacts", "workspace-artifacts"],
			createdAt: now(),
			reason,
		});
		db.prepare("INSERT INTO pb_governance_purge VALUES (?,?,NULL)").run(
			id,
			JSON.stringify(value),
		);
		return value;
	};
	const redactTicket = (ticket: Ticket, source: string, gen: number) => {
		if (marked("ticket", ticket.id)) return 0;
		mark("ticket", ticket.id, source, gen, ticket, {
			decisionId: ticket.decisionId,
			ended: ticket.ended
				? {
						at: ticket.ended.at,
						by: ticket.ended.by,
						outcome: ticket.ended.outcome,
					}
				: undefined,
		});
		store.tickets.save({
			...ticket,
			title: redacted,
			channels: [],
			mandate: {
				...ticket.mandate,
				scope: redacted,
				basis: { ...ticket.mandate.basis, scope: undefined },
			},
			attention: undefined,
			execution: undefined,
			delivery: undefined,
			ended: ticket.ended ? { ...ticket.ended, reason: undefined } : undefined,
			assignments: ticket.assignments.map((item) => ({
				...item,
				endedReason: undefined,
				report: item.report ? { ...item.report, summary: redacted } : undefined,
			})),
			inputs: ticket.inputs.map((item) =>
				item.kind === "text" || item.kind === "note"
					? { ...item, text: redacted }
					: item.kind === "trigger"
						? { ...item, note: undefined }
						: item.kind === "policy-changed"
							? { ...item, effect: undefined }
							: item,
			),
		});
		return 1;
	};
	const redactWork = (work: ProactiveWork) => {
		if (marked("work", work.assignmentId)) return 0;
		const gen = generation(work);
		if (gen === undefined) return 0;
		mark("work", work.assignmentId, work.sourceId, gen, work, {
			ticketId: work.ticketId,
			decisionId: work.decisionId,
			state: work.state,
			supersededBy: work.supersededBy,
			evidenceDigest: work.evidenceDigest,
			reviewer: work.reviewer,
			reviewedAt: work.reviewedAt,
		});
		const clean = workSchema.parse({
			...work,
      document: undefined, methodTrial: undefined, methodEvidence: undefined,
			title: redacted,
			revision: work.revision + 1,
			repair: undefined,
			workspaceRepair: undefined,
			repairEvidence: undefined,
			workspaceEvidence: undefined,
			commandEvidence: undefined,
			responsibility: undefined,
			acceptance: undefined,
			groupRepairEvidence: undefined,
			reviewFeedback: undefined,
			rework: undefined,
      wait: undefined,
      continuation: undefined,
			groupReview: work.groupReview
				? {
						...work.groupReview,
						followUp: work.groupReview.followUp
							? {
									...work.groupReview.followUp,
									fact: work.groupReview.followUp.fact
										? { ...work.groupReview.followUp.fact, text: redacted }
										: undefined,
								}
							: undefined,
					}
				: undefined,
		});
		db.prepare("UPDATE pb_work SET payload=? WHERE assignment=?").run(
			JSON.stringify(clean),
			work.assignmentId,
		);
		return 1;
	};
	const redactTrigger = (trigger: ReturnType<typeof triggers>[number]) => {
		if (marked("trigger", trigger.id)) return 0;
		const gen = Number(trigger.meta.generation ?? 0);
		mark("trigger", trigger.id, trigger.source, gen, trigger);
		store.triggers.save({
			...trigger,
			text: redacted,
			url: undefined,
			channel: undefined,
			meta: {
				generation: gen,
				bodyRedacted: true,
				bodyDigest: digest(trigger),
			},
		});
		const disposition = store.triggers.disposition(trigger.id);
		if (disposition)
			store.triggers.saveDisposition(trigger.id, {
				...disposition,
				filtered: disposition.filtered ? { code: "redacted" } : undefined,
				handbacks: disposition.handbacks?.map((item) => ({
					...item,
					reason: redacted,
				})),
			});
		return 1;
	};
	const redactThread = (
		thread: ReturnType<Store["threads"]["list"]>[number],
		gen: number,
		force: boolean,
	) => {
		let changed = 0;
		for (const decision of store.decisions.byThread(thread.key)) {
			if (marked("decision", decision.id)) continue;
			if (hasTable("pb_suggestion_adjustment"))
				db.prepare(
					"UPDATE pb_suggestion_adjustment SET title=? WHERE decision=?",
				).run(redacted, decision.id);
			mark("decision", decision.id, thread.ref.source, gen, decision, {
				kind: decision.kind,
				ticketId: decision.ticketId,
				policyVersion: decision.policyVersion,
			});
			store.decisions.save({
				...decision,
				reason: decision.reason.map((item) => ({
					code: "redacted",
					triggerId: item.triggerId,
				})),
				audit: undefined,
				mandate: decision.mandate
					? {
							...decision.mandate,
							scope: redacted,
							basis: { ...decision.mandate.basis, scope: undefined },
						}
					: undefined,
			});
			changed++;
		}
		if (!marked("thread", thread.key)) {
			mark("thread", thread.key, thread.ref.source, gen, thread);
			store.threads.save({
				...thread,
				meta: { bodyRedacted: true },
				...(force ? { pending: [], evaluating: undefined } : {}),
			});
			changed++;
		}
		return changed;
	};
	const saveForget = (receipt: ForgetReceipt) => {
		const value = forgetReceiptSchema.parse(receipt);
		db.prepare("UPDATE pb_governance_forget SET payload=? WHERE id=?").run(
			JSON.stringify(value),
			value.operationId,
		);
		return value;
	};
	const purgesComplete = (plans: ArtifactPurgePlan[]) =>
		plans.every((plan) => {
			const saved = db
				.prepare("SELECT result FROM pb_governance_purge WHERE id=?")
				.get(plan.id)?.result;
			return (
				!!saved &&
				["purged", "missing"].includes(
					artifactPurgeResultSchema.parse(JSON.parse(String(saved))).state,
				)
			);
		});
	const forget = (id: string) => {
		const row = db
			.prepare("SELECT payload FROM pb_governance_forget WHERE id=?")
			.get(id);
		return row
			? forgetReceiptSchema.parse(JSON.parse(String(row.payload)))
			: undefined;
	};
	const scopeWorks = (source: string, gen: number) =>
		works().filter((work) => {
			const value = generation(work);
			return work.sourceId === source && value !== undefined && value <= gen;
		});
	const sourceTriggers = (source: string, gen: number) =>
		triggers().filter(
			(trigger) =>
				trigger.source === source &&
				typeof trigger.meta.generation === "number" &&
				trigger.meta.generation <= gen,
		);
	const sourceTickets = (source: string, gen: number) => {
		const ids = new Set(sourceTriggers(source, gen).map((item) => item.id));
		const workTickets = new Set(
			scopeWorks(source, gen).map((item) => item.ticketId),
		);
		return store.tickets
			.list()
			.filter(
				(ticket) =>
					workTickets.has(ticket.id) ||
					ticket.origin.triggerIds.some((id) => ids.has(id)),
			);
	};
	const pending = (source: string, gen: number) =>
		[
			...new Set([
				...scopeWorks(source, gen)
					.filter((work) => !terminal(work))
					.map((item) => item.assignmentId),
				...sourceTickets(source, gen)
					.filter(active)
					.flatMap((ticket) =>
						ticket.assignments
							.filter((item) => item.state !== "ended")
							.map((item) => item.id),
					),
			]),
		].sort();
	function beginForget(input: BeginForget): ForgetReceipt {
		const request = beginForgetSchema.parse(input);
		return store.atomic(() => {
			const old = db
				.prepare(
					"SELECT request_digest,payload FROM pb_governance_forget WHERE id=?",
				)
				.get(request.operationId);
			if (old) {
				if (old.request_digest !== digest(request))
					throw new Rejection("conflict");
				return forgetReceiptSchema.parse(JSON.parse(String(old.payload)));
			}
			if (hasTable("pb_source")) {
				const current = db
					.prepare("SELECT generation FROM pb_source WHERE id=?")
					.get(request.sourceId);
				if (current && Number(current.generation) > request.generation)
					throw new Rejection("stale");
			}
			// This fence is committed before the Host attempts any cancellation/purge.
			db.prepare(`INSERT INTO pb_source_revocation VALUES (?,?) ON CONFLICT(id)
        DO UPDATE SET generation=MAX(pb_source_revocation.generation,excluded.generation)`).run(
				request.sourceId,
				request.generation,
			);
			const value = forgetReceiptSchema.parse({
				...request,
				phase: "fenced",
				fencedAt: now(),
				updatedAt: now(),
				pendingAssignments: pending(request.sourceId, request.generation),
				drainDigests: [],
				redacted: 0,
				purgePlans: [],
				boundaries: [
					"ordinary-bots-and-sessions-preserved",
					"native-session-copies-preserved",
					"adopted-memory-and-skills-preserved",
				],
			});
			db.prepare("INSERT INTO pb_governance_forget VALUES (?,?,?)").run(
				request.operationId,
				digest(request),
				JSON.stringify(value),
			);
			return value;
		});
	}
	function finishForget(input: FinishForget): ForgetReceipt {
		const request = finishForgetSchema.parse(input);
		return store.atomic(() => {
			const prior = forget(request.operationId);
			if (!prior) throw new Rejection("stale");
			if (prior.phase === "purging" || prior.phase === "complete") return prior;
			const drained = new Set(request.drained.map((item) => item.assignmentId));
			const currentPending = pending(prior.sourceId, prior.generation);
			const missing = prior.pendingAssignments.filter((id) => !drained.has(id));
			if (
				currentPending.length ||
				missing.length ||
				sourceTickets(prior.sourceId, prior.generation).some(active)
			)
				return saveForget({ ...prior, phase: "blocked", updatedAt: now() });
			const scoped = scopeWorks(prior.sourceId, prior.generation);
			const source = sourceTriggers(prior.sourceId, prior.generation);
			const threadGenerations = new Map(
				source.flatMap((item) =>
					item.threads.map(
						(ref) =>
							[
								`${ref.source}:${ref.id}`,
								Number(item.meta.generation),
							] as const,
					),
				),
			);
			const plans = scoped.flatMap((work) => {
				const value = plan(work, "source-forget");
				return value ? [value] : [];
			});
			let changed = 0;
			for (const ticket of sourceTickets(prior.sourceId, prior.generation)) {
				const trigger = store.triggers.get(ticket.origin.triggerId);
				const gen =
					trigger?.source === prior.sourceId
						? trigger.meta.generation
						: undefined;
				changed += redactTicket(
					ticket,
					prior.sourceId,
					typeof gen === "number" ? gen : prior.generation,
				);
			}
			for (const work of scoped) changed += redactWork(work);
			for (const trigger of source) changed += redactTrigger(trigger);
			for (const [key, gen] of threadGenerations) {
				const thread = store.threads.get(key);
				if (thread) changed += redactThread(thread, gen, true);
			}
			return saveForget({
				...prior,
				phase: purgesComplete(plans) ? "complete" : "purging",
				blockedReason: undefined,
				updatedAt: now(),
				pendingAssignments: [],
				drainDigests: request.drained.map((item) => item.receiptDigest),
				redacted: changed,
				purgePlans: plans,
			});
		});
	}
	function sweep(): GovernanceSweep {
		return store.atomic(() => {
			const at = now();
			const allWorks = works();
			const tickets = store.tickets.list();
			const protectedTickets = new Set(
				tickets.filter(active).map((item) => item.id),
			);
			for (const work of allWorks)
				if (!terminal(work)) protectedTickets.add(work.ticketId);
			const protectedTriggers = new Set(
				tickets
					.filter((ticket) => protectedTickets.has(ticket.id))
					.flatMap((ticket) => [
						ticket.origin.triggerId,
						...ticket.origin.triggerIds,
						...ticket.inputs.flatMap((item) =>
							item.kind === "trigger" || item.kind === "resumed"
								? [item.triggerId]
								: [],
						),
					]),
			);
			for (const work of allWorks)
				if (protectedTickets.has(work.ticketId))
					protectedTriggers.add(work.triggerId);
			const protectedThreads = new Set(
				store.threads
					.list()
					.filter(
						(thread) =>
							thread.pending.length ||
							thread.evaluating ||
							thread.subscriptions.some((id) => protectedTickets.has(id)),
					)
					.map((thread) => thread.key),
			);
			let changed = 0;
			let archived = 0;
			const plans: ArtifactPurgePlan[] = [];
			for (const work of allWorks) {
				if (protectedTickets.has(work.ticketId)) continue;
				const ticket = store.tickets.get(work.ticketId);
				const endedAt = Date.parse(
					ticket?.ended?.at ?? ticket?.updatedAt ?? work.expiresAt,
				);
				if (!Number.isFinite(endedAt)) continue;
				if (endedAt + config.artifactRetentionMs <= at) {
					const value = plan(work, "retention");
					if (value) plans.push(value);
				}
				if (endedAt + config.terminalRetentionMs > at) continue;
				if (ticket) {
					const count = redactTicket(
						ticket,
						work.sourceId,
						generation(work) ?? 0,
					);
					changed += count;
					archived += count;
				}
				changed += redactWork(work);
			}
			const eligible = triggers().filter(
				(trigger) =>
					!protectedTriggers.has(trigger.id) &&
					!trigger.threads.some((ref) =>
						protectedThreads.has(`${ref.source}:${ref.id}`),
					) &&
					Date.parse(trigger.at) + config.eventBodyRetentionMs <= at,
			);
			for (const trigger of eligible) changed += redactTrigger(trigger);
			const eligibleIds = new Set(eligible.map((item) => item.id));
			for (const thread of store.threads.list()) {
				if (protectedThreads.has(thread.key)) continue;
				const decisions = store.decisions.byThread(thread.key);
				if (
					decisions.length &&
					decisions.every(
						(item) =>
							Date.parse(item.at) + config.terminalRetentionMs <= at &&
							item.triggerIds.every((id) => eligibleIds.has(id)) &&
							(!item.ticketId || !protectedTickets.has(item.ticketId)),
					)
				)
					changed += redactThread(thread, 0, false);
			}
			// Dedup rows, source fences, audit tombstones and unknown usage charges are
			// deliberately never deleted; configured replay/recovery minimums hold.
			return {
				at,
				redacted: changed,
				archived,
				protected: protectedTickets.size,
				purgePlans: plans,
			};
		});
	}
	function recordPurge(planId: string, input: ArtifactPurgeResult) {
		const result = artifactPurgeResultSchema.parse(input);
		if (result.planId !== planId) throw new Rejection("invalid");
		return store.atomic(() => {
			const row = db
				.prepare("SELECT payload,result FROM pb_governance_purge WHERE id=?")
				.get(planId);
			if (!row) throw new Rejection("stale");
			if (row.result) {
				const old = artifactPurgeResultSchema.parse(
					JSON.parse(String(row.result)),
				);
				if (old.state === "purged" || old.state === "missing") return old;
			}
			db.prepare("UPDATE pb_governance_purge SET result=? WHERE id=?").run(
				JSON.stringify(result),
				planId,
			);
			for (const item of db
				.prepare("SELECT payload FROM pb_governance_forget")
				.all()) {
				const receipt = forgetReceiptSchema.parse(
					JSON.parse(String(item.payload)),
				);
				if (receipt.phase !== "purging") continue;
				const done = purgesComplete(receipt.purgePlans);
				if (done)
					saveForget({ ...receipt, phase: "complete", updatedAt: now() });
			}
			return result;
		});
	}
	function sourceContext(sourceId: string, gen: number) {
		const scoped = scopeWorks(sourceId, gen);
		const source = sourceTriggers(sourceId, gen);
		const keys = new Set(
			source.flatMap((item) =>
				item.threads.map((ref) => `${ref.source}:${ref.id}`),
			),
		);
		const notificationOperationIds = new Set(
			scoped.flatMap((work) => [
				`proactive:${work.assignmentId}`,
				`proactive-external:${work.assignmentId}`,
			]),
		);
		if (hasTable("pb_deferred_notice"))
			for (const row of db
				.prepare(
					"SELECT payload FROM pb_deferred_notice WHERE json_extract(payload,'$.sourceId')=? AND json_extract(payload,'$.sourceGeneration')<=?",
				)
				.all(sourceId, gen)) {
				const item = JSON.parse(String(row.payload)) as {
					operationId: string;
					batchId?: string;
				};
				notificationOperationIds.add(item.operationId);
				if (item.batchId) notificationOperationIds.add(item.batchId);
			}
		return {
			notificationOperationIds: [...notificationOperationIds],
			ticketIds: sourceTickets(sourceId, gen).map((item) => item.id),
			assignmentIds: scoped.map((item) => item.assignmentId),
			decisionIds: [
				...new Set([
					...scoped.map((item) => item.decisionId),
					...[...keys].flatMap((key) =>
						store.decisions.byThread(key).map((item) => item.id),
					),
				]),
			],
		};
	}
	return {
		beginForget,
		finishForget,
		blockForget(
			operationId: string,
			reason: NonNullable<ForgetReceipt["blockedReason"]>,
		) {
			return store.atomic(() => {
				const prior = forget(operationId);
				if (!prior) throw new Rejection("stale");
				if (!forgetBlockedReasonSchema.safeParse(reason).success)
					throw new Rejection("invalid");
				return saveForget({
					...prior,
					phase: "blocked",
					blockedReason: reason,
					updatedAt: now(),
				});
			});
		},
		sweep,
		forget,
		recordPurge,
		sourceContext,
		resumeFeedbackCleanup(
			purge: (
				sourceId: string,
				generation: number,
				workIds: string[],
				decisionIds: string[],
			) => unknown,
		) {
			const isFenced = db.prepare(
				"SELECT 1 FROM pb_source_revocation WHERE id=? AND generation>=?",
			);
			for (const row of db
				.prepare(`SELECT request_digest,payload FROM pb_governance_forget
				WHERE json_extract(payload,'$.phase') IN ('purging','complete')`)
				.all()) {
				const { operationId, sourceId, generation } = forgetReceiptSchema.parse(
					JSON.parse(String(row.payload)),
				);
				if (
					row.request_digest !==
						digest({ operationId, sourceId, generation }) ||
					!isFenced.get(sourceId, generation)
				)
					continue;
				const scope = sourceContext(sourceId, generation);
				purge(
					sourceId,
					generation,
					[...scope.ticketIds, ...scope.assignmentIds],
					scope.decisionIds,
				);
			}
		},
		pendingPurges: () =>
			db
				.prepare(
					"SELECT payload FROM pb_governance_purge WHERE result IS NULL OR json_extract(result,'$.state') IN ('blocked','unknown') ORDER BY id LIMIT 10000",
				)
				.all()
				.map((row) =>
					artifactPurgePlanSchema.parse(JSON.parse(String(row.payload))),
				),
		tombstones: () =>
			db
				.prepare(
					"SELECT kind,id,source,generation,digest,at,audit FROM pb_governance_tombstone ORDER BY at,kind,id LIMIT 10000",
				)
				.all(),
	};
}
export type Governance = ReturnType<typeof openGovernance>;
