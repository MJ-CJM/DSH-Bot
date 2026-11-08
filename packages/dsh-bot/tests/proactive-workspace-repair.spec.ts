import { spawn } from "node:child_process";
import {
	mkdtemp,
	mkdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
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
import { runJsonCommandBridge } from "../src/host/proactive/executors/json-command-bridge.js";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
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
/** Real child processes; only the DSH confinement provider boundary is doubled. */
function host(enforcement: "full" | "partial" = "full") {
	const confine = vi.fn(
		async (argv: string[], policy: { mode: string; workspaceRoot: string }) => {
			expect(policy.mode).toBe("workspace-write");
			expect(policy.workspaceRoot).toContain("workspace-artifacts");
			return {
				argv,
				enforcement,
				denialSignatures: [],
				runnerFailureRules: [],
			};
		},
	);
	const spawnProcess = vi.fn((spec: SubprocessSpawnSpec) => {
		const [command, ...args] = spec.argv;
		if (!command) throw new Error("Missing executable");
		const child = spawn(command, args, {
			cwd: spec.cwd,
			env: Object.fromEntries(
				Object.entries(spec.env ?? {}).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			),
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "",
			stderr = "",
			exited = false;
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const kill = () => {
			child.kill("SIGKILL");
		};
		spec.signal?.addEventListener("abort", kill, { once: true });
		const done = new Promise<{
			exitCode: number | null;
			signal: NodeJS.Signals | null;
		}>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (exitCode, signal) => {
				exited = true;
				spec.signal?.removeEventListener("abort", kill);
				resolve({ exitCode, signal });
			});
		});
		child.stdin.end(
			typeof spec.stdio.stdin === "object" ? spec.stdio.stdin.data : undefined,
		);
		const reader = (stream: "stdout" | "stderr") => ({
			readFrom: () => {
				const text = stream === "stdout" ? stdout : stderr;
				const shape = spec.stdio[stream],
					limit = typeof shape === "object" ? shape.maxBytes : 1000000;
				return {
					text: text.slice(-limit),
					nextOffset: Buffer.byteLength(text),
					lossy: Buffer.byteLength(text) > limit,
				};
			},
		});
		return {
			done,
			collected: { stdout: reader("stdout"), stderr: reader("stderr") },
			terminate: () => {
				if (!exited) kill();
			},
			waitForExit: async () => {
				await done;
				return true;
			},
		};
	});
	const ctx = {
		get: (name: string) =>
			name === "sandbox"
				? { confine }
				: name === "subprocess"
					? {
							resolveExecutable: async (command: string) => command,
							spawn: spawnProcess,
						}
					: undefined,
	} as unknown as Context;
	return { ctx, confine, spawnProcess };
}
const work = (
	assignmentId: string,
	workspaceRepair: Awaited<ReturnType<typeof createWorkspaceRepairOffer>>,
) => ({
	ticketId: "ticket",
	assignmentId,
	title: "Fix addition",
	workspaceRepair,
});

test("native edit proposal and command runner produce matching tested artifacts without writing the source workspace", async () => {
	const f = await fixture(),
		h = host();
	const signal = AbortSignal.timeout(10000);
	const native = work(
		"native-assignment",
		await createWorkspaceRepairOffer(f.config, "native"),
	);
	const proposal = await prepareWorkspaceRepair(
		h.ctx,
		f.artifacts,
		native,
		f.config,
		signal,
	);
	const file = proposal.promptData.files.find(
		(file) => file.path === "math.cjs",
	);
	if (!file) throw new Error("Missing source");
	const nativeEvidence = await proposal.finish([
		{
			path: file.path,
			beforeDigest: file.beforeDigest,
			content: "exports.add = (a, b) => a + b;\n",
		},
	]);
	expect(nativeEvidence.baseline.exitCode).not.toBe(0);
	expect(nativeEvidence.verification.exitCode).toBe(0);
	const adapter = join(f.root, "adapter.cjs");
	await writeFile(
		adapter,
		`let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{const req=JSON.parse(text);if(req.operation==='capabilities'){console.log(JSON.stringify({version:1,operation:'workspace-file-edits',adapterVersion:'test-1',preset:false,agentOptions:false,depthLimit:false,continuation:false,costReporting:'unknown'}));return;}const file=req.task.files.find(f=>f.path==='math.cjs');console.log(JSON.stringify({version:1,runId:req.runId,inputDigest:req.inputDigest,edits:[{path:file.path,beforeDigest:file.beforeDigest,content:file.content.replace('a - b','a + b')}],cost:{kind:'unknown'}}));});`,
	);
	const command = commandExecutorConfig.parse({
		id: "node-json-runner",
		label: "Node fixture",
		command: process.execPath,
		args: [adapter],
	});
	const external = work(
		"command-assignment",
		await createWorkspaceRepairOffer(f.config, "command", command),
	);
	const prepared = await prepareWorkspaceRepair(
		h.ctx,
		f.artifacts,
		external,
		f.config,
		signal,
		command,
	);
	const onStarted = vi.fn(async () => {});
	const running = createCommandRepairRun(h.ctx, {
		configuration: command,
		cwd: prepared.executorCwd,
		task: prepared.promptData,
		signal,
		onStarted,
	});
	const output = await running.done;
	expect(onStarted).toHaveBeenCalledWith(running.runId);
	expect(running.get().state).toBe("completed");
	expect(running.events().map((event) => event.state)).toEqual([
		"queued",
		"running",
		"completed",
	]);
	expect(running.artifacts()).toEqual(output);
	expect(output.evidence.cost).toEqual({ kind: "unknown" });
	const externalEvidence = await prepared.finish(output.edits);
	expect(externalEvidence.artifactDigest).toBe(nativeEvidence.artifactDigest);
	expect(externalEvidence.verification.exitCode).toBe(0);
	const review = await readWorkspaceReview(f.artifacts, {
		...external,
		workspaceEvidence: externalEvidence,
	});
	expect(review.diff).toEqual([
		{
			path: "math.cjs",
			before: "exports.add = (a, b) => a - b;\n",
			after: "exports.add = (a, b) => a + b;\n",
		},
	]);
	expect(review.logs.verification.stdout).toContain("2 + 3 = 5");
	expect(review.files.map((file) => file.path)).toEqual([
		"math.cjs",
		"verify.cjs",
	]);
	const retry = await prepareWorkspaceRepair(
		h.ctx,
		f.artifacts,
		{
			...native,
			assignmentId: "native-rework",
			rework: {
				previousAssignmentId: native.assignmentId,
				previousEvidenceDigest: "a".repeat(64),
				previousWorkspaceEvidence: nativeEvidence,
				feedback: {
					failures: [
						{
							criterion: "Negative inputs",
							actual: "Not covered",
							expected: "Handle negative inputs",
						},
					],
				},
				requestedAt: new Date().toISOString(),
				requestedBy: "owner",
			},
		},
		f.config,
		signal,
	);
	expect(retry.promptData.previousDelivery?.diff[0]?.after).toContain("a + b");
	expect(retry.promptData.rework?.feedback.failures[0]?.expected).toBe(
		"Handle negative inputs",
	);
	expect(await readFile(join(f.source, "math.cjs"), "utf8")).toContain("a - b");
	await writeFile(
		join(
			f.artifacts,
			"workspace-artifacts",
			external.assignmentId,
			"after",
			"math.cjs",
		),
		"tampered",
	);
	await expect(
		readWorkspaceReview(f.artifacts, {
			...external,
			workspaceEvidence: externalEvidence,
		}),
	).rejects.toThrow(/changed/);
}, 15000);

test("snapshot and edit fences reject source drift, symbolic links, noneditable tests, stale hashes and path traversal", async () => {
	const f = await fixture(),
		h = host(),
		signal = AbortSignal.timeout(10000);
	const approved = await createWorkspaceRepairOffer(f.config, "native");
	await writeFile(join(f.source, "math.cjs"), "exports.add = () => 99;\n");
	await expect(
		prepareWorkspaceRepair(
			h.ctx,
			f.artifacts,
			work("stale", approved),
			f.config,
			signal,
		),
	).rejects.toThrow(/changed since approval/);
	expect(h.spawnProcess).not.toHaveBeenCalled();
	await rm(join(f.source, "math.cjs"));
	await symlink(join(f.source, "verify.cjs"), join(f.source, "math.cjs"));
	await expect(
		createWorkspaceRepairOffer(f.config, "native"),
	).rejects.toThrow();
	await rm(join(f.source, "math.cjs"));
	await writeFile(
		join(f.source, "math.cjs"),
		"exports.add = (a, b) => a - b;\n",
	);
	const prepared = await prepareWorkspaceRepair(
		h.ctx,
		f.artifacts,
		work("edits", await createWorkspaceRepairOffer(f.config, "native")),
		f.config,
		signal,
	);
	const file = prepared.promptData.files.find(
		(file) => file.path === "verify.cjs",
	);
	if (!file) throw new Error("Missing verifier");
	await expect(
		prepared.finish([
			{
				path: file.path,
				beforeDigest: file.beforeDigest,
				content: "process.exit(0)",
			},
		]),
	).rejects.toThrow(/outside/);
	await expect(
		prepared.finish([
			{ path: "math.cjs", beforeDigest: "0".repeat(64), content: "x" },
		]),
	).rejects.toThrow(/outside/);
	await expect(
		prepared.finish([
			{ path: "../escape", beforeDigest: "0".repeat(64), content: "x" },
		]),
	).rejects.toThrow();
});

test("missing complete native confinement fails before a verifier process is started", async () => {
	const f = await fixture(),
		h = host("partial");
	await expect(
		prepareWorkspaceRepair(
			h.ctx,
			f.artifacts,
			work("partial", await createWorkspaceRepairOffer(f.config, "native")),
			f.config,
			AbortSignal.timeout(5000),
		),
	).rejects.toThrow(/Complete native/);
	expect(h.spawnProcess).not.toHaveBeenCalled();
});

test("a command adapter with wrong identity never provides artifacts; cancellation remains unknown after dispatch", async () => {
	const f = await fixture(),
		h = host();
	const adapter = join(f.root, "bad-adapter.cjs");
	const prefix = `let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{const req=JSON.parse(text);if(req.operation==='capabilities'){console.log(JSON.stringify({version:1,operation:'workspace-file-edits',adapterVersion:'test-1',preset:false,agentOptions:false,depthLimit:false,continuation:false,costReporting:'unknown'}));return;}`;
	await writeFile(
		adapter,
		`${prefix}console.log(JSON.stringify({version:1,runId:'00000000-0000-4000-8000-000000000000',inputDigest:req.inputDigest,edits:[{path:'math.cjs',beforeDigest:'a'.repeat(64),content:'bad'}],cost:{kind:'unknown'}}));});`,
	);
	const configuration = commandExecutorConfig.parse({
		id: "bad-adapter",
		label: "Test",
		command: process.execPath,
		args: [adapter],
	});
	const prepared = await prepareWorkspaceRepair(
		h.ctx,
		f.artifacts,
		work(
			"bad",
			await createWorkspaceRepairOffer(f.config, "command", configuration),
		),
		f.config,
		AbortSignal.timeout(5000),
		configuration,
	);
	const bad = createCommandRepairRun(h.ctx, {
		configuration,
		cwd: prepared.executorCwd,
		task: prepared.promptData,
		signal: AbortSignal.timeout(5000),
		onStarted: async () => {},
	});
	await expect(bad.done).rejects.toThrow(/identity/);
	expect(bad.get().state).toBe("unknown");
	expect(() => bad.artifacts()).toThrow();
	await writeFile(adapter, `${prefix}setInterval(()=>{},1000);});`);
	let stop!: () => void;
	const running = createCommandRepairRun(h.ctx, {
		configuration,
		cwd: prepared.executorCwd,
		task: prepared.promptData,
		signal: AbortSignal.timeout(5000),
		onStarted: async () => {
			setTimeout(() => stop(), 50);
		},
	});
	stop = running.cancel;
	await expect(running.done).rejects.toThrow();
	expect(running.get().state).toBe("unknown");
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
