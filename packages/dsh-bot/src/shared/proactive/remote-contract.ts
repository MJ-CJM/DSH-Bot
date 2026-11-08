import { beginForgetSchema, forgetReceiptSchema } from "./governance.js";
import {
	workspaceReviewRequest,
	workspaceReviewSchema,
} from "./workspace-repair.js";
import type {
	RemoteResult,
	TypertRemoteSpec,
} from "@deepseek-ai/dsh-typert-protocol";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol/remote-info";
import { z } from "zod";
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
	feedbackContextsSchema,
} from "./feedback.js";
import { groupKeySchema } from "../groups.js";
import { notificationState } from "../notifications.js";
import { feedbackAction } from "./feedback.js";
import {
	proactiveStatusSchema,
	suggestionActionReplySchema,
	suggestionActionSchema,
	suggestionAdjustmentSchema,
	suggestionsSchema,
} from "./protocol.js";

import {
	acceptSchema,
	groupFollowUpGrant,
	hash,
	reviewSchema,
	workListSchema,
	workMutation,
	workHistoryRequestSchema,
	workHistorySchema,
	workId,
} from "./work.js";

const codec = <S extends z.ZodType>(name: string, schema: S) => ({
	mode: "strict" as const,
	typeSymbol: `dsh-bot/proactive#${name}`,
	create: () => schema,
	encode: (value: unknown) => schema.parse(value),
	decode: (value: unknown) => schema.parse(value),
});

const owner = {
	service: "dshBotProactiveRemote",
	invocation: { kind: "direct" as const },
};
export const suggestionRequestSchema = suggestionActionSchema.extend({
	commandId: z.uuid(),
});
export const acceptRequestSchema = acceptSchema.extend({ commandId: z.uuid() });
export const cancelRequestSchema = workMutation.extend({ commandId: z.uuid() });
export const pauseRequestSchema = z.strictObject({
	commandId: z.uuid(),
	paused: z.boolean(),
	expectedRevision: z.number().int().nonnegative(),
});
export const revokeSourceRequestSchema = z.strictObject({
	commandId: z.uuid(),
	sourceId: workId,
	generation: z.number().int().nonnegative(),
});
export type RevokeSourceRequest = z.input<typeof revokeSourceRequestSchema>;
export const feedbackRequestSchema = z.strictObject({
	commandId: z.uuid(),
	input: feedbackAction,
});
export const responsibilityRequestSchema = z.strictObject({
	commandId: z.uuid(),
	mutation: responsibilityMutationSchema,
});
export const responsibilityMutationReply = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("applied"),
		responsibility: responsibilitySchema,
	}),
	z.strictObject({ kind: z.literal("rejected"), code: z.string() }),
	z.strictObject({ kind: z.literal("unknown") }),
]);
export const feedbackWorkflowRequestSchema = z.strictObject({
	commandId: z.uuid(),
	input: feedbackWorkflowAction.refine(
		(value) => value.action !== "settle-candidate",
		"Feedback settlement is Host-only",
	),
});
export const feedbackOverviewRequestSchema = z.strictObject({
	cursor: z.uuid().optional(),
});
export const feedbackCandidateRequestSchema = z.strictObject({ id: z.uuid() });
export const feedbackHistoryRequestSchema = z.strictObject({
	id: z.uuid(),
	afterRevision: z.number().int().nonnegative().optional(),
});
export type ResponsibilityRequest = z.input<typeof responsibilityRequestSchema>;
export type FeedbackWorkflowRequest = z.input<
	typeof feedbackWorkflowRequestSchema
>;
export const reviewRequestSchema = reviewSchema.extend({ commandId: z.uuid() });
export const externalNoticeRequest = workMutation.extend({
	reviewedDigest: hash.optional(),
});
export const externalNoticeResult = z.strictObject({
	id: z.string(),
	state: notificationState,
	text: z.string(),
	targetRef: z.string(),
	label: z.string(),
	digest: hash,
});
export type ExternalNoticeRequest = z.input<typeof externalNoticeRequest>;
export type ExternalNoticeResult = z.output<typeof externalNoticeResult>;
export const groupReviewRequest = workMutation.extend({
	group: groupKeySchema.optional(),
	reviewedDigest: hash.optional(),
	followUpMemberId: workId.optional(),
	cancelFollowUp: z.literal(true).optional(),
});
const groupChoice = z.strictObject({
	group: groupKeySchema,
	title: z.string(),
	rootSessionId: z.string(),
	memberIds: z.tuple([z.string(), z.string()]),
	memberBotIds: z.tuple([z.string(), z.string()]),
});
const groupReviewResult = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("choices"), groups: z.array(groupChoice) }),
	z.strictObject({
		kind: z.literal("preview"),
		choice: groupChoice,
		text: z.string(),
		digest: hash,
		followUpAvailable: z.boolean(),
		followUpMemberId: workId.optional(),
	}),
	z.strictObject({
		kind: z.literal("linked"),
		rootSessionId: z.string(),
		turnId: z.string(),
		followUpState: groupFollowUpGrant.shape.state.optional(),
	}),
	z.strictObject({ kind: z.literal("unknown") }),
]);
export type GroupReviewRequest = z.input<typeof groupReviewRequest>;
export type GroupReviewResult = z.output<typeof groupReviewResult>;
function request<S extends z.ZodType>(name: string, schema: S) {
	const input = codec(name, schema);
	return {
		...owner,
		parameters: [
			{
				name: "input",
				source: "json" as const,
				codec: input,
				strictCodec: input,
			},
		] as const,
	};
}
function mutation<S extends z.ZodType>(name: string, schema: S) {
	return {
		...request(name, schema),
		result: codec("ActionReply", suggestionActionReplySchema),
	};
}

const spec = {
	package: "dsh-bot/proactive",
	methods: {
		"dshBot.proactive/adjustSuggestion": mutation(
			"SuggestionAdjustment",
			suggestionAdjustmentSchema.extend({ commandId: z.uuid() }),
		),
		"dshBot.proactive/forgetSource": {
			...request(
				"ForgetSource",
				beginForgetSchema.extend({ commandId: z.uuid() }),
			),
			result: codec("ForgetReceipt", forgetReceiptSchema),
		},
		"dshBot.proactive/botSuggestions": {
			...request("SuggestionOwner", botKeySchema),
			result: codec("Suggestions", suggestionsSchema),
		},
		"dshBot.proactive/workspaceReview": {
			...request("WorkspaceReviewRequest", workspaceReviewRequest),
			result: codec("WorkspaceReview", workspaceReviewSchema),
		},
		"dshBot.proactive/responsibilities": {
			...request("ResponsibilityOwner", botKeySchema),
			result: codec("Responsibilities", responsibilityListSchema),
		},
		"dshBot.proactive/changeResponsibility": {
			...request("ResponsibilityRequest", responsibilityRequestSchema),
			result: codec("ResponsibilityMutationReply", responsibilityMutationReply),
		},
		"dshBot.proactive/feedbackOverview": {
			...request("FeedbackOverviewRequest", feedbackOverviewRequestSchema),
			result: codec("FeedbackOverview", feedbackWorkflowView),
		},
		"dshBot.proactive/feedbackCandidate": {
			...request("FeedbackCandidateRequest", feedbackCandidateRequestSchema),
			result: codec("FeedbackCandidate", feedbackCandidate.nullable()),
		},
		"dshBot.proactive/feedbackHistory": {
			...request("FeedbackHistoryRequest", feedbackHistoryRequestSchema),
			result: codec(
				"FeedbackHistory",
				z.strictObject({
					rows: z.array(feedbackCandidate).max(100),
					nextRevision: z.number().int().nonnegative().optional(),
				}),
			),
		},
		"dshBot.proactive/feedbackContexts": {
			...request("FeedbackContextsOwner", botKeySchema),
			result: codec("FeedbackContexts", feedbackContextsSchema),
		},
		"dshBot.proactive/feedbackWorkflow": mutation(
			"FeedbackWorkflowRequest",
			feedbackWorkflowRequestSchema,
		),
		"dshBot.proactive/workHistory": {
			...request("WorkHistoryRequest", workHistoryRequestSchema),
			result: codec("WorkHistory", workHistorySchema),
		},
		"dshBot.proactive/listSuggestions": {
			...owner,
			parameters: [],
			result: codec("Suggestions", suggestionsSchema),
		},
		"dshBot.proactive/status": {
			...owner,
			parameters: [],
			result: codec("Status", proactiveStatusSchema),
		},
		"dshBot.proactive/changeSuggestion": mutation(
			"SuggestionRequest",
			suggestionRequestSchema,
		),
		"dshBot.proactive/accept": mutation("AcceptRequest", acceptRequestSchema),
		"dshBot.proactive/cancel": mutation("CancelRequest", cancelRequestSchema),
		"dshBot.proactive/pause": mutation("PauseRequest", pauseRequestSchema),
		"dshBot.proactive/revokeSource": mutation(
			"RevokeSourceRequest",
			revokeSourceRequestSchema,
		),
		"dshBot.proactive/feedback": mutation(
			"FeedbackRequest",
			feedbackRequestSchema,
		),
		"dshBot.proactive/groupReview": {
			...request("GroupReviewRequest", groupReviewRequest),
			result: codec("GroupReviewResult", groupReviewResult),
		},
		"dshBot.proactive/externalNotice": {
			...request("ExternalNoticeRequest", externalNoticeRequest),
			result: codec("ExternalNoticeResult", externalNoticeResult),
		},
		"dshBot.proactive/review": mutation("ReviewRequest", reviewRequestSchema),
		"dshBot.proactive/listWork": {
			...owner,
			parameters: [],
			result: codec("WorkList", workListSchema),
		},
	},
} as const satisfies TypertRemoteSpec;

type Methods = typeof spec.methods;
type Endpoints = {
	[K in keyof Methods]: (
		...args: Params<K>
	) => Promise<
		RemoteResult<z.output<ReturnType<Methods[K]["result"]["create"]>>>
	>;
};
type Args<P extends readonly unknown[]> = {
	-readonly [K in keyof P]: P[K] extends {
		codec: { create: () => infer S extends z.ZodType };
	}
		? z.input<S>
		: never;
};
type Params<K extends keyof Methods> = Args<Methods[K]["parameters"]>;
type Namespace = {
	[K in keyof Endpoints as K extends `dshBot.proactive/${infer M}`
		? M
		: never]: Endpoints[K];
};
declare module "@deepseek-ai/dsh-typert-protocol" {
	interface TypertRemoteMap extends Endpoints {}
	interface TypertRemoteNamespaceMap {
		"dshBot.proactive": Namespace;
	}
}
export const PROACTIVE_REMOTE = createTypertRemoteInfo(spec, z);
export type SuggestionRequest = z.input<typeof suggestionRequestSchema>;
export type SuggestionActionReply = z.output<
	typeof suggestionActionReplySchema
>;
export type AcceptRequest = z.input<typeof acceptRequestSchema>;
export type CancelRequest = z.input<typeof cancelRequestSchema>;
export type ReviewRequest = z.input<typeof reviewRequestSchema>;
export type PauseRequest = z.input<typeof pauseRequestSchema>;
export type FeedbackRequest = z.input<typeof feedbackRequestSchema>;
