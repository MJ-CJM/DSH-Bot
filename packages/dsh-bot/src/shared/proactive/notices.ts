import { z } from "zod";
import { botKeySchema, resourceId } from "../identity.js";

const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const noticeConfigSchema = z.strictObject({
	mergeWindowMs: z.number().int().min(0).max(3600000).default(60000),
	maxBatchItems: z.number().int().min(1).max(16).default(8),
	maxPending: z.number().int().min(1).max(10000).default(1000),
});
export const noticeScheduleSchema = z.strictObject({
	assignmentId: resourceId,
	ticketId: resourceId,
	operationId: resourceId,
	bot: botKeySchema,
	sourceId: resourceId,
	sourceGeneration: instant,
	policyId: resourceId,
	policyDigest: digest,
	targetDigest: z.string().min(1).max(256),
	/** Earliest time allowed by the policy. The core adds/coalesces its merge window. */
	dueAt: instant,
	expiresAt: instant,
});
export const noticeItemSchema = noticeScheduleSchema.extend({
	revision: instant,
	createdAt: instant,
	state: z.enum(["intent", "claimed", "recorded", "suppressed", "unknown"]),
	batchId: resourceId.optional(),
	reason: z.string().max(100).optional(),
});
export const noticeBatchSchema = z.strictObject({
	id: resourceId,
	bot: botKeySchema,
	policyId: resourceId,
	policyDigest: digest,
	targetDigest: z.string().min(1).max(256),
	items: z.array(noticeItemSchema).min(1).max(16),
	claimedAt: instant,
	state: z.enum(["claimed", "recorded", "suppressed", "unknown"]),
	reason: z.string().max(100).optional(),
});
export const noticeReviseSchema = z.strictObject({
	operationId: resourceId,
	expectedRevision: instant,
	policyDigest: digest,
	targetDigest: z.string().min(1).max(256),
	dueAt: instant,
	expiresAt: instant,
});
export const noticeClaimSchema = z.strictObject({
	items: z
		.array(
			z.strictObject({ operationId: resourceId, expectedRevision: instant }),
		)
		.min(1)
		.max(16),
	policyDigest: digest,
	targetDigest: z.string().min(1).max(256),
});
export const noticeSettleSchema = z.strictObject({
	batchId: resourceId,
	state: z.enum(["recorded", "suppressed", "unknown"]),
	reason: z.string().max(100).optional(),
});
export type NoticeSchedule = z.output<typeof noticeScheduleSchema>;
export type NoticeItem = z.output<typeof noticeItemSchema>;
export type NoticeBatch = z.output<typeof noticeBatchSchema>;
export type NoticeRevise = z.output<typeof noticeReviseSchema>;
export type NoticeClaim = z.output<typeof noticeClaimSchema>;
export type NoticeSettle = z.output<typeof noticeSettleSchema>;
export type NoticeConfig = z.output<typeof noticeConfigSchema>;
