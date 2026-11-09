import { DatabaseSync } from "node:sqlite";
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, test, vi } from "vitest";
import { openDeferredNotices } from "../coordinator/notices.js";
import {
	deferredNoticeText,
	nextNoticeDueAt,
	noticePolicyDigest,
	recordDeferredNoticeBatch,
} from "../src/host/proactive/deferred-notices.js";
import {
	policySchema,
	NOTIFICATION_TEXT_MAX_BYTES,
} from "../src/shared/notifications.js";
import type {
	NoticeItem,
	NoticeSchedule,
} from "../src/shared/proactive/notices.js";
import { workSchema } from "../src/shared/proactive/work.js";

const instant = Date.parse("2026-11-08T12:00:00.000Z");
const owner = { botId: "notice-bot", botCreatedAt: 1 };
const policy = policySchema.parse({
	id: "policy",
	owner,
	channel: "in-app",
	enabled: true,
	timezone: "UTC",
	dailyLimit: 3,
	cooldownSec: 0,
	authorization: { mode: "ask" },
	revision: 1,
	createdAt: 1,
	updatedAt: 1,
	schemaVersion: 1,
	scopeDigest: "scope",
	targetDigest: "in-app",
});
const schedule = (
	id: string,
	patch: Partial<NoticeSchedule> = {},
): NoticeSchedule => ({
	assignmentId: `assignment-${id}`,
	ticketId: `ticket-${id}`,
	operationId: `notice-${id}`,
	bot: owner,
	sourceId: "ci-fixture",
	sourceGeneration: 1,
	policyId: policy.id,
	policyDigest: noticePolicyDigest(policy),
	targetDigest: policy.targetDigest,
	dueAt: instant,
	expiresAt: instant + 3600000,
	...patch,
});
const dbs: DatabaseSync[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
});
const setup = (mergeWindowMs = 60000) => {
	let at = instant;
	const db = new DatabaseSync(":memory:");
	dbs.push(db);
	return {
		db,
		core: openDeferredNotices(db, { now: () => at, mergeWindowMs }),
		now: (value: number) => {
			at = value;
		},
	};
};
const claim = (
	core: ReturnType<typeof openDeferredNotices>,
	items: NoticeItem[],
) =>
	core.claim({
		items: items.map((item) => ({
			operationId: item.operationId,
			expectedRevision: item.revision,
		})),
		policyDigest: items[0]?.policyDigest ?? "",
		targetDigest: items[0]?.targetDigest ?? "",
	});

test("the core merges arrivals into one durable window and never repeats a claimed batch", () => {
	const { core, now } = setup();
	expect(core.schedule(schedule("one")).dueAt).toBe(instant + 60000);
	now(instant + 30000);
	expect(core.schedule(schedule("two", { dueAt: instant + 30000 })).dueAt).toBe(
		instant + 60000,
	);
	expect(core.due()).toEqual([]);
	now(instant + 60000);
	const due = core.due();
	expect(due).toHaveLength(2);
	const first = claim(core, due);
	expect(first.fresh).toBe(true);
	expect(first.batch.items).toHaveLength(2);
	core.settle({
		batchId: first.batch.id,
		state: "unknown",
		reason: "lost-response",
	});
	expect(claim(core, due)).toMatchObject({
		fresh: false,
		batch: { id: first.batch.id, state: "unknown" },
	});
	expect(core.due()).toEqual([]);
	expect(() =>
		core.settle({ batchId: first.batch.id, state: "recorded" }),
	).toThrow("conflict");
});

test("same operation is idempotent, different data or replacement operation cannot reuse an assignment", () => {
	const { core } = setup();
	const input = schedule("one");
	expect(core.schedule(input)).toEqual(core.schedule(input));
	expect(() => core.schedule({ ...input, ticketId: "different" })).toThrow(
		"conflict",
	);
	expect(() => core.schedule({ ...input, operationId: "replacement" })).toThrow(
		"conflict",
	);
});

test("policy refresh requires a current revision and prevents merging an old target with a new one", () => {
	const { core } = setup(0);
	const one = core.schedule(schedule("one"));
	const changed = "b".repeat(64);
	const revised = core.revise({
		operationId: one.operationId,
		expectedRevision: 0,
		policyDigest: changed,
		targetDigest: "new-target",
		dueAt: instant,
		expiresAt: one.expiresAt,
	});
	core.schedule(schedule("two"));
	expect(() => claim(core, [one])).toThrow("stale");
	expect(() => claim(core, core.due())).toThrow("stale");
	expect(claim(core, [revised]).fresh).toBe(true);
	expect(() =>
		core.revise({
			operationId: one.operationId,
			expectedRevision: revised.revision,
			policyDigest: changed,
			targetDigest: "new-target",
			dueAt: instant,
			expiresAt: one.expiresAt,
		}),
	).toThrow("stale");
});

test("expiry and source withdrawal suppress only unclaimed items; source generations stay separate", () => {
	const { core, now } = setup(0);
	core.schedule(schedule("expired", { expiresAt: instant }));
	expect(core.get("notice-expired")).toMatchObject({
		state: "suppressed",
		reason: "expired",
	});
	core.schedule(schedule("one"));
	const claimed = claim(core, core.due()).batch;
	core.schedule(schedule("two"));
	core.schedule(schedule("three", { sourceGeneration: 2 }));
	expect(core.cancelSource("ci-fixture", 1)).toBe(1);
	expect(core.batch(claimed.id)?.state).toBe("claimed");
	expect(core.due()).toHaveLength(1);
	now(instant + 3600000);
	expect(core.due()).toEqual([]);
	expect(core.get("notice-three")?.reason).toBe("expired");
});

test("restart retains unclaimed notices and changes claimed batches to unknown in the task transaction", () => {
	const { core, db } = setup(0);
	core.schedule(schedule("one"));
	const taken = claim(core, core.due());
	core.schedule(schedule("two"));
	db.exec("BEGIN");
	core.recover();
	db.exec("ROLLBACK");
	expect(core.batch(taken.batch.id)?.state).toBe("claimed");
	expect(core.recover()).toBe(1);
	expect(core.recover()).toBe(0);
	expect(core.batch(taken.batch.id)?.state).toBe("unknown");
	expect(core.due().map((item) => item.operationId)).toEqual(["notice-two"]);
});

test("policy quiet windows use real timezone instants including spring DST and all-day silence", () => {
	const quiet = {
		...policy,
		timezone: "America/Los_Angeles",
		quietHours: { start: "22:00", end: "08:00" },
	};
	const at = Date.parse("2026-03-08T09:30:00.000Z");
	expect(nextNoticeDueAt(at, quiet, at + 86400000)).toBe(
		Date.parse("2026-03-08T15:00:00.000Z"),
	);
	expect(
		nextNoticeDueAt(at, quiet, Date.parse("2026-03-08T14:00:00.000Z")),
	).toBeUndefined();
	expect(
		nextNoticeDueAt(
			at,
			{ ...quiet, quietHours: { start: "00:00", end: "00:00" } },
			at + 86400000,
		),
	).toBeUndefined();
	expect(
		nextNoticeDueAt(at, { ...policy, channel: "im" }, at + 86400000),
	).toBeUndefined();
});

test("batched content keeps all task references within the native byte limit", () => {
	const items = Array.from({ length: 16 }, (_, i) => ({
		ticketId: `ticket-${i}-${"a".repeat(145)}`,
		assignmentId: `assignment-${i}-${"b".repeat(140)}`,
		title: "测试内容".repeat(2000),
	}));
	const text = deferredNoticeText(items);
	expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
		NOTIFICATION_TEXT_MAX_BYTES,
	);
	for (const item of items) {
		expect(text).toContain(item.ticketId);
		expect(text).toContain(item.assignmentId);
	}
	expect(text).not.toContain("\uFFFD");
});

function hostFixture() {
	const { core } = setup(0);
	core.schedule(schedule("one"));
	core.schedule(schedule("two"));
	const batch = claim(core, core.due()).batch;
	let currentPolicy = policy;
	const record = vi.fn(async () => ({ state: "recorded" }));
	const inherit = vi.fn(async (key: string) => {
		if (!/^[a-zA-Z0-9_-]+$/.test(key))
			throw new Error("Invalid per-record key");
	});
	const ctx = {
		get: () => ({ policy: () => currentPolicy, record }),
		dshBots: {
			memoryKernel: {},
			memoryOutlets: {
				label: (sessionId: string) => ({
					readers: [owner],
					originTrust: "candidate",
					sourceVersions: [sessionId],
					restrictions: [],
					grants: [],
				}),
				inherit,
			},
		},
	} as unknown as Context;
	const resolve = vi.fn(async (item: NoticeItem) =>
		workSchema.parse({
			assignmentId: item.assignmentId,
			ticketId: item.ticketId,
			decisionId: `decision-${item.assignmentId}`,
			triggerId: `trigger-${item.assignmentId}`,
			sourceId: item.sourceId,
			title: `Result ${item.ticketId}`,
			target: {
				bot: owner,
				botUpdatedAt: 1,
				provider: "fixture",
				model: "fixture",
			},
			expiresAt: "2099-01-01T00:00:00.000Z",
			policyVersion: "v1",
			revision: 1,
			generation: 1,
			state: "delivered",
			sessionId: item.assignmentId.endsWith("one")
				? "a6a6ff1a-f2b3-4ea6-8559-852504f4c9f1"
				: "b6a6ff1a-f2b3-4ea6-8559-852504f4c9f2",
		}),
	);
	return {
		ctx,
		batch,
		record,
		inherit,
		resolve,
		policy: (value: typeof policy) => {
			currentPolicy = value;
		},
	};
}

test("Host records one merged notice through Notifications and carries both session lineages", async () => {
	const { ctx, batch, record, inherit, resolve } = hostFixture();
	expect(
		await recordDeferredNoticeBatch(
			ctx,
			batch,
			resolve,
			new AbortController().signal,
			() => instant,
		),
	).toEqual({ state: "recorded" });
	expect(record).toHaveBeenCalledTimes(1);
	expect(resolve).toHaveBeenCalledTimes(6);
	expect(inherit).toHaveBeenCalledWith(
		expect.stringMatching(/^proactive-notice-/),
		expect.objectContaining({
			sourceVersions: expect.arrayContaining([
				"a6a6ff1a-f2b3-4ea6-8559-852504f4c9f1",
				"b6a6ff1a-f2b3-4ea6-8559-852504f4c9f2",
			]),
		}),
	);
	expect(record).toHaveBeenCalledWith(
		owner,
		expect.objectContaining({
			operationId: batch.id,
			text: expect.stringContaining("ticket-one / assignment-one"),
		}),
		expect.objectContaining({ kind: "proactive", id: batch.id }),
		expect.any(AbortSignal),
		expect.any(Function),
	);
});

test("policy or authorization changes before recording produce zero records; a lost record receipt is unknown", async () => {
	const denied = hostFixture();
	denied.policy({ ...policy, revision: 2 });
	expect(
		await recordDeferredNoticeBatch(
			denied.ctx,
			denied.batch,
			denied.resolve,
			new AbortController().signal,
			() => instant,
		),
	).toMatchObject({ state: "suppressed" });
	expect(denied.record).not.toHaveBeenCalled();
	const withdrawn = hostFixture();
	withdrawn.resolve.mockRejectedValueOnce(new Error("source revoked"));
	expect(
		await recordDeferredNoticeBatch(
			withdrawn.ctx,
			withdrawn.batch,
			withdrawn.resolve,
			new AbortController().signal,
			() => instant,
		),
	).toMatchObject({ state: "suppressed" });
	expect(withdrawn.record).not.toHaveBeenCalled();
	const lost = hostFixture();
	lost.record.mockRejectedValueOnce(new Error("receipt lost"));
	expect(
		await recordDeferredNoticeBatch(
			lost.ctx,
			lost.batch,
			lost.resolve,
			new AbortController().signal,
			() => instant,
		),
	).toMatchObject({ state: "unknown" });
	expect(lost.record).toHaveBeenCalledTimes(1);
});

test("a rule adopted during the final lineage await is checked before recording", async () => {
	const value = hostFixture();
	value.inherit.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
		value.resolve.mockRejectedValue(new Error("attention rule adopted"));
	});
	expect(await recordDeferredNoticeBatch(value.ctx, value.batch, value.resolve, new AbortController().signal, () => instant)).toMatchObject({ state: "suppressed" });
	expect(value.record).not.toHaveBeenCalled();
});
