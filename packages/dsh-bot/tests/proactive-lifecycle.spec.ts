import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import type {
	ThreadRef,
	Ticket,
} from "../coordinator/vendor/src/core/model.js";
import { purgeManagedArtifacts } from "../src/host/proactive/governance-artifacts.js";
import { digest, frame, frames } from "../src/host/proactive/wire.js";
import type { FeedbackDataset } from "../src/shared/proactive/feedback.js";
import type { ForgetReceipt } from "../src/shared/proactive/governance.js";
import {
	type CommandBody,
	type RequestBody,
	replySchema,
} from "../src/shared/proactive/protocol.js";
import type { ProactiveWork } from "../src/shared/proactive/work.js";

const executable = resolve("lib/proactive-coordinator/main.mjs");
interface NativeStore {
	db: DatabaseSync;
	atomic<T>(work: () => T): T;
	close(): void;
	tickets: { get(id: string): Ticket | undefined; save(ticket: Ticket): void };
}
const { Engine, Store } = (await import(
	pathToFileURL(resolve("lib/proactive-coordinator/core.mjs")).href
)) as {
	Store: new (path: string) => NativeStore;
	Engine: new (
		input: object,
	) => {
		bindThread(ticketId: string, ref: ThreadRef, own: boolean): Ticket;
		threadClosed(
			ref: ThreadRef,
			outcome: "merged" | "closed",
			at: string,
		): void;
	};
};
const sourceId = `ci:${digest("lifecycle-fixture")}`;
const owner = { botId: "lifecycle", botCreatedAt: 1 };
const marker = "SOURCE_BODY_LIFECYCLE_FIXTURE";
const evidenceDigest = digest("fixture transcript");
const reworkFeedback = {
	failures: [{ criterion: "test", actual: marker, expected: "success" }],
};

function worker(path: string) {
	const channel = randomBytes(32).toString("hex");
	const child = spawn(process.execPath, [executable, path], {
		env: { LANG: "C", DSH_BOT_IPC_KEY: channel },
		stdio: ["pipe", "pipe", "ignore"],
	});
	const out = frames(child.stdout);
	const exited = once(child, "exit");
	return {
		async send(body: RequestBody) {
			const correlationId = randomUUID();
			child.stdin.write(
				frame({ protocolVersion: 1, correlationId, channel, ...body }),
			);
			const reply = replySchema.parse((await out.next()).value);
			expect(reply.correlationId).toBe(correlationId);
			return reply;
		},
		async stop() {
			child.stdin.end();
			await exited;
			await out.return(undefined);
		},
	};
}

async function fixture() {
	const root = await mkdtemp(resolve("../../.dsh-dev/proactive-lifecycle-"));
	const path = join(root, "coordinator");
	const dbPath = join(path, "core.sqlite");
	const installationId = randomUUID();
	let child = worker(path);
	let storeId: string;
	async function hello(expectedStoreId: string | null) {
		const reply = await child.send({
			kind: "hello",
			installationId,
			expectedStoreId,
		});
		if (reply.kind !== "hello") throw new Error("Missing coordinator identity");
		storeId = reply.storeId;
	}
	async function command(body: CommandBody, commandId = randomUUID()) {
		return child.send({
			kind: "command",
			command: {
				storeId,
				commandId,
				actorRef: "local-host",
				body,
				payloadDigest: digest(body),
			},
		});
	}
	async function commit(body: CommandBody) {
		expect(await command(body)).toMatchObject({
			kind: "receipt",
			receipt: { status: "committed" },
		});
	}
	async function work(decisionId: string) {
		const result = await child.send({ kind: "work", storeId, decisionId });
		if (result.kind !== "work" || !result.work) throw new Error("Missing work");
		return result.work;
	}
	async function accept(
		generation = 1,
		nativeId = "first",
		expectedCheckpoint: string | null = null,
	) {
		await commit({
			kind: "ingest-batch",
			sourceId,
			generation,
			expectedCheckpoint,
			nextCheckpoint: nativeId,
			events: [
				{
					nativeId,
					nativeRevision: "1",
					threadId: nativeId,
					occurredAt: new Date().toISOString(),
					summary: `${marker}-${nativeId}`,
					ci: { job: "test", attempt: 1, conclusion: "failure" },
				},
			],
		});
		const result = await child.send({ kind: "suggestions", storeId });
		if (result.kind !== "suggestions") throw new Error("Missing suggestions");
		const item = result.suggestions.find((row) => row.title.includes(nativeId));
		if (!item) throw new Error("Missing CI suggestion");
		await commit({
			kind: "accept-decision",
			decisionId: item.id,
			expectedRevision: item.revision,
			sourceId,
			policyVersion: item.policyVersion,
			approved: true,
			target: {
				bot: owner,
				botUpdatedAt: 1,
				provider: "fixture",
				model: "fixture",
			},
		});
		return work(item.id);
	}
	const fence = (row: ProactiveWork) => ({
		ticketId: row.ticketId,
		assignmentId: row.assignmentId,
		expectedRevision: row.revision,
	});
	async function start(row: ProactiveWork) {
		await commit({
			...fence(row),
			kind: "dispatch-claim",
			sessionId: randomUUID(),
		});
		await commit({
			...fence(await work(row.decisionId)),
			kind: "dispatch-send",
			inputId: `input-${row.generation}`,
		});
		return work(row.decisionId);
	}
	async function deliver(row: ProactiveWork) {
		const running = await start(row);
		await commit({
			...fence(running),
			kind: "report-result",
			result: {
				state: "delivered",
				evidence: {
					inputId: `input-${row.generation}`,
					assistantId: `assistant-${row.generation}`,
					turn: 1,
					outputDigest: evidenceDigest,
					checks: ["source-match", "turn-completed", "transcript-flushed"],
				},
			},
		});
		return work(row.decisionId);
	}
	async function review(row: ProactiveWork, action: "accept" | "rework") {
		if (!row.evidenceDigest) throw new Error("Missing evidence digest");
		await commit({
			kind: "review",
			ticketId: row.ticketId,
			expectedRevision: row.revision,
			evidenceDigest: row.evidenceDigest,
			review: action,
			approved: true,
			...(action === "rework" ? { feedback: reworkFeedback } : {}),
		});
		return work(row.decisionId);
	}
	const operationId = randomUUID();
	async function forgetReceipt(): Promise<ForgetReceipt> {
		const result = await child.send({
			kind: "forget-receipt",
			storeId,
			operationId,
		});
		if (result.kind !== "forget-receipt" || !result.receipt)
			throw new Error("Missing forget receipt");
		return result.receipt;
	}
	async function begin(generation = 1) {
		await commit({
			kind: "forget-begin",
			input: { operationId, sourceId, generation },
		});
		return forgetReceipt();
	}
	async function finish(drained: ProactiveWork[] = []) {
		await commit({
			kind: "forget-finish",
			input: {
				operationId,
				drained: drained.map((row) => ({
					assignmentId: row.assignmentId,
					receiptDigest: digest(fence(row)),
				})),
			},
		});
		return forgetReceipt();
	}
	async function purge(receipt: ForgetReceipt) {
		for (const plan of receipt.purgePlans) {
			const result = await purgeManagedArtifacts(root, plan);
			await commit({
				kind: "governance-purge",
				input: { planId: plan.id, result },
			});
		}
		return forgetReceipt();
	}
	function readDb<T>(read: (db: DatabaseSync) => T) {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			return read(db);
		} finally {
			db.close();
		}
	}
	function ticket(row: ProactiveWork) {
		return readDb(
			(db) =>
				JSON.parse(
					String(
						db.prepare("SELECT value FROM ticket WHERE id=?").get(row.ticketId)
							?.value,
					),
				) as Ticket,
		);
	}
	async function restart(seed?: (store: NativeStore) => void) {
		await child.stop();
		if (seed) {
			const store = new Store(dbPath);
			try {
				store.atomic(() => seed(store));
			} finally {
				store.close();
			}
		}
		child = worker(path);
		await hello(storeId);
	}
	await hello(null);
	return {
		root,
		accept,
		start,
		deliver,
		review,
		work,
		fence,
		ticket,
		begin,
		finish,
		purge,
		command,
		commit,
		readDb,
		restart,
		forgetReceipt,
		send: (
			request: Omit<Extract<RequestBody, { kind: "work-history" }>, "storeId">,
		) => child.send({ ...request, storeId }),
		async close() {
			await child.stop();
			await rm(root, { recursive: true, force: true });
		},
	};
}

function engine(store: NativeStore) {
	const unavailable = () => {
		throw new Error("Unexpected side effect");
	};
	return new Engine({
		repo: store,
		scope: { scope: () => ({ listened: true, observed: true }) },
		policy: () => ({
			version: "fixture",
			paused: true,
			evalTimeoutMs: 0,
			gate: () => ({ admissible: false, reason: "fixture" }),
			revalidate: () => false,
			admitsInferred: () => false,
		}),
		assessor: { request: unavailable },
		executor: { start() {}, deliver() {}, stop() {} },
		outbox: {
			send: unavailable,
			withdraw: unavailable,
			status: () => undefined,
		},
	});
}

test.each(["failed", "denied"] as const)(
	"automatic %s ends the native ticket and permits verified artifact forgetting",
	async (state) => {
		const f = await fixture();
		try {
			let row = await f.accept();
			if (state === "failed") {
				const ref = { source: "fixture-pr", id: "open-at-failure" };
				await f.restart((store) => {
					engine(store).bindThread(row.ticketId, ref, true);
				});
				row = await f.start(row);
			}
			const artifact = join(f.root, "repair-artifacts", row.assignmentId);
			await mkdir(artifact, { recursive: true });
			await writeFile(join(artifact, "result.json"), marker);
			await f.commit({
				...f.fence(row),
				kind: "report-result",
				result: { state },
			});
			expect(await f.work(row.decisionId)).toMatchObject({ state });
			expect(f.ticket(row)).toMatchObject({
				ended: { by: "executor", outcome: "dropped" },
				undelivered: [],
				assignments: [
					{ state: "ended", report: { state: "dropped", summary: state } },
				],
			});
			expect(await f.begin()).toMatchObject({ pendingAssignments: [] });
			const pending = await f.finish();
			expect(pending).toMatchObject({ phase: "purging" });
			await expect(access(artifact)).resolves.toBeUndefined();
			const complete = await f.purge(pending);
			expect(complete).toMatchObject({ phase: "complete" });
			await expect(access(artifact)).rejects.toMatchObject({ code: "ENOENT" });
			await f.restart();
			expect(await f.finish()).toEqual(complete);
			expect(
				f.readDb(
					(db) =>
						db
							.prepare("SELECT value FROM trigger WHERE id=?")
							.get(row.triggerId)?.value,
				),
			).not.toContain(marker);
		} finally {
			await f.close();
		}
	},
	15000,
);

test("dropped reports honor the real Engine's closed follows outcome", async () => {
	const f = await fixture();
	try {
		const row = await f.accept();
		const ref = { source: "fixture-pr", id: "resolved-dependency" };
		await f.restart((store) => {
			engine(store).bindThread(row.ticketId, ref, true);
			const ticket = store.tickets.get(row.ticketId);
			const follow = ticket?.follows?.[0];
			if (!ticket || !follow) throw new Error("Missing bound dependency");
			// Model a follow that closed while work was unfinished.
			follow.closed = { at: new Date().toISOString(), outcome: "merged" };
			store.tickets.save(ticket);
		});
		await f.commit({
			...f.fence(row),
			kind: "report-result",
			result: { state: "denied" },
		});
		expect(await f.work(row.decisionId)).toMatchObject({ state: "denied" });
		expect(f.ticket(row)).toMatchObject({
			ended: { by: "executor", outcome: "merged" },
			assignments: [
				{ state: "ended", report: { state: "dropped", summary: "denied" } },
			],
		});
	} finally {
		await f.close();
	}
}, 15000);

test("accepted evidence remains open until its real Engine dependency closes", async () => {
	const f = await fixture();
	try {
		const row = await f.accept();
		const ref = { source: "fixture-pr", id: "open-dependency" };
		await f.restart((store) => {
			engine(store).bindThread(row.ticketId, ref, true);
		});
		const accepted = await f.review(await f.deliver(row), "accept");
		expect(accepted).toMatchObject({ state: "accepted", reviewer: "owner" });
		expect(f.ticket(row).ended).toBeUndefined();
		expect(f.ticket(row).assignments[0]).toMatchObject({
			state: "running",
			report: { state: "ready" },
		});
		expect(await f.begin()).toMatchObject({
			pendingAssignments: [row.assignmentId],
		});
		expect(await f.finish([accepted])).toMatchObject({ phase: "blocked" });
		await f.restart((store) => {
			engine(store).threadClosed(ref, "merged", new Date().toISOString());
		});
		expect(f.ticket(row).ended).toMatchObject({
			by: "executor",
			outcome: "merged",
		});
		expect(await f.purge(await f.finish([accepted]))).toMatchObject({
			phase: "complete",
		});
		expect(await f.work(row.decisionId)).toMatchObject({
			state: "accepted",
			reviewer: "owner",
		});
	} finally {
		await f.close();
	}
}, 15000);

test("a ledger write failure rolls back the native retry and preserves the same rework command", async () => {
	const f = await fixture();
	try {
		const first = await f.deliver(await f.accept());
		const before = f.ticket(first);
		if (!first.evidenceDigest) throw new Error("Missing review evidence");
		const rework: CommandBody = {
			kind: "review",
			ticketId: first.ticketId,
			expectedRevision: first.revision,
			evidenceDigest: first.evidenceDigest,
			review: "rework",
			approved: true,
			feedback: reworkFeedback,
		};
		const id = randomUUID();
		await f.restart((store) => {
			store.db.exec(`CREATE TRIGGER fixture_rework_write_failure BEFORE UPDATE OF payload ON pb_work
				WHEN json_extract(new.payload,'$.state')='superseded'
				BEGIN SELECT RAISE(ABORT,'fixture rework ledger failure'); END`);
		});
		expect(await f.command(rework, id)).toMatchObject({
			kind: "unknown",
			commandId: id,
		});
		await f.restart((store) => {
			store.db.exec("DROP TRIGGER fixture_rework_write_failure");
		});
		expect(f.ticket(first)).toEqual(before);
		expect(await f.work(first.decisionId)).toEqual(first);
		expect(await f.command(rework, id)).toMatchObject({
			kind: "receipt",
			receipt: { commandId: id, status: "committed" },
		});
		expect(
			f.ticket(first).assignments.map((assignment) => assignment.state),
		).toEqual(["ended", "pending"]);
	} finally {
		await f.close();
	}
}, 15000);

function dataset(
	id: string,
	generation: number,
	source = sourceId,
): FeedbackDataset {
	return {
		id,
		version: 1,
		owner,
		provenance: marker,
		labelPolicy: "Independent holdout",
		exceptions: [marker],
		maxAddedMisses: 0,
		batches: ["first", "second", "third"].map((batch) => ({
			id: batch,
			rows: [
				{
					taskId: `${id}-${batch}`,
					sourceId: source,
					sourceGeneration: generation,
					job: "test",
					attempt: 1,
					needed: true,
					baselineSuggested: true,
					attentionNeeded: true,
					baselineNotified: true,
					labelAgreement: "agreed",
					note: marker,
				},
			],
		})),
	};
}

test("rework supersedes old evidence, then forgets older frozen sets and adopted candidate copies", async () => {
	const f = await fixture();
	try {
		const first = await f.deliver(await f.accept());
		const next = await f.review(first, "rework");
		expect(next).toMatchObject({ state: "pending", generation: 2 });
		expect(f.ticket(first).assignments).toMatchObject([
			{ id: first.assignmentId, state: "ended", endedReason: "retried" },
			{ id: next.assignmentId, state: "pending" },
		]);
		expect(
			await f.command({
				...f.fence(first),
				kind: "report-result",
				result: { state: "failed" },
			}),
		).toMatchObject({ kind: "rejected", code: "stale" });
		const accepted = await f.review(await f.deliver(next), "accept");
		const history = await f.send({
			kind: "work-history",
			input: { ticketId: first.ticketId },
		});
		expect(history).toMatchObject({
			kind: "work-history",
			history: {
				versions: [
					{ state: "accepted", assignmentId: accepted.assignmentId },
					{
						state: "superseded",
						assignmentId: first.assignmentId,
						supersededBy: next.assignmentId,
						reviewFeedback: reworkFeedback,
					},
				],
			},
		});
		const application = {
			kind: "memory",
			memoryId: randomUUID(),
			versionId: randomUUID(),
		} as const;
		const proposal = {
			kind: "preference",
			origin: {
				bot: owner,
				taskId: first.ticketId,
				source: { id: sourceId, generation: 1 },
				evidenceDigest: evidenceDigest,
			},
			reason: marker,
			content: marker,
		} as const;
		await f.commit({
			kind: "feedback-workflow",
			input: { action: "propose-candidate", proposal },
		});
		const id = String(
			f.readDb(
				(db) => db.prepare("SELECT id FROM pb_feedback_candidate").get()?.id,
			),
		);
		await f.commit({
			kind: "feedback-workflow",
			input: {
				action: "adopt-candidate",
				candidateId: id,
				expectedRevision: 0,
				reviewedDigest: digest(proposal),
			},
		});
		const applicationId = f.readDb(
			(db) =>
				db
					.prepare(
						"SELECT json_extract(payload,'$.operationId') AS id FROM pb_feedback_candidate WHERE id=?",
					)
					.get(id)?.id,
		);
		await f.commit({
			kind: "feedback-workflow",
			input: {
				action: "settle-candidate",
				candidateId: id,
				expectedRevision: 1,
				operationId: String(applicationId),
				outcome: "applied",
				receipt: application,
			},
		});
		const old = dataset("generation-one", 1);
		await f.commit({
			kind: "feedback-workflow",
			input: { action: "import-dataset", dataset: old },
		});
		await f.commit({
			kind: "feedback-workflow",
			input: {
				action: "import-dataset",
				dataset: dataset("generation-three", 3),
			},
		});
		const other = await f.accept(2, "second");
		await f.commit({
			...f.fence(other),
			kind: "report-result",
			result: { state: "denied" },
		});
		expect(await f.begin(2)).toMatchObject({ pendingAssignments: [] });
		expect(
			await f.command({
				kind: "feedback-workflow",
				input: {
					action: "import-dataset",
					dataset: dataset("reintroduced", 1),
				},
			}),
		).toMatchObject({ kind: "rejected", code: "forbidden" });
		const complete = await f.purge(await f.finish());
		expect(complete).toMatchObject({ phase: "complete" });
		expect(
			await f.command({
				kind: "feedback-workflow",
				input: {
					action: "propose-candidate",
					proposal: {
						...proposal,
						origin: {
							...proposal.origin,
							source: { id: sourceId, generation: 3 },
						},
					},
				},
			}),
		).toMatchObject({ kind: "rejected", code: "forbidden" });
		await f.restart();
		expect(await f.finish()).toEqual(complete);
		f.readDb((db) => {
			const candidate = JSON.parse(
				String(
					db
						.prepare("SELECT payload FROM pb_feedback_candidate WHERE id=?")
						.get(id)?.payload,
				),
			);
			expect(candidate).toMatchObject({
				state: "adopted",
				application,
				proposalDigest: digest(proposal),
				bodyPurgedAt: expect.any(Number),
			});
			expect(
				JSON.stringify(
					db
						.prepare(
							"SELECT payload FROM pb_feedback_candidate_revision WHERE id=?",
						)
						.all(id),
				),
			).not.toContain(marker);
			expect(
				JSON.stringify(db.prepare("SELECT payload FROM pb_work").all()),
			).not.toContain(marker);
			expect(db.prepare("SELECT id FROM pb_feedback_dataset").all()).toEqual([
				{ id: "generation-three" },
			]);
			expect(
				db
					.prepare(
						"SELECT digest FROM pb_feedback_dataset_tombstone WHERE id=?",
					)
					.get(old.id),
			).toEqual({ digest: digest(old) });
			expect(
				JSON.parse(
					String(
						db
							.prepare(
								"SELECT audit FROM pb_governance_tombstone WHERE kind='work' AND id=?",
							)
							.get(first.assignmentId)?.audit,
					),
				),
			).toMatchObject({
				state: "superseded",
				supersededBy: next.assignmentId,
				evidenceDigest: first.evidenceDigest,
			});
		});
	} finally {
		await f.close();
	}
}, 15000);

test("cold recovery fixes legacy confirmed terminal and superseded rows, but keeps unknown blocked", async () => {
	const f = await fixture();
	try {
		const failed = await f.accept();
		await f.commit({
			...f.fence(failed),
			kind: "report-result",
			result: { state: "failed" },
		});
		const first = await f.deliver(await f.accept(1, "rework", "first"));
		const next = await f.review(first, "rework");
		await f.review(await f.deliver(next), "accept");
		const unknown = await f.start(await f.accept(1, "uncertain", "rework"));
		await f.commit({
			...f.fence(unknown),
			kind: "report-result",
			result: { state: "unknown" },
		});
		await f.restart((store) => {
			const ticket = store.tickets.get(failed.ticketId);
			const assignment = ticket?.assignments[0];
			if (!ticket || !assignment?.report)
				throw new Error("Missing original terminal row");
			delete ticket.ended;
			assignment.state = "pending";
			delete assignment.endedAt;
			assignment.report.state = "failed";
			store.tickets.save(ticket);
			const saved = store.db
				.prepare("SELECT payload FROM pb_work WHERE assignment=?")
				.get(first.assignmentId);
			const row = JSON.parse(String(saved?.payload)) as ProactiveWork;
			delete row.supersededBy;
			row.state = "delivered";
			store.db
				.prepare("UPDATE pb_work SET payload=? WHERE assignment=?")
				.run(JSON.stringify(row), first.assignmentId);
			store.db.exec("UPDATE pb_meta SET schema_version=7");
		});
		expect(f.ticket(failed).ended).toMatchObject({
			by: "executor",
			outcome: "dropped",
		});
		const history = await f.send({
			kind: "work-history",
			input: { ticketId: first.ticketId },
		});
		expect(history).toMatchObject({
			kind: "work-history",
			history: {
				versions: [
					{ state: "accepted" },
					{ state: "superseded", supersededBy: next.assignmentId },
				],
			},
		});
		const repaired = f.ticket(failed);
		await f.restart();
		expect(f.ticket(failed)).toEqual(repaired);
		expect(
			await f.send({
				kind: "work-history",
				input: { ticketId: first.ticketId },
			}),
		).toMatchObject({
			kind: "work-history",
			history: history.kind === "work-history" ? history.history : undefined,
		});
		expect(await f.begin()).toMatchObject({
			pendingAssignments: [unknown.assignmentId],
		});
		expect(await f.finish()).toMatchObject({
			phase: "blocked",
			purgePlans: [],
		});
		expect(await f.work(unknown.decisionId)).toMatchObject({
			state: "unknown",
			title: expect.stringContaining(marker),
		});
	} finally {
		await f.close();
	}
}, 15000);

test("cold upgrade replays an authorized completed forget without deleting other generations", async () => {
	const f = await fixture();
	try {
		const old = dataset("missed-by-legacy-cleanup", 1);
		const future = dataset("unfenced-legacy", 3);
		const revokedSource = `ci:${digest("revocation without forget")}`;
		const revoked = dataset("revoked-without-forget", 1, revokedSource);
		await f.commit({
			kind: "revoke-source",
			sourceId: revokedSource,
			generation: 1,
		});
		const committed = await f.begin(2);
		expect(committed.phase).toBe("fenced");
		const complete = await f.finish();
		expect(complete.phase).toBe("complete");
		await f.restart((store) => {
			const insert = store.db.prepare(
				"INSERT INTO pb_feedback_dataset VALUES (?,?,?,?)",
			);
			for (const value of [old, future, revoked])
				insert.run(
					value.id,
					value.version,
					digest(value),
					JSON.stringify({
						...value,
						digest: digest(value),
						frozenAt: Date.now(),
					}),
				);
			store.db.exec("UPDATE pb_meta SET schema_version=7");
		});
		const saved = () =>
			f.readDb((db) => ({
				datasets: db
					.prepare("SELECT id FROM pb_feedback_dataset ORDER BY id")
					.all(),
				tombstones: db
					.prepare("SELECT * FROM pb_feedback_dataset_tombstone")
					.all(),
			}));
		const repaired = saved();
		expect(repaired).toMatchObject({
			datasets: [{ id: revoked.id }, { id: future.id }],
			tombstones: [{ id: old.id, digest: digest(old) }],
		});
		await f.restart();
		expect(saved()).toEqual(repaired);
		expect(await f.forgetReceipt()).toEqual(complete);
	} finally {
		await f.close();
	}
}, 15000);
