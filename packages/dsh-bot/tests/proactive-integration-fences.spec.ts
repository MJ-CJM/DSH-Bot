import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { observeCiPage } from "../src/host/proactive/sources/ci.js";
import { digest, frame, frames } from "../src/host/proactive/wire.js";
import {
	type CommandBody,
	type RequestBody,
	replySchema,
} from "../src/shared/proactive/protocol.js";
import { responsibilityDraftSchema } from "../src/shared/proactive/responsibility.js";
import type { Suggestion } from "../src/shared/proactive/protocol.js";
import { groupRepairGrant, groupRepairEvidence } from "../src/shared/proactive/group-repair.js";
import { workspaceRepairEvidence } from "../src/shared/proactive/workspace-repair.js";

const owner = { botId: "integration-owner", botCreatedAt: 1 };
const target = {
	bot: owner,
	botUpdatedAt: 1,
	provider: "fixture",
	model: "synthetic",
};
const source = {
	repository: "fixture/fences",
	branch: "main",
	generation: 1,
};

async function fixture(dailyRequests = 8) {
	const dir = await mkdtemp(resolve("../../.dsh-dev/proactive-fences-"));
	const channel = randomBytes(32).toString("hex");
	let child = spawn(
		process.execPath,
		[resolve("lib/proactive-coordinator/main.mjs"), join(dir, "store")],
		{ env: { LANG: "C", DSH_BOT_IPC_KEY: channel }, stdio: ["pipe", "pipe", "ignore"] },
	);
	let output = frames(child.stdout);
	let exited = once(child, "exit");
	async function send(body: RequestBody) {
		const correlationId = randomUUID();
		child.stdin.write(frame({ protocolVersion: 1, channel, correlationId, ...body }));
		const response = replySchema.parse((await output.next()).value);
		expect(response.correlationId).toBe(correlationId);
		return response;
	}
	const installationId = randomUUID();
	const ready = await send({ kind: "hello", installationId, expectedStoreId: null, budget: 20 });
	if (ready.kind !== "hello") throw new Error("Worker did not start");
	const storeId = ready.storeId;
	const submit = (body: CommandBody, commandId = randomUUID()) => send({
		kind: "command",
		command: { storeId, commandId, actorRef: "local-host", payloadDigest: digest(body), body },
	});
	const draft = responsibilityDraftSchema.parse({
		name: "Integration CI duty", mode: "auto",
		source: { ...source, id: `ci:${digest([source.repository, source.branch])}` },
		target, action: "inspect-ci-result", conditions: { jobs: ["test"] },
		acceptance: { goal: "Explain CI", deliverables: ["Explanation"], checks: [{ id: "source", title: "Original CI evidence", kind: "both" }] },
		limits: { dailyRequests, dailyTokens: 8192, taskTokens: 4096, taskAttempts: 3, taskWallTimeMs: 3600000, concurrency: 1 },
		expiresAt: new Date(Date.now() + 3600000).toISOString(),
	});
	expect(await submit({ kind: "responsibility-mutation", input: { kind: "create", id: "integration-duty", owner, draft } })).toMatchObject({ kind: "receipt" });
	expect(await submit(observeCiPage(source, {
		complete: true, before: null, after: "one",
		rows: ["1001", "1002"].map(runId => ({ repository: source.repository, branch: source.branch, runId, job: "test", attempt: 1, conclusion: "failure" as const, commit: "b".repeat(40), observedAt: new Date().toISOString() })),
	}))).toMatchObject({ kind: "receipt" });
	const suggestions = async () => {
		const reply = await send({ kind: "suggestions", storeId, owner });
		if (reply.kind !== "suggestions") throw new Error("Suggestions missing");
		return reply.suggestions;
	};
	const input = (row: Suggestion) => ({ decisionId: row.id, sourceId: row.sourceId, expectedRevision: row.revision, policyVersion: row.policyVersion, target, responsibility: { id: "integration-duty", revision: 0 } });
	const work = async (decisionId: string) => {
		const reply = await send({ kind: "work", storeId, decisionId });
		if (reply.kind !== "work" || !reply.work) throw new Error("Work missing");
		return reply.work;
	};
	return {
		submit, send, storeId, suggestions, input, work,
		async restart() {
			child.kill("SIGKILL"); await exited; await output.return(undefined);
			child = spawn(process.execPath, [resolve("lib/proactive-coordinator/main.mjs"), join(dir, "store")], { env: { LANG: "C", DSH_BOT_IPC_KEY: channel }, stdio: ["pipe", "pipe", "ignore"] });
			output = frames(child.stdout); exited = once(child, "exit");
			expect(await send({ kind: "hello", installationId, expectedStoreId: storeId, budget: 20 })).toMatchObject({ kind: "hello", storeId });
		},
		async usage() {
			const reply = await send({ kind: "responsibilities", storeId, owner });
			if (reply.kind !== "responsibilities" || !reply.rows[0]) throw new Error("Responsibility missing");
			return reply.rows[0].usage;
		},
		async close() {
			child.stdin.end();
			await exited;
			await output.return(undefined);
			await rm(dir, { recursive: true, force: true });
		},
	};
}

test("real worker keeps CI provenance when adjusting a suggestion and requires a new explicit approval", async () => {
	const f = await fixture();
	try {
		const [original] = await f.suggestions();
		if (!original?.context) throw new Error("CI context missing");
		const candidates = await f.send({ kind: "auto-candidates", storeId: f.storeId });
		expect(candidates.kind === "auto-candidates" && candidates.rows.some(row => row.suggestion.id === original.id)).toBe(true);
		const commandId = randomUUID();
		const adjustment = { kind: "adjust-suggestion", decisionId: original.id, expectedRevision: original.revision, title: "Inspect the exact failing test before proposing a repair" } as const;
		expect(await f.submit(adjustment, commandId)).toMatchObject({ kind: "receipt", receipt: { status: "committed" } });
		expect(await f.submit(adjustment, commandId)).toMatchObject({ kind: "receipt", receipt: { status: "duplicate" } });
		const changed = (await f.suggestions()).find(row => row.id === original.id);
		if (!changed) throw new Error("Adjusted suggestion missing");
		expect(changed).toMatchObject({ revision: original.revision + 1, title: adjustment.title, adjusted: true, triggerId: original.triggerId, sourceId: original.sourceId, context: original.context });
		expect(changed.context).toEqual(original.context);
		expect(await f.submit({ kind: "accept-decision", ...f.input(original), approved: true })).toMatchObject({ kind: "rejected", code: "stale" });
		const filtered = await f.send({ kind: "auto-candidates", storeId: f.storeId });
		expect(filtered.kind === "auto-candidates" && filtered.rows.some(row => row.suggestion.id === original.id)).toBe(false);
		expect(await f.submit({ kind: "auto-accept", ...f.input(changed), ruleId: "integration-duty" })).toMatchObject({ kind: "rejected", code: "forbidden" });
		expect(await f.submit({ kind: "accept-decision", ...f.input(changed), approved: true })).toMatchObject({ kind: "receipt" });
		expect(await f.work(changed.id)).toMatchObject({ title: adjustment.title, triggerId: original.triggerId, sourceId: original.sourceId, state: "pending" });
		expect(changed.context?.url).toBe(`https://github.com/${source.repository}/actions/runs/${original.context.runId}`);
		expect((await f.suggestions()).some(row => row.id === original.id)).toBe(false);
	} finally { await f.close(); }
}, 15000);

test.each(["claimed", "sent"] as const)("cancelled %s work releases responsibility concurrency only after a fenced native drain", async state => {
	const f = await fixture();
	try {
		const [first, second] = await f.suggestions();
		if (!first || !second) throw new Error("Two CI observations required");
		expect(await f.submit({ kind: "accept-decision", ...f.input(first), approved: true })).toMatchObject({ kind: "receipt" });
		let work = await f.work(first.id);
		expect(await f.submit({ kind: "dispatch-claim", ticketId: work.ticketId, assignmentId: work.assignmentId, expectedRevision: work.revision, sessionId: randomUUID() })).toMatchObject({ kind: "receipt" });
		work = await f.work(first.id);
		if (state === "sent") {
			expect(await f.submit({ kind: "dispatch-send", ticketId: work.ticketId, assignmentId: work.assignmentId, expectedRevision: work.revision, inputId: "native-input" })).toMatchObject({ kind: "receipt" });
			work = await f.work(first.id);
		}
		expect(await f.usage()).toMatchObject({ activeTasks: 1, requestsUsed: 1, reservedTokens: 4096 });
		expect(await f.submit({ kind: "cancel", ticketId: work.ticketId, expectedRevision: work.revision })).toMatchObject({ kind: "receipt" });
		const cancelled = await f.work(first.id);
		expect(cancelled.state).toBe(state === "sent" ? "unknown" : "cancelled");
		expect(await f.usage()).toMatchObject({ activeTasks: 1 });
		const drain = { kind: "execution-drained", ticketId: work.ticketId, assignmentId: work.assignmentId, expectedRevision: cancelled.revision } as const;
		expect(await f.submit({ ...drain, assignmentId: "foreign-assignment" })).toMatchObject({ kind: "rejected", code: "stale" });
		expect(await f.submit({ ...drain, expectedRevision: work.revision })).toMatchObject({ kind: "rejected", code: "stale" });
		expect(await f.submit({ kind: "accept-decision", ...f.input(second), approved: true })).toMatchObject({ kind: "receipt" });
		const next = await f.work(second.id);
		const nextClaim = { kind: "dispatch-claim", ticketId: next.ticketId, assignmentId: next.assignmentId, expectedRevision: next.revision, sessionId: randomUUID() } as const;
		expect(await f.submit(nextClaim)).toMatchObject({ kind: "rejected", code: "forbidden" });
		const id = randomUUID();
		expect(await f.submit(drain, id)).toMatchObject({ kind: "receipt", receipt: { status: "committed" } });
		expect(await f.submit(drain, id)).toMatchObject({ kind: "receipt", receipt: { status: "duplicate" } });
		expect(await f.work(first.id)).toEqual(cancelled);
		expect(await f.usage()).toMatchObject({ activeTasks: 0, requestsUsed: 1, reservedTokens: 0, unknownTokens: 4096 });
		expect(await f.submit(nextClaim)).toMatchObject({ kind: "receipt" });
		expect(await f.usage()).toMatchObject({ activeTasks: 1, requestsUsed: 2, reservedTokens: 4096, unknownTokens: 4096 });
	} finally { await f.close(); }
}, 15000);

test("posthoc group review cannot bypass the responsibility request budget", async () => {
	const f = await fixture(1);
	try {
		const [first] = await f.suggestions();
		if (!first) throw new Error("CI observation required");
		expect(await f.submit({ kind: "accept-decision", ...f.input(first), approved: true })).toMatchObject({ kind: "receipt" });
		let work = await f.work(first.id);
		const fence = () => ({ ticketId: work.ticketId, assignmentId: work.assignmentId, expectedRevision: work.revision });
		expect(await f.submit({ kind: "dispatch-claim", ...fence(), sessionId: randomUUID() })).toMatchObject({ kind: "receipt" });
		work = await f.work(first.id);
		expect(await f.submit({ kind: "dispatch-send", ...fence(), inputId: "native-input" })).toMatchObject({ kind: "receipt" });
		work = await f.work(first.id);
		expect(await f.submit({ kind: "report-result", ...fence(), result: { state: "delivered", usage: { inputTokens: 50, outputTokens: 10 }, evidence: { inputId: "native-input", assistantId: "native-answer", turn: 1, outputDigest: "c".repeat(64), checks: ["source-match", "turn-completed", "transcript-flushed"] } } })).toMatchObject({ kind: "receipt" });
		work = await f.work(first.id);
		if (!work.evidenceDigest) throw new Error("Evidence missing");
		expect(await f.submit({ kind: "review", ticketId: work.ticketId, expectedRevision: work.revision, evidenceDigest: work.evidenceDigest, review: "accept", approved: true })).toMatchObject({ kind: "receipt" });
		work = await f.work(first.id);
		expect(await f.usage()).toMatchObject({ activeTasks: 0, requestsUsed: 1, knownTokens: 60 });
		expect(await f.submit({ kind: "claim-group-review", ticketId: work.ticketId, expectedRevision: work.revision, group: { groupId: "reviewers", groupCreatedAt: 1 }, digest: "d".repeat(64) })).toMatchObject({ kind: "rejected", code: "forbidden" });
		expect(await f.work(first.id)).toEqual(work);
		expect(await f.usage()).toMatchObject({ activeTasks: 0, requestsUsed: 1, knownTokens: 60 });
	} finally { await f.close(); }
}, 15000);

test("posthoc review and a fresh CI follow-up reserve and settle within the original responsibility grant", async () => {
	const f = await fixture(4);
	try {
		const [first] = await f.suggestions();
		if (!first?.context) throw new Error("CI observation required");
		expect(await f.submit({ kind: "accept-decision", ...f.input(first), approved: true })).toMatchObject({ kind: "receipt" });
		let work = await f.work(first.id);
		const fence = () => ({ ticketId: work.ticketId, assignmentId: work.assignmentId, expectedRevision: work.revision });
		expect(await f.submit({ kind: "dispatch-claim", ...fence(), sessionId: randomUUID() })).toMatchObject({ kind: "receipt" });
		work = await f.work(first.id);
		expect(await f.submit({ kind: "dispatch-send", ...fence(), inputId: "native-input" })).toMatchObject({ kind: "receipt" });
		work = await f.work(first.id);
		expect(await f.submit({ kind: "report-result", ...fence(), result: { state: "delivered", usage: { inputTokens: 50, outputTokens: 10 }, evidence: { inputId: "native-input", assistantId: "native-answer", turn: 1, outputDigest: "c".repeat(64), checks: ["source-match", "turn-completed", "transcript-flushed"] } } })).toMatchObject({ kind: "receipt" });
		work = await f.work(first.id);
		if (!work.evidenceDigest) throw new Error("Evidence missing");
		expect(await f.submit({ kind: "review", ticketId: work.ticketId, expectedRevision: work.revision, evidenceDigest: work.evidenceDigest, review: "accept", approved: true })).toMatchObject({ kind: "receipt" });
		work = await f.work(first.id);
		expect(await f.submit({ kind: "claim-group-review", ticketId: work.ticketId, expectedRevision: work.revision, group: { groupId: "reviewers", groupCreatedAt: 1 }, digest: "d".repeat(64), followUp: { memberId: "reviewer", bot: owner, botRevision: 1, membershipRevision: 1 } })).toMatchObject({ kind: "receipt" });
		work = await f.work(first.id);
		const budget = work.groupReview?.budget;
		if (!budget) throw new Error("Review reservation missing");
		expect(budget).toMatchObject({ reservationId: `${work.assignmentId}:review`, requestCount: 2, totalTokens: 4036, perCallTokens: 2018 });
		expect(await f.usage()).toMatchObject({ requestsUsed: 3, activeTasks: 1, knownTokens: 60, reservedTokens: 4036 });
		expect(await f.submit({ kind: "settle-group-review", ticketId: work.ticketId, expectedRevision: work.revision, digest: "d".repeat(64), turnId: "review-turn" })).toMatchObject({ kind: "receipt" });
		const settlement = { kind: "settle-group-budget", ticketId: work.ticketId, assignmentId: work.assignmentId, reservationId: budget.reservationId, outcome: "known", tokens: 120 } as const;
		expect(await f.submit({ ...settlement, assignmentId: "foreign-assignment" })).toMatchObject({ kind: "rejected", code: "stale" });
		expect(await f.submit({ ...settlement, tokens: 4037 })).toMatchObject({ kind: "rejected", code: "invalid" });
		expect(await f.submit(settlement)).toMatchObject({ kind: "receipt" });
		expect(await f.usage()).toMatchObject({ requestsUsed: 3, activeTasks: 0, knownTokens: 180, reservedTokens: 0 });
		expect(await f.submit(observeCiPage(source, { complete: true, before: "one", after: "two", rows: [{ repository: source.repository, branch: source.branch, runId: first.context.runId, commit: "b".repeat(40), job: "test", attempt: 2, conclusion: "success", observedAt: new Date(Date.now() + 100).toISOString() }] }))).toMatchObject({ kind: "receipt" });
		const candidates = await f.send({ kind: "group-follow-ups", storeId: f.storeId });
		if (candidates.kind !== "group-follow-ups" || !candidates.candidates[0]) throw new Error("Fresh CI follow-up missing");
		const next = candidates.candidates[0];
		expect(next.work.assignmentId).toBe(work.assignmentId);
		expect(await f.submit({ kind: "claim-group-follow-up", ticketId: work.ticketId, expectedRevision: next.work.revision, factId: next.fact.id })).toMatchObject({ kind: "receipt" });
		work = await f.work(first.id);
		const followBudget = work.groupReview?.followUp?.budget;
		if (!followBudget) throw new Error("Follow-up reservation missing");
		expect(followBudget).toMatchObject({ reservationId: `${work.assignmentId}:follow-up`, requestCount: 1, totalTokens: 3916 });
		expect(await f.usage()).toMatchObject({ requestsUsed: 4, activeTasks: 1, knownTokens: 180, reservedTokens: 3916 });
		await f.restart();
		expect(await f.usage()).toMatchObject({ requestsUsed: 4, activeTasks: 0, knownTokens: 180, reservedTokens: 0, unknownTokens: 3916 });
		// A surviving Host's late usage cannot refund a reservation made unknown
		// by coordinator recovery, even though its exact assignment is recognized.
		expect(await f.submit({ kind: "settle-group-budget", ticketId: work.ticketId, assignmentId: work.assignmentId, reservationId: followBudget.reservationId, outcome: "known", tokens: 60 })).toMatchObject({ kind: "receipt" });
		expect(await f.usage()).toMatchObject({ requestsUsed: 4, activeTasks: 0, knownTokens: 180, reservedTokens: 0, unknownTokens: 3916 });
	} finally { await f.close(); }
}, 15000);

test("real worker accepts a three-stage group delivery with a native session-prefixed root ID", async () => {
	const f = await fixture();
	try {
		const [suggestion] = await f.suggestions();
		if (!suggestion) throw new Error("CI observation required");
		const rootSessionId = `session-${randomUUID()}`;
		const grant = groupRepairGrant.parse({
			group: { groupId: `group:${randomUUID()}`, groupCreatedAt: 1 },
			rootSessionId, membershipRevision: 1, maxCalls: 3,
			supervisor: { memberId: "member:supervisor", bot: owner, botUpdatedAt: 1 },
			implementer: { memberId: "member:implementer", bot: { botId: "integration-implementer", botCreatedAt: 2 }, botUpdatedAt: 2 },
		});
		const workspace = { workspaceId: "addition", specDigest: digest("approved-file-scope"), baselineDigest: digest("baseline-files"), executor: "native" as const };
		expect(await f.submit({ kind: "accept-decision", decisionId: suggestion.id, expectedRevision: suggestion.revision, sourceId: suggestion.sourceId, policyVersion: suggestion.policyVersion, target, approved: true, groupRepair: grant, workspaceRepair: workspace })).toMatchObject({ kind: "receipt" });
		let work = await f.work(suggestion.id);
		const fence = () => ({ ticketId: work.ticketId, assignmentId: work.assignmentId, expectedRevision: work.revision });
		expect(await f.submit({ kind: "dispatch-claim", ...fence() })).toMatchObject({ kind: "receipt" });
		work = await f.work(suggestion.id);
		expect(await f.submit({ kind: "dispatch-send", ...fence(), inputId: `group-task:${work.assignmentId}` })).toMatchObject({ kind: "receipt" });
		work = await f.work(suggestion.id);
		const check = { tool: "dsh-bot/verify-workspace@1", verifierId: "addition-test", commandDigest: digest("fixed-verifier"), timedOut: false, stdoutDigest: digest("verifier-output"), stderrDigest: digest(""), stdoutPreview: "2 + 3 = 5", stderrPreview: "", outputTruncated: false };
		const artifactDigest = digest("verified-files");
		// Mirrors the actual Host report contract without importing a machine's
		// journal, artifact files, or captured session identities into this test.
		const workspaceEvidence = workspaceRepairEvidence.parse({
			version: 1, specDigest: workspace.specDigest, baselineDigest: workspace.baselineDigest,
			artifactDigest, manifestDigest: digest("manifest"), diffDigest: digest("diff"), changedPaths: ["math.cjs"],
			baseline: { ...check, inputDigest: workspace.baselineDigest, exitCode: 1 },
			verification: { ...check, inputDigest: artifactDigest, exitCode: 0 },
		});
		const grouped = groupRepairEvidence.parse({
			version: 1, grantDigest: digest(grant), state: "completed",
			stages: ["plan", "implement", "review"].map((phase, index) => ({
				phase, memberId: index === 1 ? grant.implementer.memberId : grant.supervisor.memberId,
				turnId: `turn:${randomUUID()}`, deliveryId: `delivery:${randomUUID()}`, sessionId: randomUUID(),
				inputId: randomUUID(), inputDigest: digest([phase, "input"]), outputId: randomUUID(), assistantId: randomUUID(), outputDigest: digest([phase, "output"]), state: "completed",
			})),
			plan: { goal: "Repair addition", collaborationReason: "Separate implementation and review", implementation: "Replace subtraction with addition", files: ["math.cjs"], checks: ["Addition passes"] },
			review: { verdict: "pass", summary: "Supervisor verified the implementation", checks: [{ criterion: "Addition passes", status: "PASS", evidence: "Baseline failed; fixed verifier returned zero" }] },
		});
		expect(await f.submit({ kind: "report-result", ...fence(), result: { state: "delivered", workspaceEvidence, groupRepairEvidence: grouped } })).toMatchObject({ kind: "receipt", receipt: { status: "committed" } });
		work = await f.work(suggestion.id);
		expect(work.state).toBe("delivered");
		expect(work.sessionId).toBeUndefined();
		expect(work.groupRepair?.rootSessionId).toBe(rootSessionId);
		expect(work.groupRepairEvidence).toEqual(grouped);
		if (!work.evidenceDigest) throw new Error("Group delivery evidence missing");
		expect(await f.submit({ kind: "review", ticketId: work.ticketId, expectedRevision: work.revision, evidenceDigest: work.evidenceDigest, review: "accept", approved: true })).toMatchObject({ kind: "receipt" });
		const accepted = await f.work(suggestion.id);
		expect(accepted.state).toBe("accepted");
		expect(accepted.sessionId).toBeUndefined();
		expect(accepted.groupRepair?.rootSessionId).toBe(rootSessionId);
	} finally { await f.close(); }
}, 15000);
