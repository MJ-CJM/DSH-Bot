import { groupKey, type GroupDelivery, type GroupRecord, type GroupTurn } from '../../shared/groups.js';
import { sameBot } from '../../shared/identity.js';
import { digest, OperationError } from '../common/operations.js';
import { outlets } from '../data-flow/tool-guard.js';
import { groupRelayMarker, scopedMessageId } from '../messaging/scoped-projection.js';
import type { GroupState } from './state.js';

export const relayWorkId = (turn: GroupTurn) => `group-relay:${digest([turn.group, turn.id])}`;

/** Materialize delivery facts only. The worker exchanging the actual text is isolated from both mains. */
export async function projectGroupRelay(state: GroupState, group: GroupRecord, turn: GroupTurn, kind: 'request' | 'reply', signal: AbortSignal) {
  const guest = turn.guestQuestion, via = guest?.via;
  if (!guest || !via) throw new OperationError('invalid');
  const messaging = state.ctx.get('dshBotMessaging');
  if (!messaging) throw new OperationError('unavailable');
  const check = async () => {
    signal.throwIfAborted();
    const current = state.record(groupKey(group));
    const stored = state.table('turns').get(turn.id);
    const received = state.table('deliveries').get(`${turn.id}:0`);
    const reply = kind === 'reply' ? state.table('deliveries').get(`${turn.id}:1`) : undefined;
    const members = state.members(current).filter(row => row.removedAt === undefined);
    if (current.archived || current.state !== 'ready' || current.supergroup || current.membershipRevision !== turn.membershipRevision ||
      !stored?.guestQuestion?.via || stored.group.groupId !== current.id || stored.group.groupCreatedAt !== current.createdAt ||
      !sameBot(stored.guestQuestion.bot, guest.bot) || !sameBot(stored.guestQuestion.via.bot, via.bot) ||
      !members.some(row => row.enabled && row.id === via.memberId && sameBot(row.bot, via.bot)) || members.some(row => sameBot(row.bot, guest.bot)) ||
      !received || !sameBot(received.bot, guest.bot) || received.acceptedAt === undefined || (kind === 'reply' && (received.answeredAt === undefined ||
        !reply || reply.acceptedAt === undefined || reply.memberId !== via.memberId || !sameBot(reply.bot, via.bot))))
      throw new OperationError('group-data-blocked');
    await Promise.all([state.bot(via.bot), state.bot(guest.bot)]);
  };
  await check();
  const workId = relayWorkId(turn), operationId = turn.operationId;
  if (kind === 'reply') {
    const request = messaging.store.get(scopedMessageId(workId, operationId, 'request'));
    if (!request?.nativeRef || !request.outgoingRef || request.delivery !== 'delivered')
      await projectGroupRelay(state, group, turn, 'request', signal);
  }
  const readers = [via.bot, guest.bot];
  const labelSessionId = `group-relay-${digest([turn.group, turn.id, kind])}`;
  await outlets(state.registry)?.inherit(labelSessionId, { readers, originTrust: 'candidate', restrictions: [], sourceVersions: [], grants: [] });
  await messaging.projectScoped({ workId, operationId, kind, origin: { bot: via.bot, sessionId: group.rootSessionId, userMessageId: turn.inputMessageId },
    from: kind === 'request' ? via.bot : guest.bot, to: kind === 'request' ? guest.bot : via.bot,
    ...(kind === 'reply' ? { requestId: scopedMessageId(workId, operationId, 'request') } : {}),
    readers, content: groupRelayMarker(kind), labelSessionId, signal, check });
}

/** No native chat content is read while projecting group status. */
export function relayMarkerIssue(state: GroupState, turn: GroupTurn, delivery: GroupDelivery) {
  if (!turn.guestQuestion?.via || delivery.acceptedAt === undefined) return;
  const messaging = state.ctx.get('dshBotMessaging');
  if (!messaging) return 'unavailable' as const;
  const kind = delivery.ordinal === 0 ? 'request' : 'reply';
  const row = messaging.store.get(scopedMessageId(relayWorkId(turn), turn.operationId, kind));
  if (row?.delivery === 'delivered' && row.nativeRef && row.outgoingRef) return;
  // The native receipt is committed before its two private-chat markers. Avoid a transient
  // warning while the corresponding worker is still running.
  if (row?.delivery === 'unknown' || ['completed', 'failed', 'unknown', 'cancelled'].includes(delivery.state)) return 'unconfirmed' as const;
}

/** Backfill only missing receipt records for recent, proven handoffs. Never re-run a Bot or replay an uncertain write. */
export async function recoverGroupRelay(state: GroupState, group: GroupRecord, turn: GroupTurn) {
  const messaging = state.ctx.get('dshBotMessaging');
  if (!messaging || !turn.guestQuestion?.via || group.archived || group.membershipRevision !== turn.membershipRevision) return;
  const guest = state.table('deliveries').get(`${turn.id}:0`);
  const member = state.table('deliveries').get(`${turn.id}:1`);
  if (guest?.acceptedAt === undefined || Date.now() - Math.max(guest.acceptedAt, member?.acceptedAt ?? 0) > messaging.store.config.messageRetentionMs) return;
  const workId = relayWorkId(turn);
  try {
    for (const kind of ['request', 'reply'] as const) {
      if (kind === 'reply' && (guest.answeredAt === undefined || member?.acceptedAt === undefined)) break;
      if (messaging.store.get(scopedMessageId(workId, turn.operationId, kind))) continue;
      await projectGroupRelay(state, group, turn, kind, state.startup.signal);
    }
  } catch {
    if (!state.startup.signal.aborted) state.ctx.logger.warn('[dsh-bot] Could not restore group handoff marker');
  }
}
