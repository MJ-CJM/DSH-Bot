import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
	existsSync,
	symlinkSync,
	linkSync,
	readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import type {
	Trigger,
	Thread,
	Ticket,
	Decision,
} from "../coordinator/vendor/src/core/model.js";
import { purgeManagedArtifacts } from "../src/host/proactive/governance-artifacts.js";
import {
	governanceConfigSchema,
	type ArtifactPurgePlan,
	type BeginForget,
	type FinishForget,
	type ForgetReceipt,
	type GovernanceConfig,
	type GovernanceSweep,
	type ArtifactPurgeResult,
} from "../src/shared/proactive/governance.js";
import { workSchema } from "../src/shared/proactive/work.js";
import { digest } from "../src/host/proactive/wire.js";

type Repository<T> = { get(id: string): T | undefined; save(value: T): void };
interface TestStore {
	db: DatabaseSync;
	close(): void;
	atomic<T>(fn: () => T): T;
	triggers: Repository<Trigger>;
	threads: Repository<Thread>;
	tickets: Repository<Ticket>;
	decisions: Repository<Decision>;
}
interface TestGovernance {
	blockForget(id: string, reason: "notification-copy-unknown"): ForgetReceipt;
	sweep(): GovernanceSweep;
	beginForget(input: BeginForget): ForgetReceipt;
	finishForget(input: FinishForget): ForgetReceipt;
	forget(id: string): ForgetReceipt | undefined;
	sourceContext(
		source: string,
		generation: number,
	): { ticketIds: string[]; assignmentIds: string[]; decisionIds: string[] };
	recordPurge(id: string, result: ArtifactPurgeResult): ArtifactPurgeResult;
	pendingPurges(): ArtifactPurgePlan[];
	tombstones(): Array<Record<string, unknown>>;
}
// Load the shipped Store and coordinator boundary without adding the vendored
// core build's TS-extension imports to the Host's separate compilation unit.
const CoreStore = (
	await import(
		pathToFileURL(resolve("lib/proactive-coordinator/core.mjs")).href
	)
).Store as { new (path: string): TestStore };
const openGovernance = (
	await import(new URL("../coordinator/governance.ts", import.meta.url).href)
).openGovernance as (
	store: TestStore,
	config: Partial<GovernanceConfig>,
	options: { now: () => number },
) => TestGovernance;
const now = Date.parse("2026-11-08T12:00:00Z");
const before = new Date(now - 120000).toISOString();
const sourceId = `ci:${digest("source")}`;
const owner = { botId: "governance-bot", botCreatedAt: 1 };
const roots: string[] = [];
const stores: TestStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function root() {
	const base = resolve("../../.dsh-dev/proactive-bot/governance-tests");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "case-"));
	roots.push(dir);
	return dir;
}
function setup() {
	const dir = root();
	const store = new CoreStore(join(dir, "core.sqlite"));
	stores.push(store);
	store.db.exec(
		"CREATE TABLE pb_event(id TEXT PRIMARY KEY,digest TEXT NOT NULL); CREATE TABLE pb_work(assignment TEXT PRIMARY KEY,ticket TEXT,decision TEXT,generation INTEGER,payload TEXT); CREATE TABLE pb_source(id TEXT PRIMARY KEY,generation INTEGER,checkpoint TEXT); CREATE TABLE pb_inbox(id TEXT PRIMARY KEY,digest TEXT,receipt TEXT)",
	);
	store.db.prepare("INSERT INTO pb_source VALUES (?,1,NULL)").run(sourceId);
	const core = openGovernance(
		store,
		{
			eventBodyRetentionMs: 60000,
			terminalRetentionMs: 60000,
			artifactRetentionMs: 60000,
		},
		{ now: () => now },
	);
	const seed = (
		id: string,
		state: "accepted" | "sent" | "unknown" | "delivered" = "accepted",
		gen = 1,
	) => {
		const triggerId = `trigger-${id}`;
		const threadKey = `${sourceId}:thread-${id}`;
		store.triggers.save({
			id: triggerId,
			source: sourceId,
			human: false,
			actor: { source: sourceId, id: "bot" },
			threads: [{ source: sourceId, id: `thread-${id}` }],
			at: before,
			text: `secret-trigger-${id}`,
			meta: {
				generation: gen,
				ci: { summary: "secret-summary", repository: "secret/repo" },
			},
		});
		store.threads.save({
			key: threadKey,
			ref: { source: sourceId, id: `thread-${id}` },
			createdAt: before,
			lastAt: before,
			subscriptions: [`ticket-${id}`],
			correlated: [],
			pending: [],
			meta: { label: "secret-thread" },
		});
		store.db
			.prepare("INSERT INTO pb_event VALUES (?,?)")
			.run(triggerId, digest(id));
		const mandate = {
			strength: "inferred" as const,
			policyVersion: "policy",
			basis: { via: "bot" as const, observation: { mode: "auto" as const } },
			actor: { source: sourceId, id: "bot" },
			scope: "secret-scope",
		};
		store.decisions.save({
			id: `decision-${id}`,
			evalId: `eval-${id}`,
			threadKey,
			triggerIds: [triggerId],
			policyVersion: "policy",
			at: before,
			kind: "accept",
			reason: [{ code: "said", values: { text: "secret-reason" } }],
			strength: "inferred",
			ticketId: `ticket-${id}`,
			mandate,
			audit: { text: "secret-audit" },
		});
		const ended = state === "accepted";
		store.tickets.save({
			id: `ticket-${id}`,
			title: `secret-title-${id}`,
			decisionId: `decision-${id}`,
			mandate,
			channels: [],
			assignments: [
				{
					id: `assignment-${id}`,
					state: ended ? "ended" : "running",
					createdAt: before,
					report: {
						state: ended ? "ready" : "progress",
						summary: "secret-report",
						at: before,
					},
				},
			],
			inputs: [
				{ id: `input-${id}`, kind: "text", text: "secret-input", at: before },
			],
			undelivered: [],
			createdAt: before,
			updatedAt: before,
			origin: { triggerId, triggerIds: [triggerId] },
			...(ended
				? {
						ended: {
							at: before,
							by: "executor" as const,
							outcome: "completed" as const,
						},
					}
				: {}),
		});
		const work = workSchema.parse({
			ticketId: `ticket-${id}`,
			assignmentId: `assignment-${id}`,
			decisionId: `decision-${id}`,
			triggerId,
			sourceId,
			title: `secret-title-${id}`,
			acceptance: {
				goal: "secret-goal",
				deliverables: ["secret-deliverable"],
				checks: [{ id: "check", title: "secret-check", kind: "both" }],
			},
			target: {
				bot: owner,
				botUpdatedAt: 1,
				provider: "fixture",
				model: "fixture",
			},
			expiresAt: before,
			policyVersion: "policy",
			revision: 1,
			generation: 1,
			state,
			evidenceDigest: digest(id),
			...(state === "accepted"
				? { reviewer: "owner", reviewedAt: before }
				: {}),
		});
		store.db
			.prepare("INSERT INTO pb_work VALUES (?,?,?,?,?)")
			.run(
				work.assignmentId,
				work.ticketId,
				work.decisionId,
				work.generation,
				JSON.stringify(work),
			);
		return work;
	};
	return { dir, store, core, seed };
}

test("retention validates replay windows and redacts via public repositories without losing dedupe/acceptance", () => {
	expect(() =>
		governanceConfigSchema.parse({ dedupeRetentionMs: 60000 }),
	).toThrow();
	const { store, core, seed } = setup();
	seed("done");
	store.db.exec(
		"CREATE TABLE pb_suggestion_adjustment(decision TEXT PRIMARY KEY,revision INTEGER,title TEXT,at INTEGER)",
	);
	store.db
		.prepare("INSERT INTO pb_suggestion_adjustment VALUES (?,?,?,?)")
		.run("decision-done", 1, "secret-adjusted-title", now);
	store.db
		.prepare("INSERT INTO pb_inbox VALUES ('command','digest','receipt')")
		.run();
	const save = vi.spyOn(store.triggers, "save");
	const ticketSave = vi.spyOn(store.tickets, "save");
	const outcome = core.sweep();
	expect(outcome.archived).toBe(1);
	expect(outcome.purgePlans).toHaveLength(1);
	expect(save).toHaveBeenCalled();
	expect(ticketSave).toHaveBeenCalled();
	expect(store.triggers.get("trigger-done")?.text).toBe("[redacted]");
	expect(JSON.stringify(store.tickets.get("ticket-done"))).not.toContain(
		"secret",
	);
	expect(JSON.stringify(store.decisions.get("decision-done"))).not.toContain(
		"secret",
	);
	expect(
		String(
			store.db
				.prepare(
					"SELECT payload FROM pb_work WHERE assignment='assignment-done'",
				)
				.get()?.payload,
		),
	).not.toContain("secret");
	expect(
		store.db
			.prepare("SELECT title FROM pb_suggestion_adjustment WHERE decision=?")
			.get("decision-done")?.title,
	).toBe("[redacted]");
	expect(store.db.prepare("SELECT count(*) AS n FROM pb_event").get()?.n).toBe(
		1,
	);
	expect(store.db.prepare("SELECT receipt FROM pb_inbox").get()?.receipt).toBe(
		"receipt",
	);
	expect(
		core.tombstones().find((item) => item.kind === "work")?.audit,
	).toContain('"state":"accepted"');
	expect(core.sweep().redacted).toBe(0);
});

test("active, unknown, awaiting acceptance and every older version of their tickets remain intact", () => {
	const { store, core, seed } = setup();
	seed("active", "sent");
	seed("unknown", "unknown");
	const delivered = seed("review", "delivered");
	const old = {
		...delivered,
		assignmentId: "old-review",
		state: "failed",
		generation: 2,
	};
	store.db
		.prepare("INSERT INTO pb_work VALUES (?,?,?,?,?)")
		.run(
			old.assignmentId,
			old.ticketId,
			old.decisionId,
			old.generation,
			JSON.stringify(old),
		);
	const result = core.sweep();
	expect(result.protected).toBe(3);
	expect(result.purgePlans).toEqual([]);
	expect(result.redacted).toBe(0);
	expect(store.triggers.get("trigger-unknown")?.text).toContain("secret");
});

test("forget fences first, preserves bodies until authoritative drain and remains idempotent", () => {
	const { store, core, seed } = setup();
	const work = seed("running", "unknown");
	const begin = core.beginForget({
		operationId: "forget",
		sourceId,
		generation: 1,
	});
	expect(begin.phase).toBe("fenced");
	expect(
		store.db
			.prepare("SELECT generation FROM pb_source_revocation WHERE id=?")
			.get(sourceId)?.generation,
	).toBe(1);
	expect(
		core.finishForget({
			operationId: "forget",
			drained: [
				{ assignmentId: work.assignmentId, receiptDigest: digest("fake") },
			],
		}).phase,
	).toBe("blocked");
	expect(store.triggers.get(work.triggerId)?.text).toContain("secret");
	const ticket = store.tickets.get(work.ticketId);
	if (!ticket) throw new Error("Missing ticket");
	store.tickets.save({
		...ticket,
		ended: { at: before, by: "human", outcome: "stopped" },
		assignments: ticket.assignments.map((item) => ({
			...item,
			state: "ended",
		})),
	});
	store.db
		.prepare("UPDATE pb_work SET payload=? WHERE assignment=?")
		.run(JSON.stringify({ ...work, state: "cancelled" }), work.assignmentId);
	expect(core.finishForget({ operationId: "forget", drained: [] }).phase).toBe(
		"blocked",
	);
	const done = core.finishForget({
		operationId: "forget",
		drained: [
			{ assignmentId: work.assignmentId, receiptDigest: digest("drained") },
		],
	});
	expect(done.phase).toBe("purging");
	expect(done.pendingAssignments).toEqual([]);
	expect(done.boundaries).toContain("native-session-copies-preserved");
	expect(core.sourceContext(sourceId, 1).ticketIds).toContain(work.ticketId);
	expect(
		core.beginForget({ operationId: "forget", sourceId, generation: 1 }),
	).toEqual(done);
	expect(() =>
		core.beginForget({ operationId: "forget", sourceId, generation: 2 }),
	).toThrow("conflict");
});

test("forget isolates source generations and public repository writes roll back with the outer transaction", () => {
	const { store, core, seed } = setup();
	seed("old");
	seed("new", "accepted", 2);
	core.beginForget({ operationId: "forget", sourceId, generation: 1 });
	expect(() =>
		store.atomic(() => {
			core.finishForget({ operationId: "forget", drained: [] });
			throw new Error("rollback");
		}),
	).toThrow("rollback");
	expect(store.triggers.get("trigger-old")?.text).toContain("secret");
	expect(core.forget("forget")?.phase).toBe("fenced");
	core.finishForget({ operationId: "forget", drained: [] });
	expect(store.triggers.get("trigger-old")?.text).toBe("[redacted]");
	expect(store.triggers.get("trigger-new")?.text).toContain("secret");
});

test("managed artifact purge records receipts, survives retries and never touches ordinary data", async () => {
	const { dir, core, seed } = setup();
	seed("done");
	core.beginForget({ operationId: "forget", sourceId, generation: 1 });
	const done = core.finishForget({ operationId: "forget", drained: [] });
	const plan = done.purgePlans[0];
	if (!plan) throw new Error("Missing purge plan");
	mkdirSync(join(dir, "repair-artifacts", plan.assignmentId), {
		recursive: true,
	});
	writeFileSync(
		join(dir, "repair-artifacts", plan.assignmentId, "before.json"),
		"secret-artifact",
	);
	writeFileSync(join(dir, "ordinary-session.json"), "ordinary");
	const result = await purgeManagedArtifacts(dir, plan);
	expect(result.state).toBe("purged");
	expect(result.files).toBe(1);
	core.recordPurge(plan.id, result);
	expect(core.forget("forget")?.phase).toBe("complete");
	expect(core.pendingPurges()).toEqual([]);
	expect(readFileSync(join(dir, "ordinary-session.json"), "utf8")).toBe(
		"ordinary",
	);
	expect((await purgeManagedArtifacts(dir, plan)).state).toBe("missing");
	expect(core.recordPurge(plan.id, { ...result, state: "unknown" })).toEqual(
		result,
	);
});

test("artifact symlink/hardlink/traversal are blocked before deleting any files", async () => {
	const dir = root();
	const outside = join(dir, "ordinary.txt");
	writeFileSync(outside, "preserve");
	const plan: ArtifactPurgePlan = {
		id: "purge-test",
		assignmentId: "assignment-test",
		sourceId,
		generation: 1,
		namespaces: ["repair-artifacts"],
		createdAt: now,
		reason: "retention",
	};
	const managed = join(dir, "repair-artifacts", plan.assignmentId);
	mkdirSync(managed, { recursive: true });
	writeFileSync(join(managed, "a.json"), "managed");
	symlinkSync(outside, join(managed, "z-link"));
	expect((await purgeManagedArtifacts(dir, plan)).state).toBe("blocked");
	expect(existsSync(join(managed, "a.json"))).toBe(true);
	rmSync(join(managed, "z-link"));
	linkSync(outside, join(managed, "z-hard"));
	expect((await purgeManagedArtifacts(dir, plan)).state).toBe("blocked");
	expect(readFileSync(outside, "utf8")).toBe("preserve");
	await expect(
		purgeManagedArtifacts(dir, { ...plan, assignmentId: "../ordinary" }),
	).rejects.toThrow();
});

test("forget completes when retention already recorded the same artifact purge", async () => {
	const { dir, core, seed } = setup();
	seed("old");
	const plan = core.sweep().purgePlans[0];
	if (!plan) throw new Error("Missing purge plan");
	core.recordPurge(plan.id, await purgeManagedArtifacts(dir, plan));
	core.beginForget({ operationId: "after-retention", sourceId, generation: 1 });
	expect(
		core.finishForget({ operationId: "after-retention", drained: [] }).phase,
	).toBe("complete");
});

test("copy uncertainty is a durable blocked receipt that can resume only through finish revalidation", () => {
	const { core, seed } = setup();
	seed("copy");
	core.beginForget({ operationId: "copy-forget", sourceId, generation: 1 });
	expect(
		core.blockForget("copy-forget", "notification-copy-unknown"),
	).toMatchObject({
		phase: "blocked",
		blockedReason: "notification-copy-unknown",
	});
	expect(core.forget("copy-forget")?.blockedReason).toBe(
		"notification-copy-unknown",
	);
	expect(
		core.finishForget({ operationId: "copy-forget", drained: [] }),
	).toMatchObject({ phase: "purging", blockedReason: undefined });
});
