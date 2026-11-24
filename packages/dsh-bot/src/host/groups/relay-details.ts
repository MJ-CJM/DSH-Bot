import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { EgressTarget } from '../../shared/data-flow.js';
import { groupKey, type GroupDelivery, type GroupRecord, type GroupTurn } from '../../shared/groups.js';
import { relayDetailsRequestSchema, type RelayDetails, type RelayDetailsRequest, type RelayPart } from '../../shared/group-relay-details.js';
import { sameBot, type BotKey } from '../../shared/identity.js';
import { digest, need, OperationError, parse } from '../common/operations.js';
import { ExportAuthorizationRequired } from '../data-flow/egress.js';
import { outlets } from '../data-flow/tool-guard.js';
import { groupRelayMarker, scopedMessageId } from '../messaging/scoped-projection.js';
import { audience } from './data-flow.js';
import { textOf } from './model.js';
import { assertRelayMember, readRelayAnswer } from './relay-answer.js';
import { relayWorkId } from './relay-receipts.js';
import type { GroupState } from './state.js';

const unavailable = (): never => { throw new OperationError('group-data-blocked'); };

function receiptScope(state: GroupState, request: Extract<RelayDetailsRequest, { kind: 'receipt' }>) {
  const row = state.ctx.get('dshBotMessaging')?.store.get(request.messageId);
  if (!row?.execution || row.delivery !== 'delivered') return unavailable();
  const { envelope: e, execution: ex } = row;
  const incoming = request.sessionId === e.toSessionId, ref = incoming ? row.nativeRef : row.outgoingRef;
  const viewer = incoming ? e.to : e.from;
  if (e.id !== request.messageId || !ex.workId.startsWith('group-relay:') || e.content !== groupRelayMarker(ex.phase) ||
      scopedMessageId(ex.workId, ex.operationId, ex.phase) !== e.id ||
      ref?.messageId !== request.nativeId || ref.sessionId !== request.sessionId || (incoming ? e.toSessionId : e.fromSessionId) !== request.sessionId ||
      state.registry.mainSessions?.boundSessionId(viewer.botId, viewer.botCreatedAt) !== request.sessionId) return unavailable();
  const groups = Array.from(state.table('groups').entries(), ([, g]) => g).filter(g => g.rootSessionId === e.origin.sessionId);
  if (groups.length !== 1) return unavailable();
  const group = state.record(groupKey(groups[0]!));
  const matches = state.turns(group).filter(t => t.inputMessageId === e.origin.userMessageId && t.operationId === ex.operationId && relayWorkId(t) === ex.workId);
  if (matches.length !== 1) return unavailable();
  const turn = matches[0]!, guest = turn.guestQuestion, via = guest?.via;
  if (!guest || !via || !sameBot(e.origin.bot, via.bot) ||
      !sameBot(e.from, ex.phase === 'request' ? via.bot : guest.bot) ||
      !sameBot(e.to, ex.phase === 'request' ? guest.bot : via.bot)) return unavailable();
  return { group, turn, viewer, phase: ex.phase };
}

/** Only the single JSON field actually submitted to the guest is user-facing. Older/unknown prompt formats fail closed. */
export function deliveredQuestionText(prompt: string): string {
  const json: unknown = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  if (!json || typeof json !== 'object' || Object.keys(json).length !== 1 || !('question' in json) ||
      typeof json.question !== 'string' || !json.question.trim()) return unavailable();
  return json.question;
}

function questionPart(state: GroupState, turn: GroupTurn, first: GroupDelivery, target: EgressTarget): RelayPart {
  if (first.acceptedAt === undefined) return { state: 'pending' };
  const flow = need(outlets(state.registry)), row = flow.get(need(first.inputFlowId)), e = row.envelope;
  if (row.state !== 'delivered' || !e || e.outlet !== 'group-input' || !sameBot(e.binding.bot, first.bot) ||
      e.binding.target.kind !== 'bot' || !sameBot(e.binding.target.bot, first.bot) ||
      first.inputFlowSessionId !== 'guest-question-' + digest([turn.group, turn.id, turn.inputMessageId, turn.guestQuestion, e.content]) ||
      e.binding.invocation !== first.inputFlowSessionId + '/' + first.id) return unavailable();
  flow.checker.check({ ...e, binding: { ...e.binding, target } });
  return { state: 'readable', text: deliveredQuestionText(e.content) };
}

function answerPart(state: GroupState, group: GroupRecord, turn: GroupTurn, first: GroupDelivery,
  member: GroupDelivery | undefined, target: EgressTarget): RelayPart {
  if (first.answeredAt === undefined || member?.acceptedAt === undefined) return { state: 'pending' };
  const flow = need(outlets(state.registry)), answer = readRelayAnswer(state, group, turn, member);
  const e = need(flow.get(answer.id).envelope);
  // readRelayAnswer validates the exact delivered copy for A. A's consumed grant cannot authorize other readers.
  if (target.kind !== 'bot' || !sameBot(target.bot, member.bot))
    flow.checker.check({ ...e, binding: { ...e.binding, target } });
  return { state: 'readable', text: answer.text };
}

function reportPart(state: GroupState, turn: GroupTurn, member: GroupDelivery | undefined, target: EgressTarget): RelayPart {
  if (member?.state !== 'completed' || !member.outputMessageId || member.outputSeq === undefined) return { state: 'pending' };
  const flow = need(outlets(state.registry));
  for (const [id, row] of flow.kernel.domain.table('flows').entries()) {
    const e = row.envelope;
    if (!e || row.state !== 'delivered' || e.outlet !== 'group-result' || !sameBot(e.binding.bot, member.bot) ||
        e.binding.invocation !== member.childSessionId + '/' + member.id + ':result' ||
        e.binding.target.kind !== 'group' || e.binding.target.groupId !== turn.group.groupId ||
        e.binding.target.groupCreatedAt !== turn.group.groupCreatedAt) continue;
    const message = JSON.parse(e.content) as UserMessage, source = message.source;
    if (message.id !== member.outputMessageId || source.kind !== 'dsh-bot-group' || !source.relayReply || source.guestReply ||
        source.group.groupId !== turn.group.groupId || source.group.groupCreatedAt !== turn.group.groupCreatedAt ||
        source.turnId !== turn.id || source.memberId !== member.memberId || !sameBot(source.speaker.bot, member.bot) ||
        !message.content.every(block => block.type === 'text')) continue;
    flow.checker.checkGroupCopies([id], target);
    return { state: 'readable', text: textOf(message.content) };
  }
  return { state: 'unavailable' };
}

function projectPart(read: () => RelayPart): RelayPart {
  try { return read(); }
  catch (error) { return { state: error instanceof ExportAuthorizationRequired ? 'restricted' : 'unavailable' }; }
}

/** Owner UI disclosure. Never attached to group views, main-session events or model context. */
export async function readRelayDetails(state: GroupState, raw: RelayDetailsRequest, signal?: AbortSignal): Promise<RelayDetails> {
  const request = parse(relayDetailsRequestSchema, raw);
  const scope = () => request.kind === 'receipt' ? receiptScope(state, request) : {
    group: state.record(request.group), turn: need(state.table('turns').get(request.turnId)), viewer: undefined as BotKey | undefined, phase: undefined,
  };
  const initial = scope().turn.guestQuestion;
  if (!initial?.via) return unavailable();
  await Promise.all([state.bot(initial.bot), state.bot(initial.via.bot)]);
  signal?.throwIfAborted(); state.check();
  const { group, turn, viewer, phase } = scope();
  const guest = need(turn.guestQuestion), via = assertRelayMember(state, turn);
  if (group.id !== turn.group.groupId || group.createdAt !== turn.group.groupCreatedAt || group.state !== 'ready' || group.supergroup ||
      state.members(group).some(m => m.removedAt === undefined && sameBot(m.bot, guest.bot))) return unavailable();
  const flow = need(outlets(state.registry)), groupTarget = audience(state, group);
  flow.kernel.assertReadable(); flow.kernel.assertOwnership();
  if (flow.kernel.blocked || !groupTarget.members.length) return unavailable();
  flow.checker.checkGroupCopies([need(turn.inputFlowId)], groupTarget);
  const first = need(state.table('deliveries').get(turn.id + ':0')), member = state.table('deliveries').get(turn.id + ':1');
  if (first.turnId !== turn.id || !sameBot(first.bot, guest.bot) ||
      (member && (member.turnId !== turn.id || member.memberId !== via.memberId || !sameBot(member.bot, via.bot)))) return unavailable();
  const target = viewer ? { kind: 'bot' as const, bot: viewer } : groupTarget;
  return { sender: via.name, guest: guest.name,
    ...(phase !== 'reply' && { question: projectPart(() => questionPart(state, turn, first, target)) }),
    ...(phase !== 'request' && { answer: projectPart(() => answerPart(state, group, turn, first, member, target)) }),
    ...(!phase && { report: projectPart(() => reportPart(state, turn, member, target)) }) };
}
