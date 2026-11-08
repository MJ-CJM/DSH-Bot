import type { DshBotRegistry } from "../registry.js";
import type { Capabilities } from "../capabilities/service.js";
import type { MemoryManagement } from "../memory/facade.js";
import { digest as skillDigest } from "../common/operations.js";
import { digest } from "./wire.js";
import {
	feedbackCandidate,
	type FeedbackCandidate,
	type FeedbackApplicationReceipt,
} from "../../shared/proactive/feedback.js";

type Registry = Pick<DshBotRegistry, "get" | "personaSnapshot" | "manageMemory" | "invalidate">;
type Rework = (input: { ticketId: string; expectedRevision: number; evidenceDigest: string; operationId: string; reason: string }) => Promise<{ ticketId: string; assignmentId: string }>;

function findMemory(memory: MemoryManagement, botId: string, id: string) {
	let cursor: string | undefined;
	do {
		const page = memory.query({ botId, scope: "private", view: "all", limit: 200, ...(cursor ? { cursor } : {}) });
		const row = page.rows.find(item => item.version.memoryId === id);
		if (row) return { row, revision: page.revision };
		cursor = page.next;
	} while (cursor);
	throw new Error("Feedback memory is no longer available");
}

/** Called only after the core commits an explicit owner-reviewed application claim. */
export class FeedbackApplications {
	readonly #running = new Map<string, Promise<FeedbackApplicationReceipt>>();
	constructor(
		private readonly registry: Registry,
		private readonly capabilities: Pick<Capabilities, "request">,
		private readonly rework: Rework,
	) {}
	apply(raw: FeedbackCandidate): Promise<FeedbackApplicationReceipt> {
		const row = feedbackCandidate.parse(raw);
		if (!row.operationId || !["applying", "revoking"].includes(row.state) || digest(row.proposal) !== row.proposalDigest)
			return Promise.reject(new Error("Feedback application is not claimed"));
		const prior = this.#running.get(row.operationId);
		if (prior) return prior;
		const pending = this.execute(row);
		// Keep completed operation promises for the instance lifetime, including
		// failures. A retry cannot repeat a possibly committed external write.
		this.#running.set(row.operationId, pending);
		return pending;
	}
	private async execute(row: FeedbackCandidate): Promise<FeedbackApplicationReceipt> {
		const proposal = row.proposal;
		const bot = proposal.origin.bot;
		if ((await this.registry.get(bot.botId)).createdAt !== bot.botCreatedAt)
			throw new Error("Feedback Bot generation changed");
		if (proposal.kind === "preference") {
			const receipt = await this.registry.manageMemory(async memory => {
				// The registry queue is held here. Check the committed generation again
				// so delete/recreate cannot redirect a pending preference into a new Bot.
				if (!this.registry.personaSnapshot(bot.botId, bot.botCreatedAt)) throw new Error("Feedback Bot generation changed");
				if (row.state === "applying") {
					const page = memory.query({ botId: bot.botId, scope: "private", view: "all", limit: 1 });
					const memoryId = await memory.create({ botId: bot.botId, scope: "private", kind: "how_to_work",
						content: proposal.content, subject: bot.botId, factKey: `feedback:${row.id}`,
						valid: { from: Date.now(), to: null, basis: "explicit" }, expectedRevision: page.revision });
					return { kind: "memory" as const, memoryId, versionId: findMemory(memory, bot.botId, memoryId).row.version.versionId };
				}
				if (row.application?.kind !== "memory") throw new Error("Missing feedback memory receipt");
				const { row: current, revision } = findMemory(memory, bot.botId, row.application.memoryId);
				if (current.version.versionId !== row.application.versionId || current.payload.factKey !== `feedback:${row.id}` ||
					current.payload.content !== proposal.content || current.state !== "active")
					throw new Error("Feedback preference changed after adoption");
				await memory.resolve({ ids: [row.application.memoryId], choice: "reject", expectedRevision: revision });
				return { kind: "memory" as const, memoryId: row.application.memoryId,
					versionId: findMemory(memory, bot.botId, row.application.memoryId).row.version.versionId };
			});
			this.registry.invalidate();
			return receipt;
		}
		if (proposal.kind === "skill") {
			if ((proposal.before === null ? null : skillDigest(proposal.before)) !== proposal.beforeHash)
				throw new Error("Feedback skill baseline digest mismatch");
			const current = await this.capabilities.request({ action: "skillRead", bot, name: proposal.name });
			if (current.kind !== "skill") throw new Error("Skill reader unavailable");
			if (row.state === "applying") {
				if (current.hash !== proposal.beforeHash || (current.content ?? null) !== proposal.before)
					throw new Error("Feedback skill changed before adoption");
				const saved = await this.capabilities.request({ action: "skillWrite", bot, name: proposal.name,
					content: proposal.content, expectedHash: proposal.beforeHash });
				if (saved.kind !== "skill") throw new Error("Skill write receipt unavailable");
				return { kind: "skill", hash: saved.hash };
			}
			if (row.application?.kind !== "skill" || row.application.hash !== current.hash || current.content !== proposal.content)
				throw new Error("Feedback skill changed after adoption");
			if (proposal.before === null) {
				if (!current.hash) throw new Error("Feedback skill already removed");
				await this.capabilities.request({ action: "skillRemove", bot, name: proposal.name, expectedHash: current.hash });
				return { kind: "skill", hash: null };
			}
			const restored = await this.capabilities.request({ action: "skillWrite", bot, name: proposal.name,
				content: proposal.before, expectedHash: current.hash });
			if (restored.kind !== "skill") throw new Error("Skill restoration receipt unavailable");
			return { kind: "skill", hash: restored.hash };
		}
		if (proposal.kind === "rework" && row.state === "applying" && row.operationId) {
			return { kind: "rework", ...await this.rework({ ticketId: proposal.ticketId,
				expectedRevision: proposal.expectedWorkRevision, evidenceDigest: proposal.origin.evidenceDigest, operationId: row.operationId, reason: proposal.reason }) };
		}
		throw new Error("Feedback does not authorize a memory, skill, or rework operation");
	}
}
