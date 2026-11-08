import type { BeginForget } from "../../shared/proactive/governance.js";
import type { ResponsibilityMutationRequest } from "../../shared/proactive/responsibility.js";
import type { WorkHistoryRequest } from "../../shared/proactive/work.js";
import type { WorkspaceReviewRequest } from "../../shared/proactive/workspace-repair.js";
import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { TypertContribution } from "@deepseek-ai/dsh-typert-registry";
import {
	PROACTIVE_REMOTE,
	type SuggestionRequest,
	type AcceptRequest,
	type CancelRequest,
	type ReviewRequest,
	type FeedbackRequest,
	type FeedbackWorkflowRequest,
	type PauseRequest,
	type RevokeSourceRequest,
	type ExternalNoticeRequest,
	type GroupReviewRequest,
} from "../../shared/proactive/remote-contract.js";
import type { ProactiveService } from "./service.js";
import type { BotKey } from "../../shared/identity.js";

export const PROACTIVE_HOST = {
	package: "dsh-bot/proactive",
	face: "host",
	schemas: [],
	get invocations() {
		return PROACTIVE_REMOTE.descriptors;
	},
	model: { services: [], events: [], objects: [] },
} satisfies TypertContribution;

export class ProactiveRemote extends TypertRemoteService {
	constructor(
		ctx: Context,
		private readonly service: ProactiveService,
	) {
		super(ctx, "dshBotProactiveRemote", { namespace: "dshBot.proactive" });
	}
	private requireOwner() {
		if (this.ctx.invocation?.peer.principal.kind !== "owner")
			throw new Error("Proactive owner access required");
	}
	@Remote async forgetSource({
		commandId,
		...input
	}: BeginForget & { commandId: string }) {
		this.requireOwner();
		return this.service.governance.forget(commandId, input);
	}
	@Remote async responsibilities(owner: BotKey) {
		this.requireOwner();
		return this.service.responsibilities(owner);
	}
	@Remote async changeResponsibility(input: ResponsibilityMutationRequest) {
		this.requireOwner();
		return this.service.changeResponsibility(input);
	}
	@Remote async workHistory(input: WorkHistoryRequest) {
		this.requireOwner();
		return this.service.workHistory(input);
	}
	@Remote async workspaceReview(input: WorkspaceReviewRequest) {
		this.requireOwner();
		return this.service.workspaceReview(input);
	}
	@Remote async botSuggestions(owner: BotKey) {
		this.requireOwner();
		return this.service.suggestions(owner);
	}
 @Remote async adjustSuggestion({commandId,...input}:{commandId:string;decisionId:string;expectedRevision:number;title:string}){this.requireOwner();return this.service.change(commandId,{kind:"adjust-suggestion",...input});}
	@Remote async listSuggestions() {
		this.requireOwner();
		return this.service.suggestions();
	}
	@Remote async changeSuggestion({ commandId, ...input }: SuggestionRequest) {
		this.requireOwner();
		return this.service.change(commandId, {
			...input,
			kind: "suggestion-action",
		});
	}
	@Remote async accept({ commandId, ...input }: AcceptRequest) {
		this.requireOwner();
		return this.service.accept(commandId, input);
	}
	@Remote async cancel({ commandId, ...input }: CancelRequest) {
		this.requireOwner();
		return this.service.cancel(commandId, input);
	}
	@Remote async pause({ commandId, ...input }: PauseRequest) {
		this.requireOwner();
		return this.service.pause(commandId, input);
	}
	@Remote async revokeSource(input: RevokeSourceRequest) {
		this.requireOwner();
		return this.service.revokeConfiguredSource(input);
	}
	@Remote async feedback({ commandId, input }: FeedbackRequest) {
		this.requireOwner();
		return this.service.change(commandId, { kind: "feedback-rule", input });
	}
	@Remote async feedbackOverview(input: { cursor?: string }) {
		this.requireOwner();
		return this.service.feedbackWorkflow.overview(input.cursor);
	}
	@Remote async feedbackCandidate(input: { id: string }) {
		this.requireOwner();
		return this.service.feedbackWorkflow.candidate(input.id);
	}
	@Remote async feedbackHistory(input: { id: string; afterRevision?: number }) {
		this.requireOwner();
		return this.service.feedbackWorkflow.history(input.id, input.afterRevision);
	}
	@Remote async feedbackContexts(owner: BotKey) {
		this.requireOwner();
		return this.service.feedbackWorkflow.contexts(owner);
	}
	@Remote async feedbackWorkflow({
		commandId,
		input,
	}: FeedbackWorkflowRequest) {
		this.requireOwner();
		return this.service.feedbackWorkflow.change(commandId, input);
	}
	@Remote async groupReview(input: GroupReviewRequest) {
		this.requireOwner();
		return this.service.groupReview(input);
	}
	@Remote async externalNotice(input: ExternalNoticeRequest) {
		this.requireOwner();
		return this.service.externalNotice(input);
	}
	@Remote async review({ commandId, ...input }: ReviewRequest) {
		this.requireOwner();
		return this.service.review(commandId, input);
	}
	@Remote async listWork() {
		this.requireOwner();
		return this.service.workList();
	}
	@Remote async status() {
		this.requireOwner();
		return this.service.status();
	}
}
