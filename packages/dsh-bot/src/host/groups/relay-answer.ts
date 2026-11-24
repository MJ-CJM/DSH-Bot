import { isDeepStrictEqual } from 'node:util';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { GroupRecord, GroupTurn, GroupDelivery } from '../../shared/groups.js';
import { sameBot } from '../../shared/identity.js';
import { need, OperationError } from '../common/operations.js';
import { outlets } from '../data-flow/tool-guard.js';
import type { GroupState } from './state.js';
import { textOf } from './model.js';
import { projectGroupRelay } from './relay-receipts.js';

/** The delegated authority is bound to the exact active member generation approved by the owner. */
export function assertRelayMember(state: GroupState, turn: GroupTurn) {
  const via = need(turn.guestQuestion?.via), current = state.record(turn.group);
  const member = state.members(current).find(m => m.id === via.memberId && m.enabled && m.removedAt === undefined);
  if (current.archived || current.membershipRevision !== turn.membershipRevision || !member || !sameBot(member.bot, via.bot) ||
    state.cancelledTurns.has(turn.id) || state.table('turns').get(turn.id)?.stoppedMemberIds?.includes(via.memberId) ||
    state.registry.onboardingSnapshot(via.bot.botId, via.bot.botCreatedAt)?.updatedAt !== via.botRevision) throw new OperationError('conflict');
  return via;
}
/** Accept exactly the outside Bot's completed answer. Its payload stays in the managed
 * outlet. Only A's independent, native result can become a group timeline message. */
export async function releaseRelayAnswer(state: GroupState, turn: GroupTurn, guest: GroupDelivery, id: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const via = assertRelayMember(state, turn);
  if (guest.id !== turn.id + ':0') throw new OperationError('conflict');
  const answeredAt = guest.answeredAt ?? Date.now();
  await state.putDelivery({ ...guest, state: 'completed', answeredAt, endedAt: answeredAt, stopReason: 'completed',
    reasonCode: undefined, exportFlowId: undefined, relayAnswerFlowId: id });
  const next = turn.id + ':1';
  if (!state.table('deliveries').get(next)) {
    await state.putDelivery({ id: next, turnId: turn.id, memberId: via.memberId, ordinal: 1, bot: via.bot,
      botRevision: via.botRevision, presetId: via.presetId, contextOutputMessageIds: [], contextTruncated: false, state: 'pending' });
  }
  state.wakeTurns.get(turn.id)?.();
}

/** Read the authorized answer for this one handoff; validate the exact native source and output binding on every use. */
export function readRelayAnswer(state: GroupState, g: GroupRecord, turn: GroupTurn, delivery: GroupDelivery) {
  const guest = need(turn.guestQuestion), via = need(guest.via), first = need(state.table('deliveries').get(turn.id + ':0'));
  const flow = need(outlets(state.registry)), id = need(first.relayAnswerFlowId);
  const e = flow.deliveredBotResult(id, guest.bot, via.bot);
  if (delivery.id !== turn.id + ':1' || delivery.memberId !== via.memberId || !sameBot(delivery.bot, via.bot) ||
    first.state !== 'completed' || first.answeredAt === undefined || !sameBot(first.bot, guest.bot) || first.outputMessageId ||
    g.archived || state.record(turn.group).membershipRevision !== turn.membershipRevision ||
    e.binding.invocation !== first.childSessionId + '/' + first.id + ':result') throw new OperationError('group-data-blocked');
  const msg = JSON.parse(e.content) as UserMessage, source = msg.source;
  if (source.kind !== 'dsh-bot-group' || !source.guestReply || !sameBot(source.speaker.bot, guest.bot) ||
    !isDeepStrictEqual(source.group, turn.group) || source.turnId !== turn.id || source.memberId !== first.memberId ||
    source.stopReason !== 'completed' || !msg.content.every(b => b.type === 'text')) throw new OperationError('group-data-blocked');
  return { id, from: guest.name, text: textOf(msg.content), label: e.label };
}

/** Conversation markers never control the outcome of a native handoff. */
export async function markRelay(state: GroupState, g: GroupRecord, turn: GroupTurn, kind: 'request' | 'reply', signal: AbortSignal) {
  try { await projectGroupRelay(state, g, turn, kind, signal); }
  catch { state.ctx.logger.warn('[dsh-bot] Could not project group handoff receipt'); }
}
