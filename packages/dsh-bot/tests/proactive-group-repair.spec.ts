import type { Context } from "@deepseek-ai/cordis";
import { expect, test, vi } from "vitest";
import { groupRepairGrant } from "../src/shared/proactive/group-repair.js";
import { workSchema } from "../src/shared/proactive/work.js";
import {
	runGroupRepair,
	GroupRepairFailure,
	verifyGroupRepairEvidence,
} from "../src/host/proactive/group-repair.js";

vi.mock("../src/host/proactive/workspace-repair.js", () => ({
	readWorkspaceReview: vi.fn(async () => ({
		manifests: { before: [{ path: "math.cjs", digest: "a".repeat(64) }] },
		files: [
			{
				path: "math.cjs",
				editable: true,
				before: "bad implementation",
				after: "fixed implementation",
			},
		],
		diff: [
			{
				path: "math.cjs",
				before: "bad implementation",
				after: "fixed implementation",
			},
		],
		logs: {
			baseline: { stderr: "failure" },
			verification: { stdout: "test passed" },
		},
	})),
}));

function fixture(mode: "success" | "scope" | "partial" = "success", requestAllowance = 1000) {
	const grant = groupRepairGrant.parse({
		group: { groupId: "group", groupCreatedAt: 1 },
		rootSessionId: "root",
		membershipRevision: 1,
		supervisor: {
			memberId: "leader",
			bot: { botId: "leader-bot", botCreatedAt: 1 },
			botUpdatedAt: 1,
		},
		implementer: {
			memberId: "coder",
			bot: { botId: "coder-bot", botCreatedAt: 1 },
			botUpdatedAt: 1,
		},
		maxCalls: 3,
	});
	const work = workSchema.parse({
		ticketId: "ticket",
		assignmentId: "assignment",
		decisionId: "decision",
		triggerId: "trigger",
		sourceId: `ci:${"a".repeat(64)}`,
		title: "Repair addition",
		target: {
			bot: grant.supervisor.bot,
			botUpdatedAt: 1,
			provider: "fixture",
			model: "fixture",
		},
		expiresAt: "2099-01-01T00:00:00.000Z",
		policyVersion: "v1",
		revision: 2,
		generation: 1,
		state: "sent",
		groupRepair: grant,
		taskLimits: {
			maxAttempts: 3,
			maxTokens: 30000,
			deadlineAt: "2099-01-01T00:00:00.000Z",
		},
	});
	const plan = {
		goal: "Correct addition",
		collaborationReason: "Separate implementation and independent review",
		implementation: "Replace subtraction with addition",
		files: [mode === "scope" ? "outside.cjs" : "math.cjs"],
		checks: ["Addition passes"],
	};
	const calls: Array<{
		turnId: string;
		input: { memberIds: string[]; text: string };
		review: {
			repair: { phase: string; maxTokens: number; outputTokens: number };
			ticketId: string;
			assignmentId: string;
		};
	}> = [];
	const answer = (phase: string) =>
		phase === "plan"
			? plan
			: phase === "implement"
				? {
						edits: [
							{
								path: "math.cjs",
								beforeDigest: "a".repeat(64),
								content: "fixed implementation",
							},
						],
					}
				: {
						verdict: "pass",
						summary: "Independently verified",
						checks: [
							{
								criterion: "Addition passes",
								status: "PASS",
								evidence: "The complete fixed test output passed",
							},
						],
					};
	const cancelled = vi.fn();
	const groups = {
		startProactiveReview: async (
			_group: unknown,
			input: (typeof calls)[number]["input"],
			review: (typeof calls)[number]["review"],
			check: () => Promise<void>,
		) => {
			await check();
			const turnId = `turn-${calls.length}`;
			calls.push({ turnId, input, review });
			return { id: turnId };
		},
		waitForProactiveReview: async () => {},
		proactiveRequestAllowance: (turnId: string) => ({turnId,deliveryId:`${turnId}-delivery`,inputAllowance:requestAllowance-100,outputAllowance:100}),
		view: async () => ({
			group: { rootSessionId: grant.rootSessionId },
			turns: calls.map((call) => ({
				id: call.turnId,
				membershipRevision: grant.membershipRevision,
				orderedMemberIds: call.input.memberIds,
				proactive: { ...call.review, provider: "fixture", model: "fixture" },
				state:
					mode === "partial" && call.review.repair.phase === "implement"
						? "partial"
						: "completed",
			})),
			deliveries: calls.map((call) => ({
				id: `${call.turnId}-delivery`,
				turnId: call.turnId,
				memberId: call.input.memberIds[0],
				bot: call.review.repair.phase === "implement" ? grant.implementer.bot : grant.supervisor.bot,
				botRevision: 1,
				childSessionId: `${call.turnId}-session`,
				childMessageId: `${call.turnId}-input`,
				outputMessageId: `${call.turnId}-output`,
				state:
					mode === "partial" && call.review.repair.phase === "implement"
						? "failed"
						: "completed",
			})),
		}),
		cancelProactiveRepair: cancelled,
	};
	const ctx = {
		get: (name: string) => (name === "dshBotGroups" ? groups : undefined),
		sessionController: {
			inspect: async (id: string) => {
				if (id === grant.rootSessionId) return { events: calls.map(call => ({
					type: "user/message", data: { id: `${call.turnId}-output`, source: {
						kind: "dsh-bot-group", group: grant.group, turnId: call.turnId,
						childSessionId: `${call.turnId}-session`, memberId: call.input.memberIds[0],
					}, content: [{ type: "text", text: JSON.stringify(answer(call.review.repair.phase)) }] },
				})) };
				const call = calls.find((call) => `${call.turnId}-session` === id);
				if (!call) throw new Error("Missing session");
				return {
					meta: { parentSession: grant.rootSessionId },
					events: [
						{
							type: "user/message",
							data: {
								id: `${call.turnId}-input`,
								content: [{ type: "text", text: call.input.text }],
								source: {
									kind: "dsh-bot-group-proactive",
									assignmentId: work.assignmentId,
									ticketId: work.ticketId,
									group: grant.group,
									turnId: call.turnId,
									repairPhase: call.review.repair.phase,
								},
							},
						},
						{
							type: "assistant/message",
							data: {
								turn: 1,
								message: {
									id: `${call.turnId}-assistant`,
									source: { provider: "fixture", model: "fixture" },
									content: [
										{
											type: "text",
											text: JSON.stringify(answer(call.review.repair.phase)),
										},
									],
								},
								usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
							},
						},
						{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
					],
				};
			},
		},
	} as unknown as Context;
	const finish = vi.fn(async () => ({
		version: 1,
		specDigest: "a".repeat(64),
		baselineDigest: "a".repeat(64),
		artifactDigest: "b".repeat(64),
		manifestDigest: "a".repeat(64),
		diffDigest: "a".repeat(64),
		changedPaths: ["math.cjs"],
		baseline: {},
		verification: {},
	}));
	const input = {
		work,
		artifactRoot: "unused",
		outputTokens: 1024,
		signal: AbortSignal.timeout(5000),
		check: vi.fn(async () => {}),
		workspace: {
			promptData: {
				files: [
					{
						path: "math.cjs",
						editable: true,
						beforeDigest: "a".repeat(64),
						content: "bad implementation",
					},
				],
			},
			finish,
		},
	} as unknown as Parameters<typeof runGroupRepair>[1];
	return { ctx, input, calls, finish, cancelled };
}

test("fixed group phases use distinct implementer, exact role source and complete verified artifact for supervisor review", async () => {
	const f = fixture();
	const result = await runGroupRepair(f.ctx, f.input);
	expect(
		f.calls.map((call) => [call.review.repair.phase, call.input.memberIds]),
	).toEqual([
		["plan", ["leader"]],
		["implement", ["coder"]],
		["review", ["leader"]],
	]);
	expect(
		f.calls.every(
			(call, index) =>
				call.review.repair.maxTokens === 30000 - index * 1000 &&
				call.review.repair.outputTokens === 1024,
		),
	).toBe(true);
	expect(f.calls[2]?.input.text).toContain("fixed implementation");
	expect(f.calls[2]?.input.text).toContain("test passed");
	expect(
		result.groupRepairEvidence.stages.every(
			(stage) => stage.assistantId && stage.outputDigest,
		),
	).toBe(true);
	expect(result.groupRepairEvidence.state).toBe("completed");
	expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 60 });
	expect(f.finish).toHaveBeenCalledOnce();
});

test("a supervisor cannot widen the file grant and a partial member failure cannot become completed work", async () => {
	const scope = fixture("scope");
	await expect(runGroupRepair(scope.ctx, scope.input)).rejects.toBeInstanceOf(
		GroupRepairFailure,
	);
	expect(scope.calls).toHaveLength(1);
	expect(scope.finish).not.toHaveBeenCalled();
	const partial = fixture("partial");
	let error: unknown;
	try {
		await runGroupRepair(partial.ctx, partial.input);
	} catch (failure) {
		error = failure;
	}
	expect(error).toBeInstanceOf(GroupRepairFailure);
	if (!(error instanceof GroupRepairFailure))
		throw new Error("Expected group failure");
	expect(error.evidence.state).toBe("failed");
	expect(error.evidence.stages).toHaveLength(2);
	expect(
		partial.calls.some((call) => call.review.repair.phase === "review"),
	).toBe(false);
	expect(partial.finish).not.toHaveBeenCalled();
});

test("owner acceptance rereads native role messages, output hashes and exact edit artifacts", async () => {
	const f = fixture();
	const result = await runGroupRepair(f.ctx, f.input);
	const work = { ...f.input.work, ...result };
	expect(await verifyGroupRepairEvidence(f.ctx, "unused", work)).toBe(true);
	const changedHash = structuredClone(work);
	const firstStage = changedHash.groupRepairEvidence.stages[0];
	if (!firstStage) throw new Error("Missing stage");
	firstStage.outputDigest = "f".repeat(64);
	expect(await verifyGroupRepairEvidence(f.ctx, "unused", changedHash)).toBe(false);
	const changedReview = structuredClone(work);
	if (!changedReview.groupRepairEvidence.review) throw new Error("Missing review");
	changedReview.groupRepairEvidence.review.summary = "Forged review summary";
	expect(await verifyGroupRepairEvidence(f.ctx, "unused", changedReview)).toBe(false);
	const changedDelivery = structuredClone(work);
	const implementation = changedDelivery.groupRepairEvidence.stages[1];
	if (!implementation) throw new Error("Missing implementation");
	implementation.memberId = "leader";
	expect(await verifyGroupRepairEvidence(f.ctx, "unused", changedDelivery)).toBe(false);
	const inspect = f.ctx.sessionController.inspect.bind(f.ctx.sessionController);
	vi.spyOn(f.ctx.sessionController, "inspect").mockImplementation(async id => {
		const value = await inspect(id);
		if (id === "root") {
			return { ...value, events: value.events.map(event => event.type === "user/message"
				? { ...event, data: { ...event.data, content: [{ type: "text" as const, text: "Tampered published output" }] } }
				: event) };
		}
		return value;
	});
	expect(await verifyGroupRepairEvidence(f.ctx, "unused", work)).toBe(false);
});

test("group phases subtract verified native request allowances without recycling reported token usage", async () => {
	const f = fixture("success", 12000);
	await expect(runGroupRepair(f.ctx, f.input)).rejects.toBeInstanceOf(GroupRepairFailure);
	expect(f.calls.map(call => call.review.repair.maxTokens)).toEqual([30000, 18000, 6000]);
	// The fake transport's third allowance exceeds the remaining guard budget;
	// low genuine usage (30 tokens per request) never increases that allowance.
	expect(f.calls[2]?.review.repair.outputTokens).toBe(1024);
});
