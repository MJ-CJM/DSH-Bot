import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ProactiveWork } from "../../../shared/proactive/work.js";
import {
	editSchema,
	type FixtureConfig,
} from "../../../shared/proactive/repair.js";

export const loopbackUrl = z
	.string()
	.regex(/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/)
	.refine((value) => URL.canParse(value));
const runId = z
	.string()
	.regex(/^[A-Za-z0-9._-]{1,100}$/)
	.refine((value) => value !== "." && value !== "..");
const units = z.number().int().min(0).max(1000000);
const identity = { runId, inputId: z.uuid() };
const runSchema = z.strictObject({
	...identity,
	state: z.enum(["queued", "running", "failed", "cancelled", "completed"]),
});
const capabilities = z.strictObject({
	version: z.literal(1),
	operation: z.literal("propose-json-repair"),
	submit: z.literal(true),
	get: z.literal(true),
	events: z.literal(true),
	cancel: z.literal(true),
	artifacts: z.literal(true),
	preset: z.literal(false),
	agentOptions: z.literal(false),
	depthLimit: z.literal(false),
	continuation: z.literal(false),
});
const eventsSchema = z.strictObject({
	...identity,
	events: z
		.array(
			z.strictObject({
				seq: z.number().int().positive(),
				state: runSchema.shape.state,
			}),
		)
		.max(32),
});
const artifactSchema = z.strictObject({
	...identity,
	revision: z.literal(1),
	edit: editSchema,
	units,
	unit: z.literal("fixture-operation"),
});
const maxBytes = 16 * 1024;

async function request<T extends z.ZodType>(
	endpoint: string,
	path: string,
	schema: T,
	signal: AbortSignal,
	body?: unknown,
): Promise<z.output<T>> {
	const response = await fetch(`${endpoint}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers:
			body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
		redirect: "error",
	});
	const reader = response.body?.getReader();
	try {
		if (!response.ok || !reader)
			throw new Error("External executor is unavailable");
		const chunks: Buffer[] = [];
		let size = 0;
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > maxBytes)
				throw new Error("External response exceeds the limit");
			chunks.push(Buffer.from(result.value));
		}
		return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} finally {
		await reader?.cancel().catch(() => {});
	}
}

export async function negotiateRepair(endpoint: string, signal: AbortSignal) {
	await request(
		loopbackUrl.parse(endpoint),
		"/v1/capabilities",
		capabilities,
		signal,
	);
}

export async function runExternalRepair(input: {
	endpoint: string;
	inputId: string;
	fixture: FixtureConfig;
	rework?: ProactiveWork["rework"];
	signal: AbortSignal;
	onStarted(runId: string): Promise<void>;
}) {
	const { endpoint, inputId, fixture, signal } = input;
	const submit = await request(endpoint, "/v1/runs", runSchema, signal, {
		inputId,
		operation: "propose-json-repair",
		fixture: {
			initial: fixture.initial,
			field: fixture.field,
			hint: fixture.hint,
		},
		...(input.rework ? { rework: input.rework } : {}),
	});
	if (submit.inputId !== inputId)
		throw new Error("External run identity mismatch");
	const path = `/v1/runs/${submit.runId}`;
	const sameRun = (
		record:
			| z.output<typeof runSchema>
			| z.output<typeof eventsSchema>
			| z.output<typeof artifactSchema>,
	) => {
		if (record.runId !== submit.runId || record.inputId !== inputId)
			throw new Error("External evidence identity mismatch");
		return record;
	};
	let terminal = false;
	try {
		await input.onStarted(submit.runId);
		let run = submit;
		for (;;) {
			if (run.state === "completed") break;
			if (run.state === "failed" || run.state === "cancelled") {
				terminal = true;
				throw new Error("External execution ended without an artifact");
			}
			await delay(200, undefined, { signal });
			run = await request(endpoint, path, runSchema, signal);
			sameRun(run);
		}
		terminal = true;
		const timeline = await request(
			endpoint,
			`${path}/events`,
			eventsSchema,
			signal,
		);
		sameRun(timeline);
		if (
			timeline.events.at(-1)?.state !== "completed" ||
			timeline.events.some(
				(event, index) =>
					event.seq !== index + 1 ||
					(index < timeline.events.length - 1 &&
						!["queued", "running"].includes(event.state)),
			)
		)
			throw new Error("External evidence sequence invalid");
		const artifact = await request(
			endpoint,
			`${path}/artifacts`,
			artifactSchema,
			signal,
		);
		sameRun(artifact);
		return artifact;
	} finally {
		if (!terminal) {
			await request(
				endpoint,
				`${path}/cancel`,
				runSchema,
				AbortSignal.timeout(1000),
				{ inputId },
			)
				.then(sameRun)
				.catch(() => {});
		}
	}
}
