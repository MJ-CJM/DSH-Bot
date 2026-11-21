import type { Context } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import type { ProactiveWork } from "../../shared/proactive/work.js";
import type { NoticeItem, NoticeSettle } from "../../shared/proactive/notices.js";
import { Serial } from "../common/operations.js";
import type { ProactiveConfig } from "./config.js";
import type { ProactiveService } from "./service.js";
import {
	nextNoticeDueAt, noticePolicy, NoticeReadUnavailable, NoticeWithdrawn,
	noticePolicyDigest,
	recordDeferredNoticeBatch,
} from "./deferred-notices.js";
import { digest } from "./wire.js";

/** Drained by the service lifecycle; the core owns pending intent and dedup. */
export class DeferredNoticePump {
	readonly #queue = new Serial();
	readonly #stop = new AbortController();
	// Only this live owner may retry pre-record reads. After restart a claimed batch remains uncertain.
	readonly #claims = new Map<string, NoticeSettle | undefined>();
	constructor(
		private readonly ctx: Context,
		private readonly port: ProactiveService,
		private readonly config: Pick<ProactiveConfig, "proactiveNotificationPolicy" | "proactiveNoticeConfig">,
	) {}
	async schedule(work: ProactiveWork, signal: AbortSignal) {
		signal.throwIfAborted();
		const policyId = this.config.proactiveNotificationPolicy;
		if (!policyId || work.notice?.state !== "intent") return;
		const policy = this.ctx.get("dshBotNotifications")?.policy(policyId);
		if (!policy) return;
		const source = await this.port.read({
			kind: "checkpoint",
			sourceId: work.sourceId,
		});
		if (source.kind !== "checkpoint" || !source.source || source.source.revoked)
			return;
		const expiresAt = Date.parse(work.expiresAt);
		const dueAt = nextNoticeDueAt(Date.now(), policy, expiresAt) ?? expiresAt;
		await this.port.change(randomUUID(), {
			kind: "notice-schedule",
			input: {
				assignmentId: work.assignmentId,
				ticketId: work.ticketId,
				operationId: work.notice.operationId,
				bot: work.target.bot,
				sourceId: work.sourceId,
				sourceGeneration: source.source.generation,
				policyId,
				policyDigest: noticePolicyDigest(policy),
				targetDigest: policy.targetDigest,
				dueAt,
				expiresAt,
			},
		});
	}
	private async resolve(item: NoticeItem) {
		try {
			const response = await this.port.read({ kind: "work-ticket", ticketId: item.ticketId });
			if (response.kind !== "work") throw new NoticeReadUnavailable("Notification work unavailable");
			const work = response.work;
			if (!work || work.assignmentId !== item.assignmentId) throw new NoticeWithdrawn("Notification assignment changed");
			await this.port.validateTarget(work.target);
			const source = await this.port.read({ kind: "checkpoint", sourceId: item.sourceId });
			if (source.kind !== "checkpoint") throw new NoticeReadUnavailable("Notification source unavailable");
			if (!source.source || source.source.revoked || source.source.generation !== item.sourceGeneration)
				throw new NoticeWithdrawn("Notification source changed");
			const permission = await this.port.read({
				kind: "dispatch-permitted", assignmentId: item.assignmentId, noticeRevision: work.revision,
			});
			if (permission.kind !== "dispatch-permitted") throw new NoticeReadUnavailable("Notification permission unavailable");
			if (!permission.permitted) throw new NoticeWithdrawn("Notification permission changed");
			return work;
		} catch (error) {
			if (error instanceof NoticeWithdrawn || error instanceof NoticeReadUnavailable) throw error;
			throw new NoticeReadUnavailable("Notification proof unavailable", { cause: error });
		}
	}
	private async finishClaims() {
		for (const [id, saved] of this.#claims) {
			if (this.#stop.signal.aborted) return;
			let settlement = saved;
			if (!settlement) {
				const read = await this.port.read({ kind: "notice-batch", id }).catch(() => undefined);
				if (read?.kind !== "notice-batch") continue;
				if (!read.batch || read.batch.state !== "claimed") { this.#claims.delete(id); continue; }
				try {
					const result = await recordDeferredNoticeBatch(this.ctx, read.batch, item => this.resolve(item), this.#stop.signal);
					settlement = { batchId: id, ...result };
				} catch (error) {
					if (error instanceof NoticeReadUnavailable) continue;
					settlement = { batchId: id, state: "unknown", reason: "record-unconfirmed" };
				}
				this.#claims.set(id, settlement);
			}
			// A lost acknowledgement can retry only this settlement, never the record operation.
			const reply = await this.port.change(randomUUID(), { kind: "notice-settle", input: settlement }).catch(() => undefined);
			if (reply?.kind === "receipt" && ["committed", "duplicate"].includes(reply.receipt.status)) {
				this.#claims.delete(id);
			} else if (reply) {
				// The coordinator may have recovered this claim to unknown while the Host stayed alive.
				const current = await this.port.read({ kind: "notice-batch", id }).catch(() => undefined);
				if (current?.kind === "notice-batch" && current.batch?.state !== "claimed") this.#claims.delete(id);
			}
		}
	}
	pump() {
		return this.#queue.run(async () => {
			if (!this.config.proactiveNotificationPolicy || this.#stop.signal.aborted)
				return;
			const candidates = await this.port.read({ kind: "notice-candidates" });
			if (candidates.kind === "notice-candidates")
				for (const work of candidates.work)
					await this.schedule(work, this.#stop.signal).catch(() => { /* Still an intent; retry it on the next maintenance tick. */ });
			const response = await this.port.read({ kind: "notice-due" });
			if (response.kind !== "notice-due") { await this.finishClaims(); return; }
			const groups = new Map<string, NoticeItem[]>();
			for (const item of response.items) {
				try {
					await this.resolve(item);
					const policy = noticePolicy(this.ctx, item.policyId);
					const dueAt = nextNoticeDueAt(Date.now(), policy, item.expiresAt);
					if (dueAt === undefined) throw new NoticeWithdrawn("Notification disabled or expired");
					const policyDigest = noticePolicyDigest(policy);
					if (policyDigest !== item.policyDigest || policy.targetDigest !== item.targetDigest || dueAt > Date.now()) {
						await this.port.change(randomUUID(), { kind: "notice-revise", input: {
							operationId: item.operationId, expectedRevision: item.revision, policyDigest,
							targetDigest: policy.targetDigest, dueAt, expiresAt: item.expiresAt,
						} });
						continue;
					}
				} catch (error) {
					if (error instanceof NoticeWithdrawn) {
						await this.port.change(randomUUID(), { kind: "notice-cancel",
							operationId: item.operationId, expectedRevision: item.revision });
					}
					continue;
				}
				const key = digest([
					item.bot,
					item.policyId,
					item.policyDigest,
					item.targetDigest,
				]);
				const group = groups.get(key) ?? [];
				group.push(item);
				groups.set(key, group);
			}
			const size = this.config.proactiveNoticeConfig?.maxBatchItems ?? 8;
			for (const items of groups.values())
				for (let offset = 0; offset < items.length; offset += size) {
					const batchItems = items.slice(offset, offset + size),
						first = batchItems[0];
					if (!first) continue;
					const claim = await this.port.change(randomUUID(), {
						kind: "notice-claim",
						input: {
							items: batchItems.map((item) => ({
								operationId: item.operationId,
								expectedRevision: item.revision,
							})),
							policyDigest: first.policyDigest,
							targetDigest: first.targetDigest,
						},
					});
					if (claim.kind !== "receipt" || claim.receipt.status !== "committed")
						continue;
					const id = `proactive-batch:${digest([batchItems.map((row) => row.operationId).sort(), first.bot, first.policyId, first.policyDigest, first.targetDigest])}`;
					this.#claims.set(id, undefined);
				}
			await this.finishClaims();
		});
	}
	async close() {
		this.#stop.abort();
		await this.#queue.close();
	}
}
