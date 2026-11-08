import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Storage from "@deepseek-ai/dsh-storage";
import * as storageJson from "@deepseek-ai/dsh-storage-json";
import * as storageDomain from "@deepseek-ai/dsh-storage-domain";
import { expect, test } from "vitest";
import { openResultJournal, type PendingResult } from "../src/host/proactive/result-journal.js";
import type { Reply } from "../src/shared/proactive/protocol.js";

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
