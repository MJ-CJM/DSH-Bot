import { groupChild, groupResult } from './data-flow.js';
import { outlets } from '../data-flow/tool-guard.js';
import { nextRoundRobinMember } from './round-robin.js';
import { hasOperationCode } from '../../shared/operation-errors.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent';
import type { GroupDelivery, GroupTurn, GroupSpeaker } from '../../shared/groups.js';
import { OperationError, need } from '../common/operations.js';
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
      const question = need(messages.find((m) => m.id === t.inputMessageId));
      const previous = this.state
        .deliveries(t.id)
        .filter((d) => d.outputMessageId)
        .map((d) => need(messages.find((m) => m.id === d.outputMessageId)));
      const participantNames = await Promise.all(
        this.state.deliveries(t.id).map(async (d) => {
          try {
            const b = await this.state.bot(d.bot);
            return `${b.name} (${b.id})`;
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
        previous,
        this.state.registry.config.groupContextMaxBytes,
      );
      await this.state.putDelivery({
        ...d,
        state: 'starting',
        contextOutputMessageIds: context.outputIds,
        contextTruncated: context.truncated,
      });
      return { root, bot, d, context, route: this.state.route() };
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
      const hasContent = Boolean(text.trim()) || result.output.some((b) => b.type !== 'text');
      const state = signal.aborted
        ? 'cancelled'
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
        ...(state !== 'completed'
          ? {
              reasonCode: signal.aborted ? 'cancelled-or-timeout' : text.trim() ? 'partial-output' : 'empty-or-failed',
            }
          : {}),
      });
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
    this.state.controllers.set(d0.id, controller);
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    let activation: SubagentActivation | undefined;
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
      const start = (dispatchSignal = controller.signal) => this.state.ctx.subagents.startActivation({
        ...(input ? { childId: input.childId } : {}),
        provider: 'spawn',
        delivery: 'caller',
        label: prepared.bot.name,
        signal: dispatchSignal,
        request: {
          parent: prepared.root.agent,
          agentPreset: prepared.d.presetId,
          agentOptions: prepared.route,
          prompt: blocks(prepared.context.text),
          maxDepth: this.state.registry.config.groupMaxDepth,
        },
      });
      activation = input ? await need(flow).dispatch(input.id, (_envelope, signal) => start(signal), controller.signal) : await start();
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
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', stopNative);
      if (activation) {
        disposal ??= activation.dispose();
        await disposal;
      }
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
    const deadline = Date.now() + this.state.registry.config.groupRoundTimeoutMs;
    for (const d0 of this.state.deliveries(id)) {
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
          : rows.every((d) => d.state === 'completed')
            ? 'completed'
            : 'partial';
      await this.state.putTurn({ ...current, state });
      this.state.cancelledTurns.delete(id);
    });
  }
}
