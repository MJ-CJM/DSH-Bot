import type { Context } from "@deepseek-ai/cordis";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { BotKey } from "../../shared/identity.js";
import type { FeedbackWorkflowRequest, SuggestionActionReply } from "../../shared/proactive/remote-contract.js";
import type { FeedbackCandidate, FeedbackContext, FeedbackWorkflowView } from "../../shared/proactive/feedback.js";
import { capabilityResult } from "../../shared/capabilities-contract.js";

const unwrap = <T>(result: RemoteResult<T>): T => { if (!result.ok) throw result.error; return result.value; };
export interface FeedbackWorkspaceActions {
	overview(cursor?: string): Promise<FeedbackWorkflowView>;
	contexts(owner: BotKey): Promise<FeedbackContext[]>;
	change(input: FeedbackWorkflowRequest): Promise<SuggestionActionReply>;
	history(id: string, afterRevision?: number): Promise<{ rows: FeedbackCandidate[]; nextRevision?: number }>;
	readSkill(bot: BotKey, name: string): Promise<{ content?: string; hash: string | null }>;
}
export function createFeedbackActions(ctx: Context, isActive: () => boolean): FeedbackWorkspaceActions {
	const remote = () => {
		const service = ctx.get("remote.dshBot.proactive");
		if (!isActive() || !service) throw new Error("Feedback service unavailable");
		return service;
	};
	return {
		overview: async cursor => unwrap(await remote().feedbackOverview(cursor ? { cursor } : {})),
		contexts: async owner => unwrap(await remote().feedbackContexts(owner)),
		change: async input => unwrap(await remote().feedbackWorkflow(input)),
		history: async (id, afterRevision) => unwrap(await remote().feedbackHistory({ id, ...(afterRevision !== undefined ? { afterRevision } : {}) })),
		async readSkill(bot, name) {
			const capabilities = ctx.get("remote.dshBot.capabilities");
			if (!isActive() || !capabilities) throw new Error("Skill editor unavailable");
			const value = capabilityResult.parse(unwrap(await capabilities.request({ action: "skillRead", bot, name })));
			if (value.kind !== "skill") throw new Error("Skill read failed");
			return { content: value.content, hash: value.hash };
		},
	};
}
