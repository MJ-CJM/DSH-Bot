import { z } from "zod";

const key = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const scalar = z.union([
	z.boolean(),
	z.number().int().min(-10000).max(10000),
	z.string().max(96),
]);
export const fixtureConfig = z
	.strictObject({
		id: key,
		sourceId: z.string().regex(/^ci:[a-f0-9]{64}$/),
		title: z.string().min(1).max(96),
		initial: z
			.record(key, scalar)
			.refine((value) => Object.keys(value).length <= 12),
		field: key,
		expected: scalar,
		hint: z.string().min(1).max(256),
	})
	.refine(
		(value) =>
			Object.hasOwn(value.initial, value.field) &&
			value.initial[value.field] !== value.expected,
	);

export const repairGrant = z.strictObject({
	fixtureId: key,
	specDigest: sha256,
	executor: z.enum(["native", "external"]),
});
export const repairOffer = repairGrant.extend({
	title: z.string().max(96),
	sourceId: z.string(),
});
export const editSchema = z.strictObject({ field: key, value: scalar });
export const checkSchema = z.strictObject({
	tool: z.literal("dsh-bot/verify-json-fixture@1"),
	exitCode: z.union([z.literal(0), z.literal(1)]),
	inputDigest: sha256,
});
export const repairEvidence = z
	.strictObject({
		specDigest: sha256,
		edit: editSchema,
		baseline: checkSchema.extend({ exitCode: z.literal(1) }),
		verification: checkSchema,
		artifactDigest: sha256,
	})
	.refine(
		(evidence) => evidence.verification.inputDigest === evidence.artifactDigest,
	);
export const externalEvidence = z.strictObject({
	runId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
	inputId: z.uuid(),
	outputDigest: sha256,
	units: z.number().int().nonnegative().max(1000000),
	unit: z.literal("fixture-operation"),
});
export type RepairGrant = z.output<typeof repairGrant>;
export type RepairEvidence = z.output<typeof repairEvidence>;
export type FixtureConfig = z.output<typeof fixtureConfig>;
