import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { openFeedback } from "../coordinator/feedback.js";
import { feedbackDataset, feedbackProposal, type FeedbackCandidate, type FeedbackDataset, type FeedbackProposal } from "../src/shared/proactive/feedback.js";
import { FeedbackApplications } from "../src/host/proactive/feedback.js";
import { FeedbackWorkflow, type FeedbackWorkflowPort } from "../src/host/proactive/feedback-workflow.js";
import type { DshBotRegistry } from "../src/host/registry.js";
import type { Receipt, Reply } from "../src/shared/proactive/protocol.js";
import { feedbackWorkflowRequestSchema } from "../src/shared/proactive/remote-contract.js";
import { workSchema, type ProactiveWork } from "../src/shared/proactive/work.js";
import { digest } from "../src/host/proactive/wire.js";
import { v2Fixture } from "./deepening/v2-fixtures.js";
import { management } from "./deepening/shared-fixtures.js";

const sourceId = `ci:${"a".repeat(64)}`;
const origin = { bot: { botId: "alpha", botCreatedAt: 1 }, taskId: "authoring-task", evidenceDigest: "b".repeat(64) };
const proposal: FeedbackProposal = { kind: "false-positive", origin, reason: "Ignore a known non-blocking documentation check", change: { sourceId, sourceGeneration: 1, job: "docs", attempt: 1, mode: "suppress" } };
const dataset = (): FeedbackDataset => ({
	id: "independent-ci", version: 1, owner: origin.bot, provenance: "Synthetic independently labeled task samples", labelPolicy: "A failed nonblocking docs check is noise", exceptions: [], maxAddedMisses: 0,
	batches: ["first", "second", "third"].map(id => ({ id, rows: [
		{ taskId: `${id}-docs`, sourceId, sourceGeneration: 1, job: "docs", attempt: 1, needed: false, baselineSuggested: true, attentionNeeded: false, baselineNotified: true, labelAgreement: "agreed" as const },
		{ taskId: `${id}-test`, sourceId, sourceGeneration: 1, job: "test", attempt: 1, needed: true, baselineSuggested: true, attentionNeeded: true, baselineNotified: true, labelAgreement: "agreed" as const },
	] })),
});
function fixture() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE pb_source (id TEXT PRIMARY KEY,generation INTEGER); CREATE TABLE pb_source_revocation (id TEXT PRIMARY KEY,generation INTEGER NOT NULL); CREATE TABLE pb_governance_tombstone (kind TEXT NOT NULL,id TEXT NOT NULL)");
	db.prepare("INSERT INTO pb_source VALUES (?,1)").run(sourceId);
	return { db, service: openFeedback(db) };
}
function candidate(service: ReturnType<typeof openFeedback>, value = proposal) {
	service.workflow({ action: "propose-candidate", proposal: value });
	const row = service.candidates()[0];
	if (!row) throw new Error("Missing candidate");
	return row;
}
function adopt(service: ReturnType<typeof openFeedback>, row: FeedbackCandidate) {
	service.workflow({ action: "adopt-candidate", candidateId: row.id, expectedRevision: row.revision, reviewedDigest: row.proposalDigest });
	const saved = service.candidate(row.id);
	if (!saved) throw new Error("Missing adopted candidate");
	return saved;
}
describe("independent feedback workflow", () => {
	test("rework feedback fits the original review contract without truncating the owner text", () => {
		const rework = { kind: "rework", origin, reason: "x".repeat(512), ticketId: "ticket", expectedWorkRevision: 0 };
		expect(feedbackProposal.parse(rework).reason).toBe(rework.reason);
		expect(feedbackProposal.safeParse({ ...rework, reason: "x".repeat(513) }).success).toBe(false);
	});
	test("freezes three batches before proposal, evaluates once and makes adopted visibility reversible", () => {
		const { db, service } = fixture();
		try {
			service.workflow({ action: "import-dataset", dataset: dataset() });
			const row = candidate(service);
			const input = { action: "evaluate-candidate" as const, candidateId: row.id, expectedRevision: row.revision, datasetId: "independent-ci", datasetVersion: 1 };
			service.workflow(input);
			const eligible = service.candidate(row.id);
			expect(eligible?.evaluation?.passed).toBe(true);
			expect(() => service.workflow({ ...input, expectedRevision: 1 })).toThrow();
			if (!eligible) throw new Error("Missing evaluation");
			const adopted = adopt(service, eligible);
			expect(service.visibility({ sourceId, job: "docs", attempt: 1 }, origin.bot)).toBe(true);
			expect(service.visibility({ sourceId, job: "docs", attempt: 1 })).toBeUndefined();
			expect(service.visibility({ sourceId, job: "docs", attempt: 1 }, { botId: "beta", botCreatedAt: 2 })).toBeUndefined();
			expect(service.visibility({ sourceId, job: "docs", attempt: 1 }, { ...origin.bot, botCreatedAt: 2 })).toBeUndefined();
			db.prepare("UPDATE pb_source SET generation=2").run();
			expect(service.visibility({ sourceId, job: "docs", attempt: 1 }, origin.bot)).toBeUndefined();
			service.workflow({ action: "revoke-candidate", candidateId: row.id, expectedRevision: adopted.revision, reviewedDigest: row.proposalDigest });
			expect(service.history(row.id).map(item => item.state)).toEqual(["candidate", "eligible", "adopted", "revoked"]);
		} finally { db.close(); }
	});
	test("rejects datasets imported after proposal and cross-batch leakage", () => {
		const { db, service } = fixture();
		try {
			const row = candidate(service);
			service.workflow({ action: "import-dataset", dataset: dataset() });
			expect(() => service.workflow({ action: "evaluate-candidate", candidateId: row.id, expectedRevision: 0, datasetId: "independent-ci", datasetVersion: 1 })).toThrow();
			const leaking = dataset();
			const first = leaking.batches[0]?.rows[0], second = leaking.batches[1]?.rows[0];
			if (first && second) second.taskId = first.taskId;
			expect(feedbackDataset.safeParse(leaking).success).toBe(false);
		} finally { db.close(); }
	});
	test.each(["regression", "disagreement", "origin-leak"])("cannot adopt %s in held-out evidence", issue => {
		const { db, service } = fixture();
		try {
			const sample = dataset();
			const row = sample.batches[0]?.rows[0];
			if (!row) throw new Error("Missing sample");
			if (issue === "regression") row.needed = true;
			if (issue === "disagreement") row.labelAgreement = "disputed";
			if (issue === "origin-leak") row.taskId = origin.taskId;
			service.workflow({ action: "import-dataset", dataset: sample });
			const proposed = candidate(service);
			const evaluate = () => service.workflow({ action: "evaluate-candidate", candidateId: proposed.id, expectedRevision: 0, datasetId: sample.id, datasetVersion: 1 });
			if (issue === "origin-leak") expect(evaluate).toThrow();
			else { evaluate(); expect(service.candidate(proposed.id)?.state).toBe("rejected"); }
			expect(() => adopt(service, service.candidate(proposed.id) ?? proposed)).toThrow();
		} finally { db.close(); }
	});
	test("cold claims become unknown and permission feedback never grants execution", () => {
		const { db, service } = fixture();
		try {
			const pref = candidate(service, { kind: "preference", origin, reason: "Explicit preference", content: "Use concise summaries" });
			const claim = adopt(service, pref);
			expect(claim.state).toBe("applying");
			const reopened = openFeedback(db);
			expect(reopened.candidate(pref.id)?.state).toBe("unknown");
			expect(() => adopt(reopened, reopened.candidate(pref.id) ?? pref)).toThrow();
			const permission = candidate(service, { kind: "permission", origin, reason: "Review workspace access", setting: "workspace" });
			expect(() => adopt(service, permission)).toThrow();
		} finally { db.close(); }
	});
	test("attention rules mute notifications without hiding suggestions", () => {
		const { db, service } = fixture();
		try {
			service.workflow({ action: "import-dataset", dataset: dataset() });
			const row = candidate(service, { kind: "attention", origin, reason: "Too many notifications", change: { sourceId, sourceGeneration: 1, job: "docs", attempt: 1, mode: "mute" } });
			service.workflow({ action: "evaluate-candidate", candidateId: row.id, expectedRevision: 0, datasetId: "independent-ci", datasetVersion: 1 });
			adopt(service, service.candidate(row.id) ?? row);
			expect(service.muted({ sourceId, job: "docs", attempt: 1 }, origin.bot)).toBe(true);
			expect(service.visibility({ sourceId, job: "docs", attempt: 1 }, origin.bot)).toBeUndefined();
		} finally { db.close(); }
	});
	test("a missed-suggestion rule must improve recall and can restore an explicitly filtered check", () => {
		const { db, service } = fixture();
		try {
			const samples = dataset();
			for (const batch of samples.batches) for (const row of batch.rows) {
				if (row.job === "docs") { row.needed = true; row.baselineSuggested = false; }
			}
			service.workflow({ action: "import-dataset", dataset: samples });
			const row = candidate(service, { kind: "false-negative", origin, reason: "The failed docs build is now required", change: { sourceId, sourceGeneration: 1, job: "docs", attempt: 1, mode: "include" } });
			service.workflow({ action: "evaluate-candidate", candidateId: row.id, expectedRevision: 0, datasetId: samples.id, datasetVersion: samples.version });
			const eligible = service.candidate(row.id);
			if (!eligible) throw new Error("Missing evaluation");
			expect(eligible.evaluation?.passed).toBe(true);
			adopt(service, eligible);
			expect(service.visibility({ sourceId, job: "docs", attempt: 1 }, origin.bot)).toBe(false);
		} finally { db.close(); }
	});
	test("views remain within the IPC budget and pagination does not lose candidates", () => {
		const { db, service } = fixture();
		try {
			for (let i = 0; i < 5; i++) candidate(service, { kind: "skill", origin, reason: `Skill ${i}`, name: `review-${i}`, before: null, beforeHash: null, content: "x".repeat(35000) });
			const seen = new Set<string>();
			let after: string | undefined;
			do {
				const page = service.view(after);
				expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(128 * 1024);
				for (const row of page.candidates) seen.add(row.id);
				after = page.nextCursor;
			} while (after);
			expect(seen.size).toBe(5);
		} finally { db.close(); }
	});
	test("held-out labels cannot be reused by a different Bot generation", () => {
		const { db, service } = fixture();
		try {
			service.workflow({ action: "import-dataset", dataset: { ...dataset(), owner: { ...origin.bot, botCreatedAt: 2 } } });
			const row = candidate(service);
			expect(() => service.workflow({ action: "evaluate-candidate", candidateId: row.id, expectedRevision: 0, datasetId: "independent-ci", datasetVersion: 1 })).toThrow();
		} finally { db.close(); }
	});
	test("source forgetting purges unused candidate and frozen dataset bodies while retaining exact audit hashes", () => {
		const { db, service } = fixture();
		try {
			const imported = dataset();
			const batch = imported.batches[0], sample = batch?.rows[0];
			if (!batch || !sample) throw new Error("Missing first sample");
			batch.rows.push({ ...sample, taskId: "private-label", note: "DATASET_PRIVATE_BODY" });
			service.workflow({ action: "import-dataset", dataset: imported });
			const adopted = candidate(service);
			service.workflow({ action: "evaluate-candidate", candidateId: adopted.id, expectedRevision: 0, datasetId: imported.id, datasetVersion: imported.version });
			const evaluated = service.candidate(adopted.id);
			if (!evaluated) throw new Error("Missing evaluated candidate");
			adopt(service, evaluated);
			const unadopted = candidate(service, { kind: "preference", origin: { ...origin, source: { id: sourceId, generation: 1 } }, reason: "CANDIDATE_PRIVATE_REASON", content: "CANDIDATE_PRIVATE_BODY" });
			const unrelated = candidate(service, { kind: "preference", origin, reason: "Profile preference", content: "Keep independent preference" });
			expect(service.purgeSourceBody(sourceId, 2, [])).toEqual({ candidates: 2, datasets: 1 });
			expect(service.purgeSourceBody(sourceId, 2, [])).toEqual({ candidates: 0, datasets: 0 });
			expect(service.candidate(unadopted.id)?.proposalDigest).toBe(unadopted.proposalDigest);
			expect(service.candidate(unadopted.id)?.bodyPurgedAt).toEqual(expect.any(Number));
			expect(JSON.stringify(service.history(unadopted.id))).not.toContain("CANDIDATE_PRIVATE");
			expect(service.candidate(unrelated.id)?.proposal).toEqual(unrelated.proposal);
			expect(service.candidate(adopted.id)?.state).toBe("adopted");
			expect(service.candidate(adopted.id)?.bodyPurgedAt).toEqual(expect.any(Number));
			expect(service.visibility({ sourceId, sourceGeneration: 1, job: "docs", attempt: 1 }, origin.bot)).toBeUndefined();
			expect(service.datasets()).toEqual([]);
			expect(db.prepare("SELECT digest FROM pb_feedback_dataset_tombstone").get()?.digest).toBe(digest(imported));
			expect(() => service.workflow({ action: "import-dataset", dataset: imported })).toThrow();
			const purged = service.candidate(unadopted.id);
			if (!purged) throw new Error("Missing purged audit");
			expect(() => adopt(service, purged)).toThrow();
		} finally { db.close(); }
	});
});

test("source forgetting preserves independently adopted memory and withdrawal refuses a subsequently edited version", async () => {
	const f = await v2Fixture();
	const { db, service } = fixture();
	const registry = {
		get: async (id: string) => f.bots.get(id), personaSnapshot: () => f.bots.get("alpha").persona,
		manageMemory: async <T>(operation: (memory: ReturnType<typeof management>) => T | Promise<T>) => operation(management(f)),
		invalidate() {},
	};
	const handler = new FeedbackApplications(registry, { request: async () => { throw new Error("Unexpected skill call"); } }, async () => { throw new Error("Unexpected rework"); });
	try {
		const pref = feedbackProposal.parse({
			kind: "preference", origin: { ...origin, source: { id: sourceId, generation: 1 } },
			reason: "Explicit preference", content: "Use concise summaries",
		});
		const row = adopt(service, candidate(service, pref));
		if (!row.operationId) throw new Error("Missing application operation");
		const receipt = await handler.apply(row);
		expect(await handler.apply(row)).toEqual(receipt);
		if (receipt.kind !== "memory") throw new Error("Expected memory");
		service.workflow({ action: "settle-candidate", candidateId: row.id, expectedRevision: row.revision,
			operationId: row.operationId, outcome: "applied", receipt });
		expect(service.purgeSourceBody(sourceId, 2, [])).toEqual({ candidates: 1, datasets: 0 });
		expect(service.candidate(row.id)).toMatchObject({ state: "adopted", application: receipt });
		expect(JSON.stringify(service.history(row.id))).not.toContain("Use concise summaries");
		const saved = management(f).query({ botId: "alpha", scope: "private", view: "all" });
		expect(saved.rows).toHaveLength(1);
		expect(saved.rows[0]?.payload.content).toBe("Use concise summaries");
		await management(f).revise({ id: receipt.memoryId, expectedRevision: saved.revision, patch: { content: "My later independent edit" } });
		await expect(handler.apply({ ...row, state: "revoking", operationId: randomUUID(), application: receipt })).rejects.toThrow("changed after adoption");
		expect(management(f).query({ botId: "alpha", scope: "private", view: "facts" }).rows[0]?.payload.content).toBe("My later independent edit");
	} finally { db.close(); await f.close(); }
});

test("preference withdrawal rejects only its exact adopted memory version", async () => {
	const f = await v2Fixture();
	const registry = { get: async (id: string) => f.bots.get(id), personaSnapshot: () => f.bots.get("alpha").persona,
		manageMemory: async <T>(operation: (memory: ReturnType<typeof management>) => T | Promise<T>) => operation(management(f)), invalidate() {} };
	const handler = new FeedbackApplications(registry, { request: async () => { throw new Error("Unexpected skill"); } }, async () => { throw new Error("Unexpected rework"); });
	const pref = feedbackProposal.parse({ kind: "preference", origin, reason: "Explicit preference", content: "Use concise summaries" });
	const row: FeedbackCandidate = { id: randomUUID(), revision: 1, createdAt: Date.now(), datasetDigests: [], proposal: pref, proposalDigest: digest(pref), state: "applying", operationId: randomUUID() };
	try {
		const applied = await handler.apply(row);
		await handler.apply({ ...row, state: "revoking", application: applied, operationId: randomUUID() });
		expect(management(f).query({ botId: "alpha", scope: "private", view: "facts" }).rows).toHaveLength(0);
		expect(management(f).query({ botId: "alpha", scope: "private", view: "all" }).rows[0]?.state).toBe("rejected");
	} finally { await f.close(); }
});

test("skill adoption and withdrawal use the existing editor's CAS and refuse later user edits", async () => {
	const content = "---\nname: review\ndescription: Review carefully\n---\nRead the diff.";
	let current: { content?: string; hash: string | null } = { hash: null };
	let writes = 0;
	const handler = new FeedbackApplications({ get: async () => ({ createdAt: 1 }) as never,
		personaSnapshot: () => ({ prefix: "" }), manageMemory: async () => { throw new Error("Unexpected memory"); }, invalidate() {} }, {
		request: async request => {
			if (request.action === "skillRead") return { kind: "skill", name: "review", ...current };
			if (request.action === "skillWrite") {
				expect(request.expectedHash).toBe(current.hash); writes++;
				current = { content: request.content, hash: "c".repeat(64) };
				return { kind: "skill", name: "review", ...current };
			}
			if (request.action === "skillRemove") { expect(request.expectedHash).toBe(current.hash); current = { hash: null }; return { kind: "removed" }; }
			throw new Error("Unexpected operation");
		},
	}, async () => { throw new Error("Unexpected rework"); });
	const p = feedbackProposal.parse({ kind: "skill", origin, reason: "Explicit skill", name: "review", before: null, beforeHash: null, content });
	const row: FeedbackCandidate = { id: randomUUID(), revision: 1, createdAt: Date.now(), datasetDigests: [], proposal: p, proposalDigest: digest(p), state: "applying", operationId: randomUUID() };
	const receipt = await handler.apply(row);
	await handler.apply(row);
	expect(writes).toBe(1);
	current = { content: "User edit", hash: "d".repeat(64) };
	await expect(handler.apply({ ...row, state: "revoking", application: receipt, operationId: randomUUID() })).rejects.toThrow("changed after adoption");
	expect(current.content).toBe("User edit");
});

test("Host workflow validates server-issued context, rejects Remote settlements and deduplicates adoption", async () => {
	const f = await v2Fixture(), { db, service } = fixture();
	const receipts = new Map<string, { digest: string; receipt: Receipt }>();
	const work: ProactiveWork[] = [];
	const registry = { get: async (id: string) => f.bots.get(id), personaSnapshot: () => f.bots.get("alpha").persona,
		manageMemory: async <T>(operation: (memory: ReturnType<typeof management>) => T | Promise<T>) => operation(management(f)), invalidate() {} } as unknown as DshBotRegistry;
	const port: FeedbackWorkflowPort = {
		async feedbackRead(input): Promise<Reply> {
			const header = { protocolVersion: 1 as const, correlationId: randomUUID() };
			if (input.kind === "receipt") return { ...header, kind: "receipt", receipt: receipts.get(input.commandId)?.receipt ?? null };
			if (input.kind === "feedback-candidate") return { ...header, kind: "feedback-candidate", candidate: service.candidate(input.id) ?? null };
			if (input.kind === "feedback-overview") return { ...header, kind: "feedback-overview", view: service.view(input.cursor) };
			if (input.kind === "feedback-history") return { ...header, kind: "feedback-history", history: service.historyPage(input.id, input.afterRevision) };
			if (input.kind === "checkpoint") return { ...header, kind: "checkpoint", source: { generation: 1, checkpoint: "fixture" } };
			throw new Error("Unexpected source read");
		},
		async change(id, input) {
			if (input.kind !== "feedback-workflow") throw new Error("Unexpected command");
			const previous = receipts.get(id);
			if (previous) return previous.digest === digest(input) ? { kind: "receipt", receipt: { ...previous.receipt, status: "duplicate" } } : { kind: "rejected", code: "conflict" };
			service.workflow(input.input);
			const receipt: Receipt = { scope: "core", status: "committed", commandId: id, receiptId: randomUUID(), committedSeq: receipts.size + 1, stored: 1 };
			receipts.set(id, { digest: digest(input), receipt });
			return { kind: "receipt", receipt };
		},
		async suggestions() { return []; }, async workList() { return work; }, async status() { throw new Error("Unused status"); },
	};
	let skillCalls = 0, reworkCalls = 0;
	const handler = new FeedbackWorkflow(registry, { request: async () => { skillCalls++; throw new Error("Skill write transport unavailable"); } }, port, async input => {
		reworkCalls++;
		receipts.set(input.operationId, { digest: digest({ kind: "review-work", ...input }), receipt: {
			scope: "core", status: "committed", commandId: input.operationId, receiptId: randomUUID(), committedSeq: receipts.size + 1, stored: 1,
		} });
		return { ticketId: input.ticketId, assignmentId: "replacement-assignment" };
	});
	try {
		const context = (await handler.contexts(origin.bot))[0];
		if (!context) throw new Error("Missing owner context");
		await expect(handler.change(randomUUID(), { action: "propose-candidate", proposal: { kind: "preference", origin, reason: "Bad context", content: "ignore" } })).rejects.toThrow("evidence changed");
		await handler.change(randomUUID(), { action: "propose-candidate", proposal: { kind: "preference", origin: context.origin, reason: "User choice", content: "Use concise summaries" } });
		const row = service.candidates()[0];
		if (!row) throw new Error("Missing candidate");
		const id = randomUUID(), input = { action: "adopt-candidate" as const, candidateId: row.id, expectedRevision: row.revision, reviewedDigest: row.proposalDigest };
		await handler.change(id, input);
		const duplicate = await handler.change(id, input);
		expect(duplicate.kind === "receipt" && duplicate.receipt.status).toBe("duplicate");
		expect(management(f).query({ botId: "alpha", scope: "private", view: "all" }).rows).toHaveLength(1);
		const settle = { action: "settle-candidate" as const, candidateId: row.id, expectedRevision: 0, operationId: randomUUID(), outcome: "unknown" as const };
		expect(feedbackWorkflowRequestSchema.safeParse({ commandId: randomUUID(), input: settle }).success).toBe(false);
		await expect(handler.change(randomUUID(), settle)).rejects.toThrow("Only the Host");
		await handler.change(randomUUID(), { action: "propose-candidate", proposal: { kind: "skill", origin: context.origin, reason: "Review uncertain write", name: "review", before: null, beforeHash: null, content: "Read changes" } });
		const skill = service.candidates()[0];
		if (!skill) throw new Error("Missing skill candidate");
		const uncertainId = randomUUID(), uncertain = { action: "adopt-candidate" as const, candidateId: skill.id, expectedRevision: 0, reviewedDigest: skill.proposalDigest };
		expect(await handler.change(uncertainId, uncertain)).toEqual({ kind: "unknown", commandId: uncertainId });
		expect(await handler.change(uncertainId, uncertain)).toEqual({ kind: "unknown", commandId: uncertainId });
		expect(service.candidate(skill.id)?.state).toBe("unknown");
		expect(skillCalls).toBe(1);
		work.push(workSchema.parse({ ticketId: "original-ticket", assignmentId: "original-assignment", decisionId: "original-decision", triggerId: "original-trigger", sourceId,
			title: "Delivered work", target: { bot: origin.bot, botUpdatedAt: 1, provider: "fixture", model: "fixture" },
			expiresAt: "2099-01-01T00:00:00.000Z", policyVersion: "fixture", revision: 3, generation: 1, state: "delivered", evidenceDigest: "c".repeat(64) }));
		const workContext = (await handler.contexts(origin.bot)).find(row => row.ticket?.id === "original-ticket");
		if (!workContext) throw new Error("Missing delivered context");
		await handler.change(randomUUID(), { action: "propose-candidate", proposal: { kind: "rework", origin: workContext.origin, reason: "Fix the explained outcome", ticketId: "original-ticket", expectedWorkRevision: 3 } });
		const rework = service.candidates()[0];
		if (!rework) throw new Error("Missing rework candidate");
		const reworkId = randomUUID(), reworkInput = { action: "adopt-candidate" as const, candidateId: rework.id, expectedRevision: 0, reviewedDigest: rework.proposalDigest };
		expect((await handler.change(reworkId, reworkInput)).kind).toBe("receipt");
		expect(service.candidate(rework.id)?.state).toBe("adopted");
		await handler.change(reworkId, reworkInput);
		expect(reworkCalls).toBe(1);
	} finally { await handler.close(); db.close(); await f.close(); }
});
