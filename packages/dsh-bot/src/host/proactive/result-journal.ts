import type { Context } from "@deepseek-ai/cordis";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { commandBodySchema, type CommandBody, type Reply } from "../../shared/proactive/protocol.js";
import { Serial } from "../common/operations.js";
import { digest } from "./wire.js";

export type PendingResult = Extract<CommandBody, { kind: "report-result" }>;
const report = commandBodySchema.pipe(z.custom<PendingResult>(
	(value): value is PendingResult => typeof value === "object" && value !== null && "kind" in value && value.kind === "report-result",
));
const rowSchema = z.strictObject({
	storeId: z.uuid(), commandId: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
	body: report.optional(), assignmentId: z.string().optional(),
	state: z.enum(["pending", "acknowledged", "rejected"]), stagedAt: z.number().int().nonnegative(),
	rejectionCode: z.enum(["invalid", "forbidden", "conflict", "stale", "unsupported"]).optional(),
	receiptId: z.uuid().optional(), committedSeq: z.number().int().nonnegative().optional(),
}).refine(row => row.state !== "pending" || row.body !== undefined, "Pending results require the original report");
const domainDefinition = defineDomain({
	name: "dsh_bot_proactive_results", version: 1,
	tables: { reports: domainTable(rowSchema) },
});
type JournalRow = z.output<typeof rowSchema>;
type Sender = (commandId: string, body: PendingResult) => Promise<Reply>;

/** Durable delivery spool only. Task truth and execution remain in the core. */
export async function openResultJournal(ctx: Context) {
	const domain = await ctx.storageDomain.open(domainDefinition);
	const table = domain.table("reports");
	const queue = new Serial();
	let closing: Promise<void> | undefined;
	const key = (storeId: string, commandId: string) => `${z.uuid().parse(storeId)}:${z.uuid().parse(commandId)}`;
	const entries = (storeId: string) => [...table.entries()].map(([, row]) => row).filter(row => row.storeId === storeId);
	async function acknowledgeRow(row: JournalRow, reply: Reply) {
		if (reply.kind === "rejected") {
			const { body, ...metadata } = row;
			await table.put(key(row.storeId, row.commandId), {
				...metadata, assignmentId: body?.assignmentId ?? row.assignmentId,
				state: "rejected", rejectionCode: reply.code,
			});
			return "rejected" as const;
		}
		if (reply.kind !== "receipt" || !reply.receipt ||
			!["committed", "duplicate"].includes(reply.receipt.status) || reply.receipt.commandId !== row.commandId)
			return false;
		// Await the storageDomain write before declaring the report drained. Keep
		// the command/digest tombstone so a later conflicting retry is rejected.
		const { body, ...metadata } = row;
		await table.put(key(row.storeId, row.commandId), {
			...metadata, assignmentId: body?.assignmentId ?? row.assignmentId,
			state: "acknowledged", receiptId: reply.receipt.receiptId, committedSeq: reply.receipt.committedSeq,
		});
		return "acknowledged" as const;
	}
	return {
		stage(storeId: string, commandId: string, input: PendingResult) {
			return queue.run(async () => {
				const id = key(storeId, commandId), body = report.parse(input), payloadDigest = digest(body);
				const existing = table.get(id);
				if (existing) {
					if (existing.digest !== payloadDigest || existing.body !== undefined && digest(existing.body) !== payloadDigest)
						throw new Error("Proactive result command conflicts with its durable payload");
					return;
				}
				await table.put(id, { storeId, commandId, digest: payloadDigest, body, assignmentId: body.assignmentId, state: "pending", stagedAt: Date.now() });
			});
		},
		acknowledge(storeId: string, commandId: string, reply: Reply) {
			return queue.run(async () => {
				const row = table.get(key(storeId, commandId));
				if (!row) throw new Error("Proactive result was not staged");
				if (row.state !== "pending") return true;
				return Boolean(await acknowledgeRow(row, reply));
			});
		},
		flush(storeId: string, send: Sender) {
			return queue.run(async () => {
				z.uuid().parse(storeId);
				let acknowledged = 0, rejected = 0;
				for (const row of entries(storeId)) {
					if (row.state !== "pending") continue;
					if (!row.body || digest(row.body) !== row.digest) throw new Error("Proactive result journal integrity mismatch");
					let reply: Reply;
					try { reply = await send(row.commandId, row.body); }
					catch { continue; }
					const result = await acknowledgeRow(row, reply);
					if (result === "acknowledged") acknowledged++;
					if (result === "rejected") rejected++;
				}
				return { acknowledged, rejected, pending: entries(storeId).filter(row => row.state === "pending").length };
			});
		},
		pending(storeId: string) {
			return queue.run(async () => entries(z.uuid().parse(storeId)).filter(row => row.state === "pending").map(row => structuredClone(row)));
		},
		purgeAcknowledged(assignmentIds: readonly string[]) {
			return queue.run(async () => {
				const selected = new Set(assignmentIds);
				let purged = 0;
				for (const [id, row] of table.entries()) {
					if (row.state === "pending" || !row.body || !selected.has(row.body.assignmentId)) continue;
					const { body, ...metadata } = row;
					await table.put(id, { ...metadata, assignmentId: body.assignmentId }); purged++;
				}
				return purged;
			});
		},
		close() {
			closing ??= (async () => { await queue.close(); await domain.close(); })();
			return closing;
		},
	};
}
export type ResultJournal = Awaited<ReturnType<typeof openResultJournal>>;
