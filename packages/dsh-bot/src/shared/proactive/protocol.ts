import { methodTrial, methodLoadEvidence } from "./method-evaluation.js";
import { followUpGroupAbandonInputSchema, followUpGroupInputSchema, followUpGroupPlanRequestSchema, followUpGroupPlanSchema } from './group-follow-up.js';
import { documentSnapshotSchema } from "./document.js";
import {
  followUpActionSchema, followUpBootstrapSchema, followUpGroupWatchProposalSchema, followUpIngestSchema, followUpPageRequestSchema,
  followUpPageSchema, followUpPolicyChangeSchema, followUpSummarySchema, followUpWatchCreateSchema, subjectSchema,
  followUpSourceCursorSchema, followUpSourceRequestSchema, followUpSubjectsSchema, followUpWatchUpdateSchema, followUpCardSchema,
} from './follow-up.js';
import { activityRequestSchema, workDetailRequestSchema, workSummarySchema } from './activity.js';
import { groupRepairEvidence, groupRepairOffer } from "./group-repair.js";
import {
	governanceConfigSchema,
	proactiveCopyScopeSchema,
	beginForgetSchema,
	finishForgetSchema,
	governancePurgeRecordSchema,
	forgetReceiptSchema,
	forgetBlockedReasonSchema,
	artifactPurgePlanSchema,
} from "./governance.js";
import {
	noticeConfigSchema,
	noticeScheduleSchema,
	noticeReviseSchema,
	noticeClaimSchema,
	noticeSettleSchema,
	noticeItemSchema,
	noticeBatchSchema,
} from "./notices.js";
import { z } from "zod";
import {
	workspaceRepairOffer,
	workspaceRepairEvidence,
	commandEvidence,
} from "./workspace-repair.js";
import { botKeySchema } from "../identity.js";
import {
	responsibilityMutationSchema,
	responsibilityListSchema,
	responsibilitySchema,
} from "./responsibility.js";
import {
	feedbackWorkflowAction,
	feedbackWorkflowView,
	feedbackCandidate,
} from "./feedback.js";
import {
	ciJob,
	feedbackAction,
	feedbackRule,
	feedbackSource,
} from "./feedback.js";
import { externalEvidence, repairEvidence, repairOffer } from "./repair.js";
import {
	acceptSchema,
	groupFollowUpCandidate,
	groupFollowUpTarget,
	groupReviewReceipt,
	reviewSchema,
	sessionEvidenceSchema,
	workId,
	workListSchema,
	workHistoryRequestSchema,
	workHistorySchema,
	workMutation,
  workContinuationSchema,
	workSchema,
} from "./work.js";

export const protocolVersion = 1 as const;
export const maxFrameBytes = 128 * 1024;
// Transport bounds, not an additional user-facing capability or task store.
export const maxReadBytes = 4 * 1024 * 1024;
export const readPageBytes = 48 * 1024;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version = z.literal(protocolVersion);
const correlationId = z.uuid();

export const ciSignalSchema = z.strictObject({
	job: ciJob.optional(),
	attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	conclusion: z.enum(["failure", "success", "cancelled"]),
});
export const ciContextSchema = z.strictObject({
	repository: z
		.string()
		.regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
	branch: z.string().max(200),
	runId: z.string().regex(/^[1-9][0-9]{0,30}$/),
	commit: z.string().regex(/^[a-f0-9]{40}$/),
	url: z
		.url()
		.refine((value) =>
			/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/.test(
				value,
			),
		),
});
export const sourceEventSchema = z.strictObject({
	nativeId: id,
	nativeRevision: id,
	threadId: id,
	occurredAt: z.iso.datetime(),
	summary: z.string().min(1).max(2048),
	ci: ciSignalSchema.optional(),
	context: ciContextSchema.optional(),
});
const checkpoint = z.string().min(1).max(512).nullable();
export const suggestionActionSchema = z.strictObject({
	decisionId: id,
	expectedRevision: seq,
	action: z.enum(["dismiss", "observe"]),
});
export const suggestionAdjustmentSchema = z.strictObject({
	decisionId: id,
	expectedRevision: seq,
	title: z.string().trim().min(1).max(500),
});
export const commandBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal('follow-up-policy'), input: followUpPolicyChangeSchema }),
  z.strictObject({ kind: z.literal('follow-up-watch-create'), input: followUpWatchCreateSchema }),
  z.strictObject({ kind: z.literal('follow-up-group-watch-propose'), input: followUpGroupWatchProposalSchema }),
  z.strictObject({ kind: z.literal('follow-up-watch-update'), input: followUpWatchUpdateSchema }),
  z.strictObject({ kind: z.literal('follow-up-action'), input: followUpActionSchema }),
  z.strictObject({ kind: z.literal('follow-up-group-accept'), operationId: z.uuid(), input: followUpGroupInputSchema }),
  z.strictObject({ kind: z.literal('follow-up-group-started'), operationId: z.uuid(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/), turnId: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.literal('follow-up-group-abandon'), input: followUpGroupAbandonInputSchema }),
  z.strictObject({ kind: z.literal('follow-up-ingest'), input: followUpIngestSchema }),
  z.strictObject({ kind: z.literal('follow-up-work-reconcile'),
    input: z.strictObject({ subject: followUpPolicyChangeSchema.shape.subject, expectedPolicyRevision: seq }),
  }),
  z.strictObject({ kind: z.literal('submit-document'), methodTrial: methodTrial.optional(), document: documentSnapshotSchema,
    target: acceptSchema.shape.target, approved: z.literal(true),
    taskLimits: acceptSchema.shape.taskLimits.unwrap(),
  }),
	workMutation.extend({
		kind: z.literal("execution-drained"),
		assignmentId: workId,
	}),
	z.strictObject({
		kind: z.literal("settle-group-budget"),
		ticketId: workId,
		assignmentId: workId,
		reservationId: workId,
		outcome: z.enum(["known", "unknown"]),
		tokens: seq.optional(),
	}),
	z.strictObject({
		kind: z.literal("forget-block"),
		operationId: workId,
		reason: forgetBlockedReasonSchema,
	}),
	suggestionAdjustmentSchema.extend({ kind: z.literal("adjust-suggestion") }),
	z.strictObject({ kind: z.literal("governance-sweep") }),
	z.strictObject({ kind: z.literal("forget-begin"), input: beginForgetSchema }),
	z.strictObject({
		kind: z.literal("forget-finish"),
		input: finishForgetSchema,
	}),
	z.strictObject({
		kind: z.literal("governance-purge"),
		input: governancePurgeRecordSchema,
	}),
	z.strictObject({
		kind: z.literal("notice-schedule"),
		input: noticeScheduleSchema,
	}),
	z.strictObject({
		kind: z.literal("notice-revise"),
		input: noticeReviseSchema,
	}),
	z.strictObject({ kind: z.literal("notice-claim"), input: noticeClaimSchema }),
	z.strictObject({
		kind: z.literal("notice-settle"),
		input: noticeSettleSchema,
	}),
	z.strictObject({
		kind: z.literal("notice-cancel"),
		operationId: workId,
		expectedRevision: seq,
	}),
	z.strictObject({
		kind: z.literal("responsibility-mutation"),
		input: responsibilityMutationSchema,
	}),
	z.strictObject({
		kind: z.literal("feedback-workflow"),
		input: feedbackWorkflowAction,
	}),
	workMutation.extend({
		kind: z.literal("claim-group-review"),
		group: groupReviewReceipt.shape.group,
		digest: groupReviewReceipt.shape.digest,
		evidenceDigest: groupReviewReceipt.shape.evidenceDigest,
		followUp: groupFollowUpTarget.optional(),
	}),
	workMutation.extend({
		kind: z.literal("settle-group-review"),
		digest: groupReviewReceipt.shape.digest,
		turnId: workId.optional(),
	}),
	workMutation.extend({
		kind: z.literal("claim-group-follow-up"),
		factId: workId,
	}),
	workMutation.extend({
		kind: z.literal("settle-group-follow-up"),
		factId: workId,
		turnId: workId.optional(),
	}),
	workMutation.extend({ kind: z.literal("deny-group-follow-up") }),
	z.strictObject({ kind: z.literal("feedback-rule"), input: feedbackAction }),
	workMutation.extend({
		kind: z.literal("external-started"),
		assignmentId: workId,
		runId: externalEvidence.shape.runId,
	}),
	z.strictObject({
		kind: z.literal("ingest-batch"),
		sourceId: id,
		generation: seq,
		expectedCheckpoint: checkpoint,
		nextCheckpoint: checkpoint,
		events: z.array(sourceEventSchema).max(32),
	}),
	z.strictObject({
		kind: z.literal("revoke-source"),
		sourceId: id,
		generation: seq,
	}),
	suggestionActionSchema.extend({ kind: z.literal("suggestion-action") }),
	acceptSchema.extend({ kind: z.literal("accept-decision") }),
	acceptSchema
		.omit({ approved: true })
		.extend({ kind: z.literal("auto-accept"), ruleId: workId }),
	z.strictObject({
		kind: z.literal("pause-execution"),
		paused: z.boolean(),
		expectedRevision: seq,
	}),
	workMutation.extend({ kind: z.literal("cancel") }),
	reviewSchema.extend({ kind: z.literal("review") }),
  z.strictObject({ kind: z.literal('work-continuation'), operationId: z.uuid(), input: workContinuationSchema }),
	workMutation.extend({
		kind: z.literal("dispatch-claim"),
		assignmentId: workId,
		sessionId: z.uuid().optional(),
	}),
	workMutation.extend({
		kind: z.literal("dispatch-send"),
		assignmentId: workId,
		inputId: workId,
	}),
	z.strictObject({
		kind: z.literal("claim-notice"),
		assignmentId: workId,
		operationId: workId,
	}),
	z.strictObject({
		kind: z.literal("settle-notice"),
		assignmentId: workId,
		operationId: workId,
		state: z.enum(["recorded", "suppressed", "unknown"]),
	}),
	workMutation.extend({
		kind: z.literal("report-result"),
		assignmentId: workId,
		result: z.discriminatedUnion("state", [
			z.strictObject({
				state: z.literal("delivered"),
        methodEvidence: methodLoadEvidence.optional(),
				usage: z
					.strictObject({ inputTokens: seq, outputTokens: seq })
					.optional(),
				workspaceEvidence: workspaceRepairEvidence.optional(),
				groupRepairEvidence: groupRepairEvidence.optional(),
				commandEvidence: commandEvidence.optional(),
				evidence: sessionEvidenceSchema.optional(),
				externalEvidence: externalEvidence.optional(),
				repairEvidence: repairEvidence.optional(),
			}),
			z.strictObject({
				state: z.enum(["denied", "failed", "unknown"]),
				groupRepairEvidence: groupRepairEvidence.optional(),
			}),
		]),
	}),
]);
export const commandSchema = z.strictObject({
	commandId: z.uuid(),
	actorRef: z.literal("local-host"),
	storeId: z.uuid(),
	payloadDigest: digestSchema,
	body: commandBodySchema,
});
export type CommandBody = z.infer<typeof commandBodySchema>;
export type CommandEnvelope = z.infer<typeof commandSchema>;

export const autoCiRuleSchema = z.strictObject({
	id: workId,
	sourceId: workId,
	sourceGeneration: seq,
	expiresAt: z.iso.datetime(),
	target: acceptSchema.shape.target,
});
const header = {
	protocolVersion: version,
	correlationId,
	channel: digestSchema,
};
export const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...header, kind: z.literal('follow-up-summary'), storeId: z.uuid(), subject: subjectSchema }),
  z.strictObject({ ...header, kind: z.literal('follow-up-page'), storeId: z.uuid(), input: followUpPageRequestSchema }),
  z.strictObject({ ...header, kind: z.literal('follow-up-group-plan'), storeId: z.uuid(), input: followUpGroupPlanRequestSchema }),
  z.strictObject({ ...header, kind: z.literal('follow-up-subjects'), storeId: z.uuid(), cursor: followUpPageRequestSchema.shape.cursor }),
  z.strictObject({ ...header, kind: z.literal('follow-up-source'), storeId: z.uuid(), ...followUpSourceRequestSchema.shape }),
  z.strictObject({ ...header, kind: z.literal('activity-page'), storeId: z.uuid(), input: activityRequestSchema }),
  z.strictObject({ ...header, kind: z.literal('work-detail'), storeId: z.uuid(), input: workDetailRequestSchema }),
	z.strictObject({
		...header,
		kind: z.literal("read-page"),
		storeId: z.uuid(),
		readId: z.uuid(),
		readVersion: digestSchema,
		offset: z.number().int().min(0).max(maxReadBytes),
	}),
	z.strictObject({
		...header,
		kind: z.literal("source-cleanup-scope"),
		storeId: z.uuid(),
		sourceId: workId,
		generation: seq,
	}),
	z.strictObject({
		...header,
		kind: z.literal("forget-receipt"),
		storeId: z.uuid(),
		operationId: workId,
	}),
	z.strictObject({
		...header,
		kind: z.literal("governance-pending"),
		storeId: z.uuid(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("work-assignment"),
		storeId: z.uuid(),
		assignmentId: workId,
	}),
	z.strictObject({
		...header,
		kind: z.literal("notice-due"),
		storeId: z.uuid(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("notice-candidates"),
		storeId: z.uuid(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("notice-batch"),
		storeId: z.uuid(),
		id: workId,
	}),
	z.strictObject({
		...header,
		kind: z.literal("auto-candidates"),
		storeId: z.uuid(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("feedback-candidate"),
		storeId: z.uuid(),
		id: z.uuid(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("feedback-history"),
		storeId: z.uuid(),
		id: z.uuid(),
		afterRevision: seq.optional(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("responsibilities"),
		storeId: z.uuid(),
		owner: botKeySchema,
	}),
	z.strictObject({
		...header,
		kind: z.literal("feedback-overview"),
		storeId: z.uuid(),
		cursor: z.string().optional(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("work-history"),
		storeId: z.uuid(),
		input: workHistoryRequestSchema,
	}),
	z.strictObject({
		...header,
		kind: z.literal("hello"),
		installationId: z.uuid(),
		expectedStoreId: z.uuid().nullable(),
		budget: z.number().int().min(1).max(100).optional(),
		externalBudget: z.number().int().min(0).max(100).optional(),
		notice: z.boolean().optional(),
		noticeConfig: noticeConfigSchema.optional(),
		governanceConfig: governanceConfigSchema.optional(),
		autoRule: autoCiRuleSchema.optional(),
		feedbackSource: feedbackSource.optional(),
		followUpBootstrap: followUpBootstrapSchema.optional(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("command"),
		command: commandSchema,
	}),
	z.strictObject({ ...header, kind: z.literal("snapshot"), storeId: z.uuid() }),
	z.strictObject({
		...header,
		kind: z.literal("work-ticket"),
		storeId: z.uuid(),
		ticketId: workId,
	}),
	z.strictObject({
		...header,
		kind: z.literal("checkpoint"),
		storeId: z.uuid(),
		sourceId: id,
	}),
	z.strictObject({
		...header,
		kind: z.literal("suggestions"),
		owner: botKeySchema.optional(),
		includeFiltered: z.boolean().optional(),
		storeId: z.uuid(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("receipt"),
		storeId: z.uuid(),
		commandId: z.uuid(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("dispatch-permitted"),
		storeId: z.uuid(),
		assignmentId: workId,
		groupReviewDigest: groupReviewReceipt.shape.digest.optional(),
		groupFactId: workId.optional(),
		noticeRevision: z.number().int().nonnegative().optional(),
		dispatchRevision: z.number().int().nonnegative().optional(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("group-follow-ups"),
		storeId: z.uuid(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("work-list"),
		storeId: z.uuid(),
		owner: botKeySchema.optional(),
	}),
	z.strictObject({
		...header,
		kind: z.literal("work"),
		storeId: z.uuid(),
		decisionId: workId,
	}),
	z.strictObject({ ...header, kind: z.literal("shutdown"), storeId: z.uuid() }),
]);
export type Request = z.infer<typeof requestSchema>;
type WithoutHeader<T> = T extends Request
	? Omit<T, keyof typeof header>
	: never;
export type RequestBody = WithoutHeader<Request>;

export const capabilities = {
	ingest: true,
	snapshot: true,
	scheduledSource: false,
	automaticSubagent: false,
	automaticGroup: false,
	externalNotification: false,
	directExecution: false,
} as const;
const capabilitySchema = z.strictObject({
	ingest: z.boolean(),
	snapshot: z.boolean(),
	scheduledSource: z.boolean(),
	automaticSubagent: z.boolean(),
	automaticGroup: z.boolean(),
	externalNotification: z.boolean(),
	directExecution: z.boolean(),
});
export const executionControlSchema = z.strictObject({
	paused: z.boolean(),
	revision: seq,
});
export const snapshotSchema = z.strictObject({
	storeId: z.uuid(),
	committedSeq: seq,
	triggerCount: seq,
	ticketCount: seq,
	suggestionCount: seq,
	feedbackSource: feedbackSource.optional(),
	feedbackRules: z.array(feedbackRule).max(30).optional(),
	executionControl: executionControlSchema,
});
export const suggestionSchema = z.strictObject({
	adjusted: z.boolean().optional(),
	matchedResponsibilities: z
		.array(
			z.strictObject({
				id: responsibilitySchema.shape.id,
				revision: responsibilitySchema.shape.revision,
				name: responsibilitySchema.shape.name,
				action: responsibilitySchema.shape.action,
				actionScopeDigest: responsibilitySchema.shape.actionScopeDigest,
			}),
		)
		.max(8)
		.optional(),
	sourceGeneration: seq.optional(),
	context: ciContextSchema.optional(),
	job: ciJob.optional(),
	id,
	sourceId: id,
	title: z.string().max(2048),
	observedAt: z.iso.datetime(),
	expiresAt: z.iso.datetime(),
	revision: seq,
	state: z.enum(["open", "observing"]),
	observeUntil: z.iso.datetime().optional(),
	policyVersion: z.string(),
	triggerId: id,
	attempt: seq,
	scope: z.literal("inspect-ci-result"),
});
export const suggestionsSchema = z.array(suggestionSchema).max(100);
export const activityPageSchema = z.discriminatedUnion('collection', [
  z.strictObject({ collection: z.literal('work'), rows: z.array(workSummarySchema).max(20), next: z.string().max(2048).optional() }),
  z.strictObject({ collection: z.literal('suggestions'), rows: z.array(suggestionSchema).max(20), next: z.string().max(2048).optional() }),
]);
export type ActivityPage = z.output<typeof activityPageSchema>;
export type Suggestion = z.output<typeof suggestionSchema>;
export const sourceCheckpointSchema = z.strictObject({
	generation: seq,
	checkpoint,
	revoked: z.literal(true).optional(),
});
export const receiptSchema = z.strictObject({
	scope: z.literal("core"),
	status: z.enum(["committed", "duplicate"]),
	commandId: z.uuid(),
	receiptId: z.uuid(),
	committedSeq: seq,
	stored: seq,
});
const replyHeader = { protocolVersion: version, correlationId };
export const replySchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...replyHeader, kind: z.literal('follow-up-summary'), summary: followUpSummarySchema }),
  z.strictObject({ ...replyHeader, kind: z.literal('follow-up-page'), page: followUpPageSchema }),
  z.strictObject({ ...replyHeader, kind: z.literal('follow-up-group-plan'), plan: followUpGroupPlanSchema.nullable(), card: followUpCardSchema.nullable(), activationEpoch: z.uuid().nullable() }),
  z.strictObject({ ...replyHeader, kind: z.literal('follow-up-subjects'), ...followUpSubjectsSchema.shape }),
  z.strictObject({ ...replyHeader, kind: z.literal('follow-up-source'), cursor: followUpSourceCursorSchema }),
  z.strictObject({ protocolVersion: version, correlationId, kind: z.literal('activity-page'), page: activityPageSchema }),
	z.strictObject({
		...replyHeader,
		kind: z.literal("read-page"),
		readId: z.uuid(),
		readVersion: digestSchema,
		readSeq: seq,
		totalBytes: z.number().int().positive().max(maxReadBytes),
		offset: z.number().int().nonnegative().max(maxReadBytes),
		data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(4 * Math.ceil(readPageBytes / 3)),
		nextOffset: z.number().int().positive().max(maxReadBytes).optional(),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("source-cleanup-scope"),
		scope: proactiveCopyScopeSchema,
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("forget-receipt"),
		receipt: forgetReceiptSchema.nullable(),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("governance-pending"),
		plans: z.array(artifactPurgePlanSchema).max(16),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("notice-due"),
		items: z.array(noticeItemSchema).max(1000),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("notice-candidates"),
		work: workListSchema,
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("notice-batch"),
		batch: noticeBatchSchema.nullable(),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("auto-candidates"),
		rows: z
			.array(
				z.strictObject({
					suggestion: suggestionSchema,
					responsibility: responsibilitySchema,
				}),
			)
			.max(100),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("feedback-candidate"),
		candidate: feedbackCandidate.nullable(),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("feedback-history"),
		history: z.strictObject({
			rows: z.array(feedbackCandidate),
			nextRevision: seq.optional(),
		}),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("responsibilities"),
		rows: responsibilityListSchema,
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("feedback-overview"),
		view: feedbackWorkflowView,
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("work-history"),
		history: workHistorySchema,
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("hello"),
		storeId: z.uuid(),
		bootId: z.uuid(),
		capabilities: capabilitySchema,
		scopedRecovery: z.literal(true).optional(),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("snapshot"),
		snapshot: snapshotSchema,
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("suggestions"),
		suggestions: suggestionsSchema,
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("receipt"),
		receipt: receiptSchema.nullable(),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("dispatch-permitted"),
		permitted: z.boolean(),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("group-follow-ups"),
		candidates: z.array(groupFollowUpCandidate).max(16),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("work-list"),
		work: workListSchema,
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("work"),
		work: workSchema.nullable(),
	}),
	z.strictObject({ ...replyHeader, kind: z.literal("shutdown") }),
	z.strictObject({
		...replyHeader,
		kind: z.literal("checkpoint"),
		source: sourceCheckpointSchema.nullable(),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("rejected"),
		code: z.enum(["invalid", "forbidden", "conflict", "stale", "unsupported"]),
	}),
	z.strictObject({
		...replyHeader,
		kind: z.literal("unknown"),
		commandId: z.uuid(),
	}),
]);
export type Reply = z.infer<typeof replySchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type RejectCode = Extract<Reply, { kind: "rejected" }>["code"];
export const proactiveStatusSchema = z.strictObject({
	state: z.enum(["disabled", "starting", "ready", "unavailable"]),
	capabilities: capabilitySchema,
	snapshot: snapshotSchema.optional(),
	repairOffers: z.array(repairOffer).max(2).optional(),
	workspaceOffers: z.array(workspaceRepairOffer).max(2).optional(),
	groupRepairOffers: z.array(groupRepairOffer).max(32).optional(),
	actionScopes: z
		.array(
			z.strictObject({
				action: z.enum([
					"inspect-ci-result",
					"repair-fixture",
					"repair-external",
					"repair-workspace",
				]),
				digest: digestSchema,
				title: z.string(),
			}),
		)
		.max(8)
		.optional(),
	localFeedLastSuccessAt: z.iso.datetime().optional(),
	localFeed: z
		.enum(["waiting", "ready", "invalid", "unavailable", "revoked"])
		.optional(),
	localFeedScope: z
		.strictObject({
			id,
			generation: seq,
			repository: z.string(),
			branch: z.string(),
		})
		.optional(),
	directRoute: z
		.strictObject({ provider: workId, model: z.string().min(1).max(128) })
		.optional(),
});
export type ProactiveStatus = z.infer<typeof proactiveStatusSchema>;
export const suggestionActionReplySchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("receipt"), receipt: receiptSchema }),
	z.strictObject({ kind: z.literal("unknown"), commandId: z.uuid() }),
	z.strictObject({
		kind: z.literal("rejected"),
		code: z.enum(["invalid", "forbidden", "conflict", "stale", "unsupported"]),
	}),
]);

export type AutoCiRule = NonNullable<
	Extract<Request, { kind: "hello" }>["autoRule"]
>;
