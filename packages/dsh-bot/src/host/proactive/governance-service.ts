import type { Context } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import { Serial } from "../common/operations.js";
import type {
	BeginForget,
	ForgetReceipt,
} from "../../shared/proactive/governance.js";
import type { ProactiveConfig } from "./config.js";
import type { ProactiveService } from "./service.js";
import { purgeManagedArtifacts } from "./governance-artifacts.js";
import { digest } from "./wire.js";

export class ProactiveGovernance {
	readonly #queue = new Serial();
	#lastSweep = 0;
	constructor(
		private readonly ctx: Context,
		private readonly port: ProactiveService,
		private readonly config: Pick<ProactiveConfig, "proactiveGovernanceIntervalMs">,
		private readonly root: string,
	) {}
	private async receipt(operationId: string) {
		const reply = await this.port.read({ kind: "forget-receipt", operationId });
		if (reply.kind !== "forget-receipt" || !reply.receipt)
			throw new Error("Forget receipt unavailable");
		return reply.receipt;
	}
	private async block(
		operationId: string,
		reason: NonNullable<ForgetReceipt["blockedReason"]>,
	) {
		const reply = await this.port.change(randomUUID(), {
			kind: "forget-block",
			operationId,
			reason,
		});
		if (reply.kind !== "receipt")
			throw new Error("Forget copy verification outcome unavailable");
		return this.receipt(operationId);
	}
	private async purge() {
		const reply = await this.port.read({ kind: "governance-pending" });
		if (reply.kind !== "governance-pending") return;
		for (const plan of reply.plans) {
			const result = await purgeManagedArtifacts(this.root, plan);
			await this.port.change(randomUUID(), {
				kind: "governance-purge",
				input: { planId: plan.id, result },
			});
		}
	}
	forget(commandId: string, input: BeginForget) {
		return this.#queue.run(async () => {
			const begin = await this.port.change(commandId, {
				kind: "forget-begin",
				input,
			});
			if (begin.kind !== "receipt")
				throw new Error(
					"Forget fence outcome unavailable; retry the same operation",
				);
			const previous = await this.receipt(input.operationId);
			const drained: Array<{ assignmentId: string; receiptDigest: string }> =
				[];
			for (const assignmentId of previous.pendingAssignments) {
				const reply = await this.port.read({
					kind: "work-assignment",
					assignmentId,
				});
				const work = reply.kind === "work" ? reply.work : null;
				if (!work) continue;
				if (["pending", "claimed", "sent", "delivered"].includes(work.state))
					await this.port.cancel(randomUUID(), {
						ticketId: work.ticketId,
						expectedRevision: work.revision,
					});
			}
			await this.port.execution.idle();
			const scope = await this.port.read({
				kind: "source-cleanup-scope",
				sourceId: input.sourceId,
				generation: input.generation,
			});
			if (scope.kind !== "source-cleanup-scope")
				throw new Error("Cleanup scope unavailable");
			if (!(await this.port.reconcileForgetResults(scope.scope.assignmentIds)))
				return this.block(input.operationId, "result-copy-unknown");
			for (const assignmentId of previous.pendingAssignments) {
				const reply = await this.port.read({
					kind: "work-assignment",
					assignmentId,
				});
				const work = reply.kind === "work" ? reply.work : null;
				if (
					work &&
					(["accepted", "failed", "denied", "cancelled"].includes(work.state) ||
						(work.state === "superseded" && work.supersededBy))
				)
					drained.push({
						assignmentId,
						receiptDigest: digest({
							assignmentId,
							state: work.state,
							revision: work.revision,
						}),
					});
			}
			if (
				previous.pendingAssignments.some(
					(id) => !drained.some((row) => row.assignmentId === id),
				)
			) {
				await this.port.change(randomUUID(), {
					kind: "forget-finish",
					input: { operationId: input.operationId, drained },
				});
				return this.receipt(input.operationId);
			}
			if (scope.scope.assignmentIds.length) {
				const groups = this.ctx.get("dshBotGroups");
				if (!(await groups?.purgeProactiveCopies(scope.scope.assignmentIds).catch(() => false)))
					return this.block(input.operationId, "group-copy-unknown");
			}
			const notices = this.ctx.get("dshBotNotifications");
			if (notices) {
				const status = notices.proactiveCopyStatus(scope.scope);
				if (status.blockedOperationIds.length)
					return this.block(input.operationId, "notification-copy-unknown");
				const cleaned = await notices.purgeProactiveCopies(scope.scope);
				if (cleaned.blockedOperationIds.length)
					return this.block(input.operationId, "notification-copy-unknown");
			}
			await this.port.change(randomUUID(), {
				kind: "forget-finish",
				input: { operationId: input.operationId, drained },
			});
			await this.purge();
			return this.receipt(input.operationId);
		});
	}
	maintain() {
		return this.#queue.run(async () => {
			const now = Date.now();
			if (
				now - this.#lastSweep >=
				(this.config.proactiveGovernanceIntervalMs ?? 3600000)
			) {
				const result = await this.port.change(randomUUID(), {
					kind: "governance-sweep",
				});
				if (result.kind === "receipt") this.#lastSweep = now;
			}
			await this.purge();
		});
	}
	close() {
		return this.#queue.close();
	}
}
