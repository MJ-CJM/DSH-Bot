import type { DshBotRegistry } from "../registry.js";
import type { Capabilities } from "../capabilities/service.js";
import { sameBot, type BotKey } from "../../shared/identity.js";
import { Serial } from "../common/operations.js";
import { digest } from "./wire.js";
import { FeedbackApplications } from "./feedback.js";
import {
	feedbackWorkflowAction, feedbackContextsSchema,
	type FeedbackCandidate, type FeedbackContext, type FeedbackProposal, type FeedbackWorkflowAction,
} from "../../shared/proactive/feedback.js";
import type { CommandBody, ProactiveStatus, Reply, Suggestion } from "../../shared/proactive/protocol.js";
import type { ProactiveWork } from "../../shared/proactive/work.js";
import type { SuggestionActionReply } from "../../shared/proactive/remote-contract.js";

export type FeedbackRead =
	| { kind: "receipt"; commandId: string }
	| { kind: "checkpoint"; sourceId: string }
	| { kind: "feedback-overview"; cursor?: string }
	| { kind: "feedback-candidate"; id: string }
	| { kind: "feedback-history"; id: string; afterRevision?: number };
export interface FeedbackWorkflowPort {
	feedbackRead(input: FeedbackRead): Promise<Reply>;
	change(commandId: string, input: CommandBody): Promise<SuggestionActionReply>;
	workList(): Promise<ProactiveWork[]>;
	suggestions(owner?: BotKey, includeFiltered?: boolean): Promise<Suggestion[]>;
	status(): Promise<ProactiveStatus>;
}
function settlementCommand(operationId: string) {
	// A rework application already uses operationId for its core review command.
	// Give settlement a separate deterministic identity while retaining the
	// original operationId in the claim fence.
	const hash = digest(["feedback-settlement", operationId]);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Owner Remote adapter; candidate facts and adoption claims remain core-owned. */
export class FeedbackWorkflow {
	readonly #queue = new Serial();
	readonly #applications: FeedbackApplications;
	constructor(
		private readonly registry: DshBotRegistry,
		capabilities: Pick<Capabilities, "request">,
		private readonly port: FeedbackWorkflowPort,
		rework: ConstructorParameters<typeof FeedbackApplications>[2],
	) { this.#applications = new FeedbackApplications(registry, capabilities, rework); }
	async overview(cursor?: string) {
		const reply = await this.port.feedbackRead({ kind: "feedback-overview", ...(cursor ? { cursor } : {}) });
		if (reply.kind !== "feedback-overview") throw new Error("Feedback overview unavailable");
		return reply.view;
	}
	async candidate(id: string) {
		const reply = await this.port.feedbackRead({ kind: "feedback-candidate", id });
		if (reply.kind !== "feedback-candidate") throw new Error("Feedback candidate unavailable");
		return reply.candidate;
	}
	async history(id: string, afterRevision?: number) {
		const reply = await this.port.feedbackRead({ kind: "feedback-history", id, ...(afterRevision !== undefined ? { afterRevision } : {}) });
		if (reply.kind !== "feedback-history") throw new Error("Feedback history unavailable");
		return reply.history;
	}
	async contexts(owner: BotKey): Promise<FeedbackContext[]> {
		const bot = await this.registry.get(owner.botId);
		if (bot.createdAt !== owner.botCreatedAt) throw new Error("Feedback Bot generation changed");
		const [work, suggestions] = await Promise.all([this.port.workList(), this.port.suggestions(owner, true)]);
		const sources = new Map<string, number>();
		for (const sourceId of new Set([...suggestions.map(row => row.sourceId), ...work.map(row => row.sourceId)])) {
			const reply = await this.port.feedbackRead({ kind: "checkpoint", sourceId });
			if (reply.kind === "checkpoint" && reply.source && !reply.source.revoked) sources.set(sourceId, reply.source.generation);
		}
		const result: FeedbackContext[] = [{ label: bot.name,
			origin: { bot: owner, taskId: `bot:${bot.id}:${bot.createdAt}:${bot.updatedAt}`,
				evidenceDigest: digest({ bot: owner, revision: bot.updatedAt }) } }];
		for (const row of work) {
			const generation = sources.get(row.sourceId);
			if (!sameBot(row.target.bot, owner) || !row.evidenceDigest || generation === undefined) continue;
			result.push({ label: row.title,
				origin: { bot: owner, taskId: row.ticketId, evidenceDigest: row.evidenceDigest,
					source: { id: row.sourceId, generation } },
				...(["delivered", "accepted"].includes(row.state) ? { ticket: { id: row.ticketId, revision: row.revision } } : {}) });
		}
		for (const row of suggestions) {
			const generation = sources.get(row.sourceId);
			if (generation === undefined) continue;
			result.push({ label: row.title, origin: { bot: owner, taskId: row.id, evidenceDigest: digest({
				id: row.id, triggerId: row.triggerId, revision: row.revision, sourceId: row.sourceId, policyVersion: row.policyVersion,
			}), source: { id: row.sourceId, generation } }, ...(row.job ? { change: {
				sourceId: row.sourceId, sourceGeneration: generation, job: row.job, attempt: row.attempt,
			} } : {}) });
		}
		return feedbackContextsSchema.parse(result.slice(0, 201));
	}
	private async validate(proposal: FeedbackProposal) {
		const current = (await this.contexts(proposal.origin.bot)).find(row => digest(row.origin) === digest(proposal.origin));
		if (!current) throw new Error("Feedback evidence changed or is not owned by this Bot");
		if ("change" in proposal) {
			const { mode: _mode, ...scope } = proposal.change;
			if (!current.change || digest(current.change) !== digest(scope)) throw new Error("Feedback source scope changed");
		}
		if (proposal.kind === "rework" && (current.ticket?.id !== proposal.ticketId || current.ticket.revision !== proposal.expectedWorkRevision))
			throw new Error("Feedback work revision changed");
	}
	change(commandId: string, raw: FeedbackWorkflowAction): Promise<SuggestionActionReply> {
		return this.#queue.run(async () => {
			const input = feedbackWorkflowAction.parse(raw);
			if (input.action === "settle-candidate") throw new Error("Only the Host can settle feedback applications");
			const prior = await this.port.feedbackRead({ kind: "receipt", commandId });
			if (prior.kind === "receipt" && prior.receipt) {
				const duplicate = await this.port.change(commandId, { kind: "feedback-workflow", input });
				if (duplicate.kind === "receipt" && (input.action === "adopt-candidate" || input.action === "revoke-candidate")) {
					const row = await this.candidate(input.candidateId);
					if (row && ["applying", "revoking", "unknown"].includes(row.state)) return { kind: "unknown", commandId };
				}
				return duplicate;
			}
			if (input.action === "import-dataset") {
				if ((await this.registry.get(input.dataset.owner.botId)).createdAt !== input.dataset.owner.botCreatedAt)
					throw new Error("Feedback dataset Bot generation changed");
			} else if (input.action === "propose-candidate") await this.validate(input.proposal);
			else if ("candidateId" in input) {
				const row = await this.candidate(input.candidateId);
				if (!row || row.revision !== input.expectedRevision) throw new Error("Feedback candidate revision changed");
				// Withdrawals remain possible after the original CI fact expires; the
				// application adapter still fences exact Bot and target versions.
				if (input.action !== "revoke-candidate") await this.validate(row.proposal);
				else if ((await this.registry.get(row.proposal.origin.bot.botId)).createdAt !== row.proposal.origin.bot.botCreatedAt)
					throw new Error("Feedback Bot generation changed");
			}
			const reply = await this.port.change(commandId, { kind: "feedback-workflow", input });
			if (reply.kind !== "receipt" || reply.receipt.status !== "committed" ||
				(input.action !== "adopt-candidate" && input.action !== "revoke-candidate")) return reply;
			const row = await this.candidate(input.candidateId);
			if (!row?.operationId || (row.state !== "applying" && row.state !== "revoking")) return reply;
			let receipt: FeedbackCandidate["application"];
			try { receipt = await this.#applications.apply(row); } catch { /* unknown remains parked, never replayed */ }
			const settled = await this.port.change(settlementCommand(row.operationId), { kind: "feedback-workflow", input: {
				action: "settle-candidate", candidateId: row.id, expectedRevision: row.revision,
				operationId: row.operationId, outcome: receipt ? "applied" : "unknown", ...(receipt ? { receipt } : {}),
			} });
			return settled.kind === "receipt" && receipt ? reply : { kind: "unknown", commandId };
		});
	}
	close() { return this.#queue.close(); }
}
