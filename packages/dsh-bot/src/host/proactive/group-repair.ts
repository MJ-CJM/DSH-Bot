import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { z } from "zod";
import type { ProactiveWork } from "../../shared/proactive/work.js";
import {
	groupRepairEvidence,
	groupRepairGrant,
	groupRepairPlan,
	groupRepairReview,
	type GroupRepairEvidence,
	type GroupRepairPhase,
} from "../../shared/proactive/group-repair.js";
import {
	workspaceEdits,
	type WorkspaceRepairEvidence,
} from "../../shared/proactive/workspace-repair.js";
import {
	readWorkspaceReview,
	type prepareWorkspaceRepair,
} from "./workspace-repair.js";
import { observedModelUsage } from "./model-budget.js";
import { digest } from "./wire.js";

export class GroupRepairFailure extends Error {
	constructor(readonly evidence: GroupRepairEvidence) {
		super("Group repair did not produce a complete delivery");
	}
}

/** Reread native events and the retained artifact before owner acceptance. */
export async function verifyGroupRepairEvidence(
	ctx: Context,
	artifactRoot: string,
	work: ProactiveWork,
): Promise<boolean> {
	try {
		const grant = groupRepairGrant.parse(work.groupRepair);
		const evidence = groupRepairEvidence.parse(work.groupRepairEvidence);
		const groups = ctx.get("dshBotGroups");
		if (!groups || evidence.state !== "completed" || evidence.grantDigest !== digest(grant)) return false;
		const view = await groups.view(grant.group);
		if (view.group.rootSessionId !== grant.rootSessionId) return false;
		const root = await ctx.sessionController.inspect(SessionId(grant.rootSessionId));
		const answers: unknown[] = [];
		for (const [index, phase] of (["plan", "implement", "review"] as const).entries()) {
			const stage = evidence.stages[index];
			const role = phase === "implement" ? grant.implementer : grant.supervisor;
    const model = role.modelSelection ?? { provider: work.target.provider, model: work.target.model };
			if (!stage || stage.phase !== phase || stage.memberId !== role.memberId || !stage.sessionId) return false;
			const turn = view.turns.find(item => item.id === stage.turnId);
			const delivery = view.deliveries.find(item => item.id === stage.deliveryId);
			if (!turn || !delivery || turn.state !== "completed" || delivery.state !== "completed" ||
				turn.membershipRevision !== grant.membershipRevision || digest(turn.orderedMemberIds) !== digest([role.memberId]) ||
				turn.proactive?.assignmentId !== work.assignmentId || turn.proactive.ticketId !== work.ticketId ||
				turn.proactive.repair?.phase !== phase || turn.proactive.provider !== model.provider || turn.proactive.model !== model.model ||
				delivery.turnId !== turn.id || delivery.memberId !== role.memberId || digest(delivery.bot) !== digest(role.bot) || delivery.botRevision !== role.botUpdatedAt ||
				delivery.childSessionId !== stage.sessionId || delivery.childMessageId !== stage.inputId || delivery.outputMessageId !== stage.outputId) return false;
			if (index > 0 && turn.proactive.repair.predecessorTurnId !== evidence.stages[index - 1]?.turnId) return false;
			const session = await ctx.sessionController.inspect(SessionId(stage.sessionId));
			if (session.meta.parentSession !== grant.rootSessionId) return false;
			const input = session.events.find(event => event.type === "user/message" && event.data.id === stage.inputId);
			const answer = session.events.find(event => event.type === "assistant/message" && event.data.message.id === stage.assistantId);
			const published = root.events.find(event => event.type === "user/message" && event.data.id === stage.outputId);
			const end = session.events.findLast(event => event.type === "turn/end");
			if (input?.type !== "user/message" || input.data.source.kind !== "dsh-bot-group-proactive" ||
				input.data.source.assignmentId !== work.assignmentId || input.data.source.ticketId !== work.ticketId ||
				input.data.source.turnId !== stage.turnId || input.data.source.repairPhase !== phase || digest(input.data.source.group) !== digest(grant.group) || digest(input.data.content) !== stage.inputDigest ||
				answer?.type !== "assistant/message" || answer.data.interrupted || end?.type !== "turn/end" || end.data.reason.kind !== "completed" || answer.data.turn !== end.data.turn || answer.data.message.source.provider !== model.provider ||
				answer.data.message.source.model !== model.model || digest(answer.data.message.content) !== stage.outputDigest ||
				published?.type !== "user/message" || published.data.source.kind !== "dsh-bot-group" ||
				published.data.source.turnId !== stage.turnId || published.data.source.childSessionId !== stage.sessionId ||
				published.data.source.memberId !== role.memberId || digest(published.data.source.group) !== digest(grant.group)) return false;
			const text = answer.data.message.content.filter(block => block.type === "text").map(block => block.text).join("");
			if (published.data.content.filter(block => block.type === "text").map(block => block.text).join("") !== text) return false;
			answers.push(JSON.parse(text));
		}
		const plan = groupRepairPlan.parse(answers[0]), review = groupRepairReview.parse(answers[2]);
		if (digest(plan) !== digest(evidence.plan) || digest(review) !== digest(evidence.review) ||
			plan.checks.some(criterion => !review.checks.some(check => check.criterion === criterion))) return false;
		const edits = z.strictObject({ edits: workspaceEdits }).parse(answers[1]).edits;
		const artifact = await readWorkspaceReview(artifactRoot, work);
		if (edits.length !== artifact.diff.length || edits.some(edit => {
			const file = artifact.files.find(file => file.path === edit.path);
			const before = artifact.manifests.before.find(file => file.path === edit.path);
			return !plan.files.includes(edit.path) || !file?.editable || file.after !== edit.content || before?.digest !== edit.beforeDigest ||
				!artifact.diff.some(change => change.path === edit.path);
		})) return false;
		return true;
	} catch { return false; }
}

/** Three fixed phases through the existing group runner; no new agent loop or task store. */
export async function runGroupRepair(
	ctx: Context,
	input: {
		work: ProactiveWork;
		workspace: Awaited<ReturnType<typeof prepareWorkspaceRepair>>;
		artifactRoot: string;
		outputTokens: number;
		signal: AbortSignal;
		check(): Promise<void>;
	},
) {
	const work = input.work,
		grant = groupRepairGrant.parse(work.groupRepair);
	const availableGroups = ctx.get("dshBotGroups");
	if (!availableGroups || !work.taskLimits)
		throw new Error("Bounded group repair unavailable");
	const groups = availableGroups;
	let remainingAllowance = work.taskLimits.maxTokens;
	const evidence: GroupRepairEvidence = {
		version: 1,
		grantDigest: digest(grant),
		state: "unknown",
		stages: [],
	};
	const usages: Array<ReturnType<typeof observedModelUsage>> = [];
	const cancel = () => groups.cancelProactiveRepair(work.assignmentId);
	input.signal.addEventListener("abort", cancel, { once: true });
	let workspaceEvidence: WorkspaceRepairEvidence | undefined;
	async function phase(phase: GroupRepairPhase, task: unknown) {
		input.signal.throwIfAborted();
		await input.check();
		const outputTokens = Math.min(input.outputTokens, Math.floor(remainingAllowance / 2));
		if (outputTokens < 1) throw new Error("Group repair token allowance exhausted");
		const role = phase === "implement" ? grant.implementer : grant.supervisor;
    const model = role.modelSelection ?? { provider: work.target.provider, model: work.target.model };
		const predecessorTurnId = evidence.stages.at(-1)?.turnId;
		const turn = await groups.startProactiveReview(
			grant.group,
			{
				operationId: `proactive-repair:${work.assignmentId}:${phase}`,
				expectedMembershipRevision: grant.membershipRevision,
				memberIds: [role.memberId],
				text: JSON.stringify({
					operation: "dsh-bot-group-repair",
					phase,
					task,
				}),
			},
			{
				ticketId: work.ticketId,
				assignmentId: work.assignmentId,
				provider: model.provider,
				model: model.model,
        memberModels: [{ memberId: role.memberId, modelSelection: model }],
        modelRevision: grant.modelRevision,
				botRevisions: [role.botUpdatedAt],
				repair: {
					phase,
					...(predecessorTurnId ? { predecessorTurnId } : {}),
					maxTokens: remainingAllowance,
					outputTokens,
					deadlineAt: work.taskLimits?.deadlineAt ?? work.expiresAt,
				},
			},
			input.check,
		);
		const stage: GroupRepairEvidence["stages"][number] = {
			phase,
			memberId: role.memberId,
			turnId: turn.id,
			state: "running",
		};
		evidence.stages.push(stage);
		if (input.signal.aborted) cancel();
		await groups.waitForProactiveReview(turn.id);
		const allowance = groups.proactiveRequestAllowance(turn.id);
		if (allowance !== undefined) {
			const reserved = allowance.inputAllowance + allowance.outputAllowance;
			if (allowance.turnId !== turn.id || ![allowance.inputAllowance, allowance.outputAllowance, reserved].every(value => Number.isSafeInteger(value) && value > 0) || reserved > remainingAllowance)
				throw new Error("Group request allowance changed");
			remainingAllowance -= reserved;
		}
		const view = await groups.view(grant.group);
		const current = view.turns.find((item) => item.id === turn.id);
		const delivery = view.deliveries.find((item) => item.turnId === turn.id);
		if (delivery)
			Object.assign(stage, {
				deliveryId: delivery.id,
				...(delivery.childSessionId
					? { sessionId: delivery.childSessionId }
					: {}),
				...(delivery.childMessageId
					? { inputId: delivery.childMessageId }
					: {}),
				...(delivery.outputMessageId
					? { outputId: delivery.outputMessageId }
					: {}),
			});
		stage.state =
			delivery?.state === "completed" && current?.state === "completed"
				? "completed"
				: delivery?.state === "failed"
					? "failed"
					: delivery?.state === "cancelled"
						? "cancelled"
						: "unknown";
		if (
			stage.state !== "completed" ||
			!delivery?.childSessionId ||
			!delivery.childMessageId ||
			!delivery.outputMessageId
		)
			throw new GroupRepairFailure(
				groupRepairEvidence.parse({
					...evidence,
					state: stage.state === "failed" ? "failed" : "unknown",
				}),
			);
		input.signal.throwIfAborted();
		await input.check();
		if (!allowance || allowance.deliveryId !== delivery.id) throw new Error("Native group request allowance unavailable");
		const session = await ctx.sessionController.inspect(
			SessionId(delivery.childSessionId),
		);
		const source = session.events.find(
			(event) =>
				event.type === "user/message" &&
				event.data.id === delivery.childMessageId,
		);
		if (
			source?.type !== "user/message" ||
			source.data.source.kind !== "dsh-bot-group-proactive" ||
			source.data.source.assignmentId !== work.assignmentId ||
			source.data.source.turnId !== turn.id ||
			source.data.source.repairPhase !== phase
		)
			throw new Error("Group repair source identity changed");
		stage.inputDigest = digest(source.data.content);
		const answer = session.events.findLast(
			(event) => event.type === "assistant/message",
		);
		if (
			answer?.type !== "assistant/message" ||
			answer.data.interrupted ||
			answer.data.message.source.provider !== model.provider ||
			answer.data.message.source.model !== model.model
		)
			throw new Error("Group repair native result unavailable");
		const text = answer.data.message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		stage.outputDigest = digest(answer.data.message.content);
		stage.assistantId = answer.data.message.id;
		usages.push(observedModelUsage(answer.data.usage));
		return JSON.parse(text) as unknown;
	}
	try {
		const plan = groupRepairPlan.parse(
			await phase("plan", {
				instruction:
					"You are the owner-selected supervisor. Assess why the requested role separation is useful and break this bounded repair into implementation instructions and independent checks. Return only JSON {goal,collaborationReason,implementation,files:[editable relative paths],checks:[criteria]}. Do not add members, tools, commands or permissions. The implementer is a distinct approved Bot; you will review its resulting tested artifact.",
				workspace: input.workspace.promptData,
			}),
		);
		const allowed = new Set(
			input.workspace.promptData.files
				.filter((file) => file.editable)
				.map((file) => file.path),
		);
		if (plan.files.some((path) => !allowed.has(path)))
			throw new Error("Supervisor plan expands the approved file scope");
		evidence.plan = plan;
		const proposed = z
			.strictObject({ edits: workspaceEdits })
			.parse(
				await phase("implement", {
					instruction:
						"Implement the supervisor's bounded plan. Return only JSON {edits:[{path,beforeDigest,content}]}. Edit only the plan's named files. Do not execute commands; the Host runs the fixed approved verifier.",
					plan,
					workspace: input.workspace.promptData,
				}),
			);
		if (proposed.edits.some((edit) => !plan.files.includes(edit.path)))
			throw new Error("Implementation expands the planned file scope");
		await input.check();
		input.signal.throwIfAborted();
		workspaceEvidence = await input.workspace.finish(proposed.edits);
		const artifact = await readWorkspaceReview(input.artifactRoot, {
			...work,
			workspaceEvidence,
		});
		evidence.review = groupRepairReview.parse(
			await phase("review", {
				instruction:
					"Independently inspect the implementer's complete before/after files, diff, manifests and fixed verifier output. Summarize the delivery and evaluate every planned criterion; copy each criterion verbatim from plan.checks. Return only JSON {verdict:'pass'|'fail',summary,checks:[{criterion,status:'PASS'|'FAIL',evidence}]}. Missing, failed or unexecuted checks must FAIL. You cannot accept the task for the owner or change files.",
				plan,
				artifact,
			}),
		);
		if (
			plan.checks.some(
				(criterion) =>
					!evidence.review?.checks.some(
						(check) => check.criterion === criterion,
					),
			)
		)
			throw new Error(
				"Supervisor review omitted a planned acceptance criterion",
			);
		const complete = groupRepairEvidence.parse({
			...evidence,
			state: "completed",
		});
		const measured = usages.every((usage) => usage !== undefined)
			? usages.reduce(
					(sum, usage) => ({
						inputTokens: sum.inputTokens + (usage?.inputTokens ?? 0),
						outputTokens: sum.outputTokens + (usage?.outputTokens ?? 0),
					}),
					{ inputTokens: 0, outputTokens: 0 },
				)
			: undefined;
		return {
			workspaceEvidence,
			groupRepairEvidence: complete,
			...(measured ? { usage: measured } : {}),
		};
	} catch (error) {
		if (error instanceof GroupRepairFailure) throw error;
		cancel();
		throw new GroupRepairFailure(
			groupRepairEvidence.parse({
				...evidence,
				state:
					input.signal.aborted ||
					!evidence.stages.length ||
					evidence.stages.some(
						(stage) => stage.state === "running" || stage.state === "unknown",
					)
						? "unknown"
						: "failed",
			}),
		);
	} finally {
		input.signal.removeEventListener("abort", cancel);
	}
}
