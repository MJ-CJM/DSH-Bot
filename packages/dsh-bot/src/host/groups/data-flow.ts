import { guestContext } from './guest-question.js';
import { digest } from '../common/operations.js';
import { groupContextSession, autoExportAllowed, assertGroupAudience } from './context-flow.js';
import { OperationError } from '../common/operations.js';
import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { BotKey } from '../../shared/identity.js';
import type { GroupRecord, GroupTurn, GroupDelivery } from '../../shared/groups.js';
import type { GroupState } from './state.js';
import { outlets } from '../data-flow/tool-guard.js';
import { checkSupergroup, groupReaders } from './supergroup-admission.js';
import { ExportAuthorizationRequired } from '../data-flow/egress.js';
import type { FlowEnvelope } from '../../shared/managed-flow.js';

export class GroupExportError extends Error {
  constructor(readonly reasonCode: 'export-approval-required' | 'export-blocked', readonly flowId?: string) {
    super(reasonCode === 'export-approval-required'
      ? 'Private-memory reply is saved for owner review in the group. No message was sent. Do not retry.'
      : 'Group reply was not sent: its data permissions do not allow this audience. Inspect the execution; do not retry.');
  }
}

export function audience(state: GroupState, g: GroupRecord) {
  return { kind: 'group' as const, groupId: g.id, groupCreatedAt: g.createdAt,
    members: groupReaders(state, g) };
}
export async function groupInput(state: GroupState, g: GroupRecord, root: Agent, content: string, call: string) {
  await checkSupergroup(state, g);
  const flow = outlets(state.registry); if (!flow) return;
  const target = audience(state, g), bot = target.members[0];
  if (!bot) throw new Error('Group has no audience');
  const context = await groupContextSession(state, g, root, []);
  // Supergroups retain their native owner-root lineage and existing admission policy.
  await flow.inherit(context, { readers: target.members, originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [] });
  const envelope = flow.draft('group-input', bot, context, call, target, content);
  try { return await flow.admit(envelope); }
  catch { throw new OperationError('group-data-blocked'); }
}
/** A guest receives a fresh projection of one explicitly addressed human question. No group copy or root history is relabelled. */
export async function guestQuestionInput(state: GroupState, group: GroupRecord, root: Agent, turn: GroupTurn,
  delivery: GroupDelivery, text: string, signal: AbortSignal) {
  const prompt = guestContext(state, group, root, turn, delivery);
  if (prompt.text !== text) throw new OperationError('group-data-blocked');
  const flow = outlets(state.registry);
  if (!flow) return;
  const context = `guest-question-${digest([turn.group, turn.id, turn.inputMessageId, turn.guestQuestion, text])}`;
  await flow.inherit(context, { readers: [...groupReaders(state, group), delivery.bot], originTrust: 'candidate',
    sourceVersions: [], restrictions: ['no-egress'], grants: [] });
  const envelope = flow.draft('group-input', delivery.bot, context, delivery.id, { kind: 'bot', bot: delivery.bot }, text);
  const id = await flow.admit(envelope, undefined, signal), childId = SessionId(randomUUID());
  await flow.inherit(childId, envelope.label);
  await state.queue.run(() => persistInput(state, delivery.id, id, context, childId));
  await checkGroupDispatch(state, group);
  return { id, childId };
}
export async function groupChild(state: GroupState, g: GroupRecord, root: Agent, bot: BotKey, content: string,
  call: string, signal: AbortSignal, messageIds?: readonly string[], messageDigests?: ReadonlyMap<string, string>) {
  const flow = outlets(state.registry); if (!flow) return;
  await checkSupergroup(state, g);
  const context = await groupContextSession(state, g, root, messageIds, messageDigests);
  const envelope = flow.draft('group-input', bot, context, call, { kind: 'bot', bot }, content);
  // Validate the full current group audience too, rather than only the next member.
  flow.checker.check({ ...envelope, binding: { ...envelope.binding, target: audience(state, g) } });
  const id = await flow.admit(envelope, undefined, signal), childId = SessionId(randomUUID());
  await flow.inherit(childId, envelope.label);
  await state.queue.run(() => persistInput(state, call, id, context, childId));
  assertGroupAudience(state, g);
  return { id, childId };
}
export async function groupResult<T>(state: GroupState, g: GroupRecord, bot: BotKey, childId: string,
  root: Agent, content: string, call: string, send: (flowId?: string) => T | Promise<T>, signal: AbortSignal, holdForReview = false, useSavedApproval = true, relayRecipient?: BotKey): Promise<T> {
  const flow = outlets(state.registry);
  if (!flow) {
    if (relayRecipient || !useSavedApproval) throw new GroupExportError('export-blocked');
    return send();
  }
  await checkSupergroup(state, g);
  let envelope: FlowEnvelope | undefined;
  let id: string;
  try {
    envelope = flow.draft('group-result', bot, childId, call, relayRecipient ? { kind: 'bot', bot: relayRecipient } : audience(state, g), content);
    const grant = useSavedApproval && autoExportAllowed(state, g, bot) ? flow.checker.grants.issue(envelope.binding, envelope.content) : undefined;
    id = await flow.admit(envelope, grant, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (holdForReview && envelope && error instanceof ExportAuthorizationRequired) {
      const flowId = await flow.holdForReview(envelope, signal);
      throw new GroupExportError('export-approval-required', flowId);
    }
    throw new GroupExportError('export-blocked');
  }
  try {
    if (g.supergroup) await flow.inherit(root.session.id, envelope.label);
    return await flow.dispatch(id, () => send(id), signal, () => checkGroupDispatch(state, g));
  } catch (error) {
    signal.throwIfAborted();
    if (['admitted', 'cancelled'].includes(flow.get(id).state)) throw new GroupExportError('export-blocked');
    throw error;
  }
}

export async function followupInput<T>(state: GroupState, g: GroupRecord, root: Agent, bot: BotKey,
  childId: string, content: string, call: string, signal: AbortSignal, send: () => Promise<T>, messageIds?: readonly string[], messageDigests?: ReadonlyMap<string, string>, alreadyQueued = true): Promise<T> {
  const flow = outlets(state.registry); if (!flow) return send();
  await checkSupergroup(state, g);
  const context = await groupContextSession(state, g, root, messageIds, messageDigests);
  const envelope = flow.draft('group-input', bot, context, call, { kind: 'bot', bot }, content);
  flow.checker.check({ ...envelope, binding: { ...envelope.binding, target: audience(state, g) } });
  const id = await flow.admit(envelope, undefined, signal);
  await flow.inherit(childId, envelope.label);
  if (alreadyQueued) await persistInput(state, call, id, context, childId);
  else await state.queue.run(() => persistInput(state, call, id, context, childId));
  return flow.dispatch(id, send, signal, () => checkGroupDispatch(state, g));
}

export async function checkGroupDispatch(state: GroupState, g: GroupRecord) {
  assertGroupAudience(state, g);
  await checkSupergroup(state, g);
  assertGroupAudience(state, g);
}
async function persistInput(state: GroupState, call: string, id: string, context: string, childId: string) {
  const delivery = state.table('deliveries').get(call);
  if (delivery) await state.putDelivery({ ...delivery, inputFlowId: id, inputFlowSessionId: context, childSessionId: childId });
}
