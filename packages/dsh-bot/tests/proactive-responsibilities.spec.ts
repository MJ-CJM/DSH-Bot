import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openResponsibilities } from "../coordinator/responsibilities.js";
import { digest } from "../src/host/proactive/wire.js";
import {
	responsibilityDraftSchema,
	responsibilityListSchema,
	type ResponsibilityBinding,
	type ResponsibilityDraft,
} from "../src/shared/proactive/responsibility.js";

const instant = Date.parse("2026-11-08T10:00:00.000Z");
const owner = { botId: "audit-bot", botCreatedAt: 10 };
const source = {
	id: `ci:${digest(["fixture/repo", "main"])}`,
	generation: 1,
	repository: "fixture/repo",
	branch: "main",
};
const target = {
	bot: owner,
	botUpdatedAt: 20,
	provider: "fixture",
	model: "fixture",
};
const draft = (): ResponsibilityDraft =>
	responsibilityDraftSchema.parse({
		name: "CI responsibility",
		mode: "auto",
		source,
		target,
		action: "inspect-ci-result",
		conditions: { jobs: ["test", "lint"], excludedJobs: ["lint"] },
		acceptance: {
			goal: "Explain the failure",
			deliverables: ["Analysis and evidence"],
			checks: [
				{ id: "source", title: "Source matches the task", kind: "both" },
			],
		},
		limits: {
			dailyRequests: 4,
			dailyTokens: 3000,
			taskTokens: 2000,
			taskAttempts: 2,
			taskWallTimeMs: 3600000,
			concurrency: 1,
		},
		expiresAt: new Date(instant + 86400000).toISOString(),
	});
const binding = (): ResponsibilityBinding => ({
	bot: owner,
	source,
	target,
	action: "inspect-ci-result",
	job: "test",
	attempt: 1,
	conclusion: "failure",
	observedAt: new Date(instant).toISOString(),
});
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
function setup(file = ":memory:") {
	const db = new DatabaseSync(file);
	let at = instant;
	const core = openResponsibilities(db, { now: () => at });
	cleanup.push(() => db.close());
	const create = (id = "rule-one", value = draft()) =>
		core.apply({ kind: "create", id, owner: value.target.bot, draft: value });
	const admit = (
		ticketId = "ticket-one",
		responsibilityId = "rule-one",
		patch = {},
	) =>
		core.admit({
			grantId: `grant-${ticketId}`,
			ticketId,
			responsibilityId,
			expectedRevision: core.get(responsibilityId)?.revision ?? 0,
			binding: binding(),
			automatic: true,
			...patch,
		});
	return {
		db,
		core,
		create,
		admit,
		now: (value: number) => {
			at = value;
		},
	};
}

test("versioned per-Bot CRUD rejects stale revisions and recreated identities; tombstones preserve history", () => {
	const { core, create } = setup();
	const first = create();
	create("rule-two");
	expect(core.list(owner)).toHaveLength(2);
	expect(core.list({ ...owner, botCreatedAt: 11 })).toEqual([]);
	expect(() =>
		core.apply({
			kind: "mode",
			id: first.id,
			owner: { ...owner, botCreatedAt: 11 },
			expectedRevision: 0,
			mode: "off",
		}),
	).toThrow("stale");
	const edit = core.apply({
		kind: "update",
		id: first.id,
		owner,
		expectedRevision: 0,
		draft: { ...draft(), name: "Updated" },
	});
	expect(edit).toMatchObject({ revision: 1, name: "Updated" });
	expect(() =>
		core.apply({ kind: "remove", id: first.id, owner, expectedRevision: 0 }),
	).toThrow("stale");
	const removed = core.apply({
		kind: "remove",
		id: first.id,
		owner,
		expectedRevision: 1,
	});
	expect(removed).toMatchObject({ deleted: true, mode: "off", denyEpoch: 1 });
	expect(core.list(owner)).toHaveLength(1);
	expect(core.history(first.id).map((row) => row.revision)).toEqual([0, 1, 2]);
	expect(() => create()).toThrow("conflict");
	expect(() =>
		create("bad-source", {
			...draft(),
			source: { ...source, id: `ci:${"a".repeat(64)}` },
		}),
	).toThrow("invalid");
	expect(responsibilityListSchema.safeParse(core.list(owner)).success).toBe(
		true,
	);
});

test("structured matching binds source and Bot generations, targets, actions, conditions and event age", () => {
	const { core, create, now } = setup();
	create();
	expect(core.match(binding(), true)).toHaveLength(1);
	for (const changed of [
		{ ...binding(), source: { ...source, generation: 2 } },
		{ ...binding(), target: { ...target, model: "other" } },
		{
			...binding(),
			action: "repair-workspace" as const,
			actionScopeDigest: "a".repeat(64),
		},
		{ ...binding(), job: "lint" },
		{ ...binding(), job: "package" },
		{ ...binding(), conclusion: "success" as const },
		{ ...binding(), observedAt: new Date(instant - 86400001).toISOString() },
		{ ...binding(), observedAt: new Date(instant + 300001).toISOString() },
	])
		expect(core.match(changed, true)).toEqual([]);
	now(instant + 86400000);
	expect(core.match(binding(), true)).toEqual([]);
});

test("repair authorization requires and freezes the approved configuration scope", () => {
	const { core, create, admit } = setup();
	const scopeDigest = "a".repeat(64);
	expect(() =>
		create("missing-scope", { ...draft(), action: "repair-workspace" }),
	).toThrow();
	create("rule-one", {
		...draft(),
		action: "repair-workspace",
		actionScopeDigest: scopeDigest,
	});
	const current = {
		...binding(),
		action: "repair-workspace" as const,
		actionScopeDigest: scopeDigest,
	};
	expect(core.match(current, true)).toHaveLength(1);
	expect(
		core.match({ ...current, actionScopeDigest: "b".repeat(64) }, true),
	).toEqual([]);
	const grant = admit("ticket-one", "rule-one", { binding: current });
	expect(core.assertGrant(grant.id, current).binding.actionScopeDigest).toBe(
		scopeDigest,
	);
	expect(() =>
		core.assertGrant(grant.id, {
			...current,
			actionScopeDigest: "b".repeat(64),
		}),
	).toThrow("stale");
});

test("suggest allows explicit admission, off blocks new work, pause preserves grants and revoke denies them", () => {
	const { core, create, admit } = setup();
	create("rule-one", { ...draft(), mode: "suggest" });
	expect(() => admit()).toThrow("forbidden");
	const grant = admit("ticket-one", "rule-one", { automatic: false });
	core.apply({
		kind: "mode",
		id: "rule-one",
		owner,
		expectedRevision: 0,
		mode: "off",
	});
	expect(core.match(binding())).toEqual([]);
	expect(() => admit("ticket-two", "rule-one", { automatic: false })).toThrow(
		"forbidden",
	);
	expect(core.assertGrant(grant.id, binding())).toEqual(grant);
	core.reserve({
		reservationId: "request-one",
		grantId: grant.id,
		assignmentId: "attempt-one",
		tokens: 500,
	});
	core.apply({ kind: "revoke", id: "rule-one", owner, expectedRevision: 1 });
	expect(() => core.assertGrant(grant.id, binding())).toThrow("forbidden");
	expect(() =>
		core.reserve({
			reservationId: "request-two",
			grantId: grant.id,
			assignmentId: "attempt-one",
			tokens: 100,
		}),
	).toThrow("forbidden");
	// Revocation never blocks truthful settlement of a request already sent.
	expect(
		core.settle({
			reservationId: "request-one",
			outcome: "known",
			tokens: 450,
		}),
	).toMatchObject({ chargedTokens: 450 });
});

test("admission is idempotent only for an identical request and freezes acceptance and scope", () => {
	const { core, create, admit } = setup();
	create();
	const grant = admit();
	expect(admit()).toEqual(grant);
	expect(() =>
		admit("ticket-one", "rule-one", { binding: { ...binding(), attempt: 2 } }),
	).toThrow("conflict");
	expect(() =>
		admit("ticket-one", "rule-one", { grantId: "different-grant" }),
	).toThrow("conflict");
	core.apply({
		kind: "update",
		id: "rule-one",
		owner,
		expectedRevision: 0,
		draft: {
			...draft(),
			acceptance: { ...draft().acceptance, goal: "A new goal" },
		},
	});
	expect(core.assertGrant(grant.id, binding()).acceptance.goal).toBe(
		"Explain the failure",
	);
	expect(() =>
		core.assertGrant(grant.id, {
			...binding(),
			target: { ...target, botUpdatedAt: 21 },
		}),
	).toThrow("stale");
});

test("SQL savepoints join the outer task transaction and roll back admission plus budget together", () => {
	const { core, db, create, admit } = setup();
	create();
	db.exec("CREATE TABLE test_task (id TEXT PRIMARY KEY); BEGIN");
	const grant = admit();
	core.reserve({
		reservationId: "request-one",
		grantId: grant.id,
		assignmentId: "attempt-one",
		tokens: 1000,
	});
	db.prepare("INSERT INTO test_task VALUES (?)").run(grant.ticketId);
	db.exec("ROLLBACK");
	expect(core.grantForTicket(grant.ticketId)).toBeUndefined();
	expect(core.usage("rule-one").requestsUsed).toBe(0);
	expect(db.prepare("SELECT count(*) AS n FROM test_task").get()?.n).toBe(0);
});

test("real file SQLite reopens with reservations and unknown costs intact", () => {
	const dir = mkdtempSync(resolve("../../.dsh-dev/responsibility-sql-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "coordinator.sqlite");
	const first = setup(file);
	first.create();
	const grant = first.admit();
	first.core.reserve({
		reservationId: "request-one",
		grantId: grant.id,
		assignmentId: "attempt-one",
		tokens: 1500,
	});
	first.core.settle({ reservationId: "request-one", outcome: "unknown" });
	const second = setup(file);
	expect(second.core.usage("rule-one")).toMatchObject({
		requestsUsed: 1,
		unknownTokens: 1500,
		reservedTokens: 0,
		tokensAvailable: 1500,
		measurementComplete: false,
	});
	expect(() =>
		second.core.settle({
			reservationId: "request-one",
			outcome: "known",
			tokens: 0,
		}),
	).toThrow("conflict");
	expect(() =>
		second.core.reserve({
			reservationId: "request-two",
			grantId: grant.id,
			assignmentId: "attempt-two",
			tokens: 501,
		}),
	).toThrow("forbidden");
});

test("known input-plus-output usage releases only unused token reservation, never a request count", () => {
	const { core, create, admit } = setup();
	create();
	const grant = admit();
	const request = {
		reservationId: "request-one",
		grantId: grant.id,
		assignmentId: "attempt-one",
		tokens: 1500,
	};
	expect(core.reserve(request)).toEqual(core.reserve(request));
	expect(() => core.reserve({ ...request, tokens: 1000 })).toThrow("conflict");
	core.settle({
		reservationId: request.reservationId,
		outcome: "known",
		tokens: 600 + 400,
	});
	expect(core.usage("rule-one")).toMatchObject({
		requestsUsed: 1,
		knownTokens: 1000,
		tokensAvailable: 2000,
		activeTasks: 0,
		measurementComplete: true,
	});
	core.reserve({
		...request,
		reservationId: "request-two",
		assignmentId: "attempt-two",
		tokens: 1000,
	});
	expect(() =>
		core.reserve({ ...request, reservationId: "request-three", tokens: 1 }),
	).toThrow("forbidden");
	core.settle({ reservationId: "request-two", outcome: "known", tokens: 0 });
	expect(() =>
		core.reserve({
			...request,
			reservationId: "request-four",
			assignmentId: "attempt-three",
			tokens: 1,
		}),
	).toThrow("forbidden");
});

test("cold recovery releases only local concurrency and permanently preserves uncertain costs", () => {
	const { core, create, admit, db } = setup();
	create();
	const first = admit();
	core.reserve({
		reservationId: "request-one",
		grantId: first.id,
		assignmentId: "attempt-one",
		tokens: 1500,
	});
	db.exec("BEGIN");
	expect(core.recover()).toBe(1);
	expect(core.usage("rule-one")).toMatchObject({
		activeTasks: 0,
		unknownTokens: 1500,
		tokensAvailable: 1500,
	});
	db.exec("ROLLBACK");
	expect(core.usage("rule-one")).toMatchObject({
		activeTasks: 1,
		reservedTokens: 1500,
	});
	expect(core.recover()).toBe(1);
	expect(core.recover()).toBe(0);
	const next = admit("ticket-two");
	core.reserve({
		reservationId: "request-two",
		grantId: next.id,
		assignmentId: "attempt-two",
		tokens: 500,
	});
	core.settle({
		reservationId: "request-two",
		outcome: "unknown",
		finished: true,
	});
	expect(core.usage("rule-one")).toMatchObject({
		activeTasks: 0,
		unknownTokens: 2000,
		requestsUsed: 2,
	});
	expect(() =>
		core.settle({ reservationId: "request-one", outcome: "known", tokens: 0 }),
	).toThrow("conflict");
});

test("unknown reservations hold concurrency, and unrelated responsibilities retain their own budget", () => {
	const { core, create, admit } = setup();
	create();
	create("rule-two");
	const first = admit();
	core.reserve({
		reservationId: "first",
		grantId: first.id,
		assignmentId: "a",
		tokens: 500,
	});
	core.settle({ reservationId: "first", outcome: "unknown" });
	const second = admit("ticket-two");
	expect(() =>
		core.reserve({
			reservationId: "second",
			grantId: second.id,
			assignmentId: "b",
			tokens: 500,
		}),
	).toThrow("forbidden");
	const other = admit("ticket-three", "rule-two");
	expect(
		core.reserve({
			reservationId: "third",
			grantId: other.id,
			assignmentId: "c",
			tokens: 500,
		}),
	).toMatchObject({ state: "reserved" });
});

test("clock rollback never creates credit and UTC rollover resets only the daily bucket", () => {
	const { core, create, admit, now } = setup();
	const value = draft();
	value.expiresAt = new Date(instant + 172800000).toISOString();
	value.limits.taskWallTimeMs = 86400000;
	value.limits.dailyRequests = 1;
	create("rule-one", value);
	const grant = admit();
	core.reserve({
		reservationId: "request-one",
		grantId: grant.id,
		assignmentId: "attempt-one",
		tokens: 1500,
	});
	core.settle({ reservationId: "request-one", outcome: "unknown" });
	now(instant - 1);
	expect(core.usage("rule-one").clockSkew).toBe(true);
	expect(() =>
		core.reserve({
			reservationId: "rollback",
			grantId: grant.id,
			assignmentId: "attempt-one",
			tokens: 1,
		}),
	).toThrow("forbidden");
	now(Date.parse("2026-11-09T00:00:00.000Z"));
	expect(core.usage("rule-one")).toMatchObject({
		requestsUsed: 0,
		requestsAvailable: 1,
		measurementComplete: false,
	});
	expect(() =>
		core.reserve({
			reservationId: "request-two",
			grantId: grant.id,
			assignmentId: "attempt-one",
			tokens: 501,
		}),
	).toThrow("forbidden");
	core.reserve({
		reservationId: "request-two",
		grantId: grant.id,
		assignmentId: "attempt-one",
		tokens: 500,
	});
});

test("tightened limits apply to future requests while increasing limits cannot enlarge a frozen grant", () => {
	const { core, create, admit } = setup();
	create();
	const grant = admit();
	const expanded = draft();
	expanded.limits.taskTokens = 10000;
	expanded.limits.dailyTokens = 10000;
	core.apply({
		kind: "update",
		id: "rule-one",
		owner,
		expectedRevision: 0,
		draft: expanded,
	});
	expect(() =>
		core.reserve({
			reservationId: "too-large",
			grantId: grant.id,
			assignmentId: "a",
			tokens: 2001,
		}),
	).toThrow("forbidden");
	const tightened = draft();
	tightened.limits.dailyTokens = 100;
	core.apply({
		kind: "update",
		id: "rule-one",
		owner,
		expectedRevision: 1,
		draft: tightened,
	});
	expect(() =>
		core.reserve({
			reservationId: "too-large",
			grantId: grant.id,
			assignmentId: "a",
			tokens: 101,
		}),
	).toThrow("forbidden");
	core.reserve({
		reservationId: "within",
		grantId: grant.id,
		assignmentId: "a",
		tokens: 100,
	});
});

test("legacy migration is one-time, preserves prior charges, and never overwrites later owner changes", () => {
	const { core, db } = setup();
	db.exec(
		"CREATE TABLE pb_work(assignment TEXT,ticket TEXT,payload TEXT); CREATE TABLE pb_execution_budget(assignment TEXT,utc_day TEXT)",
	);
	const rule = {
		id: "legacy-rule",
		sourceId: source.id,
		sourceGeneration: 1,
		expiresAt: draft().expiresAt,
		target,
	};
	db.prepare("INSERT INTO pb_work VALUES (?,?,?)").run(
		"legacy-assignment",
		"legacy-ticket",
		JSON.stringify({ autoRuleId: rule.id, sourceId: source.id, target }),
	);
	db.prepare("INSERT INTO pb_execution_budget VALUES (?,?)").run(
		"legacy-assignment",
		"2026-11-08",
	);
	const record = core.migrateLegacy(rule, source, draft().limits);
	expect(core.usage(record.id)).toMatchObject({
		requestsUsed: 1,
		unknownTokens: 2000,
		measurementComplete: false,
		activeTasks: 0,
	});
	core.apply({
		kind: "mode",
		id: record.id,
		owner,
		expectedRevision: 0,
		mode: "off",
	});
	expect(core.migrateLegacy(rule, source, draft().limits)).toMatchObject({
		revision: 1,
		mode: "off",
	});
	expect(core.usage(record.id).requestsUsed).toBe(1);
});

test("source forgetting revokes grants and redacts every responsibility revision without refunding usage", () => {
	const { core, db, create, admit } = setup();
	create();
	const grant = admit();
	core.reserve({
		reservationId: "reservation",
		assignmentId: "assignment",
		grantId: grant.id,
		tokens: 1500,
	});
	core.settle({
		reservationId: "reservation",
		outcome: "unknown",
		finished: true,
	});
	const usage = core.usage("rule-one");
	expect(() => core.purgeSourceBody(source.id, 1)).toThrow("forbidden");
	expect(core.sourceFence(source.id, 1)).toBe(1);
	expect(() => core.assertGrant(grant.id, binding())).toThrow("forbidden");
	expect(core.match(binding(), true)).toEqual([]);
	expect(() => create("resurrected")).toThrow("forbidden");
	expect(core.purgeSourceBody(source.id, 1)).toEqual({ records: 1, grants: 1 });
	expect(core.usage("rule-one")).toEqual(usage);
	expect(
		core
			.history("rule-one")
			.every(
				(row) =>
					row.deleted &&
					row.name === "[redacted]" &&
					row.source.repository === "redacted/redacted",
			),
	).toBe(true);
	expect(core.grant(grant.id).acceptance.goal).toBe("[redacted]");
	expect(
		Number(
			db.prepare("SELECT count(*) AS n FROM pb_responsibility_redaction").get()
				?.n,
		),
	).toBeGreaterThanOrEqual(4);
	const newer = draft();
	newer.source.generation = 2;
	expect(create("new-generation", newer).deleted).toBe(false);
});

test("remaining tokens subtract measured and unknown charges across task/day limits for bounded rework", () => {
	const { core, create, admit } = setup();
	create();
	const grant = admit();
	core.reserve({
		reservationId: "first",
		assignmentId: "first",
		grantId: grant.id,
		tokens: 2000,
	});
	expect(core.remaining(grant.id).taskTokens).toBe(0);
	core.settle({ reservationId: "first", outcome: "known", tokens: 400 });
	expect(core.remaining(grant.id)).toMatchObject({
		taskTokens: 1600,
		dailyTokens: 2600,
		tokens: 1600,
		attempts: 1,
		requests: 3,
	});
	core.reserve({
		reservationId: "second",
		assignmentId: "second",
		grantId: grant.id,
		tokens: core.remaining(grant.id).tokens,
	});
	core.settle({ reservationId: "second", outcome: "unknown", finished: true });
	expect(core.remaining(grant.id)).toMatchObject({
		taskTokens: 0,
		dailyTokens: 1000,
		tokens: 0,
		attempts: 0,
	});
});

test("group request counts charge every model call while legacy reservations still count as one attempt", () => {
	const { core, db, create, admit } = setup();
	create();
	const first = admit("ticket-first"),
		second = admit("ticket-second");
	core.reserve({
		reservationId: "legacy",
		assignmentId: "first",
		grantId: first.id,
		tokens: 300,
	});
	core.settle({ reservationId: "legacy", outcome: "known", tokens: 100 });
	const legacy = db
		.prepare(
			"SELECT payload FROM pb_responsibility_reservation WHERE id='legacy'",
		)
		.get();
	const payload = JSON.parse(String(legacy?.payload));
	delete payload.requestCount;
	db.prepare(
		"UPDATE pb_responsibility_reservation SET payload=? WHERE id='legacy'",
	).run(JSON.stringify(payload));
	core.reserve({
		reservationId: "group",
		assignmentId: "second",
		grantId: second.id,
		tokens: 1500,
		requestCount: 3,
	});
	expect(core.usage("rule-one").requestsUsed).toBe(4);
	expect(core.remaining(second.id)).toMatchObject({ requests: 0, attempts: 1 });
	expect(() =>
		core.reserve({
			reservationId: "extra",
			assignmentId: "third",
			grantId: second.id,
			tokens: 1,
		}),
	).toThrow("forbidden");
	expect(() =>
		core.reserve({
			reservationId: "group",
			assignmentId: "second",
			grantId: second.id,
			tokens: 1500,
			requestCount: 1,
		}),
	).toThrow("conflict");
});
