import { SessionSeq } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GroupDelivery, GroupRecord, GroupTurn } from '../../shared/groups.js';
import { GROUP_ROOT_PRESET } from '../../shared/groups.js';
import { matchGroupAddress } from '../../shared/addressed-bot.js';
import { sameBot, type BotKey } from '../../shared/identity.js';
import { digest, OperationError } from '../common/operations.js';
import { outlets } from '../data-flow/tool-guard.js';
import { assertGroupAudience } from './context-flow.js';
import { groupReaders } from './supergroup-admission.js';
import type { GroupState } from './state.js';

export const guestDeliveryKey = (bot: BotKey) => `guest:${digest(bot)}`;

export function guestPrompt(question: string, maxBytes: number, via?: string) {
  const text = (via ? 'A group member is asking you on behalf of the user. Answer the requesting member, who will respond to the group. Only the following owner-authorized question and topic were shared.\n' : 'A person in a group addressed this question to you. Answer the person directly, as yourself. Only the question below was shared with you. If a reference is unclear, ask the person to clarify.\n') +
    JSON.stringify({ question });
  if (Buffer.byteLength(text) > maxBytes) throw new OperationError('invalid');
  return text;
}

/** Re-derive the only authorized bytes from the exact owner input on the native group root. */
export function guestContext(state: GroupState, group: GroupRecord, root: Agent, turn: GroupTurn, delivery: GroupDelivery) {
  const guest = turn.guestQuestion, header = root.session.header;
  if (!guest || group.supergroup || turn.proactive || turn.ownerFollowUp || turn.memoryStatusOnly ||
    !sameBot(guest.bot, delivery.bot) || delivery.memberId !== guestDeliveryKey(guest.bot) ||
    turn.orderedMemberIds.length !== (guest.via ? 2 : 1) || (guest.via && turn.orderedMemberIds[1] !== guest.via.memberId) || turn.orderedMemberIds[0] !== delivery.memberId ||
    delivery.id !== `${turn.id}:0` || delivery.triggerMessageId || group.membershipRevision !== turn.membershipRevision ||
    header.parentSession || header.isSeeded || header.agentPreset !== GROUP_ROOT_PRESET || root.session.id !== group.rootSessionId)
    throw new OperationError('group-data-blocked');
  assertGroupAudience(state, group);
  const event = turn.inputSeq === undefined ? undefined : root.session.eventAt(SessionSeq(turn.inputSeq));
  if (event?.type !== 'user/message' || root.session.surface && !root.session.surface.nodes.includes(event.seq)) throw new OperationError('group-data-blocked');
  const message = event.data;
  const source = message.source as { kind: string; group?: GroupTurn['group']; turnId?: string };
  if (source.kind !== 'user' || source.turnId !== turn.id || source.group?.groupId !== group.id ||
    source.group.groupCreatedAt !== group.createdAt || message.id !== turn.inputMessageId ||
    message.content.length !== 1 || message.content[0]?.type !== 'text') throw new OperationError('group-data-blocked');
  const flow = outlets(state.registry);
  if (flow) {
    const id = turn.inputFlowId;
    const envelope = id && flow.kernel.domain.table('flows').get(id)?.envelope;
    if (!id || !envelope || envelope.outlet !== 'group-input' ||
      envelope.binding.invocation !== `${turn.inputFlowSessionId}/${turn.id}` ||
      envelope.content !== JSON.stringify(message)) throw new OperationError('group-data-blocked');
    flow.checker.checkGroupCopies([id], { kind: 'group', groupId: group.id,
      groupCreatedAt: group.createdAt, members: groupReaders(state, group) });
  }
  const match = matchGroupAddress(message.content[0].text, guest.via ? [guest, guest.via] : [guest], guest.via);
  if (match?.kind !== 'match' || match.bot !== guest || match.via !== guest.via) throw new OperationError('group-data-blocked');
  return { text: guestPrompt(match.question, state.registry.config.groupContextMaxBytes, guest.via?.name),
    messageIds: [] as string[], outputIds: [] as string[], truncated: false };
}
