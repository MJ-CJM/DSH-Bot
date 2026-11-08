import type { Context } from "@deepseek-ai/cordis";
import { sameBot } from "../../shared/identity.js";
import {
	NOTIFICATION_TEXT_MAX_BYTES,
	type NotificationPolicy,
} from "../../shared/notifications.js";
import type {
	NoticeBatch,
	NoticeItem,
	NoticeSettle,
} from "../../shared/proactive/notices.js";
import type { ProactiveWork } from "../../shared/proactive/work.js";
import { mergeLabels } from "../data-flow/labels.js";
import { outlets } from "../data-flow/tool-guard.js";
import { quietAt } from "../notifications/time.js";
import { digest } from "./wire.js";

export const noticePolicyDigest = (policy: NotificationPolicy) =>
	digest(policy);

/** Policy-only not-before calculation. Core owns the configurable merge window.
 * Iterate real instants so DST gaps/repeated clock minutes follow the same
 * public quietAt semantics as Notifications. No second scheduler is created. */
export function nextNoticeDueAt(
	at: number,
	policy: NotificationPolicy,
	expiresAt: number,
): number | undefined {
	if (
		!policy.enabled ||
		policy.channel !== "in-app" ||
		policy.dailyLimit === 0 ||
		expiresAt <= at
	)
		return;
	if (policy.quietHours?.start === policy.quietHours?.end && policy.quietHours)
		return;
	if (!quietAt(at, policy)) return at;
	const end = Math.min(expiresAt, at + 48 * 60 * 60 * 1000);
	for (
		let next = (Math.floor(at / 60000) + 1) * 60000;
		next < end;
		next += 60000
	)
		if (!quietAt(next, policy)) return next;
	return;
}

/** Every task reference is retained, even if long titles need shortening. */
export function deferredNoticeText(
	items: readonly { ticketId: string; assignmentId: string; title: string }[],
): string {
	if (items.length < 1 || items.length > 16)
		throw new Error("Invalid notification batch size");
	const refs = items.map((item) => `[${item.ticketId} / ${item.assignmentId}]`);
	const reserved = Buffer.byteLength(refs.join("\n\n"), "utf8") + items.length;
	if (reserved > NOTIFICATION_TEXT_MAX_BYTES)
		throw new Error("Notification references exceed the content limit");
	let available = NOTIFICATION_TEXT_MAX_BYTES - reserved;
	return items
		.map((item, index) => {
			const allowance = Math.floor(available / (items.length - index));
			let title = "",
				bytes = 0;
			for (const char of item.title.replace(/[\r\n]+/g, " ")) {
				const size = Buffer.byteLength(char, "utf8");
				if (bytes + size > allowance) break;
				title += char;
				bytes += size;
			}
			available -= bytes;
			return `${title}\n${refs[index]}`;
		})
		.join("\n\n");
}

type Result = Pick<NoticeSettle, "state" | "reason">;
/** Only call for a freshly claimed batch. Core retains claim uncertainty and
 * forbids replay; this adapter has no retry loop and never invokes an IM Port.
 * resolveAndAuthorize must re-read the exact Work/source/grant for each item. */
export async function recordDeferredNoticeBatch(
	ctx: Context,
	batch: NoticeBatch,
	resolveAndAuthorize: (item: NoticeItem) => Promise<ProactiveWork>,
	signal: AbortSignal,
	now: () => number = Date.now,
): Promise<Result> {
	let recordAttempted = false;
	try {
		if (batch.state !== "claimed")
			return { state: "suppressed", reason: "not-claimed" };
		const notifications = ctx.get("dshBotNotifications");
		if (!notifications) return { state: "suppressed", reason: "unavailable" };
		const checkPolicy = () => {
			signal.throwIfAborted();
			const policy = notifications.policy(batch.policyId);
			if (
				!policy.enabled ||
				policy.channel !== "in-app" ||
				policy.dailyLimit === 0 ||
				!sameBot(policy.owner, batch.bot) ||
				noticePolicyDigest(policy) !== batch.policyDigest ||
				policy.targetDigest !== batch.targetDigest ||
				quietAt(now(), policy)
			)
				throw new Error("Notification policy changed");
			if (batch.items.some((item) => item.expiresAt <= now()))
				throw new Error("Notification expired");
		};
		checkPolicy();
		const resolve = async () => {
			const work: ProactiveWork[] = [];
			for (const item of batch.items) {
				signal.throwIfAborted();
				const row = await resolveAndAuthorize(item);
				if (
					row.assignmentId !== item.assignmentId ||
					row.ticketId !== item.ticketId ||
					row.sourceId !== item.sourceId ||
					!sameBot(row.target.bot, batch.bot) ||
					!["delivered", "accepted"].includes(row.state) ||
					!(row.sessionId ?? row.groupRepair?.rootSessionId)
				)
					throw new Error("Notification work or lineage changed");
				work.push(row);
			}
			return work;
		};
		const work = await resolve();
		const text = deferredNoticeText(work);
		const flow = outlets(ctx.dshBots);
		let sessionId = work[0]?.sessionId ?? work[0]?.groupRepair?.rootSessionId;
		if (!sessionId) throw new Error("Missing notification lineage");
		if (flow) {
			// A managed provenance key, not a new native Session or a user chat.
			sessionId = `proactive-notice-${digest(batch.id)}`;
			const labels = work.map((row) =>
				flow.label(row.sessionId ?? row.groupRepair?.rootSessionId ?? ""),
			);
			await flow.inherit(sessionId, mergeLabels(...labels));
		} else if (work.length > 1)
			throw new Error("Merged notification requires managed lineage");
		const latest = await resolve();
		if (deferredNoticeText(latest) !== text)
			throw new Error("Notification content changed");
		if (flow)
			await flow.inherit(
				sessionId,
				mergeLabels(
					...latest.map((row) =>
						flow.label(row.sessionId ?? row.groupRepair?.rootSessionId ?? ""),
					),
				),
			);
		checkPolicy();
		recordAttempted = true;
		const receipt = await notifications.record(
			batch.bot,
			{
				operationId: batch.id,
				policyId: batch.policyId,
				text,
				relatedId: work[0]?.ticketId,
			},
			{ kind: "proactive", id: batch.id, sessionId },
			signal,
		);
		return receipt.state === "recorded"
			? { state: "recorded" }
			: { state: "unknown", reason: "receipt-unconfirmed" };
	} catch {
		// A record failure may be after the dedup tombstone committed. Preserve
		// unknown rather than issuing another operation or deleting the tombstone.
		return {
			state: recordAttempted ? "unknown" : "suppressed",
			reason: recordAttempted ? "record-unconfirmed" : "authorization-changed",
		};
	}
}
