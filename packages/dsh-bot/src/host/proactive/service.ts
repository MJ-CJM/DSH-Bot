import { GroupBudgetAccounting } from "./group-budget.js";
import { verifyGroupRepairEvidence } from "./group-repair.js";
import type { GroupRepairGrant } from "../../shared/proactive/group-repair.js";
import { ProactiveGovernance } from "./governance-service.js";
import { FeedbackWorkflow, type FeedbackRead } from "./feedback-workflow.js";
import type { Capabilities } from "../capabilities/service.js";
import { readRepairReview, formatRepairReview } from "./repair.js";
import { formatWorkspaceReview } from "./workspace-repair.js";
import { GROUP_TEXT_MAX_BYTES } from "../../shared/groups.js";
import { DeferredNoticePump } from "./notice-pump.js";
import type { WorkspaceReviewRequest } from "../../shared/proactive/workspace-repair.js";
import {
	openResultJournal,
	type ResultJournal,
	type PendingResult,
} from "./result-journal.js";
import type { Reply, Request } from "../../shared/proactive/protocol.js";
import type { BotKey } from "../../shared/identity.js";
import type {
	Responsibility,
	ResponsibilityMutationRequest,
	ResponsibilityMutationResult,
} from "../../shared/proactive/responsibility.js";
import type { WorkHistoryRequest } from "../../shared/proactive/work.js";
import type { WorkspaceRepairGrant } from "../../shared/proactive/workspace-repair.js";
import {
	createWorkspaceRepairOffer,
	workspaceSpecification,
	readWorkspaceReview,
} from "./workspace-repair.js";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "@deepseek-ai/cordis";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { sameBot } from "../../shared/identity.js";
import type {
	AcceptWork,
	groupFollowUpCandidate,
	ProactiveWork,
	ReviewWork,
} from "../../shared/proactive/work.js";
import { Serial } from "../common/operations.js";
import { AutomaticAdmissionQueue } from "./auto-admission.js";
import type { Groups } from "../groups/service.js";
import type {
	ExternalNoticeRequest,
	GroupReviewRequest,
	GroupReviewResult,
	RevokeSourceRequest,
	SuggestionActionReply,
} from "../../shared/proactive/remote-contract.js";
import type { RepairGrant } from "../../shared/proactive/repair.js";
import { verifySavedArtifact } from "./repair.js";
import { DirectExecution } from "./execution.js";
import {
	capabilities,
	commandBodySchema,
	type CommandBody,
	type ProactiveStatus,
	type Suggestion,
	type AutoCiRule,
} from "../../shared/proactive/protocol.js";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { pollCiFeed, type FeedStatus } from "./sources/ci-feed.js";
import { CoordinatorClient } from "./coordinator-client.js";
import type { ProactiveConfig } from "./config.js";
import { digest } from "./wire.js";
import {
	ciSourceId,
	observeCiPage,
	type CiPage,
	type CiScope,
} from "./sources/ci.js";

const bindingSchema = z.strictObject({
	installationId: z.uuid(),
	storeId: z.uuid().nullable(),
});
const bindingDomain = defineDomain({
	name: "dsh_bot_proactive",
	version: 1,
	tables: { identity: domainTable(bindingSchema) },
});
const unavailable = { ...capabilities, ingest: false, snapshot: false };

export class ProactiveService {
	#client?: CoordinatorClient;
	#resultJournal?: ResultJournal;
	#storeId?: string;
	readonly #feedStop = new AbortController();
	#feed?: Promise<void>;
	#feedStatus?: FeedStatus;
	readonly #groupFollowUpQueue = new Serial();
	#maintenance?: Promise<void>;
	#recoveries = 0;
	readonly #automatic = new AutomaticAdmissionQueue<{
		row: Suggestion;
		rule?: AutoCiRule;
		policy?: Responsibility;
	}>({
		candidates: async () => {
			if (
				!this.directRoute ||
				this.#state !== "ready" ||
				!this.#client?.available ||
				!this.#storeId
			)
				return [];
			const response = await this.read({ kind: "auto-candidates" });
			const candidates: {
				row: Suggestion;
				rule?: AutoCiRule;
				policy?: Responsibility;
			}[] =
				response.kind === "auto-candidates"
					? response.rows.map(({ suggestion, responsibility }) => ({
							row: suggestion,
							policy: responsibility,
						}))
					: [];
			const rule = this.config.proactiveAutoCiRule;
			if (
				rule &&
				Date.parse(rule.expiresAt) > Date.now() &&
				!(await this.responsibilities(rule.target.bot)).some(
					(row) =>
						row.responsibility.id ===
						`legacy-${digest([rule.id, rule.target.bot]).slice(0, 32)}`,
				)
			) {
				const source = await this.read({
					kind: "checkpoint",
					sourceId: rule.sourceId,
				});
				if (
					source.kind === "checkpoint" &&
					!source.source?.revoked &&
					source.source?.generation === rule.sourceGeneration
				)
					candidates.push(
						...(await this.suggestions(rule.target.bot))
							.filter(
								(row) =>
									row.sourceId === rule.sourceId &&
									row.state === "open" &&
									!row.adjusted,
							)
							.map((row) => ({ row, rule })),
					);
			}
			return candidates.sort(
				(a, b) =>
					a.row.observedAt.localeCompare(b.row.observedAt) ||
					a.row.id.localeCompare(b.row.id),
			);
		},
		admit: async ({ row, rule, policy }) => {
			const target = policy?.target ?? rule?.target,
				ruleId = policy?.id ?? rule?.id;
			if (!target || !ruleId) return "skip";
			let repair: AcceptWork["repair"],
				workspaceRepair: AcceptWork["workspaceRepair"];
			try {
				await this.validateTarget(target);
				if (policy && policy.action !== "inspect-ci-result") {
					if (policy.action === "repair-workspace") {
						const offer = (await this.workspaceOffers()).find(
							(o) =>
								o.sourceId === row.sourceId &&
								o.specDigest === policy.actionScopeDigest,
						);
						if (!offer || offer.executor === "command") return "skip";
						workspaceRepair = {
							workspaceId: offer.workspaceId,
							specDigest: offer.specDigest,
							baselineDigest: offer.baselineDigest,
							executor: offer.executor,
						};
					} else {
						const offer = this.repairOffers().find(
							(o) =>
								o.sourceId === row.sourceId &&
								o.specDigest === policy.actionScopeDigest &&
								o.executor ===
									(policy.action === "repair-external" ? "external" : "native"),
						);
						if (!offer) return "skip";
						repair = {
							fixtureId: offer.fixtureId,
							specDigest: offer.specDigest,
							executor: offer.executor,
						};
					}
				}
			} catch {
				return "skip";
			}
			const reply = await this.change(randomUUID(), {
				kind: "auto-accept",
				ruleId,
				target,
				decisionId: row.id,
				sourceId: row.sourceId,
				policyVersion: row.policyVersion,
				expectedRevision: row.revision,
				...(policy
					? { responsibility: { id: policy.id, revision: policy.revision } }
					: {}),
				...(repair ? { repair } : {}),
				...(workspaceRepair ? { workspaceRepair } : {}),
			});
			if (reply.kind === "receipt") return "accepted";
			if (reply.kind === "unknown") return "unknown";
			return reply.code === "conflict" ? "busy" : "skip";
		},
		dispatch: async ({ row }) => this.dispatch(row.id),
		onError: () =>
			this.ctx.logger.warn(
				"[dsh-bot] proactive automatic admission paused until the next wake-up",
			),
	});
	#state: ProactiveStatus["state"];
	readonly execution: DirectExecution;
	readonly feedbackWorkflow: FeedbackWorkflow;
	readonly deferredNotices: DeferredNoticePump;
	readonly governance: ProactiveGovernance;
	readonly groupBudgets: GroupBudgetAccounting;
	constructor(
		private readonly ctx: Context,
		private readonly config: ProactiveConfig,
		capabilities?: Pick<Capabilities, "request">,
	) {
		this.execution = new DirectExecution(
			ctx,
			this,
			join(resolveDshHome(), "dsh-bot-proactive"),
		);
		this.groupBudgets = new GroupBudgetAccounting(ctx, (id, body) =>
			this.change(id, body),
		);
		this.governance = new ProactiveGovernance(
			this.ctx,
			this,
			config,
			join(resolveDshHome(), "dsh-bot-proactive"),
		);
		this.deferredNotices = new DeferredNoticePump(ctx, this, config);
		this.feedbackWorkflow = new FeedbackWorkflow(
			ctx.dshBots,
			{
				request: (input) => {
					if (!capabilities) throw new Error("Capabilities unavailable");
					return capabilities.request(input);
				},
			},
			this,
			async (input) => {
				const reply = await this.read({
					kind: "work-ticket",
					ticketId: input.ticketId,
				});
				const work = reply.kind === "work" ? reply.work : null;
				if (
					!work ||
					work.evidenceDigest !== input.evidenceDigest ||
					work.revision !== input.expectedRevision
				)
					throw new Error("Feedback delivery changed");
				const result = await this.review(input.operationId, {
					ticketId: input.ticketId,
					expectedRevision: work.revision,
					evidenceDigest: input.evidenceDigest,
					review: "rework",
					approved: true,
					feedback: {
						failures: [
							{
								criterion: "owner-feedback",
								actual: input.reason,
								expected:
									"Resolve the specific owner feedback before requesting acceptance",
							},
						],
					},
				});
				if (result.kind !== "receipt")
					throw new Error("Rework outcome unavailable");
				const next = await this.read({
					kind: "work-ticket",
					ticketId: input.ticketId,
				});
				if (next.kind !== "work" || !next.work)
					throw new Error("Rework unavailable");
				return {
					ticketId: next.work.ticketId,
					assignmentId: next.work.assignmentId,
				};
			},
		);
		this.#state = config.proactiveEnabled ? "starting" : "disabled";
	}
	async start() {
		if (!this.config.proactiveEnabled) return;
		this.#resultJournal = await openResultJournal(this.ctx);
		await this.connect();
		if (!this.#feedStop.signal.aborted) this.#maintenance = this.maintain();
	}
	private async maintain() {
		const signal = this.#feedStop.signal;
		let healthySince = Date.now();
		while (!signal.aborted) {
			try {
				await delay(
					this.config.proactiveMaintenanceIntervalMs ?? 1000,
					undefined,
					{ signal },
				);
				if (signal.aborted) break;
				if (!this.#client?.available || this.#state !== "ready") {
					this.#state = "unavailable";
					if (this.#recoveries >= (this.config.proactiveRecoveryAttempts ?? 5))
						continue;
					this.execution.cancelAll();
					this.ctx.get("dshBotGroups")?.stopProactiveReviews();
					await this.execution.idle();
					this.#recoveries++;
					await this.#client?.close(this.#storeId).catch(() => {});
					await delay(
						Math.min(
							30000,
							(this.config.proactiveRecoveryIntervalMs ?? 1000) *
								2 ** (this.#recoveries - 1),
						),
						undefined,
						{ signal },
					);
					if (signal.aborted) break;
					await this.connect();
					healthySince = Date.now();
				} else {
					if (Date.now() - healthySince > 60000) this.#recoveries = 0;
					await this.status();
					await this.groupBudgets.flush();
					await this.deferredNotices.pump();
					await this.governance.maintain();
					this.#automatic.wake();
				}
			} catch {
				if (!signal.aborted)
					this.ctx.logger.warn(
						"[dsh-bot] proactive maintenance will retry within its configured limit",
					);
			}
		}
	}
	private async connect() {
		if (this.#feedStop.signal.aborted) return;
		try {
			const runtime = this.ctx.get("subprocess");
			if (!runtime) throw new Error("Native subprocess service unavailable");
			const root = await realpath(resolveDshHome());
			const domain = await this.ctx.storageDomain.open(bindingDomain);
			try {
				const table = domain.table("identity");
				const existing = table.get("binding");
				const binding = existing ?? {
					installationId: randomUUID(),
					storeId: null,
				};
				if (!existing) await table.put("binding", binding);
				this.#client = await CoordinatorClient.launch(
					runtime,
					this.config.proactiveNodeExecutable,
					join(root, "dsh-bot-proactive"),
					root,
					this.config.proactiveTimeoutMs,
				);
				const hello = await this.#client.request({
					kind: "hello",
					installationId: binding.installationId,
					expectedStoreId: binding.storeId,
					budget: this.config.proactiveModelDailyBudget,
					externalBudget: this.config.proactiveExternalDailyBudget,
					notice: !!this.config.proactiveNotificationPolicy,
					noticeConfig: this.config.proactiveNoticeConfig,
					governanceConfig: this.config.proactiveGovernance,
					...(this.config.proactiveRepairFixture
						? { feedbackSource: this.config.proactiveRepairFixture.sourceId }
						: {}),
					...(this.config.proactiveAutoCiRule
						? { autoRule: this.config.proactiveAutoCiRule }
						: {}),
				});
				if (
					hello.kind !== "hello" ||
					!hello.capabilities.ingest ||
					!hello.capabilities.snapshot ||
					(binding.storeId !== null && binding.storeId !== hello.storeId)
				)
					throw new Error("Proactive capability handshake failed");
				this.#storeId = hello.storeId;
				await table.put("binding", {
					installationId: binding.installationId,
					storeId: hello.storeId,
				});
				this.#state = "ready";
				await this.#resultJournal?.flush(hello.storeId, (id, body) =>
					this.sendCommand(id, body),
				);
				await this.groupBudgets.flush();
				this.scheduleGroupFollowUps();
				for (const row of await this.workList()) {
					// Only a pending assignment is known to have never been dispatched.
					// Claimed/sent rows are parked by the coordinator before handshake.
					if (row.state === "pending") this.execution.enqueue(row);
				}
				this.#automatic.wake();
				if (this.config.proactiveCiFeed && !this.#feed) {
					this.#feedStatus = "waiting";
					this.#feed = pollCiFeed(
						join(root, "dsh-bot-proactive"),
						this.config.proactiveCiFeed,
						this,
						this.#feedStop.signal,
						(status) => {
							if (this.#feedStatus !== "revoked") this.#feedStatus = status;
						},
					).catch(() => {
						this.#feedStatus = "unavailable";
					});
				}
			} finally {
				await domain.close();
			}
		} catch {
			this.#state = "unavailable";
			await this.#client?.close(this.#storeId);
		}
	}
	async status(): Promise<ProactiveStatus> {
		if (this.#state !== "ready")
			return { state: this.#state, capabilities: unavailable };
		const storeId = this.#storeId;
		if (storeId && this.#client?.available) {
			const result = await this.#client
				.request({ kind: "snapshot", storeId })
				.catch(() => undefined);
			if (result?.kind === "snapshot" && result.snapshot.storeId === storeId)
				return {
					state: "ready",
					capabilities: {
						...capabilities,
						automaticGroup:
							this.config.proactiveGroupReviewEnabled &&
							!!this.directRoute &&
							!!this.ctx.get("dshBotGroups") &&
							!result.snapshot.executionControl.paused,
						externalNotification:
							!!this.config.proactiveExternalNotificationPolicy &&
							this.ctx.get("dshBotNotifications")?.supported() === true &&
							!result.snapshot.executionControl.paused,
						directExecution:
							!!this.directRoute && !result.snapshot.executionControl.paused,
					},
					snapshot: result.snapshot,
					...(this.#feedStatus ? { localFeed: this.#feedStatus } : {}),
					...(this.config.proactiveCiFeed
						? {
								localFeedScope: {
									id: ciSourceId(this.config.proactiveCiFeed.scope),
									...this.config.proactiveCiFeed.scope,
								},
							}
						: {}),
					...(this.directRoute && !result.snapshot.executionControl.paused
						? {
								directRoute: this.directRoute,
								repairOffers: this.repairOffers(),
								workspaceOffers: await this.workspaceOffers(),
								actionScopes: await this.actionScopes(),
								groupRepairOffers: await this.groupRepairOffers(),
							}
						: {}),
				};
		}
		this.#state = "unavailable";
		return { state: "unavailable", capabilities: unavailable };
	}
	async stageResult(commandId: string, body: PendingResult) {
		if (!this.#storeId || !this.#resultJournal)
			throw new Error("Proactive result persistence unavailable");
		await this.#resultJournal.stage(this.#storeId, commandId, body);
	}
	async acknowledgeResult(
		commandId: string,
		_body: PendingResult,
		reply: Reply,
	) {
		if (!this.#storeId || !this.#resultJournal)
			throw new Error("Proactive result persistence unavailable");
		return this.#resultJournal.acknowledge(this.#storeId, commandId, reply);
	}
	private async sendCommand(
		commandId: string,
		body: CommandBody,
	): Promise<Reply> {
		const storeId = this.#storeId;
		if (this.#state !== "ready" || !storeId || !this.#client?.available)
			return {
				kind: "unknown",
				commandId,
				protocolVersion: 1,
				correlationId: commandId,
			};
		return this.#client
			.request({
				kind: "command",
				command: {
					commandId,
					body,
					storeId,
					actorRef: "local-host",
					payloadDigest: digest(body),
				},
			})
			.catch(() => ({
				kind: "unknown" as const,
				commandId,
				protocolVersion: 1 as const,
				correlationId: commandId,
			}));
	}
	async submit(
		commandId: string,
		input: CommandBody,
		onResultStaged?: () => void,
	) {
		const body = commandBodySchema.parse(input);
		if (body.kind === "report-result") {
			await this.stageResult(commandId, body);
			onResultStaged?.();
		}
		const reply = await this.sendCommand(commandId, body);
		if (body.kind === "report-result")
			await this.acknowledgeResult(commandId, body, reply);
		return reply;
	}
	async read(
		input: Request extends infer R
			? R extends { storeId: string }
				? Omit<R, "storeId" | "protocolVersion" | "correlationId" | "channel">
				: never
			: never,
	) {
		if (!this.#storeId || this.#state !== "ready" || !this.#client?.available)
			throw new Error("Proactive coordinator unavailable");
		return this.#client.request({
			...input,
			storeId: this.#storeId,
		} as Request);
	}
	async feedbackRead(input: FeedbackRead) {
		return this.read(input);
	}
	async workHistory(input: WorkHistoryRequest) {
		const reply = await this.read({ kind: "work-history", input });
		if (reply.kind !== "work-history") throw new Error("History unavailable");
		return reply.history;
	}
	async responsibilities(owner: BotKey) {
		const reply = await this.read({ kind: "responsibilities", owner });
		if (reply.kind !== "responsibilities")
			throw new Error("Responsibilities unavailable");
		return reply.rows;
	}
	async changeResponsibility({
		commandId,
		mutation,
	}: ResponsibilityMutationRequest): Promise<ResponsibilityMutationResult> {
		try {
			const bot = await this.ctx.dshBots.get(mutation.owner.botId);
			if (bot.createdAt !== mutation.owner.botCreatedAt)
				throw new Error("Bot changed");
			if ("draft" in mutation) {
				await this.validateTarget(mutation.draft.target);
				const source = await this.read({
					kind: "checkpoint",
					sourceId: mutation.draft.source.id,
				});
				if (
					source.kind !== "checkpoint" ||
					source.source?.revoked ||
					source.source?.generation !== mutation.draft.source.generation
				)
					throw new Error("Source changed");
				const policy = mutation.draft;
				if (
					policy.action !== "inspect-ci-result" &&
					!(await this.actionScopes()).some(
						(scope) =>
							scope.action === policy.action &&
							scope.digest === policy.actionScopeDigest,
					)
				)
					throw new Error("Action configuration changed");
			}
		} catch {
			return { kind: "rejected", code: "stale" };
		}
		const result = await this.change(commandId, {
			kind: "responsibility-mutation",
			input: mutation,
		});
		if (result.kind !== "receipt")
			return result.kind === "unknown" ? { kind: "unknown" } : result;
		this.#automatic.wake();
		const row = (await this.responsibilities(mutation.owner)).find(
			(row) => row.responsibility.id === mutation.id,
		);
		return row
			? { kind: "applied", responsibility: row.responsibility }
			: { kind: "unknown" };
	}
	async suggestions(owner?: BotKey, includeFiltered?: boolean) {
		const storeId = this.#storeId;
		if (this.#state === "disabled") return [];
		if (this.#state !== "ready" || !storeId || !this.#client?.available)
			throw new Error("Proactive coordinator unavailable");
		const reply = await this.#client.request({
			kind: "suggestions",
			storeId,
			...(owner ? { owner } : {}),
			...(includeFiltered ? { includeFiltered } : {}),
		});
		if (reply.kind !== "suggestions")
			throw new Error("Proactive suggestions unavailable");
		return reply.suggestions;
	}
	async ciCheckpoint(scope: CiScope) {
		const storeId = this.#storeId;
		if (this.#state !== "ready" || !storeId || !this.#client?.available)
			throw new Error("Proactive coordinator unavailable");
		const reply = await this.#client.request({
			kind: "checkpoint",
			storeId,
			sourceId: ciSourceId(scope),
		});
		if (reply.kind !== "checkpoint")
			throw new Error("Proactive source checkpoint unavailable");
		return reply.source;
	}
	async observeCi(commandId: string, scope: CiScope, page: CiPage) {
		const input = observeCiPage(scope, page);
		const reply = await this.submit(commandId, input);
		if (reply.kind === "receipt" && reply.receipt?.stored)
			this.scheduleGroupFollowUps();
		if (reply.kind === "receipt") this.#automatic.wake();
		return reply;
	}
	revokeCi(commandId: string, scope: CiScope) {
		return this.submit(commandId, {
			kind: "revoke-source",
			sourceId: ciSourceId(scope),
			generation: scope.generation,
		});
	}
	async revokeConfiguredSource(
		input: RevokeSourceRequest,
	): Promise<SuggestionActionReply> {
		const scope = this.config.proactiveCiFeed?.scope;
		if (
			!scope ||
			input.generation !== scope.generation ||
			input.sourceId !== ciSourceId(scope)
		)
			return { kind: "rejected", code: "stale" };
		const reply = await this.change(input.commandId, {
			kind: "revoke-source",
			sourceId: input.sourceId,
			generation: input.generation,
		});
		if (reply.kind === "receipt") this.#feedStatus = "revoked";
		return reply;
	}
	async receipt(commandId: string) {
		const storeId = this.#storeId;
		if (this.#state !== "ready" || !storeId || !this.#client?.available)
			throw new Error("Proactive coordinator unavailable");
		return this.#client.request({ kind: "receipt", commandId, storeId });
	}
	private get directRoute() {
		const {
			proactiveEnabled,
			proactiveExecutionEnabled,
			proactiveProvider,
			proactiveModel,
		} = this.config;
		return proactiveEnabled &&
			proactiveExecutionEnabled &&
			proactiveProvider &&
			proactiveModel
			? { provider: proactiveProvider, model: proactiveModel }
			: undefined;
	}
	private repairOffers() {
		const fixture = this.config.proactiveRepairFixture;
		if (!fixture) return [];
		const { id: fixtureId, title, sourceId } = fixture;
		const endpoint = this.config.proactiveExternalExecutor;
		return [
			{
				fixtureId,
				title,
				sourceId,
				specDigest: digest([fixture, "native"]),
				executor: "native" as const,
			},
			...(endpoint
				? [
						{
							fixtureId,
							title,
							sourceId,
							specDigest: digest([fixture, endpoint]),
							executor: "external" as const,
						},
					]
				: []),
		];
	}
	async workspaceOffers() {
		const workspace = this.config.proactiveWorkspaceRepair;
		if (!workspace) return [];
		return Promise.all([
			createWorkspaceRepairOffer(workspace, "native"),
			...(this.config.proactiveCommandExecutor
				? [
						createWorkspaceRepairOffer(
							workspace,
							"command",
							this.config.proactiveCommandExecutor,
						),
					]
				: []),
		]);
	}
	async actionScopes() {
		return [
			...this.repairOffers().map((offer) => ({
				action:
					offer.executor === "external"
						? ("repair-external" as const)
						: ("repair-fixture" as const),
				digest: offer.specDigest,
				title: offer.title,
			})),
			...(await this.workspaceOffers()).map((offer) => ({
				action: "repair-workspace" as const,
				digest: offer.specDigest,
				title: `${offer.title} / ${offer.executorLabel}`,
			})),
		];
	}
	workspaceConfiguration(grant: WorkspaceRepairGrant, sourceId: string) {
		const workspace = this.config.proactiveWorkspaceRepair,
			command = this.config.proactiveCommandExecutor;
		if (
			!workspace ||
			workspace.sourceId !== sourceId ||
			workspace.id !== grant.workspaceId ||
			(grant.executor === "command" && !command) ||
			workspaceSpecification(
				workspace,
				grant.executor,
				command ?? undefined,
			) !== grant.specDigest
		)
			throw new Error("Approved workspace configuration changed");
		return {
			workspace,
			...(grant.executor === "command" && command ? { command } : {}),
		};
	}
	repairConfiguration(repair: RepairGrant, sourceId: string) {
		const fixture = this.config.proactiveRepairFixture;
		if (
			!fixture ||
			!this.repairOffers().some(
				(offer) =>
					offer.fixtureId === repair.fixtureId &&
					offer.sourceId === sourceId &&
					offer.specDigest === repair.specDigest &&
					offer.executor === repair.executor,
			)
		)
			throw new Error("Approved repair configuration changed");
		return {
			fixture,
			endpoint: this.config.proactiveExternalExecutor,
			node: this.config.proactiveNodeExecutable,
		};
	}
	get modelOutputTokens() {
		return this.config.proactiveModelOutputTokens ?? 1024;
	}
	get executionTimeoutMs() {
		return this.config.proactiveExecutionTimeoutMs;
	}
	async groupRepairOffers() {
		const groups = this.ctx.get("dshBotGroups");
		if (
			!this.config.proactiveGroupRepairEnabled ||
			!groups ||
			!this.directRoute
		)
			return [];
		const offers: Array<{ title: string; grant: GroupRepairGrant }> = [];
		for (const row of await groups.list()) {
			const members = row.members.filter(
				(member) => member.enabled && member.removedAt === undefined,
			);
			if (
				row.group.archived ||
				row.group.state !== "ready" ||
				row.reason ||
				row.unavailableMemberIds.length ||
				members.length !== 2
			)
				continue;
			const first = members[0],
				second = members[1];
			if (!first || !second || sameBot(first.bot, second.bot)) continue;
			const bots = await Promise.all([
				this.ctx.dshBots.get(first.bot.botId),
				this.ctx.dshBots.get(second.bot.botId),
			]);
			if (
				bots[0]?.createdAt !== first.bot.botCreatedAt ||
				bots[1]?.createdAt !== second.bot.botCreatedAt
			)
				continue;
			const roles = [
				{ memberId: first.id, bot: first.bot, botUpdatedAt: bots[0].updatedAt },
				{
					memberId: second.id,
					bot: second.bot,
					botUpdatedAt: bots[1].updatedAt,
				},
			];
			for (const [supervisor, implementer] of [
				[roles[0], roles[1]],
				[roles[1], roles[0]],
			]) {
				if (supervisor && implementer)
					offers.push({
						title: row.group.name,
						grant: {
							group: {
								groupId: row.group.id,
								groupCreatedAt: row.group.createdAt,
							},
							rootSessionId: row.group.rootSessionId,
							membershipRevision: row.group.membershipRevision,
							supervisor,
							implementer,
							maxCalls: 3,
						},
					});
			}
			if (offers.length >= 32) break;
		}
		return offers;
	}
	async validateGroupRepair(
		work: Pick<ProactiveWork, "groupRepair" | "target" | "workspaceRepair">,
	) {
		const grant = work.groupRepair;
		if (!grant) return;
		if (
			work.workspaceRepair?.executor !== "native" ||
			!sameBot(grant.supervisor.bot, work.target.bot) ||
			grant.supervisor.botUpdatedAt !== work.target.botUpdatedAt ||
			!(await this.groupRepairOffers()).some(
				(offer) => digest(offer.grant) === digest(grant),
			)
		)
			throw new Error("Group repair authorization changed");
	}
	async validateTarget(target: ProactiveWork["target"]) {
		const route = this.directRoute;
		if (
			this.#state !== "ready" ||
			!this.#client?.available ||
			!route ||
			route.provider !== target.provider ||
			route.model !== target.model
		)
			throw new Error("Proactive execution route unavailable");
		const bot = await this.ctx.dshBots.get(target.bot.botId);
		if (
			!sameBot(target.bot, { botId: bot.id, botCreatedAt: bot.createdAt }) ||
			bot.updatedAt !== target.botUpdatedAt
		)
			throw new Error("Proactive Bot incarnation changed");
		return bot;
	}
	async workList() {
		if (this.#state === "disabled") return [];
		const reply = await this.readWork({ kind: "work-list" });
		if (reply.kind !== "work-list")
			throw new Error("Proactive work unavailable");
		return reply.work;
	}
	private async readWork(
		input:
			| { kind: "work-list" }
			| { kind: "work"; decisionId: string }
			| { kind: "work-ticket"; ticketId: string },
	) {
		const storeId = this.#storeId;
		if (this.#state !== "ready" || !storeId || !this.#client?.available)
			throw new Error("Proactive work unavailable");
		return this.#client.request({ ...input, storeId });
	}
	async change(
		commandId: string,
		body: CommandBody,
	): Promise<SuggestionActionReply> {
		const reply = await this.submit(commandId, body);
		if (reply.kind === "receipt" && reply.receipt) {
			if (
				[
					"report-result",
					"cancel",
					"pause-execution",
					"revoke-source",
				].includes(body.kind)
			)
				this.#automatic.wake();
			return { kind: "receipt", receipt: reply.receipt };
		}
		if (reply.kind === "rejected")
			return { kind: "rejected", code: reply.code };
		return { kind: "unknown", commandId };
	}
	async accept(
		commandId: string,
		input: AcceptWork,
	): Promise<SuggestionActionReply> {
		try {
			await this.validateTarget(input.target);
			await this.validateGroupRepair(input);
			if (input.repair) this.repairConfiguration(input.repair, input.sourceId);
			if (input.workspaceRepair)
				this.workspaceConfiguration(input.workspaceRepair, input.sourceId);
		} catch {
			return { kind: "rejected", code: "forbidden" };
		}
		const reply = await this.change(commandId, {
			...input,
			kind: "accept-decision",
		});
		if (reply.kind === "receipt" && reply.receipt.status === "committed") {
			await this.dispatch(input.decisionId);
		}
		return reply;
	}
	private async dispatch(decisionId: string) {
		const current = await this.readWork({ kind: "work", decisionId }).catch(
			() => undefined,
		);
		if (current?.kind === "work" && current.work)
			this.execution.enqueue(current.work);
	}
	async notify(decisionId: string, assignmentId: string, signal: AbortSignal) {
		const reply = await this.read({ kind: "work", decisionId });
		if (reply.kind === "work" && reply.work?.assignmentId === assignmentId)
			await this.deferredNotices.schedule(reply.work, signal);
	}
	async workspaceReview(input: WorkspaceReviewRequest) {
		let beforeGeneration: number | undefined;
		do {
			const page = await this.workHistory({
				ticketId: input.ticketId,
				beforeGeneration,
				limit: 5,
			});
			const row = page.versions.find(
				(row) =>
					row.assignmentId === input.assignmentId &&
					row.evidenceDigest === input.evidenceDigest,
			);
			if (row)
				return readWorkspaceReview(
					join(resolveDshHome(), "dsh-bot-proactive"),
					row,
				);
			beforeGeneration = page.nextBeforeGeneration;
		} while (beforeGeneration !== undefined);
		throw new Error("Workspace delivery changed");
	}
	async groupReview(input: GroupReviewRequest): Promise<GroupReviewResult> {
		const groups = this.ctx.get("dshBotGroups");
		if (!groups) throw new Error("Group review unavailable");
		const reply = await this.readWork({
			kind: "work-ticket",
			ticketId: input.ticketId,
		});
		const work = reply.kind === "work" ? reply.work : null;
		const artifactReview =
			work?.state === "delivered" &&
			(work.repairEvidence?.verification.exitCode === 0 ||
				work.workspaceEvidence?.verification.exitCode === 0)
				? (work.repairEvidence ?? work.workspaceEvidence)
				: undefined;
		if (
			!work ||
			(work.state !== "accepted" && !artifactReview) ||
			work.revision !== input.expectedRevision
		)
			throw new Error("Group review is stale");
		const summaries = await groups.list();
		if (work.groupReview) {
			const receipt = work.groupReview;
			if (input.cancelFollowUp) {
				const result = await this.change(randomUUID(), {
					kind: "deny-group-follow-up",
					ticketId: work.ticketId,
					expectedRevision: work.revision,
				});
				if (result.kind !== "receipt")
					throw new Error("Group follow-up changed");
			}
			const root = summaries.find(
				({ group }) =>
					group.id === receipt.group.groupId &&
					group.createdAt === receipt.group.groupCreatedAt,
			)?.group;
			return receipt.state === "linked" && receipt.turnId && root
				? {
						kind: "linked",
						rootSessionId: root.rootSessionId,
						turnId: receipt.turnId,
						...(receipt.followUp
							? {
									followUpState: input.cancelFollowUp
										? "denied"
										: receipt.followUp.state,
								}
							: {}),
					}
				: { kind: "unknown" };
		}
		if (input.cancelFollowUp) throw new Error("No group follow-up");
		if (!this.config.proactiveGroupReviewEnabled)
			throw new Error("Group review unavailable");
		await this.validateTarget(work.target);
		if (Date.parse(work.expiresAt) <= Date.now())
			throw new Error("Group review expired");
		const candidates = summaries.flatMap((row) => {
			const { group } = row;
			const members = row.members.filter(
				(member) => member.enabled && member.removedAt === undefined,
			);
			const [first, second] = members;
			// The whole audience is shown and authorized. A larger group
			// needs a different budget and is outside this two-reviewer route.
			if (
				group.archived ||
				group.state !== "ready" ||
				row.reason ||
				row.unavailableMemberIds.length ||
				members.length !== 2 ||
				!first ||
				!second
			)
				return [];
			return [
				{
					row,
					choice: {
						group: { groupId: group.id, groupCreatedAt: group.createdAt },
						title: group.name,
						rootSessionId: group.rootSessionId,
						memberIds: [first.id, second.id] as [string, string],
						memberBotIds: [first.bot.botId, second.bot.botId] as [
							string,
							string,
						],
					},
				},
			];
		});
		if (!input.group && input.reviewedDigest === undefined)
			return { kind: "choices", groups: candidates.map((item) => item.choice) };
		const selected = candidates.find(
			(item) =>
				item.choice.group.groupId === input.group?.groupId &&
				item.choice.group.groupCreatedAt === input.group.groupCreatedAt,
		);
		if (!selected) throw new Error("Group membership changed");
		const { row, choice } = selected;
		const revisions = await Promise.all(
			choice.memberBotIds.map((id) => this.ctx.dshBots.get(id)),
		);
		const [first, second] = revisions;
		if (!first || !second) throw new Error("Group reviewer unavailable");
		const botRevisions: [number, number] = [first.updatedAt, second.updatedAt];
		const followUpAvailable = this.config.proactiveGroupFollowUpEnabled;
		const followUpMember =
			input.followUpMemberId &&
			row.members.find(
				(member) =>
					member.id === input.followUpMemberId &&
					choice.memberIds.includes(member.id),
			);
		if (input.followUpMemberId && (!followUpAvailable || !followUpMember))
			throw new Error("Group follow-up member unavailable");
		const followUp = followUpMember
			? {
					memberId: followUpMember.id,
					bot: followUpMember.bot,
					botRevision:
						choice.memberIds[0] === followUpMember.id
							? first.updatedAt
							: second.updatedAt,
					membershipRevision: row.group.membershipRevision,
				}
			: undefined;
		if (artifactReview) await this.verifyGroupArtifact(work);
		const text = artifactReview
			? work.workspaceEvidence
				? formatWorkspaceReview(
						work,
						await readWorkspaceReview(
							join(resolveDshHome(), "dsh-bot-proactive"),
							work,
						),
					)
				: formatRepairReview(
						work,
						await readRepairReview(
							join(resolveDshHome(), "dsh-bot-proactive"),
							work,
						),
					)
			: work.title;
		if (Buffer.byteLength(text, "utf8") > GROUP_TEXT_MAX_BYTES)
			throw new Error(
				"Full artifact exceeds group review size; narrow the approved workspace scope",
			);
		const approval = digest([
			work.ticketId,
			work.assignmentId,
			work.revision,
			work.target,
			choice,
			row.group.membershipRevision,
			row.members,
			botRevisions,
			text,
			artifactReview ? work.evidenceDigest : undefined,
			followUp,
		]);
		if (input.reviewedDigest === undefined)
			return {
				kind: "preview",
				choice,
				text,
				digest: approval,
				followUpAvailable,
				...(followUp ? { followUpMemberId: followUp.memberId } : {}),
			};
		if (input.reviewedDigest !== approval)
			throw new Error("Group review changed");
		const claim = await this.change(randomUUID(), {
			kind: "claim-group-review",
			ticketId: work.ticketId,
			expectedRevision: work.revision,
			group: choice.group,
			digest: approval,
			...(artifactReview ? { evidenceDigest: work.evidenceDigest } : {}),
			...(followUp ? { followUp } : {}),
		});
		if (claim.kind === "unknown") return { kind: "unknown" };
		if (claim.kind !== "receipt") throw new Error("Group review rejected");
		const grantedReply = await this.read({
			kind: "work-ticket",
			ticketId: work.ticketId,
		});
		const grantedWork = grantedReply.kind === "work" ? grantedReply.work : null;
		if (!grantedWork || grantedWork.assignmentId !== work.assignmentId)
			throw new Error("Group grant changed");
		const budget = grantedWork.groupReview?.budget;
		if (work.responsibility && !budget)
			throw new Error("Group task budget missing");

		const turn = await groups
			.startProactiveReview(
				choice.group,
				{
					operationId: `proactive:${work.assignmentId}`,
					expectedMembershipRevision: row.group.membershipRevision,
					text,
					memberIds: choice.memberIds,
				},
				{
					ticketId: work.ticketId,
					assignmentId: work.assignmentId,
					provider: work.target.provider,
					model: work.target.model,
					botRevisions,
					...(budget
						? {
								requestBudget: {
									maxTokens: budget.perCallTokens,
									outputTokens: Math.min(
										this.modelOutputTokens,
										Math.floor(budget.perCallTokens / 2),
									),
									deadlineAt: budget.deadlineAt,
								},
							}
						: {}),
				},
				async () => {
					if (artifactReview) await this.verifyGroupArtifact(work);
					await this.verifyGroupDispatch(work, approval);
				},
			)
			.catch(() => undefined);
		const settled = await this.change(randomUUID(), {
			kind: "settle-group-review",
			ticketId: work.ticketId,
			expectedRevision: work.revision + 1,
			digest: approval,
			...(turn ? { turnId: turn.id } : {}),
		});
		if (turn && budget)
			void this.groupBudgets
				.settle(grantedWork, turn.id, choice.memberIds, "review")
				.catch(() =>
					this.ctx.logger.warn(
						"[dsh-bot] group review budget awaits reconciliation",
					),
				);
		if (turn && settled.kind === "receipt" && followUp)
			void groups
				.waitForProactiveReview(turn.id)
				.then(() => this.scheduleGroupFollowUps())
				.catch(() => {});
		return turn && settled.kind === "receipt"
			? {
					kind: "linked",
					rootSessionId: choice.rootSessionId,
					turnId: turn.id,
					...(followUp ? { followUpState: "armed" } : {}),
				}
			: { kind: "unknown" };
	}
	private async verifyGroupArtifact(work: ProactiveWork) {
		if (
			work.groupRepair &&
			!(await verifyGroupRepairEvidence(
				this.ctx,
				join(resolveDshHome(), "dsh-bot-proactive"),
				work,
			))
		)
			throw new Error("Group repair evidence changed");
		if (work.workspaceEvidence) {
			await readWorkspaceReview(
				join(resolveDshHome(), "dsh-bot-proactive"),
				work,
			);
			return;
		}
		if (
			!(await verifySavedArtifact(
				join(resolveDshHome(), "dsh-bot-proactive"),
				work,
			).catch(() => false))
		)
			throw new Error("Group repair evidence changed");
	}
	private async verifyGroupDispatch(
		work: ProactiveWork,
		groupReviewDigest: string,
		groupFactId?: string,
	) {
		this.#feedStop.signal.throwIfAborted();
		if (groupFactId && !this.config.proactiveGroupFollowUpEnabled)
			throw new Error("Group follow-up disabled");
		await this.validateTarget(work.target);
		const storeId = this.#storeId;
		const permitted = storeId
			? await this.#client?.request({
					kind: "dispatch-permitted",
					storeId,
					assignmentId: work.assignmentId,
					groupReviewDigest,
					...(groupFactId ? { groupFactId } : {}),
				})
			: undefined;
		if (permitted?.kind !== "dispatch-permitted" || !permitted.permitted)
			throw new Error("Group review withdrawn");
	}
	scheduleGroupFollowUps() {
		const groups = this.ctx.get("dshBotGroups");
		if (
			!this.config.proactiveGroupReviewEnabled ||
			!this.config.proactiveGroupFollowUpEnabled ||
			this.#state !== "ready" ||
			!groups ||
			this.#feedStop.signal.aborted
		)
			return;
		void this.#groupFollowUpQueue
			.run(async () => {
				const storeId = this.#storeId;
				if (!storeId || this.#feedStop.signal.aborted) return;
				const reply = await this.#client?.request({
					kind: "group-follow-ups",
					storeId,
				});
				if (reply?.kind !== "group-follow-ups") return;
				for (const candidate of reply.candidates) {
					if (this.#feedStop.signal.aborted) break;
					await this.dispatchGroupFollowUp(groups, candidate).catch(() => {
						this.ctx.logger.warn(
							"[dsh-bot] proactive group follow-up unavailable",
						);
					});
				}
			})
			.catch(() =>
				this.ctx.logger.warn("[dsh-bot] proactive group follow-up unavailable"),
			);
	}
	private async dispatchGroupFollowUp(
		groups: Groups,
		{ work, fact }: z.output<typeof groupFollowUpCandidate>,
	) {
		const review = work.groupReview,
			grant = review?.followUp;
		if (
			review?.state !== "linked" ||
			!review.turnId ||
			grant?.state !== "armed"
		)
			return;
		const request = {
			ticketId: work.ticketId,
			expectedRevision: work.revision,
		};
		const view = await groups.view(review.group).catch(() => undefined);
		const parent = view?.turns.find((turn) => turn.id === review.turnId);
		const member = view?.members.find((row) => row.id === grant.memberId);
		const bot = await this.ctx.dshBots
			.get(grant.bot.botId)
			.catch(() => undefined);
		if (
			!view ||
			view.reason ||
			view.group.archived ||
			view.unavailableMemberIds.length ||
			view.group.membershipRevision !== grant.membershipRevision ||
			!member?.enabled ||
			member.removedAt !== undefined ||
			!sameBot(member.bot, grant.bot) ||
			!bot ||
			bot.createdAt !== grant.bot.botCreatedAt ||
			bot.updatedAt !== grant.botRevision
		) {
			await this.change(randomUUID(), {
				...request,
				kind: "deny-group-follow-up",
			});
			return;
		}
		if (parent && ["accepted", "running"].includes(parent.state)) return;
		if (
			!parent ||
			!["completed", "partial"].includes(parent.state) ||
			!view.deliveries.some(
				(row) =>
					row.turnId === parent.id &&
					row.memberId === grant.memberId &&
					row.state === "completed",
			)
		) {
			await this.change(randomUUID(), {
				...request,
				kind: "deny-group-follow-up",
			});
			return;
		}
		await this.validateTarget(work.target);
		this.#feedStop.signal.throwIfAborted();
		const claim = await this.change(randomUUID(), {
			...request,
			kind: "claim-group-follow-up",
			factId: fact.id,
		});
		if (claim.kind !== "receipt") return;
		const grantedReply = await this.read({
			kind: "work-ticket",
			ticketId: work.ticketId,
		});
		const grantedWork = grantedReply.kind === "work" ? grantedReply.work : null;
		if (!grantedWork || grantedWork.assignmentId !== work.assignmentId)
			throw new Error("Follow-up grant changed");
		const budget = grantedWork.groupReview?.followUp?.budget;
		if (work.responsibility && !budget)
			throw new Error("Group task budget missing");
		const turn = await groups
			.startProactiveReview(
				review.group,
				{
					operationId: `proactive-follow-up:${work.assignmentId}`,
					expectedMembershipRevision: grant.membershipRevision,
					text: fact.text,
					memberIds: [grant.memberId],
				},
				{
					ticketId: work.ticketId,
					assignmentId: work.assignmentId,
					provider: work.target.provider,
					model: work.target.model,
					botRevisions: [grant.botRevision],
					...(budget
						? {
								requestBudget: {
									maxTokens: budget.perCallTokens,
									outputTokens: Math.min(
										this.modelOutputTokens,
										Math.floor(budget.perCallTokens / 2),
									),
									deadlineAt: budget.deadlineAt,
								},
							}
						: {}),
					followUp: { predecessorTurnId: parent.id, factId: fact.id },
				},
				() => this.verifyGroupDispatch(work, review.digest, fact.id),
			)
			.catch(() => undefined);
		await this.change(randomUUID(), {
			kind: "settle-group-follow-up",
			ticketId: work.ticketId,
			expectedRevision: work.revision + 1,
			factId: fact.id,
			...(turn ? { turnId: turn.id } : {}),
		});
		if (turn && budget)
			void this.groupBudgets
				.settle(grantedWork, turn.id, [grant.memberId], "follow-up")
				.catch(() =>
					this.ctx.logger.warn(
						"[dsh-bot] group follow-up budget awaits reconciliation",
					),
				);
	}
	async externalNotice(input: ExternalNoticeRequest) {
		const policyId = this.config.proactiveExternalNotificationPolicy;
		const notices = this.ctx.get("dshBotNotifications");
		if (!policyId || !notices?.supported())
			throw new Error("External notice unavailable");
		const read = async () => {
			const status = await this.status();
			if (status.state !== "ready" || status.snapshot?.executionControl.paused)
				throw new Error("Proactive work is paused");
			const reply = await this.readWork({
				kind: "work-ticket",
				ticketId: input.ticketId,
			});
			const work = reply.kind === "work" ? reply.work : null;
			const sessionId = work?.sessionId ?? work?.groupRepair?.rootSessionId;
			if (
				work?.state !== "accepted" ||
				work.revision !== input.expectedRevision ||
				!sessionId ||
				Date.parse(work.expiresAt) <= Date.now()
			)
				throw new Error("External notice review is stale");
			await this.validateTarget(work.target);
			const storeId = this.#storeId;
			const permitted = storeId
				? await this.#client?.request({
						kind: "dispatch-permitted",
						storeId,
						assignmentId: work.assignmentId,
						noticeRevision: work.revision,
					})
				: undefined;
			if (permitted?.kind !== "dispatch-permitted" || !permitted.permitted)
				throw new Error("External notice authorization withdrawn");
			return { work, sessionId };
		};
		const { work, sessionId } = await read();
		const signal = AbortSignal.any([
			this.#feedStop.signal,
			AbortSignal.timeout(30000),
		]);
		const operationId = `proactive-external:${work.assignmentId}`;
		await notices.record(
			work.target.bot,
			{ operationId, policyId, text: work.title, relatedId: work.ticketId },
			{ kind: "proactive-review", id: work.assignmentId, sessionId },
			signal,
		);
		const preview = await notices.previewReviewed(operationId);
		if (input.reviewedDigest === undefined) return preview;
		if (preview.digest !== input.reviewedDigest)
			throw new Error("External notice changed");
		const result = await notices.deliverReviewed(
			operationId,
			input.reviewedDigest,
			signal,
			async () => {
				await read();
			},
		);
		return { ...preview, state: result.state };
	}
	async verifyDispatch(
		work: ProactiveWork,
		options?: { groupAlreadyValidated?: boolean },
	) {
		await this.validateTarget(work.target);
		if (options?.groupAlreadyValidated) {
			if (
				work.groupRepair &&
				(!this.config.proactiveGroupRepairEnabled ||
					work.workspaceRepair?.executor !== "native")
			)
				throw new Error("Group repair unavailable");
		} else await this.validateGroupRepair(work);
		if (work.repair) this.repairConfiguration(work.repair, work.sourceId);
		if (work.workspaceRepair)
			await this.workspaceConfiguration(work.workspaceRepair, work.sourceId);
		const storeId = this.#storeId;
		if (!storeId || !this.#client?.available)
			throw new Error("Proactive execution unavailable");
		const current = await this.#client.request({
			kind: "dispatch-permitted",
			assignmentId: work.assignmentId,
			storeId,
		});
		if (current.kind !== "dispatch-permitted" || !current.permitted)
			throw new Error("Proactive dispatch withdrawn");
		if (
			work.autoRuleId &&
			(!this.config.proactiveAutoCiRule ||
				Date.parse(this.config.proactiveAutoCiRule.expiresAt) <= Date.now())
		)
			throw new Error("Proactive automatic rule expired");
	}
	async pause(
		commandId: string,
		input: { paused: boolean; expectedRevision: number },
	) {
		const active = input.paused
			? (await this.workList()).filter((row) =>
					["pending", "claimed", "sent"].includes(row.state),
				)
			: [];
		const reply = await this.change(commandId, {
			...input,
			kind: "pause-execution",
		});
		if (reply.kind === "receipt" && input.paused) {
			await Promise.all(
				active.map((row) =>
					this.drainExecution(row.ticketId, row.assignmentId),
				),
			);
			this.execution.cancelAll();
			this.ctx.get("dshBotGroups")?.stopProactiveReviews();
		}
		if (reply.kind === "receipt" && !input.paused)
			this.scheduleGroupFollowUps();
		return reply;
	}
	async cancel(
		commandId: string,
		input: { ticketId: string; expectedRevision: number },
	) {
		const before = await this.read({
			kind: "work-ticket",
			ticketId: input.ticketId,
		});
		const row = before.kind === "work" ? before.work : null;
		const reply = await this.change(commandId, { ...input, kind: "cancel" });
		if (reply.kind === "receipt" && row)
			await this.drainExecution(row.ticketId, row.assignmentId);
		return reply;
	}
	private async drainExecution(ticketId: string, assignmentId: string) {
		if (!(await this.execution.cancelAndDrain(ticketId, assignmentId))) return;
		const response = await this.read({ kind: "work-assignment", assignmentId });
		const row = response.kind === "work" ? response.work : null;
		if (
			row?.responsibility &&
			["cancelled", "unknown", "denied", "failed"].includes(row.state)
		)
			await this.change(randomUUID(), {
				kind: "execution-drained",
				ticketId,
				assignmentId,
				expectedRevision: row.revision,
			});
	}
	async review(
		commandId: string,
		input: ReviewWork,
	): Promise<SuggestionActionReply> {
		if (input.review === "rework" && !this.directRoute)
			return { kind: "rejected", code: "forbidden" };
		if (input.review === "accept") {
			const previous = await this.receipt(commandId);
			if (previous.kind === "receipt" && previous.receipt)
				return this.change(commandId, { ...input, kind: "review" });
			const result = await this.readWork({
				kind: "work-ticket",
				ticketId: input.ticketId,
			});
			const row = result.kind === "work" ? result.work : null;
			if (!row) return { kind: "rejected", code: "stale" };
			if (
				row.groupRepair &&
				!(await verifyGroupRepairEvidence(
					this.ctx,
					join(resolveDshHome(), "dsh-bot-proactive"),
					row,
				).catch(() => false))
			)
				return { kind: "rejected", code: "stale" };
			if (
				row.workspaceRepair &&
				!(await readWorkspaceReview(
					join(resolveDshHome(), "dsh-bot-proactive"),
					row,
				).catch(() => undefined))
			)
				return { kind: "rejected", code: "stale" };
			if (
				row?.repair &&
				!(await verifySavedArtifact(
					join(resolveDshHome(), "dsh-bot-proactive"),
					row,
				).catch(() => false))
			)
				return { kind: "rejected", code: "stale" };
		}
		const result = await this.change(commandId, { ...input, kind: "review" });
		if (result.kind === "receipt" && input.review === "accept")
			this.scheduleGroupFollowUps();
		if (
			result.kind === "receipt" &&
			result.receipt.status === "committed" &&
			input.review === "rework"
		) {
			const work = await this.workList().catch(() => []);
			const current = work.find((item) => item.ticketId === input.ticketId);
			if (current) this.execution.enqueue(current);
		}
		return result;
	}
	async close() {
		this.#feedStop.abort();
		this.ctx.get("dshBotGroups")?.stopProactiveReviews();
		const noticesClosed = this.deferredNotices.close();
		const governanceClosed = this.governance.close();
		await this.#maintenance;
		await this.#automatic.close();
		await this.#feed;
		await this.#groupFollowUpQueue.close();
		await this.execution.close();
		await this.#resultJournal?.close();
		await this.feedbackWorkflow.close();
		await this.groupBudgets.close();
		await noticesClosed;
		await governanceClosed;
		this.#state = "unavailable";
		await this.#client?.close(this.#storeId);
	}
}
