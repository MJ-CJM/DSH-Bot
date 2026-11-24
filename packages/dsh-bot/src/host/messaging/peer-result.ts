import { isDeepStrictEqual } from 'node:util';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { sameBot, type BotKey } from '../../shared/identity.js';
import type { MessageRecord } from '../../shared/messaging.js';
import { canReadLabel } from '../data-flow/labels.js';
import { groupRelayWork } from './scoped-projection.js';
import { digest } from '../common/operations.js';
import type { ManagedOutlets } from '../data-flow/outlets.js';
import { ExportAuthorizationRequired } from '../data-flow/egress.js';
import type { Supergroup } from '../supergroup/service.js';

export type PeerResult =
  | { status: 'missing' }
  | { status: 'ambiguous'; candidates: Array<{ requestId: string; ts: number }> }
  | { status: 'pending' | 'unknown' | 'closed'; requestId: string }
  | { status: 'completed'; requestId: string; question: string; content: string; scoped: boolean };

/** Only the two exact delivered copies are evidence. Never search a peer's private history. */
export function peerResultFromRows(
  rows: MessageRecord[], owner: BotKey, peer: BotKey, ownSession: string, peerSession: string,
  events: readonly SessionEvent[], flow: ManagedOutlets | undefined, requestId?: string, scopedOnly = false,
  settlement?: Supergroup['peerReplyStatus'],
): PeerResult {
  const asks = rows.filter(({ envelope: e, execution }) => e.mode === 'ask' && !(execution && groupRelayWork(execution.workId)) && sameBot(e.from, owner) && sameBot(e.to, peer) &&
    e.fromSessionId === ownSession && e.toSessionId === peerSession && (!scopedOnly || execution?.phase === 'request') &&
    (!requestId || e.id === requestId));
  if (!asks.length) return { status: 'missing' };
  if (asks.length > 1) return { status: 'ambiguous', candidates: asks.sort((a, b) => b.envelope.ts - a.envelope.ts)
    .map(({ envelope }) => ({ requestId: envelope.id, ts: envelope.ts })) };
  const ask = asks[0]!;
  const id = ask.envelope.id;
  const replies = rows.filter(({ envelope: e }) => e.mode === 'reply' && e.replyTo === id && e.parentMessageId === id &&
    e.threadId === ask.envelope.threadId && e.correlationId === ask.envelope.correlationId &&
    sameBot(e.from, peer) && sameBot(e.to, owner) && e.fromSessionId === peerSession && e.toSessionId === ownSession);
  const reply = replies[0];
  // Scoped display IDs are host-issued. Missing legacy metadata cannot turn a diagnostic into a native answer.
  if (ask.execution || reply?.execution || id.startsWith('scoped:') || reply?.envelope.id.startsWith('scoped:')) {
    const run = ask.execution;
    if (!run || run.phase !== 'request' || (reply && (reply.execution?.phase !== 'reply' ||
      reply.execution.workId !== run.workId || reply.execution.operationId !== run.operationId)))
      return { status: 'unknown', requestId: id };
    const status = settlement?.(run.workId, run.operationId, ask.envelope.to, ask.envelope.origin, reply?.envelope.contentDigest) ?? 'unknown';
    if (status !== 'completed') {
      if (status === 'pending' && (ask.processing === 'unknown' || ask.delivery === 'unknown' || reply?.delivery === 'unknown'))
        return { status: 'unknown', requestId: id };
      return { status, requestId: id };
    }
  }
  if (!reply) {
    if (ask.processing === 'unknown' || ask.delivery === 'unknown') return { status: 'unknown', requestId: id };
    if (['canceled', 'expired', 'failed'].includes(ask.delivery) || ['timed-out', 'not-required'].includes(ask.response) || ask.processing === 'interrupted')
      return { status: 'closed', requestId: id };
    return { status: ask.response === 'replied' ? 'unknown' : 'pending', requestId: id };
  }
  if (ask.processing === 'interrupted') return { status: 'closed', requestId: id };
  if (ask.response !== 'replied' || ask.processing !== 'completed')
    return { status: ask.processing === 'unknown' ? 'unknown' : 'pending', requestId: id };
  if (replies.length !== 1 || !ask.envelope.content?.trim() || !reply.envelope.content?.trim() ||
    !confirmed(ask, events, false, flow) || !confirmed(reply, events, true, flow)) return { status: 'unknown', requestId: id };
  const scoped = ask.execution?.phase === 'request' && reply.execution?.phase === 'reply' &&
    ask.execution.workId === reply.execution.workId && ask.execution.operationId === reply.execution.operationId;
  if (scopedOnly && !scoped) return { status: 'missing' };
  return { status: 'completed', requestId: id, question: ask.envelope.content, content: reply.envelope.content, scoped };
}

function confirmed(row: MessageRecord, events: readonly SessionEvent[], incoming: boolean, flow?: ManagedOutlets): boolean {
  const e = row.envelope, body = e.content;
  if ((!flow && row.flowId) || !body || row.delivery !== 'delivered' || row.retainedAt !== undefined || digest(body) !== e.contentDigest ||
    !row.nativeInput || !row.outgoingInput || row.nativeRef?.sessionId !== e.toSessionId || row.outgoingRef?.sessionId !== e.fromSessionId ||
    row.nativeRef.messageId !== row.nativeInput.id || row.outgoingRef.messageId !== row.outgoingInput.id) return false;
  if (flow) {
    const saved = row.flowId && flow.kernel.domain.table('flows').get(row.flowId);
    flow.kernel.assertReadable();
    flow.kernel.assertOwnership();
    if (flow.kernel.blocked || !saved || saved.state !== 'delivered' || !saved.envelope || saved.envelope.outlet !== 'message' ||
      saved.envelope.binding.target.kind !== 'bot' || !sameBot(saved.envelope.binding.target.bot, e.to) ||
      !sameBot(saved.envelope.binding.bot, e.from) || saved.envelope.binding.epoch !== flow.kernel.epoch ||
      saved.envelope.binding.userScope !== flow.kernel.scope.scope.id || saved.envelope.binding.policyRevision !== flow.kernel.policyRevision ||
      (saved.grantUse && (!flow.kernel.snapshot.grantUses.has(saved.grantUse) ||
        flow.kernel.domain.table('ops').get(saved.id)?.grantUse !== saved.grantUse)) ||
      !samePayload(saved.envelope.content, row)) return false;
    // Reusing scoped material in a fresh execution must not erase its original source restrictions.
    if (row.execution) {
      const { label, binding } = saved.envelope;
      if (saved.grantUse || label.sourceVersions.length || binding.sourceVersions.length || label.groupCopies?.length ||
        label.restrictions.length || label.grants.length || !canReadLabel(label, e.from) || !canReadLabel(label, e.to)) return false;
      try {
        for (const bot of [e.from, e.to]) flow.checker.check({ ...saved.envelope, binding: { ...binding, target: { kind: 'bot', bot } } });
      } catch { return false; }
    } else {
      // Even an already approved, owner-visible historical copy must withhold revoked sources.
      // The consumed grant proves the earlier disclosure; it never permits a new dispatch.
      try { flow.checker.check(saved.envelope); }
      catch (error) { if (!(saved.grantUse && error instanceof ExportAuthorizationRequired)) return false; }
    }
  }
  const expected = incoming ? row.nativeInput : row.outgoingInput;
  const event = events.find(event => event.type === 'user/message' && event.data.id === expected.id);
  return event?.type === 'user/message' && digest(event.data) === digest(expected);
}

function samePayload(payload: string, row: MessageRecord): boolean {
  try { return isDeepStrictEqual(JSON.parse(payload), JSON.parse(JSON.stringify({ envelope: row.envelope, nativeInput: row.nativeInput, outgoingInput: row.outgoingInput }))); }
  catch { return false; }
}
