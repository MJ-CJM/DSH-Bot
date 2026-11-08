import type { Context } from "@deepseek-ai/cordis";
import { expect, test } from "vitest";
import { GroupBudgetAccounting, measureGroupBudget, type GroupBudgetSettlement } from "../src/host/proactive/group-budget.js";
import type { ProactiveWork } from "../src/shared/proactive/work.js";

function need<T>(value: T | undefined): T { if (value === undefined) throw new Error("Fixture value missing"); return value; }

function fixture() {
	const budget = { reservationId: "assignment:review", totalTokens: 8000, perCallTokens: 4000, requestCount: 2 as const, deadlineAt: new Date(Date.now() + 60000).toISOString() };
	const group = { groupId: "group", groupCreatedAt: 1 };
	const work = {
		ticketId: "ticket", assignmentId: "assignment", target: { provider: "fixture", model: "synthetic" },
		groupReview: { group, state: "linked", turnId: "turn", digest: "a".repeat(64), budget },
	} as ProactiveWork;
	const view = {
		turns: [{ id: "turn", state: "completed", group, orderedMemberIds: ["a", "b"], proactive: { ticketId: "ticket", assignmentId: "assignment", provider: "fixture", model: "synthetic", requestBudget: { maxTokens: 4000, outputTokens: 1024, deadlineAt: budget.deadlineAt } } }],
		deliveries: ["a", "b"].map(memberId => ({ memberId, turnId: "turn", state: "completed", childSessionId: memberId, childMessageId: `input-${memberId}`, outputMessageId: `output-${memberId}` })),
	};
	const session = (id: string) => ({ events: [
		{ type: "user/message", data: { id: `input-${id}`, source: { kind: "dsh-bot-group-proactive", group, ticketId: "ticket", assignmentId: "assignment", turnId: "turn" } } },
		{ type: "assistant/message", data: { turn: 1, interrupted: false, message: { id: `answer-${id}`, source: { provider: "fixture", model: "synthetic" } }, usage: { inputTokens: 40, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 5, totalTokens: 60 } } },
		{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
	] });
	const groups = { waitForProactiveReview: async (_turnId: string) => {}, view: async () => view };
	const ctx = { get: () => groups, sessionController: { inspect: async (id: string) => session(id) } };
	return { ctx: ctx as unknown as Context, raw: ctx, work, view, groups };
}

test("posthoc group accounting sums exact native usage, including cache, after all members complete", async () => {
	const f = fixture();
	expect(await measureGroupBudget(f.ctx, f.work, "turn", ["a", "b"], "review")).toBe(120);
	const submitted: GroupBudgetSettlement[] = [];
	const accounting = new GroupBudgetAccounting(f.ctx, async (id, body) => { submitted.push(body); return {kind:"receipt",receipt:{commandId:id,status:"committed"}}; });
	await accounting.settle(f.work, "turn", ["a", "b"], "review");
	await accounting.settle(f.work, "turn", ["a", "b"], "review");
	expect(submitted).toEqual([{ kind: "settle-group-budget", ticketId: "ticket", assignmentId: "assignment", reservationId: "assignment:review", outcome: "known", tokens: 120 }]);
	await accounting.close();
});

test("partial or foreign native results settle unknown rather than refunding the reservation", async () => {
	for (const corrupt of ["partial", "identity", "usage", "members", "budget", "session"] as const) {
		const f = fixture();
		if (corrupt === "partial") need(f.view.deliveries[1]).state = "unknown";
		if (corrupt === "members") need(f.view.deliveries[1]).memberId = "a";
		if (corrupt === "budget") need(f.view.turns[0]).proactive.requestBudget.maxTokens = 4001;
		if (corrupt === "session") need(f.view.deliveries[1]).childSessionId = "a";
		if (corrupt === "identity" || corrupt === "usage") {
			const inspect = f.raw.sessionController.inspect;
			f.raw.sessionController.inspect = async id => {
				const session = await inspect(id);
				if (corrupt === "identity") need(need(session.events[0]).data.source).assignmentId = "other-assignment";
				else need(need(session.events[1]).data.usage).totalTokens = 1;
				return session;
			};
		}
		const submitted: GroupBudgetSettlement[] = [];
		const accounting = new GroupBudgetAccounting(f.ctx, async (id, body) => { submitted.push(body); return {kind:"receipt",receipt:{commandId:id,status:"committed"}}; });
		await accounting.settle(f.work, "turn", ["a", "b"], "review");
		expect(submitted).toEqual([{ kind: "settle-group-budget", ticketId: "ticket", assignmentId: "assignment", reservationId: "assignment:review", outcome: "unknown" }]);
		await accounting.close();
	}
});

test("accounting and close wait for the native lifecycle drain; a failed drain preserves reservation", async () => {
	const f = fixture();
	let release: () => void = () => {};
	const barrier = new Promise<void>(resolve => { release = resolve; });
	f.groups.waitForProactiveReview = async () => barrier;
	const submitted: GroupBudgetSettlement[] = [];
	const accounting = new GroupBudgetAccounting(f.ctx, async (id, body) => { submitted.push(body); return {kind:"receipt",receipt:{commandId:id,status:"committed"}}; });
	const settlement = accounting.settle(f.work, "turn", ["a", "b"], "review");
	let closed = false;
	const close = accounting.close().then(() => { closed = true; });
	await Promise.resolve(); expect(submitted).toEqual([]); expect(closed).toBe(false);
	release(); await settlement; await close;
	expect(submitted).toHaveLength(1);
	const g = fixture();
	g.groups.waitForProactiveReview = async () => { throw new Error("Drain unavailable"); };
	const blocked = new GroupBudgetAccounting(g.ctx, async (_id, body) => { submitted.push(body); });
	await expect(blocked.settle(g.work, "turn", ["a", "b"], "review")).rejects.toThrow("Drain unavailable");
	expect(submitted).toHaveLength(1);
	await blocked.close();
});

test("group settlement retries the same transport operation after unknown, rejection, or a mismatched receipt", async () => {
	const f=fixture(), sent:Array<{id:string;body:GroupBudgetSettlement}>=[];
	const replies=[{kind:"unknown"},{kind:"rejected",code:"stale"},{kind:"receipt",receipt:{commandId:"wrong",status:"committed"}}];
	const accounting=new GroupBudgetAccounting(f.ctx,async(id,body)=>{sent.push({id,body:structuredClone(body)});return replies.shift()??{kind:"receipt",receipt:{commandId:id,status:"duplicate"}};});
	await accounting.settle(f.work,"turn",["a","b"],"review");
	await accounting.flush();await accounting.flush();await accounting.flush();
	expect(sent).toHaveLength(4);expect(sent.every(row=>row.id===sent[0]?.id&&JSON.stringify(row.body)===JSON.stringify(sent[0]?.body))).toBe(true);
	await accounting.flush();expect(sent).toHaveLength(4);
	await accounting.close();
});
