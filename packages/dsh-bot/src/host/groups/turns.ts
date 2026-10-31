import { followupInput, groupInput } from './data-flow.js';
import { outlets } from '../data-flow/tool-guard.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { groupSendSchema, type GroupKey, type GroupTurn } from '../../shared/groups.js';
import { OperationError, digest, need, parse } from '../common/operations.js';
import { groupContext, routeMembers } from './routing.js';

import { blocks, terminal } from './model.js';
import type { GroupState } from './state.js';
import type { GroupRoots } from './roots.js';
import type { GroupMessages } from './messages.js';
import type { GroupTurnRunner } from './turn-runner.js';
export class GroupTurns {
  constructor(
    private state: GroupState,
    private roots: GroupRoots,
    private messages: GroupMessages,
    private runner: GroupTurnRunner,
  ) {}
  async send(key: GroupKey, value: unknown) {
    const input = parse(groupSendSchema, value);
    return this.state.queue.run(async () => {
      const g = this.state.record(key),
        id = `turn:${digest([key, input.operationId])}`,
        hash = digest({ ...input, ...(input.fileReceiptIds.length ? {} : { fileReceiptIds: undefined }) });
      const used = this.state.turns(g).flatMap(t => [
        ...(t.operationId === input.operationId ? [{ requestDigest: t.requestDigest }] : []),
        ...(t.followups ?? []).filter(row => row.operationId === input.operationId),
      ]);
      if (used.some(row => row.requestDigest !== hash)) throw new OperationError('conflict');
      if (input.followup) return this.followup(key, input, hash);
      const old = this.state.table('turns').get(id);
      if (old) {
        if (old.requestDigest !== hash) throw new OperationError('conflict');
        return old;
      }
      if (g.archived || g.state !== 'ready' || this.state.reasons.has(g.id))
        throw new OperationError('recovery-needed');
      if (g.membershipRevision !== input.expectedMembershipRevision) throw new OperationError('conflict');
      const root = await this.roots.restore(g);
      const replied = input.replyTo ? this.messages.messages(g).find(m => m.id === input.replyTo) : undefined;
      if (input.replyTo && !replied) throw new OperationError('invalid');
      const replyMember = replied?.speaker && this.state.members(g).find(m =>
        m.bot.botId === replied.speaker?.bot.botId && m.bot.botCreatedAt === replied.speaker.bot.botCreatedAt);
      const selected = routeMembers(
        g,
        this.state.members(g),
        input.memberIds.length ? input.memberIds : replyMember ? [replyMember.id] : [],
        input.round,
        this.state.registry.config.groupMaxTurns,
      );
      await this.state.validateMembers(selected.map((m) => m.bot));
      const provider = this.state.ctx.subagents.getProvider('spawn');
      if (
        !provider ||
        provider.inheritsParentContext ||
        !provider.capabilities.agentPreset ||
        !provider.capabilities.agentOptions ||
        !provider.capabilities.depthLimit
      )
        throw new OperationError('unsupported');
      const receiptIds = [...new Set(input.fileReceiptIds)];
      const uploads = receiptIds.length ? need(this.state.ctx.get('fileUploads')) : undefined;
      const files = receiptIds.map(receiptId => {
        const ref = uploads?.resolve(root.agent, receiptId as Parameters<NonNullable<typeof uploads>['resolve']>[1]);
        if (!ref) throw new OperationError('invalid');
        return { type: 'file' as const, attachment: ref };
      });
      // Keep native user attribution: fileUploads retires bound receipts by user rpcId.
      // Extra protocol metadata is public JSON source data for the workspace projection.
      const source = { kind: 'user' as const, group: key, turnId: id,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}), ...(files.length ? { rpcId: id } : {}) };
      const message = createUserMessage({ source, content: [...blocks(input.text), ...files] });
      const at = Date.now();
      const turn: GroupTurn = {
        id,
        group: key,
        operationId: input.operationId,
        requestDigest: hash,
        inputMessageId: message.id,
        membershipRevision: g.membershipRevision,
        orderedMemberIds: selected.map((m) => m.id),
        mode: g.mode,
        ...(g.modelSelection ? { modelSelection: { ...g.modelSelection } } : {}),
        ...(g.memberModelSelections ? { memberModelSelections: g.memberModelSelections.map(row => ({
          memberId: row.memberId, modelSelection: { ...row.modelSelection },
        })) } : {}),
        contextThroughSeq: this.messages.messages(g).at(-1)?.seq ?? -1,
        predecessorTurnIds: g.mode === 'natural' ? [] : this.state.turns(g).filter(t => !terminal(t)).map(t => t.id),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        state: 'accepted',
        revision: 1,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
      };
      // Reject an oversized required question before admitting any native or model side effect.
      groupContext(
        g.name,
        selected[0]?.bot.botId ?? '',
        this.state.members(g).map((m) => m.bot.botId),
        { id: message.id, seq: 0, at, text: input.text, turnId: id, ...(files.length ? { attachments: files } : {}) },
        [],
        [],
        this.state.registry.config.groupContextMaxBytes,
      );
      const flowId = await groupInput(this.state, g, root.agent, JSON.stringify(message), id);
      const flow = outlets(this.state.registry);
      if (flowId) await need(flow).persist(flowId, () => this.state.putTurn(turn));
      else await this.state.putTurn(turn);
      try {
        const statuses = await this.state.registry.status();
        for (const [ordinal, m] of selected.entries()) {
          const bot = await this.state.bot(m.bot);
          const status = need(statuses.find((s) => s.id === bot.id));
          await this.state.putDelivery({
            id: `${id}:${ordinal}`,
            turnId: id,
            memberId: m.id,
            ordinal,
            bot: m.bot,
            botRevision: bot.updatedAt,
            presetId: status.presetId,
            contextOutputMessageIds: [],
            contextTruncated: false,
            state: 'pending',
          });
        }
        using receiptBinding = uploads?.bindPrompt(root.agent, receiptIds as Parameters<NonNullable<typeof uploads>['bindPrompt']>[1], id);
        const send = () => root.agent.session.append('user/message', message, { surfaceOp: 'append' });
        const event = flowId ? await need(flow).dispatch(flowId, send) : send();
        receiptBinding?.commit();
        await this.roots.flush(root);
        const accepted = await this.state.putTurn({ ...turn, inputSeq: Number(event.seq) });
        const limit = g.mode === 'natural' ? this.state.registry.config.groupConcurrentTurns : 1;
        const running = this.state.schedule(g.id, limit, async () => {
          try { await this.runner.execute(id); }
          catch {
            await this.state.queue.run(async () => {
              const t = this.state.table('turns').get(id);
              if (t && !terminal(t)) await this.state.putTurn({ ...t, state: 'recovery_needed' });
            });
          }
        });
        this.state.chains.set(id, running);
        void running.finally(() => this.state.chains.delete(id)).catch(() => {});
        return accepted;
      } catch {
        await this.state.putTurn({ ...turn, state: 'recovery_needed' });
        throw new OperationError('recovery-needed');
      }
    });
  }
  /** Queue-owned, durable acceptance prevents re-dispatch after an unknown native outcome. */
  private async followup(key: GroupKey, input: ReturnType<typeof groupSendSchema.parse>, hash: string) {
    const g = this.state.record(key), target = need(input.followup);
    const t = this.state.turns(g).find(row => row.id === target.turnId);
    if (!t) throw new OperationError('not-found');
    const old = t.followups?.find(row => row.operationId === input.operationId);
    if (old) {
      if (old.requestDigest !== hash) throw new OperationError('conflict');
      if (old.state !== 'accepted') throw new OperationError('recovery-needed');
      return t;
    }
    if (!input.text || input.fileReceiptIds.length || input.memberIds.length || input.round || input.replyTo)
      throw new OperationError('invalid');
    if (g.membershipRevision !== input.expectedMembershipRevision || t.membershipRevision !== g.membershipRevision)
      throw new OperationError('conflict');
    const d = this.state.deliveries(t.id).find(row => row.id === target.deliveryId);
    const active = d && this.state.activations.get(d.id), controller = d && this.state.controllers.get(d.id);
    const inputAdmission = d && this.state.inputAdmissions.get(d.id);
    const member = d && this.state.members(g).find(m => m.id === d.memberId && m.enabled && m.removedAt === undefined);
    if (!d || !active || !controller || !inputAdmission || !member || d.state !== 'running' || d.skipped ||
      this.state.settledInputs.has(d.id) || inputAdmission.signal.aborted || terminal(t) ||
      g.archived || this.state.cancelledTurns.has(t.id) || controller.signal.aborted)
      throw new OperationError('unavailable');
    const admissionSignal = AbortSignal.any([controller.signal, inputAdmission.signal]);
    const assertInputOpen = () => {
      if (admissionSignal.aborted || this.state.stopped || this.state.settledInputs.has(d.id) || this.state.activations.get(d.id) !== active)
        throw new OperationError('unavailable');
    };
    await this.state.validateMembers([d.bot]);
    // Validation and native storage can yield while the result settles outside this queue.
    assertInputOpen();
    const root = need(this.state.roots.get(g.id));
    const message = createUserMessage({ source: { kind: 'dsh-bot-group-followup', group: key,
      turnId: t.id, deliveryId: d.id, replyTo: d.triggerMessageId ?? t.inputMessageId }, content: blocks(input.text) });
    const receipt = { operationId: input.operationId, requestDigest: hash, deliveryId: d.id,
      messageId: message.id, state: 'dispatching' as const };
    const flowId = await groupInput(this.state, g, root.agent, JSON.stringify(message), `followup:${input.operationId}`);
    const flow = outlets(this.state.registry);
    assertInputOpen();
    const persist = () => {
      assertInputOpen();
      return this.state.putTurn({ ...t, followups: [...(t.followups ?? []), receipt] });
    };
    if (flowId) await need(flow).persist(flowId, persist); else await persist();
    try {
      const append = () => root.agent.session.append('user/message', message, { surfaceOp: 'append' });
      assertInputOpen();
      if (flowId) await need(flow).dispatch(flowId, append, admissionSignal); else append();
      await this.roots.flush(root);
      const childMessageId = await followupInput(this.state, g, root.agent, d.bot, active.childId,
        input.text, `followup:${input.operationId}`, admissionSignal, () => {
          assertInputOpen();
          return this.state.ctx.subagents.prompt({
          requestId: input.operationId as SubagentPromptRequestId, parentSessionId: root.agent.session.id,
          childSessionId: SessionId(active.childId), mode: 'continuable', delivery: 'steer', content: blocks(input.text),
        }, admissionSignal);
        });
      const current = need(this.state.table('turns').get(t.id));
      return this.state.putTurn({ ...current, followups: current.followups?.map(row => row.operationId === input.operationId
        ? { ...row, state: 'accepted', childMessageId: childMessageId.messageId } : row) });
    } catch {
      const current = need(this.state.table('turns').get(t.id));
      await this.state.putTurn({ ...current, followups: current.followups?.map(row => row.operationId === input.operationId
        ? { ...row, state: 'unknown' } : row) });
      throw new OperationError('recovery-needed');
    }
  }
  async cancel(key: GroupKey, turnId: string, revision: number) {
    return this.state.queue.run(async () => {
      const g = this.state.record(key),
        t = this.state.turns(g).find((t) => t.id === turnId);
      if (!t) throw new OperationError('not-found');
      if (t.revision !== revision) throw new OperationError('conflict');
      if (terminal(t)) return t;
      this.state.cancelledTurns.add(t.id);
      for (const d of this.state.deliveries(t.id)) {
        this.state.controllers.get(d.id)?.abort();
        if (d.state === 'pending') await this.state.putDelivery({ ...d, state: 'cancelled' });
      }
      const active = this.state.deliveries(t.id).some((d) => ['starting', 'running'].includes(d.state));
      return this.state.putTurn({ ...t, state: active ? t.state : 'cancelled' });
    });
  }
  async archive(key: GroupKey, revision: number) {
    const next = await this.state.queue.run(async () => {
      const g = this.state.record(key);
      if (g.revision !== revision) throw new OperationError('conflict');
      const next = { ...g, archived: true, revision: g.revision + 1, updatedAt: Date.now() };
      await this.state.putGroup(next);
      for (const t of this.state.turns(g).filter((t) => !terminal(t))) {
        this.state.cancelledTurns.add(t.id);
        for (const d of this.state.deliveries(t.id)) this.state.controllers.get(d.id)?.abort();
      }
      return next;
    });
    await Promise.all(this.state.turns(next).map(t => this.state.chains.get(t.id)));
    await this.state.queue.run(async () => {
      const h = this.state.roots.get(next.id);
      if (h) {
        await this.roots.flush(h);
        await this.roots.release(h);
        this.state.roots.delete(next.id);
      }
    });
    return next;
  }
}
