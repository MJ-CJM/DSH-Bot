import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { expect, test, vi } from "vitest";
import { DirectExecution } from "../src/host/proactive/execution.js";
import type { ProactiveService } from "../src/host/proactive/service.js";
import { workSchema } from "../src/shared/proactive/work.js";
import { Groups } from "../src/host/groups/service.js";

vi.mock("@deepseek-ai/dsh-sandbox-policy", () => ({ setSandboxMode: vi.fn() }));
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

test("cancel drains claimed pre-create work, waits native disposal, and never certifies an ambiguous create", async () => {
	const base = resolve("../../.dsh-dev/proactive-bot");
	await mkdir(base, { recursive: true });
	const root = await mkdtemp(resolve(base, "unit-drain-"));
	try {
		for (const mode of ["before-create", "owned", "unknown-create"] as const) {
			const entered = deferred<void>(), release = deferred<void>(), disposal = deferred<void>();
			const work = workSchema.parse({ ticketId: `ticket-${mode}`, assignmentId: `assignment-${mode}`, decisionId: "decision", triggerId: "trigger", sourceId: `ci:${"a".repeat(64)}`, title: "Bounded inspection", target: { bot: { botId: "bot", botCreatedAt: 1 }, botUpdatedAt: 1, provider: "fixture", model: "fixture" }, expiresAt: "2099-01-01T00:00:00.000Z", policyVersion: "v1", revision: 1, generation: 1, state: "pending" });
			const dispose = vi.fn(async () => { entered.resolve(); await disposal.promise; });
			const create = vi.fn(async () => {
				entered.resolve(); await release.promise;
				if (mode === "unknown-create") throw new Error("Lost create receipt");
				return { dispose, agent: { id: "session", session: {}, cancel: vi.fn(), whenIdle: async () => {} } };
			});
			const ctx = { agents: { create }, dshBots: { config: { presetIdPrefix: "bot:" } }, tools: { schemas: () => [] }, logger: { warn: vi.fn() } } as unknown as Context;
			const submit = vi.fn(async () => ({ kind: "receipt", receipt: { status: "committed" } }));
			const service = {
				executionTimeoutMs: 10000, modelOutputTokens: 1024,
				validateTarget: async () => ({ id: "bot" }),
				verifyDispatch: async () => {},
				read: async () => { if (mode === "before-create") { entered.resolve(); await release.promise; } return { kind: "work", work: { ...work, revision: 2, state: "claimed" } }; },
				submit,
			} as unknown as ProactiveService;
			const execution = new DirectExecution(ctx, service, root);
			execution.enqueue(work);
			await entered.promise;
			expect(await execution.cancelAndDrain(work.ticketId, "wrong-assignment")).toBe(false);
			let settled = false;
			const draining = execution.cancelAndDrain(work.ticketId, work.assignmentId).then(value => { settled = true; return value; });
			release.resolve();
			if (mode === "owned") {
				await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
				expect(settled).toBe(false);
				disposal.resolve();
			}
			expect(await draining).toBe(mode !== "unknown-create");
			// A coordinator cancellation receipt can arrive after active removal.
			expect(await execution.cancelAndDrain(work.ticketId, work.assignmentId)).toBe(mode !== "unknown-create");
			expect(await execution.cancelAndDrain(work.ticketId, "different-assignment")).toBe(false);
			if (mode === "before-create") expect(create).not.toHaveBeenCalled();
			if (mode === "unknown-create")
				expect(submit).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ kind: "report-result", result: { state: "unknown" } }), expect.any(Function));
			await execution.close();
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a verifier with unconfirmed process exit remains unknown and cannot be drained", async () => {
	const base = resolve("../../.dsh-dev/proactive-bot");
	await mkdir(base, { recursive: true });
	const root = await mkdtemp(resolve(base, "unit-verifier-drain-"));
	try {
		const work = workSchema.parse({
			ticketId: "ticket", assignmentId: "assignment", decisionId: "decision", triggerId: "trigger",
			sourceId: `ci:${"a".repeat(64)}`, title: "Bounded repair",
			target: { bot: { botId: "bot", botCreatedAt: 1 }, botUpdatedAt: 1, provider: "fixture", model: "fixture" },
			repair: { fixtureId: "fixture", specDigest: "a".repeat(64), executor: "native" },
			expiresAt: "2099-01-01T00:00:00.000Z", policyVersion: "v1", revision: 1, generation: 1, state: "pending",
		});
		const spawned = deferred<AbortSignal>();
		const terminate = vi.fn(), waitForExit = vi.fn(async () => false);
		const ctx = {
			get: () => ({
				resolveExecutable: async () => process.execPath,
				spawn: ({ signal }: { signal: AbortSignal }) => {
					const done = new Promise<never>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
					spawned.resolve(signal);
					return { done, terminate, waitForExit };
				},
			}),
			logger: { warn: vi.fn() },
		} as unknown as Context;
		const submit = vi.fn(async () => ({ kind: "receipt", receipt: { status: "committed" } }));
		const verifyDispatch = vi.fn(async () => {});
		const service = {
			executionTimeoutMs: 10000, modelOutputTokens: 1024, verifyDispatch, submit,
			validateTarget: async () => ({ id: "bot" }),
			read: async () => ({ kind: "work", work: { ...work, revision: 2, state: "claimed" } }),
			repairConfiguration: () => ({ node: process.execPath, fixture: { initial: { enabled: false }, field: "enabled", expected: true } }),
		} as unknown as ProactiveService;
		const execution = new DirectExecution(ctx, service, root);
		execution.enqueue(work);
		const signal = await spawned.promise;
		execution.cancelSource("unrelated-source");
		expect(signal.aborted).toBe(false);
		execution.cancelSource(work.sourceId);
		expect(signal.aborted).toBe(true);
		await execution.idle();
		expect(verifyDispatch).toHaveBeenLastCalledWith(expect.objectContaining({ assignmentId: work.assignmentId }), expect.objectContaining({ dispatchRevision: 2 }));
		expect(terminate).toHaveBeenCalledOnce();
		expect(waitForExit).toHaveBeenCalledOnce();
		expect(submit).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ kind: "report-result", result: { state: "unknown" } }), expect.any(Function));
		expect(await execution.cancelAndDrain(work.ticketId, work.assignmentId)).toBe(false);
		await execution.close();
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("group drain awaits only the assignment's owned turns and requires observed cleanup instead of terminal state", async () => {
	const completion = deferred<void>();
	const proof = new Map<string, boolean>();
	const cancel = vi.fn();
	const turns = new Map([
		["turn", { id: "turn", proactive: { assignmentId: "owned", repair: { phase: "plan" } } }],
		["other", { id: "other", proactive: { assignmentId: "unrelated", repair: { phase: "plan" } } }],
	]);
	const groups = { state: {
		table: () => turns,
		chains: new Map([["turn", completion.promise], ["other", new Promise<void>(() => {})]]),
		deliveries: (id: string) => [{ id: `${id}-delivery`, state: "cancelled" }],
		proactiveDrains: proof,
	}, cancelProactiveRepair: cancel } as unknown as Groups;
	let settled = false;
	const draining = Groups.prototype.drainProactiveRepair.call(groups, "owned").then(value => { settled = true; return value; });
	await Promise.resolve();
	expect(settled).toBe(false);
	expect(cancel).toHaveBeenCalledWith("owned");
	completion.resolve();
	expect(await draining).toBe(false);
	proof.set("turn-delivery", false);
	expect(await Groups.prototype.drainProactiveRepair.call(groups, "owned")).toBe(false);
	proof.set("turn-delivery", true);
	expect(await Groups.prototype.drainProactiveRepair.call(groups, "owned")).toBe(true);
});
