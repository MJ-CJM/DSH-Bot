import { expect, test } from "vitest";
import { alpha, policy, withIntegrations } from "./integration-support.js";
import { flowFixture } from "./deepening/managed-flow-fixture.js";
import { notificationSchema } from "../src/shared/notifications.js";
import { notificationContent } from "../src/host/notifications/data-flow.js";

test("source-specific notification redaction clears managed bodies and preserves ordinary notices, dedup and attention charges", async () => {
	const x = await flowFixture();
	try {
		await withIntegrations(async (f) => {
			Object.assign(f.registry, x.registry());
			await f.notifications.savePolicy(
				policy("policy", "in-app", { dailyLimit: 2 }),
				0,
				false,
			);
			const proactive = {
				kind: "proactive" as const,
				id: "batch-one",
				sessionId: "clean",
			};
			const one = await f.notifications.record(
				alpha,
				{ operationId: "batch-one", policyId: "policy", text: "SOURCE_SECRET" },
				proactive,
			);
			const ordinary = await f.notifications.record(
				alpha,
				{
					operationId: "ordinary",
					policyId: "policy",
					text: "ORDINARY_PRESERVED",
				},
				{ kind: "tool", id: "batch-one", sessionId: "clean" },
			);
			const other = await f.notifications.record(
				alpha,
				{ operationId: "batch-two", policyId: "policy", text: "OTHER_SOURCE" },
				{ ...proactive, id: "batch-two" },
			);
			const scope = {
				assignmentIds: [],
				notificationOperationIds: [one.operationId, ordinary.operationId],
			};
			expect(
				f.notifications.proactiveCopyStatus(scope).blockedOperationIds,
			).toEqual([]);
			const outcome = await f.notifications.purgeProactiveCopies(scope);
			expect(outcome.purged).toBe(1);
			expect(outcome.flowCopies).toBe(1);
			expect(f.notifications.get(one.id)).toMatchObject({
				text: "[redacted]",
				state: "recorded",
				createdAt: one.createdAt,
			});
			expect(f.notifications.get(one.id).bodyDigest).toMatch(/^[a-f0-9]{64}$/);
			if (!one.flowId) throw new Error("Missing managed copy");
			expect(x.flow.get(one.flowId)).toMatchObject({
				id: one.flowId,
				state: "delivered",
				envelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
			expect(x.flow.get(one.flowId).envelope).toBeUndefined();
			expect(f.notifications.get(ordinary.id).text).toBe("ORDINARY_PRESERVED");
			expect(f.notifications.get(other.id).text).toBe("OTHER_SOURCE");
			expect(
				f.stores.notifications.table("read_state").get(one.id),
			).toBeTruthy();
			await expect(
				f.notifications.record(
					alpha,
					{ operationId: "third", policyId: "policy", text: "more" },
					{ ...proactive, id: "third" },
				),
			).rejects.toMatchObject({ code: "dsh-bot/approval-denied" });
			expect(await f.notifications.purgeProactiveCopies(scope)).toEqual({
				purged: 0,
				flowCopies: 0,
				blockedOperationIds: [],
			});
		});
	} finally {
		await x.close();
	}
});

test("unknown transport and managed send outcomes block erasure without releasing reservation", async () => {
	const x = await flowFixture();
	try {
		await withIntegrations(async (f) => {
			Object.assign(f.registry, x.registry());
			await f.notifications.savePolicy(policy("policy", "in-app"), 0, false);
			const row = await f.notifications.record(
				alpha,
				{ operationId: "uncertain", policyId: "policy", text: "AUDIT_BODY" },
				{ kind: "proactive", id: "assignment-one", sessionId: "clean" },
			);
			await f.stores.notifications.table("intents").put(
				row.id,
				notificationSchema.parse({
					...row,
					state: "unknown",
					reservation: { at: f.clock.at, day: "2026-10-24" },
				}),
			);
			const scope = {
				assignmentIds: ["assignment-one"],
				notificationOperationIds: [],
			};
			expect(
				(await f.notifications.purgeProactiveCopies(scope)).blockedOperationIds,
			).toEqual([row.id]);
			expect(f.notifications.get(row.id).text).toBe("AUDIT_BODY");
			expect(f.notifications.get(row.id).reservation?.at).toBe(f.clock.at);
			await f.stores.notifications.table("intents").put(row.id, row);
			const envelope = x.flow.draft(
				"notify-send",
				alpha,
				"clean",
				`${row.id}:send`,
				{ kind: "bot", bot: alpha },
				"AUDIT_SEND_BODY",
			);
			const flowId = await x.flow.admit(envelope);
			await expect(
				x.flow.dispatch(flowId, async () => {
					throw new Error("lost receipt");
				}),
			).rejects.toThrow("lost receipt");
			expect(
				(await f.notifications.purgeProactiveCopies(scope)).blockedOperationIds,
			).toEqual([row.id]);
			expect(x.flow.get(flowId).envelope?.content).toBe("AUDIT_SEND_BODY");
		});
	} finally {
		await x.close();
	}
});

test("expired intents do not hide retained proactive envelopes or uncertain sends", async () => {
	const x = await flowFixture();
	try {
		await withIntegrations(async (f) => {
			Object.assign(f.registry, x.registry());
			await f.notifications.savePolicy(policy("policy", "in-app"), 0, false);
			const row = await f.notifications.record(
				alpha,
				{
					operationId: "expired-proactive",
					policyId: "policy",
					text: "RETAINED_PROACTIVE",
				},
				{ kind: "proactive", id: "expired-assignment", sessionId: "clean" },
			);
			const ordinary = await f.notifications.record(
				alpha,
				{
					operationId: "expired-ordinary",
					policyId: "policy",
					text: "RETAINED_ORDINARY",
				},
				{ kind: "tool", id: "expired-assignment", sessionId: "clean" },
			);
			if (!row.flowId || !ordinary.flowId)
				throw new Error("Expected managed envelopes");
			await f.stores.notifications.table("intents").delete(row.id);
			await f.stores.notifications.table("intents").delete(ordinary.id);
			const scope = {
				assignmentIds: [],
				notificationOperationIds: [row.id, ordinary.id],
			};
			expect(await f.notifications.purgeProactiveCopies(scope)).toEqual({
				purged: 0,
				flowCopies: 1,
				blockedOperationIds: [],
			});
			expect(x.flow.get(row.flowId).envelope).toBeUndefined();
			expect(x.flow.get(ordinary.flowId).envelope?.content).toContain(
				"RETAINED_ORDINARY",
			);
			const envelope = x.flow.draft(
				"notify-send",
				alpha,
				"clean",
				`${row.id}:send`,
				{ kind: "bot", bot: alpha },
				notificationContent(row),
			);
			const flowId = await x.flow.admit(envelope);
			await expect(
				x.flow.dispatch(flowId, async () => {
					throw new Error("lost send receipt");
				}),
			).rejects.toThrow();
			expect(
				(await f.notifications.purgeProactiveCopies(scope)).blockedOperationIds,
			).toEqual([row.id]);
			expect(x.flow.get(flowId).envelope?.content).toContain(
				"RETAINED_PROACTIVE",
			);
		});
	} finally {
		await x.close();
	}
});
