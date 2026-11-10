import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { expect, test } from "vitest";
import { digest, frame, frames } from "../src/host/proactive/wire.js";
import {
	type CommandBody,
	type RequestBody,
	replySchema,
} from "../src/shared/proactive/protocol.js";

const executable = resolve("lib/proactive-coordinator/main.mjs");
function worker(dir: string) {
	const channel = randomBytes(32).toString("hex");
	const child = spawn(process.execPath, [executable, dir], {
		env: { LANG: "C", DSH_BOT_IPC_KEY: channel },
		stdio: ["pipe", "pipe", "ignore"],
	});
	const out = frames(child.stdout);
	const exited = once(child, "exit");
	async function send(body: RequestBody, patch: Record<string, unknown> = {}) {
		const correlationId = randomUUID();
		child.stdin.write(
			frame({ protocolVersion: 1, correlationId, channel, ...body, ...patch }),
		);
		const reply = replySchema.parse((await out.next()).value);
		expect(reply.correlationId).toBe(correlationId);
		return reply;
	}
	return {
		send,
		async kill() {
			child.kill("SIGKILL");
			await exited;
			await out.return(undefined);
		},
		async stop() {
			child.stdin.end();
			await exited;
			await out.return(undefined);
		},
	};
}
const event = {
	nativeId: "job-1",
	nativeRevision: "1",
	threadId: "repo-main",
	occurredAt: "2026-11-07T10:00:00.000Z",
	summary: "synthetic failed check",
};
const first = {
	kind: "ingest-batch",
	sourceId: "ci-fixture",
	generation: 1,
	expectedCheckpoint: null,
	nextCheckpoint: "one",
	events: [event],
} satisfies CommandBody;

test("packaged SQLite worker rejects unauthenticated and malformed requests, commits once, and reconciles after reopening", async () => {
	const scratch = await mkdtemp(resolve("../../.dsh-dev/proactive-ipa-"));
	const root = join(scratch, "store");
	let child = worker(root);
	const installationId = randomUUID();
	const hello = {
		kind: "hello",
		installationId,
		expectedStoreId: null,
	} as const;
	try {
		expect(await child.send(hello, { channel: "0".repeat(64) })).toMatchObject({
			kind: "rejected",
			code: "forbidden",
		});
		expect(await child.send(hello, { protocolVersion: 2 })).toMatchObject({
			kind: "rejected",
			code: "invalid",
		});
		expect(await child.send(hello, { surprise: 1 })).toMatchObject({
			kind: "rejected",
			code: "invalid",
		});
		const ready = await child.send(hello);
		if (ready.kind !== "hello") throw new Error("Coordinator startup failed");
		const { storeId } = ready;
		const commandId = randomUUID();
		const command = (body: CommandBody, id = commandId) =>
			({
				kind: "command",
				command: {
					storeId,
					commandId: id,
					actorRef: "local-host",
					body,
					payloadDigest: digest(body),
				},
			}) as const;
		const committed = await child.send(command(first));
		expect(committed).toMatchObject({
			kind: "receipt",
			receipt: { stored: 1, committedSeq: 1, status: "committed" },
		});
		expect(await child.send(command(first))).toMatchObject({
			kind: "receipt",
			receipt: { stored: 1, committedSeq: 1, status: "duplicate" },
		});
		expect(
			await child.send(command({ ...first, nextCheckpoint: "changed" })),
		).toMatchObject({ kind: "rejected", code: "conflict" });
		expect(
			await child.send(
				command(
					{
						...first,
						expectedCheckpoint: "one",
						events: [
							{ ...event, nativeId: "job-2" },
							{ ...event, summary: "conflict" },
						],
					},
					randomUUID(),
				),
			),
		).toMatchObject({ kind: "rejected", code: "conflict" });
		expect(await child.send({ kind: "snapshot", storeId })).toMatchObject({
			kind: "snapshot",
			snapshot: { triggerCount: 1, ticketCount: 0, committedSeq: 1 },
		});
		const rival = worker(root);
		try {
			expect(
				await rival.send({ ...hello, expectedStoreId: storeId }),
			).toMatchObject({ kind: "rejected" });
		} finally {
			await rival.stop();
		}
		expect(await child.send({ kind: "shutdown", storeId })).toMatchObject({
			kind: "shutdown",
		});
		await child.stop();
		child = worker(root);
		expect(
			await child.send({
				...hello,
				installationId: randomUUID(),
				expectedStoreId: storeId,
			}),
		).toMatchObject({ kind: "rejected", code: "forbidden" });
		expect(
			await child.send({ ...hello, expectedStoreId: storeId }),
		).toMatchObject({ kind: "hello", storeId });
		const receipt = await child.send({ kind: "receipt", storeId, commandId });
		if (receipt.kind !== "receipt" || committed.kind !== "receipt")
			throw new Error("Missing command receipt");
		expect(receipt.receipt).toEqual(committed.receipt);
		expect(
			await child.send(
				command(
					{ ...first, expectedCheckpoint: "one", events: [event] },
					randomUUID(),
				),
			),
		).toMatchObject({
			kind: "receipt",
			receipt: { stored: 0, committedSeq: 2 },
		});
	} finally {
		await child.stop();
		await rm(scratch, { recursive: true, force: true });
	}
}, 15000);

test("read-only CI observations reject foreign scope and supersede stale failures after a successful rerun", async () => {
	const { observeCiPage } = await import("../src/host/proactive/sources/ci.js");
	const repo = { repository: "test/sample", branch: "main", generation: 1 };
	const row = {
		repository: repo.repository,
		branch: repo.branch,
		runId: "404",
		job: "test",
		commit: "a".repeat(40),
		observedAt: new Date().toISOString(),
		attempt: 1,
		conclusion: "failure",
	} as const;
	const page = {
		complete: true,
		before: null,
		after: "a",
		rows: [row],
	} as const;
	expect(() =>
		observeCiPage(repo, {
			...page,
			rows: [{ ...row, repository: "test/other" }],
		}),
	).toThrow(/scope/);
	expect(() =>
		observeCiPage(repo, { ...page, rows: [{ ...row, job: "<instruction>" }] }),
	).toThrow();
	const first = observeCiPage(repo, { ...page, rows: [row] });
	const root = await mkdtemp(resolve("../../.dsh-dev/proactive-ci-"));
	const child = worker(join(root, "store"));
	try {
		const hello = await child.send({
			kind: "hello",
			installationId: randomUUID(),
			expectedStoreId: null,
		});
		if (hello.kind !== "hello") throw new Error("Missing CI coordinator");
		const { storeId } = hello;
		const submit = (body: CommandBody) =>
			child.send({
				kind: "command",
				command: {
					storeId,
					commandId: randomUUID(),
					actorRef: "local-host",
					body,
					payloadDigest: digest(body),
				},
			});
		expect(await submit(first)).toMatchObject({
			kind: "receipt",
			receipt: { stored: 1 },
		});
		expect(await child.send({ kind: "suggestions", storeId })).toMatchObject({
			kind: "suggestions",
			suggestions: [{ scope: "inspect-ci-result" }],
		});
		expect(
			await submit(
				observeCiPage(repo, { ...page, before: "a", after: "b", rows: [row] }),
			),
		).toMatchObject({ kind: "receipt", receipt: { stored: 0 } });
		const success = observeCiPage(repo, {
			...page,
			before: "b",
			after: "c",
			rows: [{ ...row, attempt: 2, conclusion: "success" }],
		});
		expect(await submit(success)).toMatchObject({
			kind: "receipt",
			receipt: { stored: 1 },
		});
		const late = observeCiPage(repo, {
			...page,
			before: "c",
			after: "d",
			rows: [{ ...row, observedAt: new Date(Date.now() + 2000).toISOString() }],
		});
		expect(await submit(late)).toMatchObject({
			kind: "receipt",
			receipt: { stored: 1 },
		});
		expect(await child.send({ kind: "snapshot", storeId })).toMatchObject({
			kind: "snapshot",
			snapshot: { suggestionCount: 0, ticketCount: 0 },
		});
		expect(await child.send({ kind: "suggestions", storeId })).toMatchObject({
			kind: "suggestions",
			suggestions: [],
		});
	} finally {
		await child.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 15000);

test("durable work fences duplicate admission, lost launch, quota, revocation, and old evidence", async () => {
	const dir = await mkdtemp(resolve("../../.dsh-dev/proactive-work-"));
	let child = worker(join(dir, "store"));
	const installationId = randomUUID();
	const hello = {
		kind: "hello",
		installationId,
		expectedStoreId: null,
		budget: 2,
		notice: true,
	} as const;
	const scope = { repository: "fixture/demo", branch: "main", generation: 1 };
	const target = {
		bot: { botId: "fixture-ci", botCreatedAt: 1 },
		botUpdatedAt: 1,
		provider: "local",
		model: "synthetic",
	};
	try {
		const ready = await child.send(hello);
		if (ready.kind !== "hello") throw new Error("Coordinator failed");
		const { storeId } = ready;
		const submit = (body: CommandBody, commandId = randomUUID()) =>
			child.send({
				kind: "command",
				command: {
					storeId,
					commandId,
					actorRef: "local-host",
					body,
					payloadDigest: digest(body),
				},
			});
		const read = async (decisionId: string) => {
			const response = await child.send({ kind: "work", storeId, decisionId });
			if (response.kind !== "work" || !response.work)
				throw new Error("Work receipt missing");
			return response.work;
		};
		const observedAt = new Date().toISOString();
		const { observeCiPage } = await import(
			"../src/host/proactive/sources/ci.js"
		);
		expect(
			await submit(
				observeCiPage(scope, {
					complete: true,
					before: null,
					after: "1",
					rows: [1, 2, 3].map((i) => ({
						repository: scope.repository,
						branch: scope.branch,
						runId: String(i),
						job: "tests",
						observedAt,
						commit: "b".repeat(40),
						attempt: 1,
						conclusion: "failure",
					})),
				}),
			),
		).toMatchObject({ kind: "receipt" });
		const result = await child.send({ kind: "suggestions", storeId });
		if (result.kind !== "suggestions") throw new Error("Missing suggestions");
		const [a, b, c] = result.suggestions;
		if (!a || !b || !c) throw new Error("Unexpected fixture");
		const input = (row: typeof a) => ({
			decisionId: row.id,
			sourceId: row.sourceId,
			expectedRevision: row.revision,
			policyVersion: row.policyVersion,
			target,
		});
		const accept = (row: typeof a) =>
			({ kind: "accept-decision", ...input(row), approved: true }) as const;
		expect(
			await submit({
				kind: "auto-accept",
				...input(a),
				ruleId: "unconfigured",
			}),
		).toMatchObject({ kind: "rejected", code: "forbidden" });
		const ownerCommand = randomUUID();
		expect(await submit(accept(a), ownerCommand)).toMatchObject({
			kind: "receipt",
			receipt: { status: "committed" },
		});
		expect(await submit(accept(a), ownerCommand)).toMatchObject({
			kind: "receipt",
			receipt: { status: "duplicate" },
		});
		expect(await submit(accept(a))).toMatchObject({
			kind: "rejected",
			code: "conflict",
		});
		const workA = await read(a.id);
		const fence = (row: typeof workA) => ({
			ticketId: row.ticketId,
			assignmentId: row.assignmentId,
			expectedRevision: row.revision,
		});
		expect(
			await submit({
				...fence(workA),
				kind: "dispatch-claim",
				sessionId: randomUUID(),
			}),
		).toMatchObject({ kind: "receipt" });
		await child.kill();
		child = worker(join(dir, "store"));
		const autoRule = {
			id: "fixture-auto",
			sourceId: a.sourceId,
			sourceGeneration: 1,
			target,
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		};
		expect(
			await child.send({
				...hello,
				expectedStoreId: storeId,
				autoRule,
			}),
		).toMatchObject({ kind: "hello", storeId });
		expect(await read(a.id)).toMatchObject({
			state: "unknown",
			assignmentId: workA.assignmentId,
		});
		expect(
			await submit({
				kind: "auto-accept",
				...input(b),
				ruleId: "fixture-auto",
				target: { ...target, botUpdatedAt: 2 },
			}),
		).toMatchObject({ kind: "rejected", code: "forbidden" });
		expect(
			await submit({
				kind: "auto-accept",
				...input(b),
				ruleId: "fixture-auto",
			}),
		).toMatchObject({ kind: "receipt" });
		const workB = await read(b.id);
		expect(
			await submit({
				...fence(workB),
				kind: "dispatch-claim",
				sessionId: randomUUID(),
			}),
		).toMatchObject({ kind: "receipt" });
		expect(
			await submit({
				...fence(await read(b.id)),
				kind: "dispatch-send",
				inputId: "message-1",
			}),
		).toMatchObject({ kind: "receipt" });
		const delivery = {
			state: "delivered",
			evidence: {
				inputId: "message-1",
				assistantId: "assistant-1",
				turn: 1,
				outputDigest: "c".repeat(64),
				checks: ["source-match", "turn-completed", "transcript-flushed"] as [
					"source-match",
					"turn-completed",
					"transcript-flushed",
				],
			},
		} as const;
		const sent = await read(b.id);
		expect(
			await child.send({
				kind: "dispatch-permitted",
				storeId,
				assignmentId: sent.assignmentId,
			}),
		).toMatchObject({ permitted: true });
		expect(
			await submit({
				...fence(sent),
				assignmentId: workA.assignmentId,
				kind: "report-result",
				result: delivery,
			}),
		).toMatchObject({ kind: "rejected", code: "stale" });
		expect(
			await submit({ ...fence(sent), kind: "report-result", result: delivery }),
		).toMatchObject({ kind: "receipt" });
		const delivered = await read(b.id);
		expect(delivered.state).toBe("delivered");
		const notice = delivered.notice;
		if (!notice || !delivered.evidenceDigest)
			throw new Error("Delivery linkage missing");
		expect(
			await submit({
				kind: "claim-notice",
				assignmentId: delivered.assignmentId,
				operationId: notice.operationId,
			}),
		).toMatchObject({ kind: "receipt" });
		await child.kill();
		child = worker(join(dir, "store"));
		expect(
			await child.send({ ...hello, expectedStoreId: storeId, autoRule }),
		).toMatchObject({ kind: "hello" });
		expect(await read(b.id)).toMatchObject({
			notice: { operationId: notice.operationId, state: "unknown" },
		});
		expect(
			await submit({
				kind: "claim-notice",
				assignmentId: delivered.assignmentId,
				operationId: notice.operationId,
			}),
		).toMatchObject({ kind: "rejected", code: "conflict" });
		const review = {
			kind: "review",
			ticketId: delivered.ticketId,
			expectedRevision: delivered.revision,
			review: "accept",
			approved: true,
		} as const;
		expect(
			await submit({ ...review, evidenceDigest: "0".repeat(64) }),
		).toMatchObject({ kind: "rejected", code: "stale" });
		expect(
			await submit({ ...review, evidenceDigest: delivered.evidenceDigest }),
		).toMatchObject({ kind: "receipt" });
		const accepted = await read(b.id);
		const noticePermit = {
			kind: "dispatch-permitted",
			storeId,
			assignmentId: accepted.assignmentId,
			noticeRevision: accepted.revision,
		} as const;
		expect(await child.send(noticePermit)).toMatchObject({ permitted: true });
		expect(
			await child.send({ ...noticePermit, noticeRevision: delivered.revision }),
		).toMatchObject({ permitted: false });
		expect(await submit(accept(c))).toMatchObject({ kind: "receipt" });
		const workC = await read(c.id);
		expect(
			await submit({
				...fence(workC),
				kind: "dispatch-claim",
				sessionId: randomUUID(),
			}),
		).toMatchObject({ kind: "rejected", code: "forbidden" });
		expect(
			await submit({
				kind: "pause-execution",
				paused: true,
				expectedRevision: 0,
			}),
		).toMatchObject({ kind: "receipt" });
		expect(await read(c.id)).toMatchObject({ state: "cancelled" });
		expect(await child.send(noticePermit)).toMatchObject({ permitted: false });
		expect(await child.send({ kind: "snapshot", storeId })).toMatchObject({
			kind: "snapshot",
			snapshot: {
				ticketCount: 3,
				executionControl: { paused: true, revision: 1 },
			},
		});
		expect(
			await submit({
				kind: "revoke-source",
				sourceId: a.sourceId,
				generation: 1,
			}),
		).toMatchObject({ kind: "receipt" });
		expect(
			await submit({
				kind: "pause-execution",
				paused: false,
				expectedRevision: 1,
			}),
		).toMatchObject({ kind: "receipt" });
		expect(await child.send(noticePermit)).toMatchObject({ permitted: false });
		expect(
			await submit(
				observeCiPage(scope, {
					complete: true,
					before: "1",
					after: "2",
					rows: [],
				}),
			),
		).toMatchObject({ kind: "rejected", code: "forbidden" });
		expect(
			await submit(
				observeCiPage(
					{ ...scope, generation: 2 },
					{ complete: true, before: null, after: "restart", rows: [] },
				),
			),
		).toMatchObject({ kind: "receipt" });
	} finally {
		await child.stop();
		await rm(dir, { recursive: true, force: true });
	}
}, 20000);
