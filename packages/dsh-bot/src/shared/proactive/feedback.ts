import { methodManifest } from "./method-package.js";
import { methodPlan, methodEvaluation, methodRunReceipt } from "./method-evaluation.js";
import { z } from "zod";
import { botKeySchema } from "../identity.js";

export const ciJob = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
export const feedbackSource = z.string().regex(/^ci:[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const feedbackAction = z.discriminatedUnion("action", [
	z.strictObject({
		action: z.literal("propose"),
		decisionId: z.string(),
		expectedRevision: revision,
	}),
	z.strictObject({
		action: z.enum(["evaluate", "adopt", "revoke"]),
		ruleId: z.uuid(),
		expectedRevision: revision,
	}),
]);
export const feedbackEvaluation = z.strictObject({
	dataset: z.literal("synthetic-ci-v2"),
	digest,
	batches: z
		.array(
			z.strictObject({
				id: z.enum(["build", "publication", "retry"]),
				beforeFalsePositives: revision,
				afterFalsePositives: revision,
				beforeMissed: revision,
				afterMissed: revision,
			}),
		)
		.length(3),
	passed: z.boolean(),
});
export const feedbackRule = z.strictObject({
	id: z.uuid(),
	sourceId: feedbackSource,
	job: ciJob,
	attempt: z.number().int().positive(),
	revision,
	state: z.enum(["candidate", "eligible", "rejected", "adopted", "revoked"]),
	evaluation: feedbackEvaluation.optional(),
});
export type FeedbackAction = z.output<typeof feedbackAction>;
export type FeedbackRule = z.output<typeof feedbackRule>;

// General owner-reviewed feedback is independent of the optional repair fixture.
const identifier = z.string().trim().min(1).max(160);
const text = z.string().trim().min(1).max(2048);
const skillName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const feedbackRuleChange = z.strictObject({
	sourceId: feedbackSource,
	sourceGeneration: revision,
	job: ciJob,
	attempt: z.number().int().positive(),
	mode: z.enum(["suppress", "include", "mute"]),
});
export const feedbackAttribution = z.strictObject({
  category: z.enum(['preference', 'method', 'handoff', 'environment', 'unknown']),
  basis: z.literal('owner-hypothesis'),
  problem: text, reproducer: text, scope: text, counterexample: text,
  confounds: z.array(z.enum(['human-fix', 'model-change', 'environment-change', 'tool-change'])).max(4),
}).refine(value => value.category !== 'method' || value.confounds.length === 0, 'Confounded outcomes cannot be attributed to a method');
const origin = z.strictObject({
  trace: z.strictObject({
    assignmentId: identifier, generation: revision,
    provider: identifier, model: identifier,
    sessionId: z.uuid().optional(),
    groupDigest: digest.optional(), membershipRevision: revision.optional(),
    modelRevision: revision.optional(),
    turnIds: z.array(identifier).max(4), deliveryIds: z.array(identifier).max(8),
    artifactDigest: digest.optional(),
  }).optional(),
	bot: botKeySchema,
	taskId: identifier,
	evidenceDigest: digest,
	source: z.strictObject({ id: z.string().regex(/^(ci|doc):[a-f0-9]{64}$/), generation: revision }).optional(),
});
const common = { origin, reason: text, attribution: feedbackAttribution.optional() };
export const feedbackProposal = z.discriminatedUnion("kind", [
	z.strictObject({ ...common, kind: z.literal("rework"), reason: text.max(512), ticketId: identifier, expectedWorkRevision: revision }),
	z.strictObject({ ...common, kind: z.literal("false-positive"), change: feedbackRuleChange.extend({ mode: z.literal("suppress") }) }),
	z.strictObject({ ...common, kind: z.literal("false-negative"), change: feedbackRuleChange.extend({ mode: z.literal("include") }) }),
	z.strictObject({ ...common, kind: z.literal("attention"), change: feedbackRuleChange.extend({ mode: z.literal("mute") }) }),
	z.strictObject({ ...common, kind: z.literal("preference"), content: text }),
	z.strictObject({ ...common, kind: z.literal("skill"), importedMethod: methodManifest.omit({ content: true, name: true, parentHash: true }).extend({ packageDigest: digest }).optional(), name: skillName, before: z.string().max(65536).nullable(), beforeHash: digest.nullable(), content: z.string().min(1).max(65536) }),
	z.strictObject({ ...common, kind: z.literal("permission"), setting: z.enum(["tools", "workspace", "model", "notifications", "proactive"]) }),
]).refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 40 * 1024, "Feedback proposal exceeds transport budget");
export const feedbackDataset = z.strictObject({
	id: identifier,
	version: z.number().int().positive(),
	owner: botKeySchema,
	provenance: text,
	labelPolicy: text,
	exceptions: z.array(text).max(50),
	maxAddedMisses: revision.max(100),
	batches: z.array(z.strictObject({
		id: identifier,
		rows: z.array(z.strictObject({
			taskId: identifier,
			sourceId: feedbackSource,
			sourceGeneration: revision,
			job: ciJob,
			attempt: z.number().int().positive(),
			needed: z.boolean(),
			baselineSuggested: z.boolean(),
			attentionNeeded: z.boolean(),
			baselineNotified: z.boolean(),
			labelAgreement: z.enum(["agreed", "disputed"]),
			note: z.string().max(2048).optional(),
		})).min(1).max(200),
	})).length(3),
}).superRefine((value, ctx) => {
	if (new Set(value.batches.map(batch => batch.id)).size !== 3)
		ctx.addIssue({ code: "custom", message: "Three distinct batches are required" });
	const tasks = value.batches.flatMap(batch => batch.rows.map(row => row.taskId));
	if (new Set(tasks).size !== tasks.length)
		ctx.addIssue({ code: "custom", message: "A task cannot cross held-out batches" });
	if (new TextEncoder().encode(JSON.stringify(value)).length > 96 * 1024)
		ctx.addIssue({ code: "custom", message: "Frozen dataset exceeds transport budget" });
});
export const frozenFeedbackDataset = feedbackDataset.safeExtend({ digest, frozenAt: z.number().int().nonnegative() });
export const feedbackComparison = z.strictObject({
	datasetId: identifier, datasetVersion: z.number().int().positive(), digest,
	maxAddedMisses: revision, evaluatedAt: z.number().int().nonnegative(),
	batches: z.array(z.strictObject({
		id: identifier, samples: revision, disputed: revision,
		beforeFalsePositives: revision, afterFalsePositives: revision,
		beforeMissed: revision, afterMissed: revision,
		beforeUnwantedNotices: revision, afterUnwantedNotices: revision,
		beforeMissedNotices: revision, afterMissedNotices: revision,
	})).length(3),
	passed: z.boolean(),
});
export const feedbackApplicationReceipt = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("memory"), memoryId: z.uuid(), versionId: z.uuid() }),
	z.strictObject({ kind: z.literal("skill"), hash: digest.nullable() }),
	z.strictObject({ kind: z.literal("rework"), ticketId: identifier, assignmentId: identifier }),
]);
export const feedbackCandidate = z.strictObject({
  methodEvaluation: methodEvaluation.optional(),
	failureKey: digest.optional(),
	id: z.uuid(), revision, createdAt: z.number().int().nonnegative(),
	datasetDigests: z.array(digest).max(30),
	proposal: feedbackProposal, proposalDigest: digest,
	state: z.enum(["candidate", "eligible", "rejected", "applying", "adopted", "revoking", "revoked", "unknown"]),
	evaluation: feedbackComparison.optional(),
	application: feedbackApplicationReceipt.optional(),
	operationId: z.uuid().optional(),
	unknownAction: z.enum(["adopt", "revoke"]).optional(),
	bodyPurgedAt: z.number().int().nonnegative().optional(),
});
const candidateFence = { candidateId: z.uuid(), expectedRevision: revision };
export const feedbackWorkflowAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal('register-method-evaluation'), ...candidateFence, plan: methodPlan }),
  z.strictObject({ action: z.literal('run-method-evaluation'), ...candidateFence }),
  z.strictObject({ action: z.literal('settle-method-evaluation'), ...candidateFence, operationId: z.uuid(), receipts: z.array(methodRunReceipt).max(36) }),
	z.strictObject({ action: z.literal("import-dataset"), dataset: feedbackDataset }),
	z.strictObject({ action: z.literal("propose-candidate"), proposal: feedbackProposal }),
	z.strictObject({ action: z.literal("evaluate-candidate"), ...candidateFence, datasetId: identifier, datasetVersion: z.number().int().positive() }),
	z.strictObject({ action: z.literal("adopt-candidate"), ...candidateFence, reviewedDigest: digest }),
	z.strictObject({ action: z.literal("revoke-candidate"), ...candidateFence, reviewedDigest: digest }),
	z.strictObject({ action: z.literal("settle-candidate"), ...candidateFence, operationId: z.uuid(), outcome: z.enum(["applied", "unknown"]), receipt: feedbackApplicationReceipt.optional() }),
]);
export const feedbackWorkflowView = z.strictObject({
	candidates: z.array(feedbackCandidate).max(200),
	datasets: z.array(z.strictObject({
		id: identifier, version: z.number().int().positive(), owner: botKeySchema, digest, frozenAt: z.number().int().nonnegative(),
		samples: revision, disputed: revision, exceptions: revision,
	})).max(30),
	nextCursor: z.uuid().optional(),
});
export const feedbackContextSchema = z.strictObject({
	label: text, origin,
	ticket: z.strictObject({ id: identifier, revision }).optional(),
	change: feedbackRuleChange.omit({ mode: true }).optional(),
});
export const feedbackContextsSchema = z.array(feedbackContextSchema).max(201);
export type FeedbackContext = z.output<typeof feedbackContextSchema>;
export type FeedbackProposal = z.output<typeof feedbackProposal>;
export type FeedbackCandidate = z.output<typeof feedbackCandidate>;
export type FeedbackDataset = z.output<typeof feedbackDataset>;
export type FrozenFeedbackDataset = z.output<typeof frozenFeedbackDataset>;
export type FeedbackComparison = z.output<typeof feedbackComparison>;
export type FeedbackApplicationReceipt = z.output<typeof feedbackApplicationReceipt>;
export type FeedbackWorkflowAction = z.output<typeof feedbackWorkflowAction>;
export type FeedbackWorkflowView = z.output<typeof feedbackWorkflowView>;
