import { followupInput, groupInput } from './data-flow.js';
import { outlets } from '../data-flow/tool-guard.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { groupSendSchema, ownerFollowUpBindingSchema, type GroupKey, type GroupTurn, type OwnerFollowUpBinding } from '../../shared/groups.js';
import { OperationError, digest, need, parse } from '../common/operations.js';
import { groupContext, routeMembers } from './routing.js';

import { blocks, terminal } from './model.js';
import type { GroupState } from './state.js';
import type { GroupRoots } from './roots.js';
import type { GroupMessages } from './messages.js';
import type { GroupTurnRunner } from './turn-runner.js';
import { ownerFollowUpChoice, verifyOwnerFollowUpChoice } from './owner-follow-up.js';
export class GroupTurns {
  constructor(
    private state: GroupState,
    private roots: GroupRoots,
    private messages: GroupMessages,
    private runner: GroupTurnRunner,
  ) {}
  async send(key: GroupKey, value: unknown) {
    const input = parse(groupSendSchema, value);
    return this.accept(key, input);
  }
  startProactiveReview(
    key: GroupKey, value: unknown, review: NonNullable<GroupTurn['proactive']>, check: () => Promise<void>,
  ) {
    return this.accept(key, parse(groupSendSchema, value), { review, check });
  }
  ownerFollowUpChoice(key: GroupKey, predecessorTurnId: string, memberId: string) {
    return this.state.queue.run(() => ownerFollowUpChoice(this.state, key, predecessorTurnId, memberId));
  }
  ownerFollowUpUnstarted(key: GroupKey, operationId: string) {
    return this.state.queue.run(async () => {
      this.state.record(key);
      return !this.state.table('turns').get(`turn:${digest([key, operationId])}`);
    });
  }
  abandonOwnerFollowUp<T>(key: GroupKey, operationId: string, abandon: () => Promise<T>) {
    return this.state.queue.run(async () => {
      this.state.record(key);
      if (this.state.table('turns').get(`turn:${digest([key, operationId])}`)) throw new OperationError('conflict');
      return abandon();
    });
  }
  startOwnerFollowUp(
    key: GroupKey, value: { operationId: string; text: string }, choice: OwnerFollowUpBinding,
    admit: () => Promise<void>, check: () => Promise<void>,
  ) {
    const binding = parse(ownerFollowUpBindingSchema, choice);
    const input = parse(groupSendSchema, { ...value, expectedMembershipRevision: binding.membershipRevision, memberIds: [binding.memberId] });
    if (!input.text || input.followup || input.fileReceiptIds.length || input.replyTo || input.round)
      throw new OperationError('invalid');
    return this.accept(key, input, { binding, admit, check });
  }
  private accept(key: GroupKey, input: ReturnType<typeof groupSendSchema.parse>,
    restricted?: { review: NonNullable<GroupTurn['proactive']>; check: () => Promise<void> }
      | { binding: OwnerFollowUpBinding; admit: () => Promise<void>; check: () => Promise<void> }) {
    return this.state.queue.run(async () => {
      const proactive = restricted && 'review' in restricted ? restricted : undefined;
      const owner = restricted && 'binding' in restricted ? restricted : undefined;
      const g = this.state.record(key),
        id = `turn:${digest([key, input.operationId])}`,
        hash = digest({ ...input, ...(input.fileReceiptIds.length ? {} : { fileReceiptIds: undefined }),
          ...(proactive ? { proactive: proactive.review } : {}), ...(owner ? { ownerFollowUp: owner.binding } : {}) });
      const used = this.state.turns(g).flatMap(t => [
        ...(t.operationId === input.operationId ? [{ requestDigest: t.requestDigest }] : []),
        ...(t.followups ?? []).filter(row => row.operationId === input.operationId),
      ]);
      if (used.some(row => row.requestDigest !== hash)) throw new OperationError('conflict');
      if (input.followup && !restricted) return this.followup(key, input, hash);
      const followUp = proactive?.review.followUp;
      const repair = proactive?.review.repair;
      if (proactive && (input.followup || input.fileReceiptIds.length || input.replyTo || input.round ||
          (followUp && repair) || input.memberIds.length !== (followUp || repair ? 1 : 2) || proactive.review.botRevisions.length !== input.memberIds.length))
        throw new OperationError('invalid');
      const old = this.state.table('turns').get(id);
      if (old) {
        if (old.requestDigest !== hash) throw new OperationError('conflict');
        return old;
      }
      if (g.archived || g.state !== 'ready' || this.state.reasons.has(g.id))
        throw new OperationError('recovery-needed');
      if (g.membershipRevision !== input.expectedMembershipRevision) throw new OperationError('conflict');
      if (owner) await verifyOwnerFollowUpChoice(this.state, key, owner.binding);
      if (proactive?.review.modelRevision !== undefined && (g.modelRevision ?? 0) !== proactive.review.modelRevision) throw new OperationError('conflict');
      if (proactive?.review.memberModels && (proactive.review.memberModels.length !== input.memberIds.length || proactive.review.memberModels.some(row => !input.memberIds.includes(row.memberId)))) throw new OperationError('invalid');
      if (followUp && proactive) {
        const parent = this.state.turns(g).find(t => t.id === followUp.predecessorTurnId);
        if (!parent || !['completed', 'partial'].includes(parent.state) ||
            parent.proactive?.assignmentId !== proactive.review.assignmentId ||
            parent.proactive?.ticketId !== proactive.review.ticketId ||
            !this.state.deliveries(parent.id).some(d => d.memberId === input.memberIds[0] && d.state === 'completed'))
          throw new OperationError('conflict');
      }
      if (repair && proactive) {
        if (Date.parse(repair.deadlineAt) <= Date.now() || repair.outputTokens >= repair.maxTokens) throw new OperationError('invalid');
        if (repair.phase === 'plan') { if (repair.predecessorTurnId) throw new OperationError('invalid'); }
        else {
          const parent = this.state.turns(g).find(turn => turn.id === repair.predecessorTurnId);
          if (!parent || parent.state !== 'completed' || parent.proactive?.assignmentId !== proactive.review.assignmentId ||
            parent.proactive.ticketId !== proactive.review.ticketId || parent.proactive.repair?.phase !== (repair.phase === 'implement' ? 'plan' : 'implement')) throw new OperationError('conflict');
        }
      }
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
      if (proactive) await proactive.check();
      else if (!owner && (
        !provider ||
        provider.inheritsParentContext ||
        !provider.capabilities.agentPreset ||
        !provider.capabilities.agentOptions ||
        !provider.capabilities.depthLimit
      ))
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
      const source = proactive ? {
        kind: 'dsh-bot-group-proactive' as const, group: key, turnId: id,
        ticketId: proactive.review.ticketId, assignmentId: proactive.review.assignmentId,
        ...(repair ? { repairPhase: repair.phase } : {}),
        ...(followUp ? { factId: followUp.factId, predecessorTurnId: followUp.predecessorTurnId } : {}),
      } : owner ? { kind: 'dsh-bot-group-owner-followup' as const, group: key, turnId: id,
        cardId: owner.binding.cardId, predecessorTurnId: owner.binding.predecessorTurnId,
      } : { kind: 'user' as const, group: key, turnId: id,
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
        mode: restricted ? 'round-robin' : g.mode,
        ...(proactive ? { proactive: proactive.review } : {}),
        ...(owner ? { ownerFollowUp: owner.binding } : {}),
        ...(!restricted && g.mode !== 'round-robin' ? { protocol: 2 as const, automaticExecutions: 0, continuationAllowance: this.state.registry.config.groupMaxContinuations } : {}),
        ...(g.modelSelection ? { modelSelection: { ...g.modelSelection } } : {}),
        ...(g.memberModelSelections ? { memberModelSelections: g.memberModelSelections.map(row => ({
          memberId: row.memberId, modelSelection: { ...row.modelSelection },
        })) } : {}),
        contextThroughSeq: restricted ? -1 : (this.messages.messages(g).at(-1)?.seq ?? -1),
        predecessorTurnIds: repair?.predecessorTurnId ? [repair.predecessorTurnId] : followUp ? [followUp.predecessorTurnId] :
          owner ? [owner.binding.predecessorTurnId] : restricted || g.mode !== 'round-robin' ? [] : this.state.turns(g).filter(t => !terminal(t)).map(t => t.id),
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
      if (owner) {
        await verifyOwnerFollowUpChoice(this.state, key, owner.binding);
        await owner.admit();
      }
      const flowId = await groupInput(this.state, g, root.agent, JSON.stringify(message), id);
      const flow = outlets(this.state.registry);
      if (flowId) await need(flow).persist(flowId, () => this.state.putTurn(turn));
      else await this.state.putTurn(turn);
      try {
        const statuses = await this.state.registry.status();
        for (const [ordinal, m] of selected.entries()) {
          const bot = await this.state.bot(m.bot);
          if ((proactive && bot.updatedAt !== proactive.review.botRevisions[ordinal]) ||
            (owner && bot.updatedAt !== owner.binding.botRevision))
            throw new OperationError('conflict');
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
        const append = () => root.agent.session.append('user/message', message, { surfaceOp: 'append' });
        const send = restricted ? async () => {
          if (owner) await verifyOwnerFollowUpChoice(this.state, key, owner.binding);
          await restricted.check();
          return append();
        } : append;
        const event = flowId ? await need(flow).dispatch(flowId, send) : restricted ? await send() : append();
        receiptBinding?.commit();
        await this.roots.flush(root);
        const accepted = await this.state.putTurn({ ...turn, inputSeq: Number(event.seq) });
        const limit = accepted.protocol === 2 ? Number.MAX_SAFE_INTEGER : 1;
        if (restricted) this.state.proactiveChecks.set(id, restricted.check);
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
        void running.finally(() => {
          this.state.chains.delete(id);
          this.state.proactiveChecks.delete(id);
        }).catch(() => {});
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
    if (t.proactive || t.ownerFollowUp) throw new OperationError('unsupported');
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
    const worker = d?.childSessionId && t.protocol === 2 ? this.state.workers.get(d.childSessionId) : undefined;
    const childId = active?.childId ?? (worker?.deliveryId === d?.id && worker?.isActive?.() ? d?.childSessionId : undefined);
    const inputAdmission = d && this.state.inputAdmissions.get(d.id);
    const member = d && this.state.members(g).find(m => m.id === d.memberId && m.enabled && m.removedAt === undefined);
    if (!d || !childId || !controller || !inputAdmission || !member || d.state !== 'running' || d.skipped ||
      this.state.settledInputs.has(d.id) || inputAdmission.signal.aborted || terminal(t) ||
      g.archived || this.state.cancelledTurns.has(t.id) || controller.signal.aborted)
      throw new OperationError('unavailable');
    const admissionSignal = AbortSignal.any([controller.signal, inputAdmission.signal]);
    const assertInputOpen = () => {
      if (admissionSignal.aborted || this.state.stopped || this.state.settledInputs.has(d.id) || (t.protocol === 2 ? this.state.workers.get(childId) !== worker || !worker?.isActive?.() : this.state.activations.get(d.id) !== active))
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
      const childMessageId = await followupInput(this.state, g, root.agent, d.bot, childId,
        input.text, `followup:${input.operationId}`, admissionSignal, () => {
          assertInputOpen();
          return this.state.ctx.subagents.prompt({
          requestId: input.operationId as SubagentPromptRequestId, parentSessionId: root.agent.session.id,
          childSessionId: SessionId(childId), mode: 'continuable', delivery: 'steer', content: blocks(input.text),
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
      if (terminal(t) && t.state !== 'paused') return t;
      this.state.cancelledTurns.add(t.id);
      this.state.wakeTurns.get(t.id)?.();
      for (const d of this.state.deliveries(t.id)) {
        this.state.controllers.get(d.id)?.abort('user-task-stop');
        if (d.state === 'pending') await this.state.putDelivery({ ...d, state: 'cancelled' });
      }
      const active = this.state.deliveries(t.id).some((d) => ['starting', 'running'].includes(d.state));
      return this.state.putTurn({ ...t, state: active ? t.state : 'cancelled' });
    });
  }
  async continueTurn(key: GroupKey, turnId: string, revision: number) {
    return this.state.queue.run(async () => {
      const g = this.state.record(key), t = need(this.state.turns(g).find(row => row.id === turnId));
      if (t.revision !== revision || t.membershipRevision !== g.membershipRevision) throw new OperationError('conflict');
      if (t.protocol !== 2 || t.state !== 'paused' || g.archived || this.state.chains.has(t.id)) throw new OperationError('unavailable');
      if (!this.state.registry.config.groupMaxContinuations) throw new OperationError('invalid');
      await this.roots.restore(g);
      const next = await this.state.putTurn({ ...t, state: 'accepted', continuationAllowance: (t.automaticExecutions ?? 0) + this.state.registry.config.groupMaxContinuations });
      const running = this.runner.execute(t.id).catch(() => this.state.queue.run(async () => {
        const current = this.state.table('turns').get(t.id);
        if (current && !terminal(current)) await this.state.putTurn({ ...current, state: 'recovery_needed' });
      }));
      this.state.chains.set(t.id, running);
      void running.finally(() => this.state.chains.delete(t.id)).catch(() => {});
      return next;
    });
  }
  async stopMember(key: GroupKey, turnId: string, memberId: string, revision: number) {
    return this.state.queue.run(async () => {
      const g = this.state.record(key), t = need(this.state.turns(g).find(row => row.id === turnId));
      if (t.revision !== revision) throw new OperationError('conflict');
      if (t.protocol !== 2 || !['accepted', 'running', 'paused'].includes(t.state) || !this.state.members(g).some(m => m.id === memberId)) throw new OperationError('invalid');
      const next = await this.state.putTurn({ ...t, stoppedMemberIds: [...new Set([...(t.stoppedMemberIds ?? []), memberId])] });
      for (const d of this.state.deliveries(t.id).filter(d => d.memberId === memberId)) {
        this.state.controllers.get(d.id)?.abort('user-member-stop');
        if (d.state === 'pending') await this.state.putDelivery({ ...d, state: 'cancelled', endedAt: Date.now(), reasonCode: 'user-member-stop' });
      }
      this.state.wakeTurns.get(t.id)?.();
      return next;
    });
  }
  async archive(key: GroupKey, revision: number) {
    const next = await this.state.queue.run(async () => {
      const g = this.state.record(key);
      if (g.revision !== revision) throw new OperationError('conflict');
      const next = { ...g, archived: true, revision: g.revision + 1, updatedAt: Date.now() };
      await this.state.putGroup(next);
      for (const t of this.state.turns(g).filter((t) => !terminal(t) || t.state === 'paused')) {
        this.state.cancelledTurns.add(t.id);
        this.state.wakeTurns.get(t.id)?.();
        for (const d of this.state.deliveries(t.id)) {
          this.state.controllers.get(d.id)?.abort('user-task-stop');
          if (d.state === 'pending') await this.state.putDelivery({ ...d, state: 'cancelled', reasonCode: 'user-task-stop', endedAt: Date.now() });
        }
        if (t.state === 'paused') { await this.state.putTurn({ ...t, state: 'cancelled' }); this.state.cancelledTurns.delete(t.id); }
      }
      return next;
    });
    await Promise.all(this.state.turns(next).map(t => this.state.chains.get(t.id)));
    await this.state.queue.run(async () => {
      const h = this.state.roots.get(next.id);
      if (h) {
        await this.state.ctx.subagents.drainChildren(h.agent, (await this.state.ctx.subagents.listChildren(h.agent.id)).map(child => child.id));
        await this.roots.flush(h);
        await this.roots.release(h);
        this.state.roots.delete(next.id);
      }
    });
    return next;
  }
}
