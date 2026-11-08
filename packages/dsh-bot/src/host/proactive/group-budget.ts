import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { ProactiveWork } from "../../shared/proactive/work.js";
import { observedModelUsage } from "./model-budget.js";
import { digest } from "./wire.js";
import { Serial } from "../common/operations.js";

export type GroupBudgetPhase = "review" | "follow-up";
export type GroupBudgetSettlement = {
	kind: "settle-group-budget";
	ticketId: string;
	assignmentId: string;
	reservationId: string;
	outcome: "known" | "unknown";
	tokens?: number;
};

/** Exact native accounting only. Missing/inconsistent evidence keeps the entire
 * reservation charged; a group output alone is never a usage measurement. */
export async function measureGroupBudget(
	ctx: Context,
	work: ProactiveWork,
	turnId: string,
	memberIds: readonly string[],
	phase: GroupBudgetPhase,
) {
	const review = work.groupReview;
	const budget = phase === "review" ? review?.budget : review?.followUp?.budget;
	const groups = ctx.get("dshBotGroups");
	if (!review || !budget || !groups) throw new Error("Group budget binding missing");
	if (memberIds.length !== budget.requestCount || new Set(memberIds).size !== memberIds.length)
		throw new Error("Group budget audience changed");
	await groups.waitForProactiveReview(turnId);
	const view = await groups.view(review.group);
	const turn = view.turns.find(row => row.id === turnId);
	const deliveries = view.deliveries.filter(row => row.turnId === turnId);
	if (turn?.state !== "completed" || turn.group.groupId !== review.group.groupId ||
		turn.group.groupCreatedAt !== review.group.groupCreatedAt ||
		turn.proactive?.assignmentId !== work.assignmentId || turn.proactive.ticketId !== work.ticketId ||
		turn.proactive.provider !== work.target.provider || turn.proactive.model !== work.target.model ||
		turn.proactive.requestBudget?.maxTokens !== budget.perCallTokens ||
		turn.proactive.requestBudget.deadlineAt !== budget.deadlineAt ||
		(phase === "follow-up" && turn.proactive.followUp?.factId !== review.followUp?.fact?.id) ||
		turn.orderedMemberIds.length !== memberIds.length ||
		!memberIds.every(id => turn.orderedMemberIds.includes(id)) ||
		deliveries.length !== memberIds.length ||
		new Set(deliveries.map(row => row.memberId)).size !== memberIds.length ||
		new Set(deliveries.map(row => row.childSessionId)).size !== memberIds.length ||
		new Set(deliveries.map(row => row.childMessageId)).size !== memberIds.length)
		throw new Error("Group result does not match its reservation");
	let tokens = 0;
	for (const delivery of deliveries) {
		if (!memberIds.includes(delivery.memberId) || delivery.state !== "completed" ||
			!delivery.childSessionId || !delivery.childMessageId || !delivery.outputMessageId)
			throw new Error("Group delivery is incomplete");
		const session = await ctx.sessionController.inspect(SessionId(delivery.childSessionId));
		const inputIndex = session.events.findIndex(event => event.type === "user/message" && event.data.id === delivery.childMessageId);
		const source = session.events[inputIndex];
		if (source?.type !== "user/message" || source.data.source.kind !== "dsh-bot-group-proactive" ||
			source.data.source.assignmentId !== work.assignmentId || source.data.source.ticketId !== work.ticketId ||
			source.data.source.group.groupId !== review.group.groupId || source.data.source.group.groupCreatedAt !== review.group.groupCreatedAt ||
			source.data.source.turnId !== turnId ||
			(phase === "follow-up" && source.data.source.factId !== review.followUp?.fact?.id))
			throw new Error("Group native source changed");
		const events = session.events.slice(inputIndex + 1);
		const answers = events.filter(event => event.type === "assistant/message");
		const answer = answers[0];
		const end = events.findLast(event => event.type === "turn/end");
		if (answers.length !== 1 || answer?.type !== "assistant/message" || answer.data.interrupted ||
			end?.type !== "turn/end" || end.data.reason.kind !== "completed" || answer.data.turn !== end.data.turn ||
			answer.data.message.source.provider !== work.target.provider || answer.data.message.source.model !== work.target.model)
			throw new Error("Group native result changed");
		const usage = observedModelUsage(answer.data.usage);
		if (!usage || usage.inputTokens + usage.outputTokens > budget.perCallTokens)
			throw new Error("Group native usage missing or over budget");
		tokens += usage.inputTokens + usage.outputTokens;
	}
	if (!Number.isSafeInteger(tokens) || tokens > budget.totalTokens)
		throw new Error("Group aggregate usage exceeds reservation");
	return tokens;
}

export class GroupBudgetAccounting {
	readonly #jobs = new Map<string, Promise<void>>();
	readonly #pending = new Map<string, { id: string; body: GroupBudgetSettlement }>();
	readonly #completed = new Set<string>();
	readonly #delivery = new Serial();
	#closed = false;
	#closing?: Promise<void>;
	constructor(
		private readonly ctx: Context,
		private readonly change: (commandId: string, body: GroupBudgetSettlement) => Promise<unknown>,
	) {}
	settle(work: ProactiveWork, turnId: string, memberIds: readonly string[], phase: GroupBudgetPhase) {
		const budget = phase === "review" ? work.groupReview?.budget : work.groupReview?.followUp?.budget;
		if (!budget || this.#closed) return Promise.resolve();
		if (this.#completed.has(budget.reservationId)) return Promise.resolve();
		if (this.#pending.has(budget.reservationId)) return this.flush();
		const known = this.#jobs.get(budget.reservationId);
		if (known) return known;
		const task = (async () => {
			const groups = this.ctx.get("dshBotGroups");
			if (!groups) throw new Error("Cannot prove group execution has drained");
			// Failure to establish the lifecycle barrier leaves concurrency reserved.
			// Evidence/usage failures after it may safely release concurrency only.
			await groups.waitForProactiveReview(turnId);
			const tokens = await measureGroupBudget(this.ctx, work, turnId, memberIds, phase).catch(() => undefined);
			const body: GroupBudgetSettlement = {
				kind: "settle-group-budget", ticketId: work.ticketId, assignmentId: work.assignmentId,
				reservationId: budget.reservationId,
				...(tokens === undefined ? { outcome: "unknown" } : { outcome: "known", tokens }),
			};
			// Stable command identity lets the service reconcile a lost receipt safely.
			const hash = digest(["group-budget", body]);
			const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
			this.#pending.set(budget.reservationId, { id, body });
			await this.flush();
		})();
		this.#jobs.set(budget.reservationId, task);
		void task.finally(() => this.#jobs.delete(budget.reservationId)).catch(() => {});
		return task;
	}
	/** Retry transport only, with the same ID and bytes. The core's reservation
	 * remains authoritative; a cold Host instead preserves unknown cost in recover(). */
	flush() {
		return this.#delivery.run(async () => {
			for (const [reservationId, pending] of this.#pending) {
				const reply = await this.change(pending.id, pending.body).catch(() => undefined);
				if (!reply || typeof reply !== "object" || !("kind" in reply) || reply.kind !== "receipt" ||
					!("receipt" in reply) || !reply.receipt || typeof reply.receipt !== "object" ||
					!("commandId" in reply.receipt) || reply.receipt.commandId !== pending.id ||
					!("status" in reply.receipt) || !["committed", "duplicate"].includes(String(reply.receipt.status))) continue;
				this.#pending.delete(reservationId);
				this.#completed.add(reservationId);
				while (this.#completed.size > 256) {
					const first = this.#completed.values().next().value;
					if (first !== undefined) this.#completed.delete(first);
				}
			}
		});
	}
	close() {
		this.#closing ??= (async () => {
			this.#closed = true;
			await Promise.allSettled(this.#jobs.values());
			await this.flush();
			await this.#delivery.close();
		})();
		return this.#closing;
	}
}
