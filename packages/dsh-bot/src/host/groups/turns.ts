import { followupInput, groupInput, checkGroupDispatch } from './data-flow.js';
import { outlets } from '../data-flow/tool-guard.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent';
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { groupSendSchema, groupUploadedAttachment, ownerFollowUpBindingSchema, type GroupKey, type GroupMessage, type GroupTurn, type OwnerFollowUpBinding } from '../../shared/groups.js';
import { OperationError, digest, need, parse, redactedErrorMetadata } from '../common/operations.js';
import { memoryOnlyIntent } from '../../shared/group-memory-intent.js';
import { hasExplicitBotAddress, isAddressedQuestion, isGroupDelegation, matchGroupAddress, relayNeedsTopic } from '../../shared/addressed-bot.js';
import { resolveGroupMentions } from '../../shared/group-mentions.js';
import { sameBot } from '../../shared/identity.js';
import { guestDeliveryKey, guestPrompt } from './guest-question.js';
import { groupContext, groupParticipantLabel, selectOnDemand } from './routing.js';

import { blocks, textOf, terminal } from './model.js';
import type { GroupState } from './state.js';
import type { GroupRoots } from './roots.js';
import type { GroupMessages } from './messages.js';
import type { GroupTurnRunner } from './turn-runner.js';
import { ownerFollowUpChoice, verifyOwnerFollowUpChoice } from './owner-follow-up.js';
import { checkSupergroup, checkSupergroupEnqueue, type SupergroupAuthority } from './supergroup-admission.js';
export class GroupTurns {
  constructor(
    private state: GroupState,
    private roots: GroupRoots,
    private messages: GroupMessages,
    private runner: GroupTurnRunner,
  ) {}
  async send(key: GroupKey, value: unknown, authority?: SupergroupAuthority) {
    const input = parse(groupSendSchema, value);
    return this.accept(key, input, undefined, authority);
  }
  sendOwner(key: GroupKey, value: unknown) {
    return this.accept(key, parse(groupSendSchema, value), undefined, undefined, true);
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
      | { binding: OwnerFollowUpBinding; admit: () => Promise<void>; check: () => Promise<void> }, authority?: SupergroupAuthority, ownerInput = false) {
    return this.state.queue.run(async () => {
      const proactive = restricted && 'review' in restricted ? restricted : undefined;
      const owner = restricted && 'binding' in restricted ? restricted : undefined;
      const g = this.state.record(key),
        id = `turn:${digest([key, input.operationId])}`,
        hash = digest({ ...input, ...(input.fileReceiptIds.length ? {} : { fileReceiptIds: undefined }),
          ...(proactive ? { proactive: proactive.review } : {}), ...(owner ? { ownerFollowUp: owner.binding } : {}),
          ...(g.supergroup ? { supergroup: g.supergroup } : {}) });
      const scoped = g.supergroup ? await checkSupergroup(this.state, g) : undefined;
      checkSupergroupEnqueue(this.state, g);
      if (g.supergroup && (!authority || this.state.supergroupAuthorities.get(g.id) !== authority || restricted ||
          input.followup || input.fileReceiptIds.length || input.replyTo && !authority.groupInput || input.text !== scoped?.text.trim()) || !g.supergroup && authority)
        throw new OperationError('approval-denied');
      const memoryIntent = ownerInput && !g.supergroup && !restricted ? memoryOnlyIntent(input.text) : undefined;
      if (input.memoryStatusOnly && (g.supergroup || restricted || input.followup || input.replyTo && !memoryIntent)) throw new OperationError('invalid');
      const used = this.state.turns(g).flatMap(t => [
        ...(t.operationId === input.operationId ? [{ requestDigest: t.requestDigest }] : []),
        ...(t.followups ?? []).filter(row => row.operationId === input.operationId),
      ]);
      if (used.some(row => row.requestDigest !== hash)) throw new OperationError('conflict');
      if (input.followup && (input.expectedGuest || input.expectedRelay || input.relayTopic || memoryIntent && !used.length)) throw new OperationError('invalid');
      if (input.followup && !restricted) return this.followup(key, input, hash);
      const followUp = proactive?.review.followUp;
      const repair = proactive?.review.repair;
      if (proactive && (input.followup || input.fileReceiptIds.length || input.replyTo || input.round ||
          (followUp && repair) || input.memberIds.length !== (followUp || repair ? 1 : 2) || proactive.review.botRevisions.length !== input.memberIds.length))
        throw new OperationError('invalid');
      const old = this.state.table('turns').get(id);
      if (old) {
        if (old.guestQuestion && !ownerInput) throw new OperationError('approval-denied');
        if (old.requestDigest !== hash) throw new OperationError('conflict');
        return old;
      }
      if (memoryIntent === 'reference' && !input.replyTo && !input.fileReceiptIds.length) throw new OperationError('memory-text-required');
      if (memoryIntent) input = { ...input, memoryStatusOnly: true };
      this.state.checkNewWorkMembers(g);
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
      const memberRows = this.state.members(g);
      const addressable = !g.supergroup && !restricted && !input.round && !input.memoryStatusOnly;
      const checkMentions = ownerInput && !g.supergroup && /[@＠]/u.test(input.text);
      const candidates = checkMentions || addressable && (isAddressedQuestion(input.text) || isGroupDelegation(input.text))
        ? await this.state.registry.list() : [];
      const roster = memberRows.flatMap(member => {
        if (!member.enabled || member.removedAt !== undefined) return [];
        const bot = candidates.find(b => member.bot.botId === b.id && member.bot.botCreatedAt === b.createdAt);
        return bot ? [{ member, bot }] : [];
      });
      const mentions = checkMentions ? resolveGroupMentions(input.text, roster.map(({ member, bot }) => ({
        id: member.id, botId: bot.id, name: bot.name,
      })), input.memberIds) : undefined;
      if (mentions?.issues.some(issue => issue.reason === 'unknown')) throw new OperationError('mention-not-member');
      if (mentions?.issues.length) throw new OperationError('guest-ambiguous');
      if (mentions?.memberIds.length && input.memberIds.length && (mentions.memberIds.length !== input.memberIds.length ||
        input.memberIds.some(id => !mentions.memberIds.includes(id)))) throw new OperationError('conflict');
      const repliedBot = replied?.speaker && candidates.find(bot => sameBot(replied.speaker!.bot, { botId: bot.id, botCreatedAt: bot.createdAt }));
      const address = matchGroupAddress(input.text, candidates, replyMember ? repliedBot : undefined, roster.map(row => row.bot));
      if (address?.kind === 'nonmember-mention' && (addressable || checkMentions)) throw new OperationError('mention-not-member');
      const addressed = addressable && (!input.memberIds.length || address?.kind === 'match' && address.via) ? address : undefined;
      if (addressed?.kind === 'ambiguous') throw new OperationError('guest-ambiguous');
      if ((input.expectedGuest || input.expectedRelay) && !addressed) throw new OperationError('guest-changed');
      const memberIds = !input.memberIds.length && !input.round && mentions ? mentions.memberIds : input.memberIds;
      if (addressable && !memberIds.length && !addressed && hasExplicitBotAddress(input.text)) throw new OperationError('guest-unavailable');
      const target = addressed?.kind === 'match' ? { botId: addressed.bot.id, botCreatedAt: addressed.bot.createdAt } : undefined;
      const namedMember = target && memberRows.find(m => m.removedAt === undefined && sameBot(m.bot, target));
      const guest: GroupTurn['guestQuestion'] = target && !namedMember && addressed?.kind === 'match' ? { bot: target, name: addressed.bot.name } : undefined;
      if (guest && !ownerInput) throw new OperationError('approval-denied');
      if (guest && replied?.speaker && !sameBot(replied.speaker.bot, guest.bot) && !/^[@＠]/u.test(input.text) &&
        addressed?.kind === 'match' && !addressed.via) throw new OperationError('guest-unavailable');
      if (input.expectedGuest && (!guest || !sameBot(input.expectedGuest, guest.bot))) throw new OperationError('guest-changed');
      if (namedMember && !namedMember.enabled) throw new OperationError('guest-unavailable');
      if (guest && input.fileReceiptIds.length) throw new OperationError('invalid');
      if (guest && addressed?.kind === 'match' && addressed.via) {
        const via = addressed.via, bot = { botId: via.id, botCreatedAt: via.createdAt };
        const member = memberRows.find(m => m.removedAt === undefined && m.enabled && sameBot(m.bot, bot));
        if (!member || input.memberIds.some(id => id !== member.id)) throw new OperationError('guest-unavailable');
        if (!outlets(this.state.registry)) throw new OperationError('group-data-blocked');
        await this.state.validateMembers([bot]);
        const status = need((await this.state.registry.status()).find(s => s.id === via.id));
        guest.via = { bot, name: via.name, memberId: member.id, botRevision: via.updatedAt, presetId: status.presetId };
      }
      if (guest && addressed?.kind === 'match' && !input.relayTopic && relayNeedsTopic(addressed.question)) throw new OperationError('relay-topic-required');
      if (input.expectedRelay && (!guest?.via || !sameBot(input.expectedRelay, guest.via.bot))) throw new OperationError('guest-changed');
      if (input.relayTopic && !guest) throw new OperationError('invalid');
      const text = input.relayTopic ? input.text + '\n\n' + input.relayTopic : input.text;
      const descriptions = new Map<string, string>();
      if (g.onDemand && !g.supergroup && !restricted && !input.memberIds.length && !replyMember && !input.round) {
        // Read only public Bot metadata; a missing Bot falls through to existing admission checks.
        for (const member of memberRows) {
          const bot = await this.state.bot(member.bot).catch(() => undefined);
          if (bot) descriptions.set(member.id, `${bot.name} ${bot.description}`);
        }
      }
      const choice = guest ? undefined : selectOnDemand(restricted || input.memoryStatusOnly ? { ...g, onDemand: false } : g, memberRows, input.text,
        memberIds, input.memoryStatusOnly ? undefined : namedMember?.id ?? replyMember?.id, input.memoryStatusOnly && !memberIds.length ? true : input.round, this.state.registry.config.groupMaxTurns, descriptions);
      const selected = guest ? [{ id: guestDeliveryKey(guest.bot), bot: guest.bot }] : need(choice).selected;
      try { await this.state.validateMembers(selected.map((m) => m.bot)); }
      catch (error) {
        if (guest) throw new OperationError('guest-unavailable');
        throw error;
      }
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
        const staged = uploads?.resolve(root.agent, receiptId as Parameters<NonNullable<typeof uploads>['resolve']>[1]);
        const block = groupUploadedAttachment(staged);
        if (!block) throw new OperationError('invalid');
        return block;
      });
      // Keep native user attribution: fileUploads retires bound receipts by user rpcId.
      // Extra protocol metadata is public JSON source data for the workspace projection.
      const source = scoped && g.supergroup ? { kind: 'dsh-bot-supergroup' as const, group: key, turnId: id,
        workId: g.supergroup.workId, originSessionId: g.supergroup.originSessionId,
        originMessageId: g.supergroup.originMessageId, originSeq: scoped.seq,
      } : proactive ? {
        kind: 'dsh-bot-group-proactive' as const, group: key, turnId: id,
        ticketId: proactive.review.ticketId, assignmentId: proactive.review.assignmentId,
        ...(repair ? { repairPhase: repair.phase } : {}),
        ...(followUp ? { factId: followUp.factId, predecessorTurnId: followUp.predecessorTurnId } : {}),
      } : owner ? { kind: 'dsh-bot-group-owner-followup' as const, group: key, turnId: id,
        groupRootSessionId: g.rootSessionId,
        cardId: owner.binding.cardId, predecessorTurnId: owner.binding.predecessorTurnId,
      } : { kind: 'user' as const, group: key, turnId: id,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}), ...(files.length ? { rpcId: id } : {}) };
      const message = scoped && 'existing' in scoped && !scoped.projected ? scoped.message : createUserMessage({ source,
        content: scoped?.projected ? blocks(scoped.text) : scoped ? scoped.message.content : [...blocks(text),
          // IDs came from the native root-owned receipt and retain their native identity.
          ...files as Extract<ContentBlock, { type: 'file' | 'image' }>[]] });
      const at = Date.now();
      const turn: GroupTurn = {
        id,
        group: key,
        operationId: input.operationId,
        requestDigest: hash,
        inputMessageId: message.id,
        membershipRevision: g.membershipRevision,
        orderedMemberIds: [...selected.map(m => m.id), ...(guest?.via ? [guest.via.memberId] : [])],
        ...(!restricted && !g.supergroup && choice ? { routing: choice.routing } : {}),
        ...(guest ? { guestQuestion: guest } : {}),
        mode: restricted ? 'round-robin' : g.mode,
        ...(proactive ? { proactive: proactive.review } : {}),
        ...(owner ? { ownerFollowUp: owner.binding } : {}),
        ...(!restricted && (guest || g.mode !== 'round-robin') ? { protocol: 2 as const, automaticExecutions: 0, continuationAllowance: guest ? 0 : this.state.registry.config.groupMaxContinuations } : {}),
        ...(g.modelSelection ? { modelSelection: { ...g.modelSelection } } : {}),
        ...(g.memberModelSelections ? { memberModelSelections: g.memberModelSelections.map(row => ({
          memberId: row.memberId, modelSelection: { ...row.modelSelection },
        })) } : {}),
        ...(input.memoryStatusOnly ? { memoryStatusOnly: true as const } : {}),
        contextThroughSeq: guest || restricted || input.memoryStatusOnly ? -1 : (this.messages.messages(g).at(-1)?.seq ?? -1),
        predecessorTurnIds: repair?.predecessorTurnId ? [repair.predecessorTurnId] : followUp ? [followUp.predecessorTurnId] :
          owner ? [owner.binding.predecessorTurnId] : guest || restricted || input.memoryStatusOnly || g.mode !== 'round-robin' ? [] : this.state.turns(g).filter(t => !terminal(t)).map(t => t.id),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        state: 'accepted',
        revision: 1,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
      };
      // Reject an oversized required question before admitting any native or model side effect.
      const preflightParticipantNames = async () => Promise.all(
        memberRows.filter(m => m.enabled && m.removedAt === undefined).map(async (m) => {
          try {
            return groupParticipantLabel(await this.state.bot(m.bot), m.id);
          } catch {
            return m.bot.botId;
          }
        }),
      );
      const makePreflightQuestion = (): GroupMessage => ({
        id: message.id,
        seq: 0,
        at,
        text: textOf(message.content),
        turnId: id,
        authorKind: proactive || owner || (scoped && (!('existing' in scoped) || scoped.projected)) ? 'proactive' : 'user',
        ...(files.length ? { attachments: files, hasNonText: true } : {}),
        ...(turn.replyTo && !proactive && !owner && !g.supergroup ? { replyTo: turn.replyTo } : {}),
      });
      if (guest && addressed?.kind === 'match') {
        guestPrompt(input.relayTopic ? `${addressed.question}\n\n${input.relayTopic}` : addressed.question, this.state.registry.config.groupContextMaxBytes, guest.via?.name);
        const via = guest.via;
        if (via) {
          const participantNames = await preflightParticipantNames();
          const preflightQuestion = makePreflightQuestion();
          const viaRole = g.memberRoles?.find(row => sameBot(row.bot, via.bot))?.role;
          groupContext(
            g.name,
            via.name,
            participantNames,
            preflightQuestion,
            [],
            replied ? [replied] : [],
            this.state.registry.config.groupContextMaxBytes,
            viaRole,
            false,
            { from: guest.name, reply: 'x' },
          );
        }
      } else {
        const participantNames = await preflightParticipantNames();
        const preflightQuestion = makePreflightQuestion();
        for (const m of selected) {
          const bot = await this.state.bot(m.bot);
          const targetRole = g.memberRoles?.find(row => sameBot(row.bot, m.bot))?.role;
          groupContext(
            g.name,
            bot.name,
            participantNames,
            preflightQuestion,
            [],
            replied ? [replied] : [],
            this.state.registry.config.groupContextMaxBytes,
            targetRole,
            Boolean(turn.memoryStatusOnly),
          );
        }
      }
      if (owner) {
        await verifyOwnerFollowUpChoice(this.state, key, owner.binding);
        await owner.admit();
      }
      const flowId = await groupInput(this.state, g, root.agent, JSON.stringify(message), id);
      const flow = outlets(this.state.registry);
      if (flowId) {
        turn.inputFlowId = flowId;
        turn.inputFlowSessionId = need(flow).get(flowId).envelope?.binding.invocation.split('/')[0];
        await need(flow).persist(flowId, () => this.state.putTurn(turn));
      }
      else await this.state.putTurn(turn);
      let phase: 'deliveries' | 'dispatch' | 'flush' | 'finalize' | 'schedule' = 'deliveries';
      let inputSeq: number | undefined;
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
        phase = 'dispatch';
        using receiptBinding = uploads?.bindPrompt(root.agent, receiptIds as Parameters<NonNullable<typeof uploads>['bindPrompt']>[1], id);
        const append = async () => { await checkGroupDispatch(this.state, g);
          if (scoped && 'existing' in scoped) {
            const event = root.agent.session.snapshotEvents().find(row => row.type === 'user/message' && row.data.id === message.id);
            if (!event || Number(event.seq) !== scoped.seq) throw new OperationError('approval-denied');
            return event;
          }
          return root.agent.session.append('user/message', message, { surfaceOp: 'append' }); };
        const send = restricted ? async () => {
          if (owner) await verifyOwnerFollowUpChoice(this.state, key, owner.binding);
          await restricted.check();
          return append();
        } : append;
        const event = flowId ? await need(flow).dispatch(flowId, send) : restricted ? await send() : await append();
        inputSeq = Number(event.seq);
        receiptBinding?.commit();
        phase = 'flush';
        await this.roots.flush(root);
        phase = 'finalize';
        const accepted = await this.state.putTurn({ ...turn, inputSeq });
        if (restricted) this.state.proactiveChecks.set(id, restricted.check);
        phase = 'schedule';
        this.schedule(accepted);
        return accepted;
      } catch (error) {
        this.state.ctx.logger?.warn?.('[dsh-bot] Group turn acceptance failed; marking recovery_needed', {
          groupId: g.id, turnId: id, phase, ...redactedErrorMetadata(error),
        });
        try {
          const current = this.state.table('turns').get(id) ?? turn;
          await this.state.putTurn({
            ...current,
            ...(inputSeq !== undefined ? { inputSeq } : {}),
            state: 'recovery_needed',
          });
        } catch (markError) {
          this.state.ctx.logger?.warn?.('[dsh-bot] Failed to persist recovery_needed on group turn', {
            groupId: g.id, turnId: id, phase, ...redactedErrorMetadata(markError),
          });
        }
        throw new OperationError('recovery-needed');
      }
    });
  }
  /** Resume after an exact owner approval, which may arrive while the first worker is settling. */
  resumeRelay(turn: GroupTurn) {
    const run = () => {
      const current = this.state.table('turns').get(turn.id);
      if (!this.state.stopped && current && this.state.deliveries(turn.id).some(d => d.state === 'pending')) this.schedule(current);
    };
    const previous = this.state.chains.get(turn.id);
    if (previous) void previous.then(run, run).catch(() => {});
    else run();
  }
  private schedule(accepted: GroupTurn) {
    const id = accepted.id;
    const limit = accepted.protocol === 2 ? Number.MAX_SAFE_INTEGER : 1;
    const running = this.state.schedule(accepted.group.groupId, limit, async () => {
      try { await this.runner.execute(id); }
      catch (error) {
        this.state.ctx.logger?.warn?.('[dsh-bot] Group turn execution failed; marking recovery_needed', {
          groupId: accepted.group.groupId, turnId: id, phase: 'execute', ...redactedErrorMetadata(error),
        });
        await this.state.queue.run(async () => {
          try {
            const t = this.state.table('turns').get(id);
            if (t && !terminal(t)) await this.state.putTurn({ ...t, state: 'recovery_needed' });
          } catch (markError) {
            this.state.ctx.logger?.warn?.('[dsh-bot] Failed to persist recovery_needed after turn execution failure', {
              groupId: accepted.group.groupId, turnId: id, phase: 'execute', ...redactedErrorMetadata(markError),
            });
          }
        });
      }
    });
    this.state.chains.set(id, running);
    void running.finally(() => {
      if (this.state.chains.get(id) === running) this.state.chains.delete(id);
      this.state.proactiveChecks.delete(id);
    }).catch(() => {});
  }
  /** Queue-owned, durable acceptance prevents re-dispatch after an unknown native outcome. */
  private async followup(key: GroupKey, input: ReturnType<typeof groupSendSchema.parse>, hash: string) {
    const g = this.state.record(key), target = need(input.followup);
    const t = this.state.turns(g).find(row => row.id === target.turnId);
    if (!t) throw new OperationError('not-found');
    if (t.proactive || t.ownerFollowUp || t.guestQuestion) throw new OperationError('unsupported');
    const old = t.followups?.find(row => row.operationId === input.operationId);
    if (old) {
      if (old.requestDigest !== hash) throw new OperationError('conflict');
      if (old.state !== 'accepted') throw new OperationError('recovery-needed');
      return t;
    }
    if (t.memoryStatusOnly) throw new OperationError('invalid');
    this.state.checkNewWorkMembers(g);
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
    let phase: 'dispatch' | 'flush' | 'prompt' | 'finalize' = 'dispatch';
    try {
      const append = () => root.agent.session.append('user/message', message, { surfaceOp: 'append' });
      assertInputOpen();
      if (flowId) await need(flow).dispatch(flowId, append, admissionSignal); else append();
      phase = 'flush';
      await this.roots.flush(root);
      phase = 'prompt';
      const childMessageId = await followupInput(this.state, g, root.agent, d.bot, childId,
        input.text, `followup:${input.operationId}`, admissionSignal, () => {
          assertInputOpen();
          return this.state.ctx.subagents.prompt({
          requestId: input.operationId as SubagentPromptRequestId, parentSessionId: root.agent.session.id,
          childSessionId: SessionId(childId), mode: 'continuable', delivery: 'steer', content: blocks(input.text),
        }, admissionSignal);
        }, [message.id]);
      phase = 'finalize';
      const current = need(this.state.table('turns').get(t.id));
      return this.state.putTurn({ ...current, followups: current.followups?.map(row => row.operationId === input.operationId
        ? { ...row, state: 'accepted', childMessageId: childMessageId.messageId } : row) });
    } catch (error) {
      this.state.ctx.logger?.warn?.('[dsh-bot] Group follow-up dispatch failed; marking unknown', {
        groupId: g.id, turnId: t.id, deliveryId: d.id, phase, ...redactedErrorMetadata(error),
      });
      try {
        const current = need(this.state.table('turns').get(t.id));
        await this.state.putTurn({ ...current, followups: current.followups?.map(row => row.operationId === input.operationId
          ? { ...row, state: 'unknown' } : row) });
      } catch (markError) {
        this.state.ctx.logger?.warn?.('[dsh-bot] Failed to persist unknown state on group follow-up', {
          groupId: g.id, turnId: t.id, deliveryId: d.id, phase, ...redactedErrorMetadata(markError),
        });
      }
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
      if (g.supergroup || t.memoryStatusOnly) throw new OperationError('approval-denied');
      if (t.revision !== revision || t.membershipRevision !== g.membershipRevision) throw new OperationError('conflict');
      if (t.protocol !== 2 || t.state !== 'paused' || g.archived || this.state.chains.has(t.id)) throw new OperationError('unavailable');
      if (!this.state.registry.config.groupMaxContinuations) throw new OperationError('invalid');
      this.state.checkNewWorkMembers(g);
      await this.roots.restore(g);
      const next = await this.state.putTurn({ ...t, state: 'accepted', continuationAllowance: (t.automaticExecutions ?? 0) + this.state.registry.config.groupMaxContinuations });
      this.schedule(next);
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
      let g = this.state.record(key);
      if (g.revision !== revision) throw new OperationError('conflict');
      g = await this.roots.reconcilePendingRename(g);
      const next = { ...g, archived: true, revision: g.revision + 1, updatedAt: Date.now() };
      await this.state.putGroup(next);
      const activeTurns = this.state.turns(g).filter((t) => !terminal(t) || t.state === 'paused');
      for (const t of activeTurns) {
        this.state.cancelledTurns.add(t.id);
        this.state.wakeTurns.get(t.id)?.();
        for (const d of this.state.deliveries(t.id)) {
          this.state.controllers.get(d.id)?.abort('user-task-stop');
        }
      }
      for (const t of activeTurns) {
        for (const d of this.state.deliveries(t.id)) {
          if (d.state !== 'pending') continue;
          try {
            await this.state.putDelivery({ ...d, state: 'cancelled', reasonCode: 'user-task-stop', endedAt: Date.now() });
          } catch (error) {
            this.state.ctx.logger?.warn?.('[dsh-bot] Group archive could not persist cancelled delivery', {
              groupId: next.id, turnId: t.id, deliveryId: d.id, phase: 'archive-cancel-delivery', ...redactedErrorMetadata(error),
            });
          }
        }
        if (t.state === 'paused') {
          try {
            await this.state.putTurn({ ...t, state: 'cancelled' });
            this.state.cancelledTurns.delete(t.id);
          } catch (error) {
            this.state.ctx.logger?.warn?.('[dsh-bot] Group archive could not persist cancelled turn', {
              groupId: next.id, turnId: t.id, phase: 'archive-cancel-turn', ...redactedErrorMetadata(error),
            });
          }
        }
      }
      return next;
    });
    const settled = await Promise.allSettled(this.state.turns(next).map(t => this.state.chains.get(t.id)));
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        this.state.ctx.logger?.warn?.('[dsh-bot] Group archive observed rejected turn chain', {
          groupId: next.id, phase: 'archive-chains', ...redactedErrorMetadata(outcome.reason),
        });
      }
    }
    await this.state.queue.run(async () => {
      const h = this.state.roots.get(next.id);
      if (!h) return;
      try {
        await this.state.ctx.subagents.drainDescendants([h.agent]);
      } catch (error) {
        this.state.ctx.logger?.warn?.('[dsh-bot] Group archive descendant drain failed', {
          groupId: next.id, phase: 'archive-drain', ...redactedErrorMetadata(error),
        });
      }
      try {
        await this.roots.flush(h);
      } catch (error) {
        this.state.ctx.logger?.warn?.('[dsh-bot] Group archive root flush failed', {
          groupId: next.id, phase: 'archive-flush', ...redactedErrorMetadata(error),
        });
      }
      let released = h.ownership === 'borrowed';
      try {
        await this.roots.release(h);
        released = true;
      } catch (error) {
        this.state.ctx.logger?.warn?.('[dsh-bot] Group archive root release failed', {
          groupId: next.id, phase: 'archive-release', ...redactedErrorMetadata(error),
        });
      }
      if (released && this.state.roots.get(next.id) === h) this.state.roots.delete(next.id);
    });
    return next;
  }
}
