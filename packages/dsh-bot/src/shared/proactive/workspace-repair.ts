import { z } from "zod";

const key = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const workspaceFilePath = z
	.string()
	.min(1)
	.max(240)
	.refine(
		(value) =>
			!value.includes("\\") &&
			!value.includes("\0") &&
			!value.startsWith("/") &&
			!/^[A-Za-z]:/.test(value) &&
			value
				.split("/")
				.every(
					(part) => part && part !== "." && part !== ".." && part !== ".git",
				),
		"Expected a relative, normalized workspace file path",
	);
export const workspaceVerifier = z.strictObject({
	id: key,
	command: z.string().min(1).max(1024),
	args: z.array(z.string().max(2048)).max(64).default([]),
	timeoutMs: z.number().int().min(100).max(300000).default(30000),
	maxOutputBytes: z.number().int().min(1024).max(1048576).default(65536),
});
export const workspaceRepairConfig = z.strictObject({
	id: key,
	title: z.string().trim().min(1).max(160),
	sourceId: z.string().regex(/^ci:[a-f0-9]{64}$/),
	root: z.string().min(1).max(2048),
	files: z
		.array(z.strictObject({ path: workspaceFilePath, editable: z.boolean() }))
		.min(1)
		.max(64)
		.refine(
			(files) =>
				new Set(files.map((file) => file.path)).size === files.length &&
				files.some((file) => file.editable),
		),
	verifier: workspaceVerifier,
	maxFileBytes: z.number().int().min(1).max(262144).default(65536),
	maxTotalBytes: z.number().int().min(1).max(1048576).default(262144),
	maxEdits: z.number().int().min(1).max(32).default(8),
});
export const commandExecutorConfig = z.strictObject({
	id: key,
	label: z.string().trim().min(1).max(160),
	command: z.string().min(1).max(1024),
	args: z.array(z.string().max(2048)).max(64).default([]),
	timeoutMs: z.number().int().min(100).max(300000).default(60000),
	maxOutputBytes: z.number().int().min(1024).max(2097152).default(524288),
});
export const workspaceRepairGrant = z.strictObject({
	workspaceId: key,
	specDigest: hash,
	baselineDigest: hash,
	executor: z.enum(["native", "command"]),
});
export const workspaceManifestEntry = z.strictObject({
	path: workspaceFilePath,
	digest: hash,
	bytes: z.number().int().min(0).max(262144),
	editable: z.boolean(),
});
export const workspaceRepairOffer = workspaceRepairGrant.extend({
	title: z.string(),
	sourceId: z.string(),
	files: z.array(workspaceManifestEntry).max(64),
	verifier: workspaceVerifier,
	executorLabel: z.string(),
});
export const workspaceEdit = z.strictObject({
	path: workspaceFilePath,
	beforeDigest: hash,
	content: z.string().max(262144),
});
export const workspaceEdits = z
	.array(workspaceEdit)
	.min(1)
	.max(32)
	.refine(
		(edits) => new Set(edits.map((edit) => edit.path)).size === edits.length,
	);
export const workspaceCheck = z.strictObject({
	tool: z.literal("dsh-bot/verify-workspace@1"),
	verifierId: key,
	commandDigest: hash,
	inputDigest: hash,
	exitCode: z.number().int().nullable(),
	timedOut: z.boolean(),
	stdoutDigest: hash,
	stderrDigest: hash,
	stdoutPreview: z.string().max(2048),
	stderrPreview: z.string().max(2048),
	outputTruncated: z.boolean(),
});
export const workspaceRepairEvidence = z
	.strictObject({
		version: z.literal(1),
		specDigest: hash,
		baselineDigest: hash,
		artifactDigest: hash,
		manifestDigest: hash,
		diffDigest: hash,
		changedPaths: z.array(workspaceFilePath).min(1).max(32),
		baseline: workspaceCheck,
		verification: workspaceCheck,
	})
	.refine(
		(value) =>
			value.baseline.inputDigest === value.baselineDigest &&
			value.verification.inputDigest === value.artifactDigest,
	);
export const commandCapabilities = z.strictObject({
	version: z.literal(1),
	operation: z.literal("workspace-file-edits"),
	adapterVersion: z.string().min(1).max(100),
	preset: z.literal(false),
	agentOptions: z.literal(false),
	depthLimit: z.literal(false),
	continuation: z.literal(false),
	costReporting: z.enum(["unknown", "reported"]),
});
export const commandCost = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("unknown") }),
	z.strictObject({
		kind: z.literal("reported"),
		units: z.number().finite().nonnegative(),
		unit: z.string().min(1).max(64),
		source: z.literal("executor"),
	}),
]);
export const commandArtifact = z.strictObject({
	version: z.literal(1),
	runId: z.uuid(),
	inputDigest: hash,
	edits: workspaceEdits,
	cost: commandCost,
});
export const commandEvidence = z.strictObject({
	version: z.literal(1),
	executorId: key,
	adapterVersion: z.string().min(1).max(100),
	runId: z.uuid(),
	inputDigest: hash,
	artifactDigest: hash,
	cost: commandCost,
	events: z
		.array(
			z.strictObject({
				seq: z.number().int().positive(),
				state: z.enum([
					"queued",
					"running",
					"completed",
					"failed",
					"cancelled",
					"unknown",
				]),
				at: z.iso.datetime(),
			}),
		)
		.min(1)
		.max(8),
});
export const workspaceReviewRequest = z.strictObject({
	ticketId: z.string().min(1).max(160),
	assignmentId: z.string().min(1).max(160),
	evidenceDigest: hash,
});
export const workspaceReviewSchema = z.strictObject({
	assignmentId: z.string().min(1).max(160),
	evidenceDigest: hash,
	manifests: z.strictObject({
		before: z.array(workspaceManifestEntry).max(64),
		after: z.array(workspaceManifestEntry).max(64),
	}),
	files: z
		.array(
			z.strictObject({
				path: workspaceFilePath,
				editable: z.boolean(),
				before: z.string().max(262144),
				after: z.string().max(262144),
			}),
		)
		.max(64),
	diff: z
		.array(
			z.strictObject({
				path: workspaceFilePath,
				before: z.string().max(262144),
				after: z.string().max(262144),
			}),
		)
		.max(32),
	checks: z.strictObject({
		baseline: workspaceCheck,
		verification: workspaceCheck,
	}),
	logs: z.strictObject({
		baseline: z.strictObject({
			stdout: z.string().max(1048576),
			stderr: z.string().max(1048576),
		}),
		verification: z.strictObject({
			stdout: z.string().max(1048576),
			stderr: z.string().max(1048576),
		}),
	}),
});
export type WorkspaceReviewRequest = z.input<typeof workspaceReviewRequest>;
export type WorkspaceReview = z.output<typeof workspaceReviewSchema>;
export type WorkspaceRepairConfig = z.output<typeof workspaceRepairConfig>;
export type WorkspaceRepairGrant = z.output<typeof workspaceRepairGrant>;
export type WorkspaceRepairEvidence = z.output<typeof workspaceRepairEvidence>;
export type WorkspaceEdit = z.output<typeof workspaceEdit>;
export type WorkspaceCheck = z.output<typeof workspaceCheck>;
export type CommandExecutorConfig = z.output<typeof commandExecutorConfig>;
export type CommandEvidence = z.output<typeof commandEvidence>;
