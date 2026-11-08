import { z } from "zod";
import { resourceId } from "../identity.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const period = z
	.number()
	.int()
	.min(60000)
	.max(10 * 365 * 86400000);
export const governanceConfigSchema = z
	.strictObject({
		eventBodyRetentionMs: period.default(7 * 86400000),
		terminalRetentionMs: period.default(30 * 86400000),
		artifactRetentionMs: period.default(7 * 86400000),
		dedupeRetentionMs: period.default(90 * 86400000),
		sourceReplayWindowMs: period.default(30 * 86400000),
		recoveryWindowMs: period.default(7 * 86400000),
	})
	.refine(
		(value) =>
			value.dedupeRetentionMs >=
			Math.max(value.sourceReplayWindowMs, value.recoveryWindowMs),
		{
			message: "Deduplication retention must cover source replay and recovery",
		},
	);
export const artifactPurgePlanSchema = z.strictObject({
	id: resourceId,
	assignmentId: resourceId,
	sourceId: resourceId,
	generation: count,
	namespaces: z
		.array(z.enum(["repair-artifacts", "workspace-artifacts"]))
		.min(1)
		.max(2),
	createdAt: count,
	reason: z.enum(["retention", "source-forget"]),
});
export const artifactPurgeResultSchema = z.strictObject({
	planId: resourceId,
	state: z.enum(["purged", "missing", "blocked", "unknown"]),
	files: count,
	bytes: count,
	manifestDigest: sha,
	at: count,
	reason: z.string().max(100).optional(),
});
export const beginForgetSchema = z.strictObject({
	operationId: resourceId,
	sourceId: resourceId,
	generation: count,
});
/** Only the Host may supply drain receipts after stopping owned native/external work. */
export const finishForgetSchema = z.strictObject({
	operationId: resourceId,
	drained: z
		.array(z.strictObject({ assignmentId: resourceId, receiptDigest: sha }))
		.max(10000),
});
export const forgetReceiptSchema = beginForgetSchema.extend({
	phase: z.enum(["fenced", "blocked", "purging", "complete"]),
	blockedReason: z.enum(["notification-copy-unknown"]).optional(),
	fencedAt: count,
	updatedAt: count,
	pendingAssignments: z.array(resourceId).max(10000),
	drainDigests: z.array(sha).max(10000),
	redacted: count,
	purgePlans: z.array(artifactPurgePlanSchema).max(10000),
	boundaries: z.array(
		z.enum([
			"ordinary-bots-and-sessions-preserved",
			"native-session-copies-preserved",
			"adopted-memory-and-skills-preserved",
		]),
	),
});
export const governanceSweepSchema = z.strictObject({
	at: count,
	redacted: count,
	archived: count,
	protected: count,
	purgePlans: z.array(artifactPurgePlanSchema).max(10000),
});
export const governancePurgeRecordSchema = z.strictObject({
	planId: resourceId,
	result: artifactPurgeResultSchema,
});
export const proactiveCopyScopeSchema = z.strictObject({
	assignmentIds: z.array(resourceId).max(10000),
	notificationOperationIds: z.array(resourceId).max(10000),
});
export type ProactiveCopyScope = z.output<typeof proactiveCopyScopeSchema>;
export type GovernanceConfig = z.output<typeof governanceConfigSchema>;
export type ArtifactPurgePlan = z.output<typeof artifactPurgePlanSchema>;
export type ArtifactPurgeResult = z.output<typeof artifactPurgeResultSchema>;
export type BeginForget = z.output<typeof beginForgetSchema>;
export type FinishForget = z.output<typeof finishForgetSchema>;
export type ForgetReceipt = z.output<typeof forgetReceiptSchema>;
export type GovernanceSweep = z.output<typeof governanceSweepSchema>;
