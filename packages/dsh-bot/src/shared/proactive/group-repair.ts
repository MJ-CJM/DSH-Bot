import { z } from "zod";
import { groupKeySchema } from "../groups.js";
import { botKeySchema, resourceId } from "../identity.js";
import { workspaceFilePath } from "./workspace-repair.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const member = z.strictObject({
	memberId: resourceId,
	bot: botKeySchema,
	botUpdatedAt: z.number().int().nonnegative(),
});
export const groupRepairGrant = z
	.strictObject({
		group: groupKeySchema,
		rootSessionId: resourceId,
		membershipRevision: z.number().int().nonnegative(),
		supervisor: member,
		implementer: member,
		maxCalls: z.literal(3),
	})
	.refine(
		(value) =>
			value.supervisor.memberId !== value.implementer.memberId &&
			(value.supervisor.bot.botId !== value.implementer.bot.botId ||
				value.supervisor.bot.botCreatedAt !==
					value.implementer.bot.botCreatedAt),
	);
export const groupRepairOffer = z.strictObject({
	title: z.string().min(1).max(160),
	grant: groupRepairGrant,
});
export const groupRepairPlan = z.strictObject({
	goal: z.string().trim().min(1).max(1000),
	collaborationReason: z.string().trim().min(1).max(1000),
	implementation: z.string().trim().min(1).max(4000),
	files: z
		.array(workspaceFilePath)
		.min(1)
		.max(32)
		.refine((files) => new Set(files).size === files.length),
	checks: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
});
export const groupRepairReview = z
	.strictObject({
		verdict: z.enum(["pass", "fail"]),
		summary: z.string().trim().min(1).max(4000),
		checks: z
			.array(
				z.strictObject({
					criterion: z.string().trim().min(1).max(500),
					status: z.enum(["PASS", "FAIL"]),
					evidence: z.string().trim().min(1).max(2000),
				}),
			)
			.min(1)
			.max(20),
	})
	.refine(
		(review) =>
			review.verdict !== "pass" ||
			review.checks.every((check) => check.status === "PASS"),
	);
export const groupRepairPhase = z.enum(["plan", "implement", "review"]);
export const groupRepairStageEvidence = z.strictObject({
	phase: groupRepairPhase,
	memberId: resourceId,
	turnId: resourceId,
	deliveryId: resourceId.optional(),
	sessionId: resourceId.optional(),
	inputId: resourceId.optional(),
	inputDigest: hash.optional(),
	outputId: resourceId.optional(),
	assistantId: resourceId.optional(),
	outputDigest: hash.optional(),
	state: z.enum(["running", "completed", "failed", "unknown", "cancelled"]),
});
export const groupRepairEvidence = z
	.strictObject({
		version: z.literal(1),
		grantDigest: hash,
		state: z.enum(["completed", "failed", "unknown"]),
		stages: z
			.array(groupRepairStageEvidence)
			.max(3)
			.refine(
				(stages) =>
					new Set(stages.map((stage) => stage.phase)).size === stages.length,
			),
		plan: groupRepairPlan.optional(),
		review: groupRepairReview.optional(),
	})
	.refine(
		(value) =>
			value.state !== "completed" ||
			(value.stages.length === 3 &&
				value.stages.every(
					(stage) =>
						stage.state === "completed" &&
						stage.deliveryId &&
						stage.sessionId &&
						stage.inputId &&
						stage.inputDigest &&
						stage.outputId &&
						stage.assistantId &&
						stage.outputDigest,
				) &&
				value.plan !== undefined &&
				value.review !== undefined),
	);
export type GroupRepairGrant = z.output<typeof groupRepairGrant>;
export type GroupRepairEvidence = z.output<typeof groupRepairEvidence>;
export type GroupRepairPhase = z.output<typeof groupRepairPhase>;
export type GroupRepairPlan = z.output<typeof groupRepairPlan>;
export type GroupRepairReview = z.output<typeof groupRepairReview>;
