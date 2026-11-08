import type { Context } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import type { ProactiveWork } from "../../shared/proactive/work.js";
import type { NoticeItem } from "../../shared/proactive/notices.js";
import { Serial } from "../common/operations.js";
import type { ProactiveConfig } from "./config.js";
import type { ProactiveService } from "./service.js";
import {
	nextNoticeDueAt,
	noticePolicyDigest,
	recordDeferredNoticeBatch,
} from "./deferred-notices.js";
import { digest } from "./wire.js";

/** Drained by the service lifecycle; the core owns pending intent and dedup. */
export class DeferredNoticePump {
	readonly #queue = new Serial();
	readonly #stop = new AbortController();
	constructor(
		private readonly ctx: Context,
		private readonly port: ProactiveService,
		private readonly config: ProactiveConfig,
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
		const response = await this.port.read({
			kind: "work-ticket",
			ticketId: item.ticketId,
		});
		const work = response.kind === "work" ? response.work : null;
		if (!work || work.assignmentId !== item.assignmentId)
			throw new Error("Notification assignment changed");
		await this.port.validateTarget(work.target);
		const source = await this.port.read({
			kind: "checkpoint",
			sourceId: item.sourceId,
		});
		if (
			source.kind !== "checkpoint" ||
			source.source?.revoked ||
			source.source?.generation !== item.sourceGeneration
		)
			throw new Error("Notification source changed");
		const permission = await this.port.read({
			kind: "dispatch-permitted",
			assignmentId: item.assignmentId,
			noticeRevision: work.revision,
		});
		if (permission.kind !== "dispatch-permitted" || !permission.permitted)
			throw new Error("Notification permission changed");
		return work;
	}
	pump() {
		return this.#queue.run(async () => {
			if (!this.config.proactiveNotificationPolicy || this.#stop.signal.aborted)
				return;
			const candidates = await this.port.read({ kind: "notice-candidates" });
			if (candidates.kind === "notice-candidates")
				for (const work of candidates.work)
					await this.schedule(work, this.#stop.signal);
			const response = await this.port.read({ kind: "notice-due" });
			if (response.kind !== "notice-due") return;
			const groups = new Map<string, NoticeItem[]>();
			for (const item of response.items) {
				let valid = false;
				try {
					await this.resolve(item);
					const policy = this.ctx
						.get("dshBotNotifications")
						?.policy(item.policyId);
					if (policy) {
						const dueAt = nextNoticeDueAt(Date.now(), policy, item.expiresAt);
						if (dueAt !== undefined) {
							if (
								noticePolicyDigest(policy) !== item.policyDigest ||
								policy.targetDigest !== item.targetDigest ||
								dueAt > Date.now()
							) {
								await this.port.change(randomUUID(), {
									kind: "notice-revise",
									input: {
										operationId: item.operationId,
										expectedRevision: item.revision,
										policyDigest: noticePolicyDigest(policy),
										targetDigest: policy.targetDigest,
										dueAt,
										expiresAt: item.expiresAt,
									},
								});
								continue;
							}
							valid = true;
						}
					}
				} catch {}
				if (!valid) {
					await this.port.change(randomUUID(), {
						kind: "notice-cancel",
						operationId: item.operationId,
						expectedRevision: item.revision,
					});
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
					const read = await this.port.read({ kind: "notice-batch", id });
					if (read.kind !== "notice-batch" || !read.batch) continue;
					const result = await recordDeferredNoticeBatch(
						this.ctx,
						read.batch,
						(item) => this.resolve(item),
						this.#stop.signal,
					);
					await this.port.change(randomUUID(), {
						kind: "notice-settle",
						input: { batchId: id, ...result },
					});
				}
		});
	}
	async close() {
		this.#stop.abort();
		await this.#queue.close();
	}
}
