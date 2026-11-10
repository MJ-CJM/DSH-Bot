import { z } from "zod";
import { botKeySchema, resourceId } from "../identity.js";

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = revision;
const job = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
export const responsibilityModeSchema = z.enum(["off", "suggest", "auto"]);
export const responsibilityActionSchema = z.enum([
	"inspect-ci-result",
	"repair-fixture",
	"repair-external",
	"repair-workspace",
]);
// Keep this boundary independent from work.ts: work may reference a grant ID.
const responsibilityOwnerTargetSchema = z.strictObject({
	bot: botKeySchema,
	botUpdatedAt: revision,
});
export const responsibilityTargetSchema = responsibilityOwnerTargetSchema.extend({
	provider: resourceId,
	model: z.string().min(1).max(128),
});
const responsibilityPolicyTargetSchema = z.union([
	responsibilityTargetSchema,
	responsibilityOwnerTargetSchema,
]);
export const responsibilitySourceSchema = z.strictObject({
	id: z.string().regex(/^ci:[a-f0-9]{64}$/),
	generation: revision,
	repository: z
		.string()
		.regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
	branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/._-]{0,199}$/),
});
export const responsibilityConditionsSchema = z.strictObject({
	jobs: z.array(job).max(32).default([]),
	excludedJobs: z.array(job).max(32).default([]),
	conclusions: z
		.array(z.enum(["failure", "success", "cancelled"]))
		.min(1)
		.max(3)
		.default(["failure"]),
	minAttempt: z.number().int().min(1).max(1000).default(1),
	maxAgeSeconds: z.number().int().min(60).max(604800).default(86400),
});
export const responsibilityAcceptanceSchema = z
	.strictObject({
		goal: z.string().trim().min(1).max(1000),
		deliverables: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
		checks: z
			.array(
				z.strictObject({
					id: resourceId,
					title: z.string().trim().min(1).max(500),
					kind: z.enum(["tool", "human", "both"]),
				}),
			)
			.min(1)
			.max(20),
	})
	.refine(
		(value) =>
			new Set(value.checks.map((check) => check.id)).size ===
			value.checks.length,
		{
			message: "Acceptance check IDs must be unique",
		},
	);
export const responsibilityLimitsSchema = z.strictObject({
	dailyRequests: z.number().int().min(1).max(1000).default(8),
	dailyTokens: z.number().int().min(1).max(10000000).default(32768),
	taskTokens: z.number().int().min(1).max(1000000).default(4096),
	taskAttempts: z.number().int().min(1).max(20).default(3),
	taskWallTimeMs: z.number().int().min(1000).max(86400000).default(300000),
	concurrency: z.number().int().min(1).max(16).default(1),
});
export const responsibilityDraftSchema = z
	.strictObject({
		name: z.string().trim().min(1).max(120),
		mode: responsibilityModeSchema.default("off"),
		source: responsibilitySourceSchema,
		conditions: responsibilityConditionsSchema,
		action: responsibilityActionSchema,
		actionScopeDigest: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		target: responsibilityPolicyTargetSchema,
		acceptance: responsibilityAcceptanceSchema,
		limits: responsibilityLimitsSchema,
		expiresAt: z.iso.datetime(),
	})
	.refine(
		(value) =>
			value.action === "inspect-ci-result" || !!value.actionScopeDigest,
		{
			message: "Repair actions require an exact approved configuration digest",
		},
	)
	.refine((value) => value.mode !== "auto" || "provider" in value.target, {
		message: "Automatic duties require an approved execution route",
	});
export const responsibilitySchema = responsibilityDraftSchema.safeExtend({
	id: resourceId,
	owner: botKeySchema,
	revision,
	denyEpoch: revision,
	deleted: z.boolean(),
	createdAt: revision,
	updatedAt: revision,
});
const mutationIdentity = {
	id: resourceId,
	owner: botKeySchema,
	expectedRevision: revision,
};
export const responsibilityMutationSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("create"),
		id: resourceId,
		owner: botKeySchema,
		draft: responsibilityDraftSchema,
	}),
	z.strictObject({
		kind: z.literal("update"),
		...mutationIdentity,
		draft: responsibilityDraftSchema,
	}),
	z.strictObject({
		kind: z.literal("mode"),
		...mutationIdentity,
		mode: responsibilityModeSchema,
	}),
	z.strictObject({ kind: z.literal("revoke"), ...mutationIdentity }),
	z.strictObject({ kind: z.literal("remove"), ...mutationIdentity }),
]);
export const responsibilityMutationRequestSchema = z.strictObject({
	commandId: z.uuid(),
	mutation: responsibilityMutationSchema,
});
export const responsibilityMutationResultSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("applied"),
		responsibility: responsibilitySchema,
	}),
	z.strictObject({ kind: z.literal("rejected"), code: z.string() }),
	z.strictObject({ kind: z.literal("unknown") }),
]);
export const responsibilityMatchSchema = z
	.strictObject({
		bot: botKeySchema,
		source: responsibilitySourceSchema,
		action: responsibilityActionSchema,
		actionScopeDigest: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		target: responsibilityPolicyTargetSchema,
		job,
		attempt: z.number().int().positive(),
		conclusion: z.enum(["failure", "success", "cancelled"]),
		observedAt: z.iso.datetime(),
	})
	.refine(
		(value) =>
			value.action === "inspect-ci-result" || !!value.actionScopeDigest,
		{
			message: "Repair actions require an exact approved configuration digest",
		},
	);
export const responsibilityBindingSchema = responsibilityMatchSchema.safeExtend({
	target: responsibilityTargetSchema,
});
export type ResponsibilityMatch = z.output<typeof responsibilityMatchSchema>;
export const responsibilityAdmissionSchema = z.strictObject({
	grantId: resourceId,
	ticketId: resourceId,
	responsibilityId: resourceId,
	expectedRevision: revision,
	binding: responsibilityBindingSchema,
	automatic: z.boolean(),
});
export const responsibilityGrantSchema = z.strictObject({
	id: resourceId,
	ticketId: resourceId,
	responsibilityId: resourceId,
	responsibilityRevision: revision,
	denyEpoch: revision,
	binding: responsibilityBindingSchema,
	acceptance: responsibilityAcceptanceSchema,
	limits: responsibilityLimitsSchema,
	admittedAt: revision,
	expiresAt: z.iso.datetime(),
});
export const responsibilityReservationInputSchema = z.strictObject({
	reservationId: resourceId,
	grantId: resourceId,
	assignmentId: resourceId,
	tokens: z.number().int().min(1).max(10000000),
	requestCount: z.number().int().min(1).max(3).default(1),
});
export const responsibilitySettlementSchema = z.discriminatedUnion("outcome", [
	z.strictObject({
		reservationId: resourceId,
		outcome: z.literal("known"),
		tokens: count,
	}),
	z.strictObject({
		reservationId: resourceId,
		outcome: z.literal("unknown"),
		finished: z.boolean().optional(),
	}),
]);
export const responsibilityUsageSchema = z.strictObject({
	utcDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	resetsAt: z.iso.datetime(),
	requestsUsed: count,
	requestsAvailable: count,
	knownTokens: count,
	reservedTokens: count,
	unknownTokens: count,
	tokensAvailable: count,
	activeTasks: count,
	measurementComplete: z.boolean(),
	clockSkew: z.boolean(),
});
export const responsibilityViewSchema = z.strictObject({
	responsibility: responsibilitySchema,
	usage: responsibilityUsageSchema,
});
export const responsibilityListSchema = z
	.array(responsibilityViewSchema)
	.max(100);

export type Responsibility = z.output<typeof responsibilitySchema>;
export type ResponsibilityDraft = z.output<typeof responsibilityDraftSchema>;
export type ResponsibilityMutation = z.output<
	typeof responsibilityMutationSchema
>;
export type ResponsibilityMutationRequest = z.output<
	typeof responsibilityMutationRequestSchema
>;
export type ResponsibilityMutationResult = z.output<
	typeof responsibilityMutationResultSchema
>;
export type ResponsibilityBinding = z.output<
	typeof responsibilityBindingSchema
>;
export type ResponsibilityAdmission = z.output<
	typeof responsibilityAdmissionSchema
>;
export type ResponsibilityGrant = z.output<typeof responsibilityGrantSchema>;
export type ResponsibilityLimits = z.output<typeof responsibilityLimitsSchema>;
export type ResponsibilityAction = z.output<typeof responsibilityActionSchema>;
export type ResponsibilitySource = z.output<typeof responsibilitySourceSchema>;
export type ResponsibilityTarget = z.output<typeof responsibilityTargetSchema>;
export function hasResponsibilityRoute(target: ResponsibilityDraft["target"]): target is ResponsibilityTarget {
	return "provider" in target;
}
export type ResponsibilityUsage = z.output<typeof responsibilityUsageSchema>;
export type ResponsibilityView = z.output<typeof responsibilityViewSchema>;
export type ResponsibilityReservationInput = z.input<
	typeof responsibilityReservationInputSchema
>;
export type ResponsibilitySettlement = z.output<
	typeof responsibilitySettlementSchema
>;
