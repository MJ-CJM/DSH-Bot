import { assertRelayMember, releaseRelayAnswer } from './relay-answer.js';
import { isDeepStrictEqual } from 'node:util';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { groupExportReviewStatus } from '../../shared/group-export-review.js';
import type { GroupKey, GroupTurn } from '../../shared/groups.js';
import type { BotKey } from '../../shared/identity.js';
import { digest, need, OperationError, redactedErrorMetadata } from '../common/operations.js';
import { outlets } from '../data-flow/tool-guard.js';
import { audience } from './data-flow.js';
import { checkSupergroup } from './supergroup-admission.js';
import type { GroupState } from './state.js';
import type { GroupRoots } from './roots.js';
import { readCompletedChild } from './recall-sessions.js';
import { ExportAuthorizationRequired } from '../data-flow/egress.js';
import { sameBot, sameGroupReaders } from './model.js';

/** Final replies are already outside the native turn. Owner review authorizes only
 * this stored copy; it does not alter native approval policy or memory readers. */
export class GroupExportReview {
  constructor(private state: GroupState, private roots: GroupRoots, private resumeRelay: (t: GroupTurn) => void) {}
  private async settle(turnId: string) {
    const t = need(this.state.table('turns').get(turnId));
    if (['accepted', 'running', 'cancelled', 'paused'].includes(t.state)) return;
    const rows = this.state.deliveries(turnId);
    const failed = rows.some(d => d.state === 'failed' &&
      !(d.reasonCode === 'export-rejected' && d.stopReason === 'completed'));
    await this.state.putTurn({ ...t, state: rows.some(d => d.state === 'unknown') ? 'recovery_needed' :
      failed ? 'partial' : t.protocol === 2 ? 'idle' : 'completed' });
  }
  private async pending(key: GroupKey, deliveryId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const g = this.state.record(key), d = need(this.state.table('deliveries').get(deliveryId));
    const t = need(this.state.table('turns').get(d.turnId));
    if (g.archived || g.state !== 'ready' || t.state === 'cancelled' ||
      this.state.cancelledTurns.has(t.id) || t.stoppedMemberIds?.includes(d.memberId) ||
      groupExportReviewStatus(g, t, d) !== 'pending' || this.state.closedExportReviews(key).has(d.id) ||
      d.reasonCode !== 'export-approval-required' || !d.exportFlowId)
      throw new OperationError('conflict');
    await checkSupergroup(this.state, g);
    const flow = need(outlets(this.state.registry));
    let review: ReturnType<typeof flow.review>;
    try { review = flow.review(d.exportFlowId, signal); }
    catch { throw new OperationError('group-data-blocked'); }
    const e = review.envelope;
    const target = e.binding.target, via = t.guestQuestion?.via;
    const expectedTarget = via && d.ordinal === 0 ? { kind: 'bot' as const, bot: via.bot } : audience(this.state, g);
    if (e.outlet !== 'group-result' || e.binding.invocation !== `${d.childSessionId}/${d.id}:result` ||
      !sameBot(e.binding.bot, d.bot) || (expectedTarget.kind === 'bot' ? target.kind !== 'bot' || !sameBot(target.bot, expectedTarget.bot) :
        target.kind !== 'group' || target.groupId !== g.id || target.groupCreatedAt !== g.createdAt ||
        !sameGroupReaders(target.members, expectedTarget.members)))
      throw new OperationError('conflict');
    const message = JSON.parse(e.content) as ReturnType<typeof createUserMessage>;
    if (message.source.kind !== 'dsh-bot-group' || message.source.turnId !== t.id || message.source.memberId !== d.memberId ||
      !sameBot(message.source.speaker.bot, d.bot) ||
      (t.guestQuestion ? (t.guestQuestion.via && d.ordinal === 1 ? !message.source.relayReply : !message.source.guestReply) || message.source.childSessionId !== undefined :
        message.source.childSessionId !== d.childSessionId) || !isDeepStrictEqual(message.source.group, key))
      throw new OperationError('conflict');
    const token = digest({ flowId: d.exportFlowId, digest: review.digest, revision: d.revision, membershipRevision: g.membershipRevision });
    return { g, d, t, flow, review, message, token, expectedTarget };
  }
  review(key: GroupKey, deliveryId: string, signal?: AbortSignal) {
    return this.state.queue.run(async () => {
      await this.reconcileLegacy(key, deliveryId, signal ?? this.state.startup.signal);
      const p = await this.pending(key, deliveryId, signal);
      const recipients = await Promise.all((p.expectedTarget.kind === 'bot' ? [p.expectedTarget.bot] : p.expectedTarget.members).map(async bot => ({ bot, name: (await this.state.bot(bot)).name })));
      // Names require async reads. Recheck revocation immediately before returning private text.
      if (p.flow.review(need(p.d.exportFlowId), signal).digest !== p.review.digest) throw new OperationError('conflict');
      // Render as plain text in an owner-only panel; no Markdown, remote images or model dispatch.
      return { token: p.token, deliveryRevision: p.d.revision, flowId: need(p.d.exportFlowId), groupName: p.g.name, recipients,
        content: p.message.content.map(block => block.type === 'text' ? block.text : JSON.stringify(block, null, 2)).join('\n\n') };
    });
  }
  private async reconcileLegacy(key: GroupKey, deliveryId: string, signal: AbortSignal) {
    const d = need(this.state.table('deliveries').get(deliveryId));
    if (d.exportFlowId || d.state !== 'unknown' || d.reasonCode !== 'native-failure') return;
    const g = this.state.record(key), t = need(this.state.table('turns').get(d.turnId));
    if (groupExportReviewStatus(g, t, d) !== 'pending' || this.state.closedExportReviews(key).has(d.id) ||
      !d.id.startsWith(`${t.id}:`) || !d.childSessionId || !d.childMessageId || !d.startedAt || !d.nativeRunId || d.joinedDeliveryId ||
      g.archived || g.state !== 'ready' || t.state === 'cancelled') throw new OperationError('conflict');
    await checkSupergroup(this.state, g);
    const flow = need(outlets(this.state.registry));
    const invocation = `${d.childSessionId}/${d.id}:result`;
    // Any prior admitted/attempted envelope makes automatic reconstruction unsafe.
    if ([...flow.kernel.domain.table('flows').entries()].some(([, row]) => row.envelope?.binding.invocation === invocation))
      throw new OperationError('recovery-needed');
    const root = need(this.state.roots.get(g.id));
    if (root.agent.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.source.kind === 'dsh-bot-group' &&
      e.data.source.turnId === t.id && e.data.source.childSessionId === d.childSessionId && e.data.source.stopReason === 'completed'))
      throw new OperationError('recovery-needed');
    const content = await readCompletedChild(this.state.ctx, { childSessionId: d.childSessionId, childMessageId: d.childMessageId,
      rootSessionId: g.rootSessionId, presetId: d.presetId, startedAt: d.startedAt }, this.state.registry.config.groupRecall, signal);
    if (!content.length) throw new OperationError('unavailable');
    const bot = await this.state.bot(d.bot);
    const message = createUserMessage({ source: { kind: 'dsh-bot-group', group: key, turnId: t.id, memberId: d.memberId,
      speaker: { bot: d.bot, name: bot.name }, childSessionId: d.childSessionId, stopReason: 'completed',
      replyTo: d.triggerMessageId ?? t.replyTo ?? t.inputMessageId, causeId: t.id }, content });
    const envelope = flow.draft('group-result', d.bot, d.childSessionId, `${d.id}:result`, audience(this.state, g), JSON.stringify(message));
    // Only the diagnosed pre-dispatch permission refusal is eligible, not arbitrary native failures.
    try { flow.checker.check(envelope); throw new OperationError('conflict'); }
    catch (error) { if (!(error instanceof ExportAuthorizationRequired)) throw error; }
    const exportFlowId = await flow.holdForReview(envelope, signal);
    await this.state.putDelivery({ ...d, state: 'failed', reasonCode: 'export-approval-required', exportFlowId, stopReason: 'completed' });
  }
  revoke(key: GroupKey, bot: BotKey) {
    return this.state.queue.run(async () => {
      const g = this.state.record(key);
      await this.state.putGroup({ ...g, revision: g.revision + 1, updatedAt: Date.now(), exportApprovals: (g.exportApprovals ?? []).filter(p => !isDeepStrictEqual(p.bot, bot)) });
      return true;
    });
  }
  discard(key: GroupKey, deliveryId: string, expectedRevision: number, signal?: AbortSignal) {
    return this.state.queue.run(async () => {
      signal?.throwIfAborted();
      this.state.record(key);
      const d = need(this.state.table('deliveries').get(deliveryId));
      const turn = need(this.state.table('turns').get(d.turnId));
      if (!isDeepStrictEqual(turn.group, key) || this.state.closedExportReviews(key).has(d.id) || d.revision !== expectedRevision ||
          d.reasonCode !== 'export-approval-required' || !d.exportFlowId || d.outputMessageId)
        throw new OperationError('conflict');
      const flow = need(outlets(this.state.registry));
      try { await flow.rejectReview(d.exportFlowId); }
      catch { throw new OperationError('recovery-needed'); }
      await this.state.putDelivery({ ...d, reasonCode: 'export-rejected', exportFlowId: undefined });
      await this.settleAfterDecision(turn.id);
      return true;
    });
  }
  closeStale(key: GroupKey, expectedMembershipRevision: number, signal?: AbortSignal) {
    return this.state.queue.run(async () => {
      signal?.throwIfAborted();
      const group = this.state.record(key);
      if (group.membershipRevision !== expectedMembershipRevision) throw new OperationError('conflict');
      const receipts = this.state.closedExportReviews(key);
      const before = receipts.size;
      const at = Date.now();
      for (const turn of this.state.turns(group)) {
        if (turn.membershipRevision === group.membershipRevision) continue;
        for (const delivery of this.state.deliveries(turn.id)) {
          if (!receipts.has(delivery.id) && groupExportReviewStatus(group, turn, delivery) === 'stale') receipts.set(delivery.id, at);
        }
      }
      const closed = receipts.size - before;
      // Commit a receipt only. No review, redaction or replay of the underlying reply.
      if (closed > 0) await this.state.storeClosedExportReviews(key, receipts);
      return { closed };
    });
  }
  private async settleAfterDecision(turnId: string) {
    try { await this.settle(turnId); }
    catch { this.state.ctx.logger.warn('[dsh-bot] Could not update group turn summary after export decision'); }
  }
  decide(key: GroupKey, deliveryId: string, token: string, allow: boolean | 'always', signal?: AbortSignal) {
    return this.state.queue.run(async () => {
      const p = await this.pending(key, deliveryId, signal);
      if (p.t.guestQuestion && allow === 'always') throw new OperationError('approval-denied');
      if (p.token !== token) throw new OperationError('conflict');
      if (!allow) {
        await p.flow.rejectReview(need(p.d.exportFlowId));
        await this.state.putDelivery({ ...p.d, reasonCode: 'export-rejected', exportFlowId: undefined });
        await this.settleAfterDecision(p.t.id);
        return true;
      }
      if (p.t.guestQuestion?.via && p.d.ordinal === 0) assertRelayMember(this.state, p.t);
      let attempted = false;
      let outputSeq: number | undefined;
      let relayFlowId: string | undefined;
      let relayReleased = false;
      try {
        const id = await p.flow.approveReview(need(p.d.exportFlowId), p.review.digest, signal);
        const root = need(this.state.roots.get(p.g.id));
        if (p.t.guestQuestion?.via && p.d.ordinal === 0) {
          relayFlowId = id;
          await p.flow.dispatch(id, () => { attempted = true; }, signal, async () => { await checkSupergroup(this.state, this.state.record(key)); });
          await releaseRelayAnswer(this.state, p.t, p.d, id, signal ?? this.state.startup.signal);
          relayReleased = true;
          try {
            await this.state.putTurn({ ...p.t, state: 'accepted' });
          } catch (error) {
            this.state.ctx.logger?.warn?.('[dsh-bot] Group handoff answer released; could not update turn summary', {
              groupId: p.g.id, turnId: p.t.id, deliveryId: p.d.id, phase: 'relay-turn-summary', ...redactedErrorMetadata(error),
            });
          }
          this.resumeRelay(p.t);
          return true;
        }
        if (p.g.supergroup) await p.flow.inherit(root.agent.session.id, p.review.envelope.label);
        await p.flow.dispatch(id, async () => {
          attempted = true;
          const event = root.agent.session.append('user/message', p.message, { surfaceOp: 'append' });
          await this.roots.flush(root);
          outputSeq = Number(event.seq);
        }, signal, async () => { await checkSupergroup(this.state, this.state.record(key)); });
      } catch (error) {
        if (relayReleased) {
          this.state.ctx.logger?.warn?.('[dsh-bot] Group handoff answer released; post-release step failed', {
            groupId: p.g.id, turnId: p.t.id, deliveryId: p.d.id, phase: 'relay-resume', ...redactedErrorMetadata(error),
          });
          return true;
        }
        if (relayFlowId && this.state.table('deliveries').get(p.d.id)?.relayAnswerFlowId === relayFlowId) {
          this.state.ctx.logger?.warn?.('[dsh-bot] Group handoff answer persisted; follow-up delivery creation failed', {
            groupId: p.g.id, turnId: p.t.id, deliveryId: p.d.id, phase: 'relay-release', ...redactedErrorMetadata(error),
          });
          try {
            const currentTurn = this.state.table('turns').get(p.t.id);
            if (currentTurn && currentTurn.state !== 'cancelled') await this.state.putTurn({ ...currentTurn, state: 'recovery_needed' });
          } catch (markError) {
            this.state.ctx.logger?.warn?.('[dsh-bot] Could not mark group turn recovery_needed after partial relay release', {
              groupId: p.g.id, turnId: p.t.id, deliveryId: p.d.id, phase: 'relay-release', ...redactedErrorMetadata(markError),
            });
          }
          throw new OperationError('recovery-needed');
        }
        if (outputSeq === undefined) {
          this.state.ctx.logger?.warn?.('[dsh-bot] Group export dispatch failed', {
            groupId: p.g.id, turnId: p.t.id, deliveryId: p.d.id, attempted, ...redactedErrorMetadata(error),
          });
          await this.state.putDelivery({ ...p.d, state: attempted ? 'unknown' : 'failed',
            reasonCode: attempted ? 'export-delivery-unknown' : 'export-blocked', exportFlowId: undefined });
          await this.settleAfterDecision(p.t.id);
          throw new OperationError(attempted ? 'recovery-needed' : 'group-data-blocked');
        }
        this.state.ctx.logger?.warn?.('[dsh-bot] Group reply flushed; outlet receipt could not be finalized', {
          groupId: p.g.id, turnId: p.t.id, deliveryId: p.d.id, phase: 'export-finalize', ...redactedErrorMetadata(error),
        });
      }
      try {
        await this.state.putDelivery({ ...p.d, state: p.d.stopReason === 'completed' ? 'completed' : 'failed',
          reasonCode: undefined, exportFlowId: undefined, outputMessageId: p.message.id, outputSeq });
      } catch {
        throw new OperationError('group-export-sent-receipt-failed');
      }
      try {
        if (allow === 'always') {
          const current = this.state.record(key);
          await this.state.putGroup({ ...current, revision: current.revision + 1, updatedAt: Date.now(), exportApprovals: [
            ...(current.exportApprovals ?? []).filter(row => !isDeepStrictEqual(row.bot, p.d.bot)),
            { bot: p.d.bot, members: audience(this.state, current).members, membershipRevision: current.membershipRevision, enabledAt: Date.now() },
          ] });
        }
      } catch {
        throw new OperationError('group-export-preference-failed');
      } finally {
        await this.settleAfterDecision(p.t.id);
      }
      return true;
    });
  }
}
