import type { FollowUpPolicyRequest, ProactiveSetupRequest } from "../../shared/proactive/setup.js";
import type { FollowUpPageRequest, Subject } from '../../shared/proactive/follow-up.js';
import type { FollowUpGroupAbandonRequest, FollowUpGroupChoiceRequest, FollowUpGroupAcceptRequest } from '../../shared/proactive/group-follow-up.js';
import type { ExportMethodRequest, ImportMethodRequest } from "../../shared/proactive/method-package.js";
import type { DocumentRequest } from "../../shared/proactive/document.js";
import type { ActivityRequest, WorkDetailRequest } from '../../shared/proactive/activity.js';
import type { BeginForget } from "../../shared/proactive/governance.js";
import type { ResponsibilityMutationRequest } from "../../shared/proactive/responsibility.js";
import type { WorkContinuationRequest, WorkHistoryRequest } from "../../shared/proactive/work.js";
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
	type FollowUpActionRequest,
	type FollowUpWatchRequest,
	type SuggestionActionReply,
} from "../../shared/proactive/remote-contract.js";
import type { ProactiveLifecycle } from "./lifecycle.js";
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
		private readonly lifecycle: ProactiveLifecycle,
	) {
		super(ctx, "dshBotProactiveRemote", { namespace: "dshBot.proactive" });
	}
	private get service() { return this.lifecycle.service; }
	@Remote async setup(input: ProactiveSetupRequest) {
    this.requireOwner();
    return this.lifecycle.setup(input);
  }
  @Remote async followUpSummary(input: Subject) {
    this.requireOwner();
    return this.lifecycle.followUpSummary(input);
  }
  @Remote async followUpPage(input: FollowUpPageRequest) {
    this.requireOwner();
    return this.service.followUpPage(input);
  }
  @Remote async followUpPolicy(input: FollowUpPolicyRequest) {
    this.requireOwner();
    return this.lifecycle.followUpPolicy(input);
  }
  @Remote async followUpWatchCreate({ commandId, ...input }: FollowUpWatchRequest): Promise<SuggestionActionReply> {
    this.requireOwner();
    if (input.watch.source.kind !== 'manual') return { kind: 'rejected', code: 'forbidden' };
    return this.service.createFollowUpWatch(commandId, input);
  }
  @Remote async followUpAction({ commandId, ...input }: FollowUpActionRequest) {
    this.requireOwner();
    return this.service.followUpAction(commandId, input);
  }
  @Remote async followUpGroupChoice(input: FollowUpGroupChoiceRequest) {
    this.requireOwner(); return this.service.followUpGroupChoice(input);
  }
  @Remote async followUpGroupAccept(input: FollowUpGroupAcceptRequest) {
    this.requireOwner(); return this.service.followUpGroupAccept(input);
  }
  @Remote async followUpGroupAbandon(input: FollowUpGroupAbandonRequest) {
    this.requireOwner(); return this.service.followUpGroupAbandon(input);
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
  @Remote async activityPage(input: ActivityRequest) {
    this.requireOwner(); return this.service.activityPage(input);
  }
  @Remote async submitDocument(input: DocumentRequest) {
    this.requireOwner(); return this.service.submitDocument(input);
  }
  @Remote async reconcileWork(input: WorkDetailRequest) {
    this.requireOwner(); return this.service.reconcileWork(input);
  }
  @Remote async workDetail(input: WorkDetailRequest) {
    this.requireOwner(); return this.service.workDetail(input);
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
  @Remote async exportMethod(input: ExportMethodRequest) { this.requireOwner(); return this.service.feedbackWorkflow.exportMethod(input); }
  @Remote async importMethod(input: ImportMethodRequest) { this.requireOwner(); return this.service.feedbackWorkflow.importMethod(input); }
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
  @Remote async workContinuation({ commandId, ...input }: WorkContinuationRequest) {
    this.requireOwner();
    return this.service.continueWork(commandId, input);
  }
	@Remote async listWork() {
		this.requireOwner();
		return this.service.workList();
	}
	@Remote async botWork(owner: BotKey) {
		this.requireOwner();
		return this.service.workList(owner);
	}
	@Remote async status() {
		this.requireOwner();
		return this.service.status();
	}
}
