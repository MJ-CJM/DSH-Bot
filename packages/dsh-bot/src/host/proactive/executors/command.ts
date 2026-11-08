import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import {
	commandArtifact,
	commandCapabilities,
	commandEvidence,
	type CommandEvidence,
	type CommandExecutorConfig,
} from "../../../shared/proactive/workspace-repair.js";
import { digest } from "../wire.js";
import { runManagedCommand } from "../workspace-process.js";

/** Capabilities supplied by this managed-process adapter, not by a native Agent. */
export const commandRunnerCapabilities = {
	version: 1,
	submit: true,
	get: true,
	events: true,
	cancel: true,
	artifacts: true,
	preset: false,
	agentOptions: false,
	depthLimit: false,
	continuation: false,
} as const;

export function createCommandRepairRun(
	ctx: Context,
	input: {
		configuration: CommandExecutorConfig;
		cwd: string;
		task: unknown;
		signal: AbortSignal;
		onStarted(runId: string): Promise<void>;
	},
) {
	const runId = randomUUID(),
		inputDigest = digest(input.task);
	const stop = new AbortController();
	const signal = AbortSignal.any([input.signal, stop.signal]);
	type State = CommandEvidence["events"][number]["state"];
	let state: State = "queued";
	const events: CommandEvidence["events"] = [
		{ seq: 1, state, at: new Date().toISOString() },
	];
	let artifact:
		| {
				edits: ReturnType<typeof commandArtifact.parse>["edits"];
				evidence: CommandEvidence;
		  }
		| undefined;
	const transition = (next: State) => {
		state = next;
		events.push({
			seq: events.length + 1,
			state,
			at: new Date().toISOString(),
		});
	};
	const run = async () => {
		let started = false;
		try {
			const call = (
				request: unknown,
				maxOutputBytes = input.configuration.maxOutputBytes,
			) =>
				runManagedCommand(ctx, {
					...input.configuration,
					cwd: input.cwd,
					stdin: JSON.stringify(request),
					maxOutputBytes,
					signal,
				});
			const negotiation = await call(
				{ version: 1, operation: "capabilities" },
				8192,
			);
			if (
				negotiation.cancelled ||
				negotiation.timedOut ||
				negotiation.exitCode !== 0 ||
				negotiation.outputTruncated
			)
				throw new Error("Command executor capability negotiation failed");
			const capabilities = commandCapabilities.parse(
				JSON.parse(negotiation.stdout),
			);
			signal.throwIfAborted();
			await input.onStarted(runId);
			signal.throwIfAborted();
			started = true;
			transition("running");
			const result = await call({
				version: 1,
				operation: "workspace-file-edits",
				runId,
				inputDigest,
				task: input.task,
			});
			if (
				result.cancelled ||
				result.timedOut ||
				result.exitCode !== 0 ||
				result.outputTruncated
			)
				throw new Error("Command executor did not return complete evidence");
			const parsed = commandArtifact.parse(JSON.parse(result.stdout));
			if (
				parsed.runId !== runId ||
				parsed.inputDigest !== inputDigest ||
				(parsed.cost.kind === "reported" &&
					capabilities.costReporting !== "reported")
			)
				throw new Error(
					"Command executor artifact identity or cost capability mismatch",
				);
			signal.throwIfAborted();
			transition("completed");
			artifact = {
				edits: parsed.edits,
				evidence: commandEvidence.parse({
					version: 1,
					executorId: input.configuration.id,
					adapterVersion: capabilities.adapterVersion,
					runId,
					inputDigest,
					artifactDigest: digest(parsed.edits),
					cost: parsed.cost,
					events,
				}),
			};
			return artifact;
		} catch (error) {
			// A lost output after dispatch cannot prove the command had no effects.
			transition(started ? "unknown" : signal.aborted ? "cancelled" : "failed");
			throw error;
		}
	};
	const done = run();
	return {
		runId,
		done,
		get: () => ({ runId, inputDigest, state }),
		events: () => events.map((event) => ({ ...event })),
		cancel: () =>
			stop.abort(new Error("Owner cancelled the command execution")),
		artifacts: () => {
			if (!artifact || state !== "completed")
				throw new Error("Command artifact is not complete");
			return artifact;
		},
	};
}

export async function runCommandRepair(
	ctx: Context,
	input: Parameters<typeof createCommandRepairRun>[1],
) {
	return createCommandRepairRun(ctx, input).done;
}
