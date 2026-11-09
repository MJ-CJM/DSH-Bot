import { registerMethodSkill, loadMethodSkill } from "./method-skill.js";
import type { MethodLoadEvidence } from "../../shared/proactive/method-evaluation.js";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import type { CommandBody } from "../../shared/proactive/protocol.js";
import type { ProactiveWork } from "../../shared/proactive/work.js";
import { outlets } from "../data-flow/tool-guard.js";
import type { ProactiveService } from "./service.js";
import { prepareRepair } from "./repair.js";
import { negotiateRepair, runExternalRepair } from "./executors/loopback.js";
import { digest } from "./wire.js";
import { executionPrompt } from "./execution-prompt.js";
import { prepareWorkspaceRepair } from "./workspace-repair.js";
import { runCommandRepair } from "./executors/command.js";
import { runGroupRepair, GroupRepairFailure } from "./group-repair.js";
import { assertModelBudget, observedModelUsage } from "./model-budget.js";
import {
	workspaceEdits,
	type WorkspaceRepairEvidence,
} from "../../shared/proactive/workspace-repair.js";
import { z } from "zod";

declare module "@deepseek-ai/dsh-llm" {
	interface MessageSourceMap {
		"dsh-bot-proactive-ci": {
			kind: "dsh-bot-proactive-ci";
			form: "notice";
			ticketId: string;
			assignmentId: string;
			summary: string;
		};
	}
}

/** Live input ownership, checked before any group prompt can reach a model. */
export const proactiveGroupInputs = new Map<string, string>();

interface NativeRun {
	sessionId: string;
	assignmentId: string;
	sourceId: string;
	inputId?: string;
	handle?: AgentHandle;
	stop: AbortController;
	task?: Promise<void>;
	runtimeStarted?: boolean;
	createAttempted?: boolean;
	localDrained?: boolean;
	external?: boolean;
	grouped?: boolean;
	processActive?: boolean;
}

export class DirectExecution {
	readonly #active = new Map<string, NativeRun>();
	readonly #drained = new Set<string>();
	readonly #stop = new AbortController();
	constructor(
		private readonly ctx: Context,
		private readonly service: ProactiveService,
		private readonly root: string,
	) {}

	install() {
		return this.ctx.on(
			"agent/pre-step",
			async ({ agent, messages }, next) => {
				const groupInput = proactiveGroupInputs.get(agent.id);
				if (
					groupInput ||
					messages.some(
						(message) => message.source.kind === "dsh-bot-group-proactive",
					)
				) {
					const input = messages[0];
					return input &&
						messages.length === 1 &&
						input.id === groupInput &&
						input.source.kind === "dsh-bot-group-proactive"
						? next()
						: { kind: "reject" };
				}
				const observed = messages.filter(
					(message) => message.source.kind === "dsh-bot-proactive-ci",
				);
				if (
					observed.length ||
					[...this.#active.values()].some((run) => run.sessionId === agent.id)
				) {
					const message = observed[0];
					const source = message?.source;
					if (
						!message ||
						messages.length !== 1 ||
						source?.kind !== "dsh-bot-proactive-ci" ||
						!this.owns(agent, source.ticketId, message.id)
					)
						return { kind: "reject" };
				}
				return next();
			},
			{ prepend: true },
		);
	}

	private owns(agent: Agent, ticketId: string, inputId: string) {
		const run = this.#active.get(ticketId);
		return (
			!!run &&
			!run.stop.signal.aborted &&
			run.sessionId === agent.id &&
			run.inputId === inputId
		);
	}

	enqueue(work: ProactiveWork) {
		if (this.#stop.signal.aborted || work.state !== "pending") return;
		const previous = this.#active.get(work.ticketId);
		if (previous) {
			if (previous.assignmentId !== work.assignmentId)
				void previous.task?.then(() => this.enqueue(work)).catch(() => {});
			return;
		}
		const run: NativeRun = {
			sessionId: randomUUID(),
			assignmentId: work.assignmentId,
			sourceId: work.sourceId,
			stop: new AbortController(),
		};
		this.#active.set(work.ticketId, run);
		const task = this.run(work, run).finally(() => {
			if (this.provedDrained(run)) {
				this.#drained.add(JSON.stringify([work.ticketId, work.assignmentId]));
				while (this.#drained.size > 128) {
					const oldest = this.#drained.values().next().value;
					if (oldest !== undefined) this.#drained.delete(oldest);
				}
			}
			this.#active.delete(work.ticketId);
		});
		run.task = task;
		void task.catch(() =>
			this.ctx.logger.warn(
				"[dsh-bot] proactive execution receipt could not be reconciled",
			),
		);
	}

	private async run(work: ProactiveWork, run: NativeRun) {
		let expectedRevision = work.revision;
		let sent = false;
		let resultStaged = false;
		const grouped = !!work.groupRepair;
		const external =
			work.repair?.executor === "external" ||
			work.workspaceRepair?.executor === "command";
		run.external = external;
		run.grouped = grouped;
		const deadline = Math.min(
			Date.parse(work.expiresAt),
			work.taskLimits
				? Date.parse(work.taskLimits.deadlineAt)
				: Number.POSITIVE_INFINITY,
		);
		const signal = AbortSignal.any([
			run.stop.signal,
			this.#stop.signal,
			AbortSignal.timeout(
				Math.max(
					1,
					Math.min(this.service.executionTimeoutMs, deadline - Date.now()),
				),
			),
		]);
		const fence = () => ({
			ticketId: work.ticketId,
			assignmentId: work.assignmentId,
			expectedRevision,
		});
		const checkDispatch = (groupAlreadyValidated = false) =>
			this.service.verifyDispatch(work, {
				dispatchRevision: expectedRevision,
				groupAlreadyValidated,
			});
		const gate = {
			beforeSpawn: () => checkDispatch(),
			processActive: (active: boolean) => {
				run.processActive = active;
			},
		};
		const transition = async (body: CommandBody) => {
			const reply = await this.service.submit(
				randomUUID(),
				body,
				body.kind === "report-result"
					? () => {
							resultStaged = true;
						}
					: undefined,
			);
			if (reply.kind === "rejected" && body.kind !== "report-result")
				throw new Error("Proactive dispatch rejected");
			if (reply.kind !== "receipt" || !reply.receipt) return false;
			expectedRevision++;
			return true;
		};
		try {
			const bot = await this.service.validateTarget(work.target);
			if (work.repair && work.workspaceRepair)
				throw new Error("Conflicting repair authorization");
			const workspaceConfiguration = work.workspaceRepair
				? this.service.workspaceConfiguration(
						work.workspaceRepair,
						work.sourceId,
					)
				: undefined;
			signal.throwIfAborted();
			if (
				!(await transition({
					...fence(),
					kind: "dispatch-claim",
					...(external || grouped ? {} : { sessionId: run.sessionId }),
				}))
			)
				return;
			const claimed = await this.service.read({
				kind: "work-assignment",
				assignmentId: work.assignmentId,
			});
			if (
				claimed.kind !== "work" ||
				!claimed.work ||
				claimed.work.state !== "claimed" ||
				claimed.work.assignmentId !== work.assignmentId ||
				claimed.work.revision !== expectedRevision
			)
				throw new Error("Claimed task budget version changed");
			work = { ...work, taskLimits: claimed.work.taskLimits };
			signal.throwIfAborted();
			const workspace =
				workspaceConfiguration &&
				(await prepareWorkspaceRepair(
					this.ctx,
					this.root,
					work,
					workspaceConfiguration.workspace,
					signal,
					gate,
					workspaceConfiguration.command,
				));
			const configuration = work.repair
				? this.service.repairConfiguration(work.repair, work.sourceId)
				: undefined;
			const finishRepair =
				configuration &&
				(await prepareRepair(
					this.ctx,
					configuration.node,
					this.root,
					work,
					configuration.fixture,
					signal,
					gate,
				));
			if (grouped) {
				if (
					!workspace ||
					work.workspaceRepair?.executor !== "native" ||
					work.repair
				)
					throw new Error("Group repair requires a native workspace scope");
				await this.service.validateGroupRepair(work);
				if (
					!(await transition({
						...fence(),
						kind: "dispatch-send",
						inputId: randomUUID(),
					}))
				)
					return;
				sent = true;
				await checkDispatch();
				signal.throwIfAborted();
				run.createAttempted = true;
				const result = await runGroupRepair(this.ctx, {
					work,
					workspace,
					artifactRoot: this.root,
					outputTokens: this.service.modelOutputTokens,
					signal,
					check: async () => {
						// GroupTurns calls this while holding its queue; its native
						// membership/Bot revision checks remain the authoritative guard.
						await checkDispatch(true);
						signal.throwIfAborted();
					},
				});
				if (
					await transition({
						...fence(),
						kind: "report-result",
						result: { state: "delivered", ...result },
					})
				)
					await this.service
						.notify(work.decisionId, work.assignmentId, signal)
						.catch(() => {});
				return;
			}
			if (work.workspaceRepair?.executor === "command") {
				if (!workspace || !workspaceConfiguration?.command)
					throw new Error("Command executor unavailable");
				const inputId = randomUUID();
				if (!(await transition({ ...fence(), kind: "dispatch-send", inputId })))
					return;
				sent = true;
				const result = await runCommandRepair(this.ctx, {
					configuration: workspaceConfiguration.command,
					cwd: workspace.executorCwd,
					task: workspace.promptData,
					signal,
					gate,
					onStarted: async (runId) => {
						await checkDispatch();
						signal.throwIfAborted();
						if (
							!(await transition({
								...fence(),
								kind: "external-started",
								runId,
							}))
						)
							throw new Error("Command run receipt unknown");
					},
				});
				await checkDispatch();
				signal.throwIfAborted();
				const workspaceEvidence = await workspace.finish(result.edits);
				signal.throwIfAborted();
				await transition({
					...fence(),
					kind: "report-result",
					result: {
						state: "delivered",
						workspaceEvidence,
						commandEvidence: result.evidence,
					},
				});
				return;
			}
			if (work.repair?.executor === "external") {
				if (!configuration?.endpoint || !finishRepair)
					throw new Error("External executor unavailable");
				await checkDispatch();
				signal.throwIfAborted();
				await negotiateRepair(configuration.endpoint, signal);
				const inputId = randomUUID();
				if (!(await transition({ ...fence(), kind: "dispatch-send", inputId })))
					return;
				sent = true;
				await checkDispatch();
				signal.throwIfAborted();
				const artifact = await runExternalRepair({
					endpoint: configuration.endpoint,
					inputId,
					fixture: configuration.fixture,
					...(work.rework ? { rework: work.rework } : {}),
					signal,
					onStarted: async (runId) => {
						if (
							!(await transition({
								...fence(),
								kind: "external-started",
								runId,
							}))
						)
							throw new Error("External run receipt unknown");
					},
				});
				await checkDispatch();
				signal.throwIfAborted();
				const repairEvidence = await finishRepair(artifact.edit);
				signal.throwIfAborted();
				await transition({
					...fence(),
					kind: "report-result",
					result: {
						state: "delivered",
						repairEvidence,
						externalEvidence: {
							runId: artifact.runId,
							inputId,
							outputDigest: digest(artifact.edit),
							units: artifact.units,
							unit: artifact.unit,
						},
					},
				});
				return;
			}
			const root = await realpath(this.root);
			const cwd = join(root, "execution");
			await checkDispatch();
			signal.throwIfAborted();
			await mkdir(cwd, { recursive: true, mode: 0o700 });
			if ((await realpath(cwd)) !== cwd)
				throw new Error("Unsafe proactive execution directory");
			const agentOptions = {
				provider: work.target.provider,
				model: work.target.model,
				maxTokens: work.taskLimits
					? Math.max(
							1,
							Math.min(
								this.service.modelOutputTokens,
								Math.floor(work.taskLimits.maxTokens / 2),
							),
						)
					: this.service.modelOutputTokens,
			};
			let requested = false;
      let methodContent: string | undefined;
      let methodEvidence: MethodLoadEvidence | undefined;
			await checkDispatch();
			signal.throwIfAborted();
			run.createAttempted = true;
			const handle = await this.ctx.agents.create({
				sessionId: SessionId(run.sessionId),
				meta: {
					cwd,
					agentPreset: `${this.ctx.dshBots.config.presetIdPrefix}${bot.id}`,
				},
				agentOptions,
				signal,
				setup: async (agentCtx) => {
          const trial = work.methodTrial;
          if (trial) await agentCtx.effect(() => registerMethodSkill(agentCtx, trial), 'dsh-bot: evaluation skill');
					await agentCtx.effect(() => {
						const restrict = agentCtx.tools.restrict({ allow: [] });
						const guard = agentCtx.tools.guard(
							() => "Proactive CI inspection cannot call tools",
						);
						const request = agentCtx.on(
							"agent/request",
							async () => {
								signal.throwIfAborted();
								if (requested)
									throw new Error("Proactive model request budget exhausted");
								await checkDispatch();
								signal.throwIfAborted();
								requested = true;
								return agentOptions;
							},
							{ prepend: true },
						);
						const noRetry = agentCtx.on(
							"agent/request-error",
							async () => undefined,
							{ prepend: true },
						);
						const stream = agentCtx.on(
							"llm/stream",
							(options, next) => {
								if (options.sessionId === run.sessionId) {
									signal.throwIfAborted();
									if (work.taskLimits)
                    assertModelBudget(options, work.taskLimits.maxTokens);
                  if (work.methodTrial) {
                    const loadedContent = methodContent;
                    if (!loadedContent || !options.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes(loadedContent)))) throw new Error('Loaded method missing from actual model request');
                    const { content: _content, ...identity } = work.methodTrial;
                    methodEvidence = { ...identity, loadedBodyHash: digest(methodContent), requestHash: digest(options.messages),
                      contextHash: digest({ system: options.system, tools: options.tools ?? [], provider: options.provider, model: options.model, maxTokens: options.maxTokens }), tools: 'none', permission: 'read-only-no-egress' };
                  }
								}
								return next();
							},
							{ prepend: true },
						);
						return () => {
							stream();
							noRetry();
							request();
							guard();
							restrict();
						};
					}, "dsh-bot: proactive execution limits");
				},
			});
			run.handle = handle;
			run.runtimeStarted = true;
			signal.throwIfAborted();
			const { agent } = handle;
      if (work.methodTrial) methodContent = await loadMethodSkill(agent, work.methodTrial, cwd, signal);
			setSandboxMode(agent.session, "read-only");
			// This session only sees the CI observation and one model response.
			// Bind its audience before followup so station notifications use the
			// same native data-flow checks as other Bot notices.
			await outlets(this.ctx.dshBots)?.inherit(agent.id, {
				readers: [work.target.bot],
				originTrust: "candidate",
				sourceVersions: [],
				restrictions: ["no-egress"],
				grants: [],
			});
			if (this.ctx.tools.schemas(agent).length !== 0)
				throw new Error("Tool restriction failed");
			const source = {
				kind: "dsh-bot-proactive-ci" as const,
				form: "notice" as const,
				ticketId: work.ticketId,
				assignmentId: work.assignmentId,
				summary: work.document ? "Owner-provided document snapshot" : "Local CI observation",
			};
			const message = createUserMessage({
				source,
				content: [
					{
						type: "text",
						text: workspace
							? JSON.stringify(workspace.promptData)
							: work.methodTrial && methodContent ? `Apply this owner-approved method without tools.
${methodContent}

Return only JSON for this independent task:
${work.document?.content}` : executionPrompt(work, configuration?.fixture),
					},
				],
			});
			await this.service.validateTarget(work.target);
			signal.throwIfAborted();
			if (
				!(await transition({
					...fence(),
					kind: "dispatch-send",
					inputId: message.id,
				}))
			)
				return;
			sent = true;
			await checkDispatch();
			signal.throwIfAborted();
			run.inputId = message.id;
			agent.followup(message);
			await waitIdle(agent, signal);
			signal.throwIfAborted();
			const events = agent.session.snapshotEvents();
			const index = events.findIndex(
				(event) =>
					event.type === "user/message" &&
					event.data.id === message.id &&
					digest(event.data.source) === digest(source),
			);
			const start = events
				.slice(0, Math.max(0, index))
				.findLast((event) => event.type === "turn/start");
			const end = events.findIndex(
				(event, i) =>
					i > index &&
					event.type === "turn/end" &&
					event.data.turn === start?.data.turn &&
					event.data.reason.kind === "completed",
			);
			const assistant = events
				.slice(index + 1, end)
				.find(
					(event) =>
						event.type === "assistant/message" &&
						event.data.turn === start?.data.turn &&
						event.data.message.content.some(
							(block) => block.type === "text" && block.text.trim(),
						),
				);
			if (
				index < 0 ||
				!start ||
				end < 0 ||
				assistant?.type !== "assistant/message" ||
				assistant.data.interrupted ||
				assistant.data.message.source.provider !== work.target.provider ||
				assistant.data.message.source.model !== work.target.model ||
				!(await this.ctx.sessions.flush(agent.session))
			)
				throw new Error("Native completion evidence unavailable");
			let repairResult:
				| Awaited<ReturnType<NonNullable<typeof finishRepair>>>
				| undefined;
			let workspaceEvidence: WorkspaceRepairEvidence | undefined;
			if (finishRepair) {
				await checkDispatch();
				signal.throwIfAborted();
				const answer = assistant.data.message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("");
				repairResult = await finishRepair(JSON.parse(answer));
			}
			if (workspace) {
				await checkDispatch();
				signal.throwIfAborted();
				const answer = assistant.data.message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("");
				const parsed = z
					.strictObject({ edits: workspaceEdits })
					.parse(JSON.parse(answer));
				workspaceEvidence = await workspace.finish(parsed.edits);
			}
			signal.throwIfAborted();
			const usage = observedModelUsage(assistant.data.usage);
			const delivered = await transition({
				...fence(),
				kind: "report-result",
				result: {
					state: "delivered",
					...(repairResult ? { repairEvidence: repairResult } : {}),
					...(workspaceEvidence ? { workspaceEvidence } : {}),
					...(usage ? { usage } : {}),
          ...(methodEvidence ? { methodEvidence } : {}),
					evidence: {
						inputId: message.id,
						assistantId: assistant.data.message.id,
						turn: Number(start.data.turn),
						outputDigest: digest(assistant.data.message.content),
						checks: ["source-match", "turn-completed", "transcript-flushed"],
					},
				},
			});
			if (delivered)
				await this.service
					.notify(work.decisionId, work.assignmentId, signal)
					.catch(() => {});
		} catch (error) {
			if (resultStaged) return;
			await transition({
				...fence(),
				kind: "report-result",
				result: {
					state: run.processActive || (run.createAttempted && !run.runtimeStarted && !grouped)
						? "unknown"
						: error instanceof GroupRepairFailure
							? error.evidence.state === "failed"
								? "failed"
								: "unknown"
							: sent
								? signal.aborted || external || grouped
									? "unknown"
									: "failed"
								: "denied",
					...(error instanceof GroupRepairFailure
						? { groupRepairEvidence: error.evidence }
						: {}),
				},
			});
		} finally {
			if (run.grouped && run.createAttempted)
				run.localDrained = await this.ctx.get("dshBotGroups")?.drainProactiveRepair(work.assignmentId).catch(() => false);
			await run.handle?.dispose();
			if (run.handle) {
				await run.handle.agent.whenIdle();
				run.localDrained = true;
			}
		}
	}

	cancel(ticketId: string, assignmentId?: string) {
		const run = this.#active.get(ticketId);
		if (
			!run ||
			run.stop.signal.aborted ||
			(assignmentId !== undefined && run.assignmentId !== assignmentId)
		)
			return;
		run.stop.abort();
		run.handle?.agent.cancel({
			kind: "hook",
			reason: "Proactive task cancelled",
		});
	}

	cancelSource(sourceId: string) {
		for (const [ticketId, run] of this.#active)
			if (run.sourceId === sourceId) this.cancel(ticketId);
	}

	cancelAll() {
		for (const ticketId of this.#active.keys()) this.cancel(ticketId);
	}

	async cancelAndDrain(ticketId: string, assignmentId: string): Promise<boolean> {
		const run = this.#active.get(ticketId);
		if (!run) return this.#drained.has(JSON.stringify([ticketId, assignmentId]));
		if (run.assignmentId !== assignmentId) return false;
		this.cancel(ticketId);
		await Promise.allSettled([run.task]);
		// A remote command may have spawned downstream work; only owned native
		// handles whose disposal and idle completion were observed qualify.
		return this.provedDrained(run);
	}

	private provedDrained(run: NativeRun) {
		return (
			!run.processActive &&
			!run.external &&
			(!run.createAttempted ||
				(!!run.localDrained && (run.grouped || !!run.runtimeStarted)))
		);
	}

	async idle() {
		await Promise.allSettled([...this.#active.values()].map((run) => run.task));
	}

	async close() {
		this.#stop.abort();
		this.cancelAll();
		await this.idle();
	}
}

export async function waitIdle(agent: Agent, signal: AbortSignal) {
	signal.throwIfAborted();
	let abort: (() => void) | undefined;
	try {
		await Promise.race([
			agent.whenIdle(),
			new Promise<never>((_resolve, reject) => {
				abort = () => {
					agent.cancel({
						kind: "hook",
						reason: "Proactive execution interrupted",
					});
					reject(signal.reason);
				};
				signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}
