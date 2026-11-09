import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Storage from "@deepseek-ai/dsh-storage";
import * as storageJson from "@deepseek-ai/dsh-storage-json";
import * as storageDomain from "@deepseek-ai/dsh-storage-domain";
import { expect, test } from "vitest";
import { ProactiveGovernance } from "../src/host/proactive/governance-service.js";
import { openResultJournal, type PendingResult } from "../src/host/proactive/result-journal.js";
import type { BeginForget, ForgetReceipt } from "../src/shared/proactive/governance.js";
import type { CommandBody, Reply } from "../src/shared/proactive/protocol.js";

const body: PendingResult = {
	kind: "report-result", ticketId: "ticket", assignmentId: "assignment", expectedRevision: 2,
	result: { state: "delivered", evidence: { inputId: "input", assistantId: "assistant", turn: 1,
		outputDigest: "a".repeat(64), checks: ["source-match", "turn-completed", "transcript-flushed"] } },
};
function acknowledgement(commandId: string, status: "committed" | "duplicate" = "committed"): Reply {
	return { kind: "receipt", protocolVersion: 1, correlationId: randomUUID(), receipt: {
		scope: "core", status, commandId, receiptId: randomUUID(), committedSeq: 1, stored: 1,
	} };
}
async function fixture() {
	const base = resolve("../../.dsh-dev/proactive-bot"); await mkdir(base, { recursive: true });
	const root = await mkdtemp(join(base, "journal-test-"));
	let ctx: Context;
	async function open() {
		ctx = new Context();
		await ctx.plugin(Storage).await();
		await ctx.plugin(storageJson, { root: join(root, "storage") }).await();
		await ctx.plugin(storageDomain, { backend: "json" }).await();
		return openResultJournal(ctx);
	}
	return { open, snapshot: () => readFile(join(root, "storage/dsh_bot_proactive_results.json"), "utf8"),
		dispose: () => ctx.fiber.dispose(), clean: () => rm(root, { recursive: true, force: true }) };
}

test("staged results survive a new storage service and replay the same command once", async () => {
	const f = await fixture(), storeId = randomUUID(), commandId = randomUUID();
	let journal = await f.open();
	try {
		await journal.stage(storeId, commandId, body);
		await journal.close(); await f.dispose();
		journal = await f.open();
		let calls = 0;
		const result = await journal.flush(storeId, async (id, saved) => {
			calls++; expect(id).toBe(commandId); expect(saved).toEqual(body);
			return acknowledgement(id, "duplicate");
		});
		expect(result).toEqual({ acknowledged: 1, rejected: 0, pending: 0 });
		await journal.flush(storeId, async () => { throw new Error("Acknowledged report must not be replayed"); });
		expect(calls).toBe(1);
		await expect(journal.stage(storeId, commandId, { ...body, expectedRevision: 99 })).rejects.toThrow("conflicts");
	} finally { await journal.close(); await f.dispose(); await f.clean(); }
});

test("lost acknowledgements retain the report while unrelated store and receipt IDs cannot clear it", async () => {
	const f = await fixture(), storeId = randomUUID(), commandId = randomUUID();
	const journal = await f.open();
	try {
		await journal.stage(storeId, commandId, body);
		expect(await journal.flush(randomUUID(), async () => { throw new Error("Different installation"); })).toEqual({ acknowledged: 0, rejected: 0, pending: 0 });
		expect(await journal.flush(storeId, async () => { throw new Error("IPC lost"); })).toEqual({ acknowledged: 0, rejected: 0, pending: 1 });
		expect(await journal.acknowledge(storeId, commandId, acknowledgement(randomUUID()))).toBe(false);
		expect(await journal.pending(storeId)).toHaveLength(1);
		expect(await journal.acknowledge(storeId, commandId, acknowledgement(commandId))).toBe(true);
		expect(await journal.pending(storeId)).toHaveLength(0);
		expect(await f.snapshot()).not.toContain('"body"');
		await expect(journal.stage(storeId, commandId, body)).resolves.toBeUndefined();
	} finally { await journal.close(); await f.dispose(); await f.clean(); }
});

test("source retention cleanup never removes an unacknowledged report", async () => {
	const f = await fixture(), storeId = randomUUID(), commandId = randomUUID();
	const journal = await f.open();
	try {
		await journal.stage(storeId, commandId, body);
		expect(await journal.purgeAcknowledged([body.assignmentId])).toBe(0);
		expect(await journal.pending(storeId)).toHaveLength(1);
		expect(await f.snapshot()).toContain('"body"');
	} finally { await journal.close(); await f.dispose(); await f.clean(); }
});

test("Host forgetting blocks on a lost result acknowledgement, then clears the exact copy after a duplicate receipt", async () => {
	const f = await fixture(), storeId = randomUUID(), commandId = randomUUID();
	const journal = await f.open();
	const request: BeginForget = { operationId: randomUUID(), sourceId: "source", generation: 1 };
	let receipt: ForgetReceipt = {
		...request, phase: "fenced", fencedAt: 1, updatedAt: 1, pendingAssignments: [],
		drainDigests: [], redacted: 0, purgePlans: [], boundaries: [],
	};
	let recover = false;
	const changes: CommandBody["kind"][] = [];
	const port = {
		execution: { idle: async () => {} },
		async reconcileForgetResults(assignments: string[]) {
			const result = await journal.flush(storeId, async (id, saved) => {
				expect(id).toBe(commandId);
				expect(saved).toEqual(body);
				return recover ? acknowledgement(id, "duplicate") : {
					kind: "unknown", commandId: id, protocolVersion: 1, correlationId: randomUUID(),
				};
			}, assignments);
			return result.pending === 0;
		},
		async change(id: string, change: CommandBody) {
			changes.push(change.kind);
			if (change.kind === "forget-block") {
				receipt = { ...receipt, phase: "blocked", blockedReason: change.reason };
			} else if (change.kind === "forget-finish") {
				receipt = { ...receipt, phase: "complete", blockedReason: undefined };
			}
			return acknowledgement(id);
		},
		async read({ kind }: { kind: string }) {
			if (kind === "forget-receipt") return { kind, receipt };
			if (kind === "source-cleanup-scope") return {
				kind, scope: { assignmentIds: [body.assignmentId], notificationOperationIds: [] },
			};
			if (kind === "governance-pending") return { kind, plans: [] };
			throw new Error("Unexpected Host governance read");
		},
	};
	const context = new Context();
	let groupVerified = false;
	context.provide("dshBotGroups", {
		async purgeProactiveCopies(assignments: string[]) {
			expect(assignments).toEqual([body.assignmentId]);
			return groupVerified;
		},
	} as unknown as typeof context.dshBotGroups);
	const governance = new ProactiveGovernance(
		context, port as unknown as ConstructorParameters<typeof ProactiveGovernance>[1], {}, "",
	);
	try {
		const unrelated = { ...body, assignmentId: "another-assignment", result: { state: "denied" } } satisfies PendingResult;
		await journal.stage(storeId, commandId, body);
		await journal.stage(storeId, randomUUID(), unrelated);
		const forgetCommandId = randomUUID();
		expect(await governance.forget(forgetCommandId, request)).toMatchObject({
			phase: "blocked", blockedReason: "result-copy-unknown",
		});
		expect(changes).toEqual(["forget-begin", "forget-block"]);
		expect(await journal.pending(storeId)).toHaveLength(2);

		recover = true;
		expect(await governance.forget(forgetCommandId, request)).toMatchObject({
			phase: "blocked", blockedReason: "group-copy-unknown",
		});
		expect(changes).toEqual(["forget-begin", "forget-block", "forget-begin", "forget-block"]);
		groupVerified = true;
		expect(await governance.forget(forgetCommandId, request)).toMatchObject({ phase: "complete" });
		expect(changes.slice(-2)).toEqual(["forget-begin", "forget-finish"]);
		expect(await journal.pending(storeId)).toMatchObject([{ body: unrelated }]);
		const saved = await f.snapshot();
		const persisted = JSON.parse(saved).tables.reports[`${storeId}:${commandId}`];
		expect(persisted).toMatchObject({ state: "acknowledged", assignmentId: body.assignmentId });
		expect(persisted).not.toHaveProperty("body");
		expect(saved).not.toContain("a".repeat(64));
	} finally { await governance.close(); await context.fiber.dispose(); await journal.close(); await f.dispose(); await f.clean(); }
});

test("definitive rejection leaves a body-free failure tombstone and is never retried as pending", async () => {
	const f = await fixture(), storeId = randomUUID(), commandId = randomUUID();
	let journal = await f.open();
	try {
		await journal.stage(storeId, commandId, body);
		expect(await journal.flush(storeId, async () => ({ kind: "rejected", protocolVersion: 1, correlationId: randomUUID(), code: "stale" }))).toEqual({ acknowledged: 0, rejected: 1, pending: 0 });
		const saved = await f.snapshot();
		expect(saved).toContain('"rejected"');
		expect(saved).toContain('"stale"');
		expect(saved).not.toContain('"body"');
		await journal.close(); await f.dispose(); journal = await f.open();
		await journal.stage(storeId, commandId, body);
		expect(await journal.flush(storeId, async () => { throw new Error("Rejected report replayed"); })).toEqual({ acknowledged: 0, rejected: 0, pending: 0 });
		await expect(journal.stage(storeId, commandId, { ...body, expectedRevision: 3 })).rejects.toThrow("conflicts");
	} finally { await journal.close(); await f.dispose(); await f.clean(); }
});

test("unknown reports remain pending and cannot be erased by a mismatched successful receipt", async () => {
	const f = await fixture(), storeId = randomUUID(), commandId = randomUUID();
	const journal = await f.open();
	try {
		await journal.stage(storeId, commandId, body);
		expect(await journal.acknowledge(storeId, commandId, { kind: "unknown", protocolVersion: 1, correlationId: randomUUID(), commandId })).toBe(false);
		expect(await journal.acknowledge(storeId, commandId, acknowledgement(randomUUID()))).toBe(false);
		expect(await journal.pending(storeId)).toHaveLength(1);
	} finally { await journal.close(); await f.dispose(); await f.clean(); }
});

test("failed durable writes reject staging instead of making a result appear safe to send", async () => {
	const fake = { storageDomain: { open: async () => ({ table: () => ({ get: () => undefined,
		put: async () => { throw new Error("disk full"); }, entries: () => [] }), close: async () => {} }) } };
	const journal = await openResultJournal(fake as unknown as Context);
	try {
		await expect(journal.stage(randomUUID(), randomUUID(), body)).rejects.toThrow("disk full");
	} finally { await journal.close(); }
});

test("close drains an in-flight flush and rejects later staging", async () => {
	const f = await fixture(), storeId = randomUUID(), commandId = randomUUID();
	const journal = await f.open();
	try {
		await journal.stage(storeId, commandId, body);
		let release: (() => void) | undefined;
		const gate = new Promise<void>(accept => { release = accept; });
		let entered: (() => void) | undefined;
		const started = new Promise<void>(accept => { entered = accept; });
		const flush = journal.flush(storeId, async id => { entered?.(); await gate; return acknowledgement(id); });
		await started;
		let closed = false;
		const closing = journal.close().then(() => { closed = true; });
		await Promise.resolve(); expect(closed).toBe(false);
		release?.(); await flush; await closing;
		await expect(journal.stage(storeId, randomUUID(), body)).rejects.toThrow();
	} finally { await f.dispose(); await f.clean(); }
});
