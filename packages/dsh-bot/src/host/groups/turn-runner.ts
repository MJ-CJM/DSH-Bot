import { workerReservations } from './worker-tool.js';
import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { z } from 'zod';
import type { WorkerBinding, groupToolInput } from './worker-tool.js';
import { groupChild, groupResult } from './data-flow.js';
import { outlets } from '../data-flow/tool-guard.js';
import { nextRoundRobinMember } from './round-robin.js';
import { hasOperationCode } from '../../shared/operation-errors.js';
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent';
import type { GroupDelivery, GroupTurn, GroupSpeaker } from '../../shared/groups.js';
import { OperationError, need, digest } from '../common/operations.js';
import { groupContext } from './routing.js';

import { blocks, textOf, terminal } from './model.js';
import type { GroupState } from './state.js';
import type { GroupRoots } from './roots.js';
import type { GroupMessages } from './messages.js';
export class GroupTurnRunner {
  constructor(
    private state: GroupState,
    private roots: GroupRoots,
    private messages: GroupMessages,
  ) {}
  /** Called inside the service queue. A delivery receipt is the durable acceptance point. */
  async enqueue(t: GroupTurn, memberId: string, triggerMessageId: string, id: string, returnMemberId?: string, requestDigest?: string) {
    const old = this.state.table('deliveries').get(id);
    if (old) {
      if (requestDigest && old.requestDigest !== requestDigest) throw new OperationError('conflict');
      return old;
    }
    const g = this.state.record(t.group), rows = this.state.deliveries(t.id);
    if (this.state.cancelledTurns.has(t.id) || terminal(need(this.state.table('turns').get(t.id))) ||
      Date.now() >= t.createdAt + this.state.registry.config.groupRoundTimeoutMs) throw new OperationError('unavailable');
    if (rows.length >= t.orderedMemberIds.length + this.state.registry.config.groupMaxContinuations) throw new OperationError('invalid');
    if (g.membershipRevision !== t.membershipRevision) throw new OperationError('conflict');
    const member = this.state.members(g).find(m => m.id === memberId && m.enabled && m.removedAt === undefined);
    if (!member) throw new OperationError('invalid');
    const bot = await this.state.bot(member.bot), status = need((await this.state.registry.status()).find(s => s.id === bot.id));
    const row: GroupDelivery = { id, turnId: t.id, memberId, ordinal: rows.length, bot: member.bot,
      botRevision: bot.updatedAt, presetId: status.presetId, triggerMessageId, returnMemberId, requestDigest,
      contextOutputMessageIds: [], contextTruncated: false, state: 'pending' };
    await this.state.putDelivery(row);
    return row;
  }
  async groupMessage(agent: Agent, binding: WorkerBinding, input: z.output<typeof groupToolInput>, callId: string, signal: AbortSignal) {
    return this.state.queue.run(async () => {
      signal.throwIfAborted();
      const t = need(this.state.table('turns').get(binding.turnId)), g = this.state.record(t.group),
        d = need(this.state.table('deliveries').get(binding.deliveryId));
      if (this.state.workers.get(agent.session.id) !== binding || this.state.cancelledTurns.has(t.id) ||
        !['starting', 'running'].includes(d.state)) throw new OperationError('approval-denied');
      if (input.action === 'skip') {
        await this.state.putDelivery({ ...d, skipped: true });
        return { status: 'skipped' };
      }
      if (d.skipped) throw new OperationError('invalid');
      const root = need(this.state.roots.get(g.id)), bot = await this.state.bot(d.bot),
        id = `group-message:${digest([d.id, callId])}`, hash = digest(input);
      const old = this.state.table('deliveries').get(id);
      if (old) {
        if (old.requestDigest !== hash) throw new OperationError('conflict');
        return { status: old.state === 'unknown' ? 'unknown' : 'accepted', messageId: old.triggerMessageId };
      }
      const messages = this.messages.messages(g), reply = input.replyTo ? messages.find(m => m.id === input.replyTo) : undefined;
      if (input.replyTo && (!reply || (reply.seq > t.contextThroughSeq && reply.turnId !== t.id && !t.predecessorTurnIds?.includes(reply.turnId)))) throw new OperationError('invalid');
      const target = input.to ?? (reply?.speaker && this.state.members(g).find(m =>
        m.bot.botId === reply.speaker?.bot.botId && m.bot.botCreatedAt === reply.speaker.bot.botCreatedAt)?.id);
      if (this.state.deliveries(t.id).length >= t.orderedMemberIds.length + this.state.registry.config.groupMaxContinuations) throw new OperationError('invalid');
      if (input.requestReply && !target) throw new OperationError('invalid');
      const message = createUserMessage({ source: { kind: 'dsh-bot-group', group: t.group, turnId: t.id,
        memberId: d.memberId, speaker: { bot: d.bot, name: bot.name, ...(bot.avatar ? { avatar: bot.avatar } : {}), ...(bot.avatarColor ? { avatarColor: bot.avatarColor } : {}), ...(bot.avatarVariant ? { avatarVariant: bot.avatarVariant } : {}) },
        childSessionId: binding.childId, stopReason: 'group-message', replyTo: input.replyTo ?? d.triggerMessageId ?? t.inputMessageId, causeId: t.id }, content: blocks(input.text) });
      // A receipt is written before the native append. Unknown append outcomes are never replayed.
      const receipt = target ? await this.enqueue(t, target, message.id, id, input.requestReply ? d.memberId : undefined, hash) :
        { ...d, id, ordinal: this.state.deliveries(t.id).length, triggerMessageId: message.id, requestDigest: hash, returnMemberId: undefined, state: 'skipped' as const };
      if (!target) await this.state.putDelivery(receipt);
      try {
        await groupResult(this.state, g, d.bot, binding.childId, root.agent, JSON.stringify(message), id,
          () => root.agent.session.append('user/message', message, { surfaceOp: 'append' }), signal);
        await this.roots.flush(root);
      } catch {
        await this.state.putDelivery({ ...receipt, state: 'unknown', reasonCode: 'message-append-unknown' });
        throw new OperationError('recovery-needed');
      }
      return { status: 'accepted', messageId: message.id };
    });
  }
  async prepareDelivery(t: GroupTurn, deliveryId: string, signal: AbortSignal) {
    return this.state.queue.run(async () => {
      const d = need(this.state.table('deliveries').get(deliveryId)),
        g = this.state.record(t.group);
      const member = this.state.members(g).find((m) => m.id === d.memberId);
      if (
        this.state.stopped ||
        this.state.cancelledTurns.has(t.id) ||
        d.state !== 'pending' ||
        signal.aborted ||
        !member?.enabled ||
        member.removedAt !== undefined ||
        g.archived
      ) {
        await this.state.putDelivery({ ...d, state: 'cancelled' });
        return;
      }
      const bot = await this.state.bot(d.bot);
      const status = (await this.state.registry.status()).find((s) => s.id === bot.id);
      if (bot.updatedAt !== d.botRevision || status?.presetId !== d.presetId || status.preset.state !== 'ok')
        throw new OperationError('conflict');
      const root = need(this.state.roots.get(g.id));
      const messages = this.messages.messages(g);
      const question = need(messages.find((m) => m.id === (d.triggerMessageId ?? t.inputMessageId)));
      const previous = this.state
        .turns(g).filter(prior => prior.id === t.id || t.predecessorTurnIds?.includes(prior.id))
        .flatMap(prior => this.state.deliveries(prior.id))
        .filter((row) => row.ordinal < d.ordinal || row.turnId !== t.id)
        .filter((d) => d.outputMessageId)
        .map((d) => need(messages.find((m) => m.id === d.outputMessageId)));
      const participantNames = await Promise.all(
        this.state.members(g).filter(m => m.enabled && m.removedAt === undefined).map(async (d) => {
          try {
            const b = await this.state.bot(d.bot);
            return `${b.name} (botId=${b.id}, memberId=${d.id})`;
          } catch {
            return d.bot.botId;
          }
        }),
      );
      const context = groupContext(
        g.name,
        bot.name,
        participantNames,
        question,
        messages.filter((m) => m.seq <= t.contextThroughSeq),
        [...previous, ...messages.filter(m => m.id === (d.triggerMessageId ? question.replyTo : t.replyTo))],
        this.state.registry.config.groupContextMaxBytes,
      );
      await this.state.putDelivery({
        ...d,
        state: 'starting',
        contextOutputMessageIds: context.outputIds,
        contextTruncated: context.truncated,
      });
      const attachmentBlocks = [...new Map([question, ...messages.filter(m => m.id === question.replyTo || context.outputIds.includes(m.id))]
        .flatMap(m => m.attachments ?? []).map(block => [`${block.type}:${block.attachment.attachmentId}`, block])).values()] as import('@deepseek-ai/dsh-llm').ContentBlock[];
      const modelSelection = t.memberModelSelections?.find(row => row.memberId === d.memberId)?.modelSelection ?? t.modelSelection;
      const selected = modelSelection ?? bot.model;
      const route = selected ? { ...selected,
        // Explicit undefined clears a same-route effort inherited from the root's creation options.
        reasoningEffort: selected.reasoningEffort === undefined ? undefined : ReasoningEffortId(selected.reasoningEffort) } : this.state.route();
      return { root, bot, d, context, attachmentBlocks, route, modelSelection };
    });
  }
  async recordDeliveryResult(
    t: GroupTurn,
    deliveryId: string,
    prepared: NonNullable<Awaited<ReturnType<GroupTurnRunner['prepareDelivery']>>>,
    childId: string,
    result: SubagentResult,
    signal: AbortSignal,
  ) {
    await this.state.queue.run(async () => {
      const g = this.state.record(t.group),
        d = need(this.state.table('deliveries').get(deliveryId));
      const text = textOf(result.output);
      const hasContent = !d.skipped && !signal.aborted && (Boolean(text.trim()) || result.output.some((b) => b.type !== 'text'));
      const state = signal.aborted
        ? 'cancelled'
        : d.skipped && result.stopReason === 'completed'
          ? 'skipped'
        : result.stopReason === 'completed' && hasContent
          ? 'completed'
          : 'failed';
      let output: { outputMessageId: string; outputSeq: number } | undefined;
      if (hasContent) {
        const b = prepared.bot;
        const speaker: GroupSpeaker = {
          bot: d.bot,
          name: b.name,
          ...(b.avatar ? { avatar: b.avatar } : {}),
          ...(b.avatarColor ? { avatarColor: b.avatarColor } : {}),
          ...(b.avatarVariant ? { avatarVariant: b.avatarVariant } : {}),
        };
        const message = createUserMessage({
          source: {
            kind: 'dsh-bot-group',
            group: t.group,
            turnId: t.id,
            memberId: d.memberId,
            speaker,
            childSessionId: childId,
            stopReason: result.stopReason,
            replyTo: d.triggerMessageId ?? t.replyTo ?? t.inputMessageId,
            causeId: t.id,
          },
          content: [...result.output],
        });
        const event = await groupResult(this.state, g, d.bot, childId, prepared.root.agent,
          JSON.stringify(message), `${deliveryId}:result`,
          () => prepared.root.agent.session.append('user/message', message, { surfaceOp: 'append' }), signal);
        await this.roots.flush(prepared.root);
        output = { outputMessageId: message.id, outputSeq: Number(event.seq) };
      }
      await this.state.putDelivery({
        ...d,
        state,
        ...output,
        stopReason: result.stopReason,
        ...(state !== 'completed' && state !== 'skipped'
          ? {
              reasonCode: signal.aborted ? 'cancelled-or-timeout' : text.trim() ? 'partial-output' : 'empty-or-failed',
            }
          : {}),
      });
      if (state === 'completed' && output && d.returnMemberId &&
        this.state.deliveries(t.id).length < t.orderedMemberIds.length + this.state.registry.config.groupMaxContinuations &&
        Date.now() < t.createdAt + this.state.registry.config.groupRoundTimeoutMs && g.membershipRevision === t.membershipRevision)
        await this.enqueue(t, d.returnMemberId, output.outputMessageId, `group-return:${digest(d.id)}`);
      if (state === 'completed' && output) {
        await this.state.putGroup({
          ...g,
          nextMemberId: nextRoundRobinMember(this.state.members(g), d.memberId),
          revision: g.revision + 1,
          updatedAt: Date.now(),
        });
      }
    });
  }
  async deliver(t: GroupTurn, d0: GroupDelivery, deadline: number) {
    const controller = new AbortController();
    const inputAdmission = new AbortController();
    this.state.inputAdmissions.set(d0.id, inputAdmission);
    this.state.controllers.set(d0.id, controller);
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    let activation: SubagentActivation | undefined;
    let reservedChild: string | undefined;
    let disposal: Promise<void> | undefined;
    const stopNative = () => {
      if (activation) {
        disposal ??= activation.dispose();
        void disposal.catch(() => {});
      }
    };
    controller.signal.addEventListener('abort', stopNative, { once: true });
    try {
      const prepared = await this.prepareDelivery(t, d0.id, controller.signal);
      if (!prepared) return;
      // A member can be removed while native startup awaits: signal remains authoritative.
      const g = this.state.record(t.group);
      const flow = outlets(this.state.registry);
      const input = await groupChild(this.state, g, prepared.root.agent, prepared.d.bot,
        prepared.context.text, d0.id, controller.signal);
      const childId = input?.childId ?? SessionId(randomUUID());
      reservedChild = childId;
      this.state.workers.set(childId, { turnId: t.id, deliveryId: d0.id, childId, rootId: g.rootSessionId, presetId: prepared.d.presetId, modelSelection: prepared.modelSelection, isActive: () => !this.state.stopped && !this.state.cancelledTurns.has(t.id) && !controller.signal.aborted && this.state.workers.get(childId)?.deliveryId === d0.id, audience: this.state.members(g).filter(m => m.enabled && m.removedAt === undefined).map(m => m.bot) });
      workerReservations.set(childId, need(this.state.workers.get(childId)));
      const start = (dispatchSignal = controller.signal) => this.state.ctx.subagents.startActivation({
        childId,
        provider: 'spawn',
        delivery: 'caller',
        label: prepared.bot.name,
        signal: dispatchSignal,
        request: {
          parent: prepared.root.agent,
          agentPreset: prepared.d.presetId,
          agentOptions: prepared.route,
          prompt: [...blocks(prepared.context.text), ...prepared.attachmentBlocks],
          maxDepth: this.state.registry.config.groupMaxDepth,
        },
      });
      activation = input ? await need(flow).dispatch(input.id, (_envelope, signal) => start(signal), controller.signal) : await start();
      // Observe settlement independently of the shared queue and delivery-result persistence.
      // This closes only supplemental inbox admission; a successful result remains successful.
      void activation.result.then(() => inputAdmission.abort(), () => inputAdmission.abort());
      this.state.activations.set(d0.id, activation);
      if (controller.signal.aborted) stopNative();
      const currentBot = await this.state.bot(prepared.d.bot);
      if (currentBot.updatedAt !== prepared.d.botRevision) {
        controller.abort();
        throw new OperationError('conflict');
      }
      await this.state.queue.run(async () => {
        await this.state.putDelivery({
          ...need(this.state.table('deliveries').get(d0.id)),
          state: 'running',
          childSessionId: activation?.childId,
        });
      });
      const result = await activation.result;
      // Close supplementation before waiting for the shared persistence queue.
      this.state.settledInputs.add(d0.id);
      await this.recordDeliveryResult(t, d0.id, prepared, activation.childId, result, controller.signal);
    } catch (error) {
      await this.state.queue.run(async () => {
        const d = need(this.state.table('deliveries').get(d0.id));
        await this.state.putDelivery({
          ...d,
          ...(activation ? { childSessionId: activation.childId } : {}),
          state:
            error instanceof OperationError && hasOperationCode(error, 'recovery-needed')
              ? 'unknown'
              : controller.signal.aborted
                ? 'cancelled'
                : 'failed',
          reasonCode: error instanceof OperationError ? error.code : 'native-failure',
        });
      });
    } finally {
      inputAdmission.abort();
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', stopNative);
      if (activation) {
        disposal ??= activation.dispose();
        await disposal;
      }
      if (reservedChild) { this.state.workers.delete(reservedChild); workerReservations.delete(reservedChild); }
      this.state.inputAdmissions.delete(d0.id);
      this.state.settledInputs.delete(d0.id);
      this.state.activations.delete(d0.id);
      this.state.controllers.delete(d0.id);
    }
  }
  async execute(id: string) {
    let t = need(this.state.table('turns').get(id));
    if (terminal(t)) {
      this.state.cancelledTurns.delete(id);
      return;
    }
    await this.state.queue.run(async () => {
      t = await this.state.putTurn({ ...t, state: 'running' });
    });
    const deadline = t.createdAt + this.state.registry.config.groupRoundTimeoutMs;
    for (;;) {
      const d0 = this.state.deliveries(id).find(d => d.state === 'pending');
      if (!d0) break;
      await this.deliver(t, d0, deadline);
      if (this.state.table('deliveries').get(d0.id)?.state === 'unknown') {
        await this.state.queue.run(async () => {
          for (const rest of this.state.deliveries(id).filter((d) => d.state === 'pending'))
            await this.state.putDelivery({ ...rest, state: 'cancelled', reasonCode: 'previous-result-unknown' });
        });
        break;
      }
    }
    await this.state.queue.run(async () => {
      const current = need(this.state.table('turns').get(id)),
        rows = this.state.deliveries(id);
      const state = rows.some((d) => d.state === 'unknown')
        ? 'recovery_needed'
        : this.state.cancelledTurns.has(id) || rows.every((d) => d.state === 'cancelled')
          ? 'cancelled'
          : rows.every((d) => d.state === 'completed' || d.state === 'skipped')
            ? 'completed'
            : 'partial';
      await this.state.putTurn({ ...current, state });
      this.state.cancelledTurns.delete(id);
    });
  }
}
