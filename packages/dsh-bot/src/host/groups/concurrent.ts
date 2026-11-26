import { markRelay, readRelayAnswer, assertRelayMember } from './relay-answer.js';
import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent';
import type { z } from 'zod';
import type { GroupDelivery, GroupTurn } from '../../shared/groups.js';
import { OperationError, digest, need } from '../common/operations.js';
import { outlets } from '../data-flow/tool-guard.js';
import { blocks } from './model.js';
import { followupInput, guestQuestionInput, groupChild, groupResult, GroupExportError, checkGroupDispatch } from './data-flow.js';
import { workerReservations, admitGroupInput, type WorkerBinding, type groupToolInput } from './worker-tool.js';
import type { GroupState } from './state.js';
import type { GroupRoots } from './roots.js';
import type { GroupMessages } from './messages.js';
import type { GroupTurnRunner } from './turn-runner.js';
import { compatibleActivationSpec } from '../common/subagent-activation.js';
import { checkSupergroup, groupReaders } from './supergroup-admission.js';

/** Task-local single ownership; the shared FIFO bounds native work across tasks. */
export class ConcurrentGroups {
  constructor(private state: GroupState, private roots: GroupRoots, private messages: GroupMessages, private runner: GroupTurnRunner) {}
  async message(agent: Agent, binding: WorkerBinding, input: z.output<typeof groupToolInput>, callId: string, signal: AbortSignal) {
    if (input.action === 'request-expert') throw new OperationError('approval-denied');
    return this.state.queue.run(async () => {
      signal.throwIfAborted();
      const t = need(this.state.table('turns').get(binding.turnId)), g = this.state.record(t.group),
        d = need(this.state.table('deliveries').get(binding.deliveryId));
      await checkSupergroup(this.state, g);
      if (this.state.workers.get(agent.session.id) !== binding || !binding.isActive?.() || !['starting', 'running'].includes(d.state)) throw new OperationError('approval-denied');
      if (input.action === 'skip') { await this.state.putDelivery({ ...d, skipped: true }); return { status: 'skipped' }; }
      if (d.skipped) throw new OperationError('invalid');
      const all = this.messages.messages(g), reply = input.replyTo ? all.find(m => m.id === input.replyTo) : undefined;
      if (input.replyTo && (!reply || (reply.seq > t.contextThroughSeq && reply.turnId !== t.id))) throw new OperationError('invalid');
      const target = input.to ?? (reply?.speaker && this.state.members(g).find(m => m.bot.botId === reply.speaker?.bot.botId && m.bot.botCreatedAt === reply.speaker.bot.botCreatedAt)?.id);
      const requested = [...new Set(input.targets ?? (target ? [target] : []))];
      const progress = input.kind === 'progress' || !requested.length;
      if (input.requestReply && progress) throw new OperationError('invalid');
      const members = this.state.members(g).filter(m => m.enabled && m.removedAt === undefined);
      if (requested.some(id => id === d.memberId || !members.some(m => m.id === id))) throw new OperationError('invalid');
      // A broadcast is a progress update: only already active peers receive it.
      const recipients = progress ? members.filter(m => m.id !== d.memberId && this.active(t.id, m.id)).map(m => m.id) : requested;
      const root = need(this.state.roots.get(g.id)), bot = await this.state.bot(d.bot),
        id = `group-message:${digest([d.id, callId])}`, hash = digest(input);
      const old = this.state.table('deliveries').get(id);
      if (old) {
        if (old.requestDigest !== hash) throw new OperationError('conflict');
        if (old.state === 'failed') throw new GroupExportError(old.reasonCode === 'export-approval-required' ? 'export-approval-required' : 'export-blocked', old.exportFlowId);
        return { status: old.state === 'unknown' ? 'unknown' : 'accepted', messageId: old.triggerMessageId };
      }
      const message = createUserMessage({ source: { kind: 'dsh-bot-group', group: t.group, turnId: t.id, memberId: d.memberId,
        speaker: { bot: d.bot, name: bot.name, ...(bot.avatar ? { avatar: bot.avatar } : {}), ...(bot.avatarColor ? { avatarColor: bot.avatarColor } : {}), ...(bot.avatarVariant ? { avatarVariant: bot.avatarVariant } : {}) },
        childSessionId: binding.childId, stopReason: progress ? 'group-progress' : 'group-request', replyTo: input.replyTo ?? d.triggerMessageId ?? t.inputMessageId, causeId: t.id }, content: blocks(input.text) });
      const receipt: GroupDelivery = { ...d, id, ordinal: this.state.deliveries(t.id).length, state: 'unknown',
        reasonCode: 'message-dispatch-unknown', requestDigest: hash, triggerMessageId: message.id, returnMemberId: undefined,
        outputMessageId: undefined, outputSeq: undefined, joinedDeliveryId: undefined };
      await this.state.putDelivery(receipt);
      try {
        await groupResult(this.state, g, d.bot, binding.childId, root.agent, JSON.stringify(message), id,
          () => root.agent.session.append('user/message', message, { surfaceOp: 'append' }), signal);
        await this.roots.flush(root);
        await this.state.putDelivery({ ...receipt, state: 'skipped', reasonCode: 'message-published' });
        for (const memberId of recipients) {
          if (t.stoppedMemberIds?.includes(memberId)) continue;
          const active = this.active(t.id, memberId);
          if (progress && !active) continue;
          const next = await this.runner.enqueue(t, memberId, message.id, `${id}:${digest(memberId)}`, input.requestReply ? d.memberId : undefined);
          const joined = active && await this.bridge(t, next, active, input.text, d.memberId, signal);
          if (progress && !joined) await this.state.putDelivery({ ...next, state: 'skipped', reasonCode: 'progress-peer-idle' });
        }
        this.state.wakeTurns.get(t.id)?.();
        return { status: 'accepted', messageId: message.id };
      } catch (error) {
        await this.state.putDelivery({ ...receipt, state: error instanceof GroupExportError ? 'failed' : 'unknown',
          reasonCode: error instanceof GroupExportError ? error.reasonCode : 'message-dispatch-unknown' });
        this.state.wakeTurns.get(t.id)?.();
        if (error instanceof GroupExportError) throw error;
        throw error instanceof OperationError ? error : new OperationError('recovery-needed');
      }
    });
  }
  async returnToActive(t: GroupTurn, receipt: GroupDelivery, text: string, author: string, signal: AbortSignal) {
    const active = this.active(t.id, receipt.memberId);
    if (active) await this.bridge(t, receipt, active, text, author, signal);
    this.state.wakeTurns.get(t.id)?.();
  }
  private active(turnId: string, memberId: string) {
    return this.state.deliveries(turnId).find(d => d.memberId === memberId && d.state === 'running' &&
      d.childSessionId && !d.skipped && !this.state.settledInputs.has(d.id) && !this.state.inputAdmissions.get(d.id)?.signal.aborted);
  }
  /** Called under the queue; the receipt is durable before an uncertain native effect. */
  private async bridge(t: GroupTurn, receipt: GroupDelivery, active: GroupDelivery, text: string, author: string, signal: AbortSignal) {
    const g = this.state.record(t.group), root = need(this.state.roots.get(g.id));
    const admission = this.state.inputAdmissions.get(active.id), controller = this.state.controllers.get(active.id);
    if (!admission || !controller || admission.signal.aborted || controller.signal.aborted) return false;
    const joined = { ...receipt, joinedDeliveryId: active.id, childSessionId: active.childSessionId, state: 'unknown' as const, reasonCode: 'inbox-dispatch-unknown' };
    await this.state.putDelivery(joined);
    const acceptedSignal = AbortSignal.any([signal, admission.signal, controller.signal]);
    const content = JSON.stringify({ taskId: t.id, messageId: receipt.triggerMessageId, authorMemberId: author, text });
    try {
      const childMessageId = await followupInput(this.state, g, root.agent, active.bot, need(active.childSessionId), content, receipt.id, acceptedSignal,
        () => { admitGroupInput(need(this.state.workers.get(need(active.childSessionId))), blocks(content), root.agent); return this.state.ctx.subagents.sendMessage(root.agent, SessionId(need(active.childSessionId)), blocks(content), { signal: acceptedSignal }); }, [need(receipt.triggerMessageId)]);
      await this.state.putDelivery({ ...need(this.state.table('deliveries').get(receipt.id)), childMessageId, state: 'skipped', reasonCode: 'inbox-accepted' });
      return true;
    } catch { throw new OperationError('recovery-needed'); }
  }
  async execute(id: string) {
    const running = new Map<string, Promise<void>>();
    let wake!: () => void;
    let changed = new Promise<void>(resolve => { wake = resolve; });
    this.state.wakeTurns.set(id, () => wake());
    try {
      await this.state.queue.run(async () => {
        const t = need(this.state.table('turns').get(id));
        if (['accepted', 'paused'].includes(t.state)) await this.state.putTurn({ ...t, state: 'running' });
      });
      for (;;) {
        let t = need(this.state.table('turns').get(id));
        const pending = this.state.deliveries(id).filter(d => d.state === 'pending');
        let available = Math.max(0, (t.continuationAllowance ?? 0) - (t.automaticExecutions ?? 0));
        for (const d of pending) {
          if (running.has(d.memberId)) continue;
          if (d.automatic && available <= 0 && !this.state.cancelledTurns.has(id) && !this.state.stopped) continue;
          if (d.automatic) available--;
          // Mark task/member ownership before shared FIFO admission, including queued jobs.
          const promise = this.state.schedule(`members:${t.group.groupId}`, this.state.registry.config.groupConcurrentMembers,
            () => this.deliver(need(this.state.table('turns').get(id)), d)).finally(() => { running.delete(d.memberId); wake(); });
          running.set(d.memberId, promise);
        }
        if (!running.size) {
          // The shared queue serializes the idle decision with incoming requests.
          const settled = await this.state.queue.run(async () => {
            t = need(this.state.table('turns').get(id));
            const rows = this.state.deliveries(id), remaining = rows.filter(d => d.state === 'pending');
            if (remaining.some(d => !d.automatic || (t.automaticExecutions ?? 0) < (t.continuationAllowance ?? 0)) && !this.state.stopped && !this.state.cancelledTurns.has(id)) return false;
            const state = rows.some(d => d.state === 'unknown') ? 'recovery_needed' :
              this.state.stopped || this.state.cancelledTurns.has(id) || rows.filter(d => d.reasonCode !== 'message-published').every(d => d.state === 'cancelled') ? 'cancelled' : remaining.length ? 'paused' :
              rows.some(d => d.state === 'failed') ? 'partial' : 'idle';
            await this.state.putTurn({ ...t, state }); return true;
          });
          if (settled) break;
        }
        await Promise.race([...running.values(), changed]);
        changed = new Promise<void>(resolve => { wake = resolve; });
      }
    } finally {
      try {
        await Promise.allSettled(running.values());
      } finally {
        this.state.wakeTurns.delete(id); this.state.cancelledTurns.delete(id);
        // Idle children have durable history but no continued tool capability.
        for (const [childId, binding] of this.state.workers) if (binding.turnId === id) {
          this.state.workers.delete(childId);
          if (workerReservations.get(childId) === binding) workerReservations.delete(childId);
        }
      }
    }
  }
  private async deliver(t: GroupTurn, d0: GroupDelivery) {
    const controller = new AbortController(), admission = new AbortController();
    this.state.controllers.set(d0.id, controller); this.state.inputAdmissions.set(d0.id, admission);
    let nativeDispatchStarted = false;
    let activation: SubagentActivation | undefined, childId: string | undefined, runId: string | undefined;
    let acceptedMessageId: string | undefined;
    let releaseEvents = () => {}, timer: ReturnType<typeof setTimeout> | undefined;
    const cleanupErrors: unknown[] = [];
    const stop = () => {
      if (activation) { void activation.dispose().catch(() => {}); return; }
      if (!childId) return;
      const root = this.state.roots.get(t.group.groupId);
      if (!root) return;
      try {
        void Promise.resolve(this.state.ctx.subagents.interrupt(SessionId(childId), { kind: 'ancestor', agent: root.agent })).catch(() => {});
      } catch {
        /* Drain in finally handles remaining child cleanup. */
      }
    };
    controller.signal.addEventListener('abort', stop);
    try {
      const prepared = await this.runner.prepareDelivery(t, d0.id, controller.signal);
      if (!prepared) return;
      // Human review can take longer than a worker timeout. A gets its task window when B's reply is released.
      const admittedAt = t.guestQuestion?.via && d0.ordinal === 1 ? need(this.state.table('deliveries').get(t.id + ':0')?.answeredAt) : t.createdAt;
      const limits = [this.state.registry.config.groupTaskTimeoutMs ? admittedAt + this.state.registry.config.groupTaskTimeoutMs : Infinity,
        this.state.registry.config.groupMemberTimeoutMs ? Date.now() + this.state.registry.config.groupMemberTimeoutMs : Infinity];
      const deadline = Math.min(...limits);
      if (Number.isFinite(deadline)) timer = setTimeout(() => controller.abort('configured-timeout'), Math.max(1, deadline - Date.now()));
      const g = prepared.group;
      const prior = t.guestQuestion ? undefined : this.state.deliveries(t.id).find(d => d.memberId === d0.memberId && d.childSessionId && !d.joinedDeliveryId && ['completed', 'skipped'].includes(d.state));
      const flow = outlets(this.state.registry);
      const input = t.guestQuestion && d0.ordinal === 0 ? await guestQuestionInput(this.state, g, prepared.root.agent, t, d0, prepared.context.text, controller.signal)
        : prior ? undefined : await groupChild(this.state, g, prepared.root.agent, prepared.d.bot,
          'groupInputText' in prepared.context ? prepared.context.groupInputText ?? prepared.context.text : prepared.context.text,
          d0.id, controller.signal, prepared.context.messageIds, prepared.messageDigests);
      childId = prior?.childSessionId ?? input?.childId ?? SessionId(randomUUID());
      // The original Bot's readers and source versions still constrain A's answer to the group.
      if (prepared.relayAnswer) await need(flow).inherit(childId, prepared.relayAnswer.label);
      const previous = this.state.workers.get(childId);
      const binding: WorkerBinding = previous ?? { turnId: t.id, deliveryId: d0.id, childId, rootId: g.rootSessionId, presetId: prepared.d.presetId, audience: [] };
      Object.assign(binding, { deliveryId: d0.id, guestQuestion: t.guestQuestion ? true : undefined,
        guestIdentity: t.guestQuestion ? { bot: d0.bot, revision: d0.botRevision } : undefined, modelSelection: prepared.modelSelection, audience: groupReaders(this.state, g),
        resumeAllowed: Boolean(prior), isActive: () => !this.state.stopped && !this.state.cancelledTurns.has(t.id) && !controller.signal.aborted &&
          !admission.signal.aborted && this.state.workers.get(need(childId)) === binding });
      if (binding.agent !== this.state.ctx.agents.get(SessionId(childId))) binding.agent = undefined;
      this.state.workers.set(childId, binding); workerReservations.set(childId, binding);
      let ended!: (result: SubagentResult) => void;
      const end = new Promise<SubagentResult>(resolve => { ended = resolve; });
      const abortEnd = () => {
        admission.abort();
        ended({ stopReason: 'aborted', output: [] });
      };
      releaseEvents = this.state.ctx.effect(() => {
        const offStart = this.state.ctx.on('subagent/start', info => { if (info.id === childId) runId = info.runId; });
        const offEnd = this.state.ctx.on('subagent/end', info => {
          if (info.id !== childId || runId === undefined || info.runId !== runId) return;
          admission.abort(); ended({ stopReason: info.stopReason, output: info.lastAssistantMessage ?? [] });
        });
        controller.signal.addEventListener('abort', abortEnd, { once: true });
        return () => { offStart(); offEnd(); controller.signal.removeEventListener('abort', abortEnd); };
      }, 'dsh-bot: exact group activation result');
      if (controller.signal.aborted) abortEnd();
      await this.state.queue.run(async () => this.state.putDelivery({ ...need(this.state.table('deliveries').get(d0.id)), childSessionId: childId }));
      if (prior) {
        acceptedMessageId = await followupInput(this.state, g, prepared.root.agent, prepared.d.bot, childId, prepared.context.text, d0.id, controller.signal,
          () => { const content = [...blocks(prepared.context.text), ...prepared.attachmentBlocks]; admitGroupInput(binding, content, prepared.root.agent); nativeDispatchStarted = true; return this.state.ctx.subagents.sendMessage(prepared.root.agent, SessionId(need(childId)), content, { signal: controller.signal }); }, prepared.context.messageIds, prepared.messageDigests, false);
      } else {
        const start = (signal = controller.signal) => { nativeDispatchStarted = true; return this.state.ctx.subagents.startActivation(compatibleActivationSpec({ childId: SessionId(need(childId)), provider: 'spawn', delivery: 'caller', label: prepared.bot.name, signal,
          request: { parent: prepared.root.agent, agentPreset: prepared.d.presetId, agentOptions: prepared.route, prompt: [...blocks(prepared.context.text), ...prepared.attachmentBlocks], maxDepth: this.state.registry.config.groupMaxDepth } })); };
        activation = input ? await need(flow).dispatch(input.id, (_e, signal) => start(signal), controller.signal,
          async () => {
            await checkGroupDispatch(this.state, g);
            if (t.guestQuestion?.via) assertRelayMember(this.state, t);
            if (prepared.relayAnswer && readRelayAnswer(this.state, g, t, d0).id !== prepared.relayAnswer.id)
              throw new OperationError('group-data-blocked');
          }) : await start();
        if (t.guestQuestion && (activation.childId !== childId || !activation.messageId)) throw new OperationError('recovery-needed');
        acceptedMessageId = activation.messageId;
        this.state.activations.set(d0.id, activation);
        void activation.result.then(() => admission.abort(), () => admission.abort());
      }
      if (controller.signal.aborted) stop();
      if ((await this.state.bot(prepared.d.bot)).updatedAt !== prepared.d.botRevision) { controller.abort('bot-changed'); throw new OperationError('conflict'); }
      await this.state.queue.run(async () => this.state.putDelivery({ ...need(this.state.table('deliveries').get(d0.id)), state: 'running', nativeRunId: runId, childMessageId: acceptedMessageId, ...(t.guestQuestion ? { acceptedAt: Date.now() } : {}) }));
      if (t.guestQuestion?.via) await markRelay(this.state, g, t, d0.ordinal === 0 ? 'request' : 'reply', controller.signal);
      const result = await (activation?.result ?? end);
      this.state.settledInputs.add(d0.id);
      await this.runner.recordDeliveryResult(t, d0.id, prepared, childId, result, controller.signal);
    } catch (error) {
      await this.state.queue.run(async () => this.state.putDelivery({ ...need(this.state.table('deliveries').get(d0.id)),
        state: controller.signal.aborted ? 'cancelled' : nativeDispatchStarted || error instanceof OperationError && error.code === 'dsh-bot/recovery-needed' ? 'unknown' : 'failed',
        endedAt: Date.now(), reasonCode: controller.signal.aborted ? String(controller.signal.reason ?? 'user-stop') : error instanceof OperationError ? error.code : 'native-failure' }));
    } finally {
      admission.abort(); clearTimeout(timer); releaseEvents(); controller.signal.removeEventListener('abort', stop);
      try {
        try {
          await activation?.dispose();
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (controller.signal.aborted && childId) {
          const root = this.state.roots.get(t.group.groupId);
          if (root && typeof this.state.ctx.subagents?.drainChildren === 'function') {
            try {
              await this.state.ctx.subagents.drainChildren(root.agent, [SessionId(childId)]);
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
        }
      } finally {
        this.state.controllers.delete(d0.id); this.state.inputAdmissions.delete(d0.id); this.state.activations.delete(d0.id); this.state.settledInputs.delete(d0.id);
      }
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Group delivery cleanup failed');
  }
}
