import { methodTrial, methodLoadEvidence } from "./method-evaluation.js";
import { documentSnapshotSchema } from "./document.js";
import { groupModelSelectionSchema } from '../groups.js';
import { groupRepairGrant, groupRepairEvidence } from "./group-repair.js";
import { z } from "zod";
import {
	workspaceRepairGrant,
	workspaceRepairEvidence,
	commandEvidence,
} from "./workspace-repair.js";
import { externalEvidence, repairEvidence, repairGrant } from "./repair.js";
import { groupKeySchema } from "../groups.js";
import { botKeySchema } from "../identity.js";
import {
	responsibilityBindingSchema,
	responsibilityAcceptanceSchema,
} from "./responsibility.js";

export const workId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
export const revision = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const executionTarget = z.strictObject({
	bot: botKeySchema,
	botUpdatedAt: revision,
	provider: workId,
	model: z.string().min(1).max(128),
});
export const taskLimitsSchema = z.strictObject({
	maxAttempts: z.number().int().min(1).max(20),
	maxTokens: z.number().int().min(128).max(32768),
	deadlineAt: z.iso.datetime(),
});
export const acceptSchema = z.strictObject({
	decisionId: workId,
	expectedRevision: revision,
	sourceId: workId,
	policyVersion: z.string().min(1).max(100),
	target: executionTarget,
	approved: z.literal(true),
	repair: repairGrant.optional(),
	workspaceRepair: workspaceRepairGrant.optional(),
	groupRepair: groupRepairGrant.optional(),
	taskLimits: taskLimitsSchema.optional(),
	responsibility: z.strictObject({ id: workId, revision }).optional(),
});
export const sessionEvidenceSchema = z.strictObject({
	inputId: workId,
	assistantId: workId,
	turn: revision,
	outputDigest: hash,
	checks: z.tuple([
		z.literal("source-match"),
		z.literal("turn-completed"),
		z.literal("transcript-flushed"),
	]),
});
export const groupFollowUpTarget = z.strictObject({
  modelSelection: groupModelSelectionSchema.optional(),
  modelRevision: z.number().int().nonnegative().optional(),
	memberId: workId,
	bot: botKeySchema,
	botRevision: revision,
	membershipRevision: revision,
});
export const groupFollowUpFact = z.strictObject({
	id: workId,
	attempt: z.number().int().positive(),
	conclusion: z.enum(["failure", "success", "cancelled"]),
	text: z.string().min(1).max(2048),
});
export const groupBudgetReservation = z.strictObject({
	reservationId: workId,
	totalTokens: z.number().int().min(128).max(32768),
	perCallTokens: z.number().int().min(64).max(32768),
	requestCount: z.union([z.literal(1), z.literal(2)]),
	deadlineAt: z.iso.datetime(),
});
export const groupFollowUpGrant = groupFollowUpTarget.extend({
	thread: workId,
	sourceGeneration: revision,
	baselineAttempt: z.number().int().positive(),
	baselineAt: z.iso.datetime(),
	state: z.enum(["armed", "claimed", "linked", "unknown", "denied"]),
	fact: groupFollowUpFact.optional(),
	turnId: workId.optional(),
	budget: groupBudgetReservation.optional(),
});
export const groupReviewReceipt = z.strictObject({
	group: groupKeySchema,
	digest: hash,
	state: z.enum(["claimed", "linked", "unknown"]),
	turnId: workId.optional(),
	evidenceDigest: hash.optional(),
	followUp: groupFollowUpGrant.optional(),
	budget: groupBudgetReservation.optional(),
});
export const reworkFeedbackSchema = z.strictObject({
	failures: z
		.array(
			z.strictObject({
				criterion: z.string().trim().min(1).max(160),
				actual: z.string().trim().min(1).max(512),
				expected: z.string().trim().min(1).max(512),
			}),
		)
		.min(1)
		.max(8)
		.refine(
			(rows) =>
				new Set(rows.map((row) => JSON.stringify(row))).size === rows.length,
			"Duplicate findings are not allowed",
		),
	notes: z.string().trim().min(1).max(1024).optional(),
});
export const reworkContextSchema = z.strictObject({
	previousAssignmentId: workId,
	previousEvidenceDigest: hash,
	feedback: reworkFeedbackSchema,
	requestedAt: z.iso.datetime(),
	requestedBy: z.literal("owner"),
	previousRepairEvidence: repairEvidence.optional(),
	previousWorkspaceEvidence: workspaceRepairEvidence.optional(),
	previousGroupRepairEvidence: groupRepairEvidence.optional(),
});
const waitText = z.string().trim().min(1).max(500);
const supplementalText = z.string().trim().min(1).max(2048);
const workWait = z.strictObject({
  reason: waitText, request: waitText, operationId: z.uuid(), recordedAt: z.iso.datetime(),
});
const continuationBase = z.strictObject({
  owner: botKeySchema, ticketId: workId, assignmentId: workId,
  expectedRevision: revision, expectedPolicyRevision: revision,
});
const continuationOptions = [
  continuationBase.extend({ action: z.literal('mark-waiting'), reason: waitText, request: waitText }),
  continuationBase.extend({ action: z.literal('retry'), approved: z.literal(true) }),
  continuationBase.extend({ action: z.literal('supplement'), approved: z.literal(true), text: supplementalText }),
] as const;
export const workContinuationSchema = z.discriminatedUnion('action', continuationOptions);
export const workContinuationRequestSchema = z.discriminatedUnion('action', [
  continuationOptions[0].extend({ commandId: z.uuid() }),
  continuationOptions[1].extend({ commandId: z.uuid() }),
  continuationOptions[2].extend({ commandId: z.uuid() }),
]);
export type WorkContinuation = z.output<typeof workContinuationSchema>;
export type WorkContinuationRequest = z.output<typeof workContinuationRequestSchema>;
const continuationAudit = z.strictObject({ previousAssignmentId: workId, operationId: z.uuid(), requestedAt: z.iso.datetime() });
const workContinuationContext = z.discriminatedUnion('kind', [
  continuationAudit.extend({ kind: z.literal('retry') }),
  continuationAudit.extend({ kind: z.literal('supplement'), wait: workWait, text: supplementalText }),
]);
export const workSchema = z.strictObject({
  wait: workWait.optional(),
  continuation: workContinuationContext.optional(),
  methodTrial: methodTrial.optional(),
  methodEvidence: methodLoadEvidence.optional(),
  admission: z.enum(['manual', 'proactive']).optional(),
  taskKind: z.enum(['ci-analysis', 'document-analysis']).optional(),
  document: documentSnapshotSchema.optional(),
  sourceDigest: hash.optional(),
  taskCost: z.strictObject({ truncated: z.boolean().optional(), attempts: z.number().int().min(1).max(20), knownNativeTokens: z.number().int().nonnegative(), unknownMeasurements: z.number().int().nonnegative(), externalUnits: z.number().int().nonnegative() }).optional(),
	ticketId: workId,
	assignmentId: workId,
	decisionId: workId,
	triggerId: workId,
	sourceId: workId,
	title: z.string().min(1).max(2048),
	target: executionTarget,
	expiresAt: z.iso.datetime(),
	policyVersion: z.string().min(1).max(100),
	acceptance: responsibilityAcceptanceSchema.optional(),
	autoRuleId: workId.optional(),
	repair: repairGrant.optional(),
	workspaceRepair: workspaceRepairGrant.optional(),
	groupRepair: groupRepairGrant.optional(),
	taskLimits: taskLimitsSchema.optional(),
	responsibility: z
		.strictObject({
			id: workId,
			revision,
			grantId: workId,
			binding: responsibilityBindingSchema,
		})
		.optional(),
	repairEvidence: repairEvidence.optional(),
	workspaceEvidence: workspaceRepairEvidence.optional(),
	groupRepairEvidence: groupRepairEvidence.optional(),
	commandEvidence: commandEvidence.optional(),
	recoveryRevision: revision.optional(),
	usage: z
		.strictObject({
			inputTokens: z.number().int().nonnegative(),
			outputTokens: z.number().int().nonnegative(),
		})
		.optional(),
	groupReview: groupReviewReceipt.optional(),
	externalEvidence: externalEvidence.optional(),
	externalRunId: externalEvidence.shape.runId.optional(),
	revision,
	generation: z.number().int().min(1).max(20),
	state: z.enum([
		"pending",
		"claimed",
		"sent",
		"delivered",
		"denied",
		"failed",
		"unknown",
		"cancelled",
		"accepted",
		"superseded",
	]),
	supersededBy: workId.optional(),
	sessionId: z.uuid().optional(),
	inputId: workId.optional(),
	evidence: sessionEvidenceSchema.optional(),
	evidenceDigest: hash.optional(),
	reviewer: z.literal("owner").optional(),
	reviewedAt: z.iso.datetime().optional(),
	reviewFeedback: reworkFeedbackSchema.optional(),
	rework: reworkContextSchema.optional(),
	notice: z
		.strictObject({
			operationId: workId,
			state: z.enum(["intent", "claim", "recorded", "suppressed", "unknown"]),
			notBefore: z.iso.datetime().optional(),
			expiresAt: z.iso.datetime().optional(),
			batchId: workId.optional(),
			policyId: workId.optional(),
			policyRevision: revision.optional(),
		})
		.optional(),
});
export const workListSchema = z.array(workSchema).max(30);
export const workHistoryRequestSchema = z.strictObject({
	ticketId: workId,
	beforeGeneration: z.number().int().positive().optional(),
	limit: z.number().int().min(1).max(5).optional(),
});
export const workHistorySchema = z.strictObject({
	versions: z.array(workSchema).max(5),
	nextBeforeGeneration: z.number().int().positive().optional(),
});
export const groupFollowUpCandidate = z.strictObject({
	work: workSchema,
	fact: groupFollowUpFact,
});
export const workMutation = z.strictObject({
	ticketId: workId,
	expectedRevision: revision,
});
export const reviewSchema = workMutation.extend({
	evidenceDigest: hash,
	review: z.enum(["accept", "rework"]),
	approved: z.literal(true),
	feedback: reworkFeedbackSchema.optional(),
});
export type ReworkFeedback = z.output<typeof reworkFeedbackSchema>;
export type WorkHistoryRequest = z.input<typeof workHistoryRequestSchema>;
export type WorkHistory = z.output<typeof workHistorySchema>;
export type AcceptWork = z.input<typeof acceptSchema>;
export type ProactiveWork = z.output<typeof workSchema>;
export function supportsWorkContinuation(row: ProactiveWork) {
  return !row.repair && !row.workspaceRepair && !row.groupRepair && !row.groupReview && !row.methodTrial && !row.externalRunId;
}
export type ReviewWork = z.input<typeof reviewSchema>;
