import { createHash, randomUUID } from "node:crypto";
import {
	mkdtemp,
	mkdir,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, test, vi } from "vitest";
import {
	commandExecutorConfig,
	workspaceRepairConfig,
} from "../src/shared/proactive/workspace-repair.js";
import {
	createWorkspaceRepairOffer,
	prepareWorkspaceRepair,
	readWorkspaceReview,
} from "../src/host/proactive/workspace-repair.js";
import { createCommandRepairRun } from "../src/host/proactive/executors/command.js";
import { runManagedCommand } from "../src/host/proactive/workspace-process.js";
import { runJsonCommandBridge } from "../src/host/proactive/executors/json-command-bridge.js";
import { Readable } from "node:stream";
import { digest } from "../src/host/proactive/wire.js";
import {
	assertModelBudget,
	observedModelUsage,
} from "../src/host/proactive/model-budget.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(resolve("../../.dsh-dev/proactive-workspace-"));
	roots.push(root);
	const source = join(root, "source"),
		artifacts = join(root, "artifacts");
	await mkdir(source);
	await mkdir(artifacts);
	await writeFile(join(source, "math.cjs"), "exports.add = (a, b) => a - b;\n");
	await writeFile(
		join(source, "verify.cjs"),
		"const assert = require('node:assert/strict'); const { add } = require('./math.cjs'); assert.equal(add(2, 3), 5); console.log('2 + 3 = 5');\n",
	);
	const config = workspaceRepairConfig.parse({
		id: "addition",
		title: "Fix addition",
		sourceId: `ci:${"a".repeat(64)}`,
		root: source,
		files: [
			{ path: "math.cjs", editable: true },
			{ path: "verify.cjs", editable: false },
		],
		verifier: {
			id: "add-test",
			command: process.execPath,
			args: ["verify.cjs"],
		},
	});
	return { root, source, artifacts, config };
}
test("native and command workspace execution fail closed before preparing or spawning", async () => {
	const f = await fixture();
	const spawn = vi.fn(), confine = vi.fn(), resolveExecutable = vi.fn();
	const ctx = {
		get: (name: string) => name === "sandbox" ? { confine } : { spawn, resolveExecutable },
	} as unknown as Context;
	const gate = { beforeSpawn: vi.fn(async () => {}), processActive: vi.fn() };
	const configuration = commandExecutorConfig.parse({
		id: "runner",
		label: "Command fixture",
		command: process.execPath,
		args: ["verify.cjs"],
	});
	const signal = AbortSignal.timeout(5000);
	for (const executor of ["native", "command"] as const) {
		const workspaceRepair = await createWorkspaceRepairOffer(f.config, executor, configuration);
		await expect(prepareWorkspaceRepair(
			ctx, f.artifacts, { ticketId: "ticket", assignmentId: executor, title: f.config.title, workspaceRepair },
			f.config, signal, gate, configuration,
		)).rejects.toThrow(/file-read and network isolation/);
	}
	await expect(runManagedCommand(ctx, {
		...f.config.verifier, cwd: f.source, signal, gate,
	})).rejects.toThrow(/file-read and network isolation/);
	const onStarted = vi.fn(async () => {});
	const command = createCommandRepairRun(ctx, {
		configuration, cwd: f.source, task: {}, signal, gate, onStarted,
	});
	await expect(command.done).rejects.toThrow(/file-read and network isolation/);
	expect(command.get().state).toBe("failed");
	expect(onStarted).not.toHaveBeenCalled();
	expect(resolveExecutable).not.toHaveBeenCalled();
	expect(confine).not.toHaveBeenCalled();
	expect(spawn).not.toHaveBeenCalled();
	expect(gate.beforeSpawn).not.toHaveBeenCalled();
	expect(await readdir(f.artifacts)).toEqual([]);
});

test("historical workspace evidence remains readable as data and rejects tampering", async () => {
	const f = await fixture();
	const sha = (text: string) => createHash("sha256").update(text).digest("hex");
	const workspaceRepair = await createWorkspaceRepairOffer(f.config, "native");
	const assignmentId = "prior-workspace";
	const directory = join(f.artifacts, "workspace-artifacts", assignmentId);
	const path = "math.cjs";
	const before = "exports.add = (a, b) => a - b;\n";
	const after = "exports.add = (a, b) => a + b;\n";
	const manifest = (text: string) => [{ path, editable: true, digest: sha(text), bytes: Buffer.byteLength(text) }];
	const manifests = { before: manifest(before), after: manifest(after) };
	const diff = [{ path, before, after }];
	for (const phase of ["before", "after"] as const) {
		await mkdir(join(directory, phase), { recursive: true });
		await writeFile(join(directory, phase, path), phase === "before" ? before : after);
	}
	await writeFile(join(directory, "manifest.json"), JSON.stringify(manifests));
	await writeFile(join(directory, "diff.json"), JSON.stringify(diff));
	const baselineDigest = digest(manifests.before), artifactDigest = digest(manifests.after);
	const log = "trusted historical test output";
	for (const phase of ["baseline", "verification"]) {
		await writeFile(join(directory, `${phase}.stdout.txt`), log);
		await writeFile(join(directory, `${phase}.stderr.txt`), "");
	}
	const check = (inputDigest: string, exitCode: number) => ({
		tool: "dsh-bot/verify-workspace@1" as const, verifierId: "test", commandDigest: sha("argv"),
		inputDigest, exitCode, timedOut: false, stdoutDigest: sha(log), stderrDigest: sha(""),
		stdoutPreview: log, stderrPreview: "", outputTruncated: false,
	});
	const work = {
		ticketId: "ticket", assignmentId, title: f.config.title, workspaceRepair,
		workspaceEvidence: {
			version: 1 as const, specDigest: workspaceRepair.specDigest,
			baselineDigest, artifactDigest, manifestDigest: sha(JSON.stringify(manifests)), diffDigest: sha(JSON.stringify(diff)),
			changedPaths: [path], baseline: check(baselineDigest, 1), verification: check(artifactDigest, 0),
		},
	};
	const review = await readWorkspaceReview(f.artifacts, work);
	expect(review.diff).toEqual(diff);
	expect(review.logs.verification.stdout).toBe(log);
	await writeFile(join(directory, "after", path), "tampered");
	await expect(readWorkspaceReview(f.artifacts, work)).rejects.toThrow(/changed/);
});

test("workspace snapshots reject symbolic links", async () => {
	const f = await fixture();
	await rm(join(f.source, "math.cjs"));
	await symlink(join(f.source, "verify.cjs"), join(f.source, "math.cjs"));
	await expect(createWorkspaceRepairOffer(f.config, "native")).rejects.toThrow();
});

test("budget checks account for complete request text and observed cache usage", () => {
	const options = {
		provider: "fixture",
		model: "fixture",
		messages: [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: "hello" }],
			},
		],
		maxTokens: 100,
	};
	expect(assertModelBudget(options, 2000).outputAllowance).toBe(100);
	expect(
		assertModelBudget(
			{ ...options, toolHistory: { tools: [], updates: [] } },
			2000,
		).outputAllowance,
	).toBe(100);
	expect(() =>
		assertModelBudget({ ...options, system: "x".repeat(3000) }, 2000),
	).toThrow(/allowance/);
	expect(
		observedModelUsage({
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 20,
			cacheWriteTokens: 7,
			totalTokens: 42,
		}),
	).toEqual({ inputTokens: 37, outputTokens: 5 });
	expect(observedModelUsage(undefined)).toBeUndefined();
	expect(
		observedModelUsage({
			inputTokens: 10,
			outputTokens: 5,
			reasoningTokens: 6,
		}),
	).toBeUndefined();
	expect(
		observedModelUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 99 }),
	).toBeUndefined();
});

test("JSON CLI bridge binds exact run identity, bounds output and terminates an actual CLI on cancellation", async () => {
	const f = await fixture();
	const cli = join(f.root, "json-cli.cjs");
	await writeFile(
		cli,
		`let s=''; process.stdin.on('data', x=>s+=x); process.stdin.on('end',()=>{const {task}=JSON.parse(s);console.log(JSON.stringify({edits:[{path:'math.cjs',beforeDigest:task.hash,content:'exports.add=(a,b)=>a+b;'}]}))});`,
	);
	const config = {
		argv: [process.execPath, cli],
		timeoutMs: 2000,
		maxOutputBytes: 1024,
	};
	const task = { hash: "a".repeat(64) },
		runId = randomUUID();
	const input = {
		version: 1,
		operation: "workspace-file-edits",
		runId,
		inputDigest: digest(task),
		task,
	};
	const stream = (value: unknown) => Readable.from([JSON.stringify(value)]);
	expect(
		await runJsonCommandBridge(
			config,
			stream({ version: 1, operation: "capabilities" }),
			AbortSignal.timeout(5000),
		),
	).toMatchObject({ costReporting: "unknown", continuation: false });
	expect(
		await runJsonCommandBridge(
			config,
			stream(input),
			AbortSignal.timeout(5000),
		),
	).toMatchObject({
		runId,
		inputDigest: input.inputDigest,
		cost: { kind: "unknown" },
		edits: [{ path: "math.cjs" }],
	});
	await expect(
		runJsonCommandBridge(
			config,
			stream({ ...input, inputDigest: "b".repeat(64) }),
			AbortSignal.timeout(5000),
		),
	).rejects.toThrow(/identity/);
	await writeFile(cli, "console.log('x'.repeat(2000))");
	await expect(
		runJsonCommandBridge(config, stream(input), AbortSignal.timeout(5000)),
	).rejects.toThrow(/exceeds/);
	await writeFile(cli, "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)");
	const stop = new AbortController();
	const pending = runJsonCommandBridge(config, stream(input), stop.signal);
	setTimeout(() => stop.abort(new Error("Cancelled CLI")), 150);
	await expect(pending).rejects.toThrow(/Cancelled CLI/);
});
