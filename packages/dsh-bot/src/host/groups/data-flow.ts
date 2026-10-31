import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { BotKey } from '../../shared/identity.js';
import type { GroupRecord } from '../../shared/groups.js';
import type { GroupState } from './state.js';
import { outlets } from '../data-flow/tool-guard.js';

export function audience(state: GroupState, g: GroupRecord) {
  return { kind: 'group' as const, groupId: g.id, groupCreatedAt: g.createdAt,
    members: state.members(g).filter(m => m.enabled && m.removedAt === undefined).map(m => m.bot) };
}
export async function groupInput(state: GroupState, g: GroupRecord, root: Agent, content: string, call: string) {
  const flow = outlets(state.registry); if (!flow) return;
  if (!flow.kernel.domain.table('flow_sessions').get(root.session.id) && root.session.snapshotEvents().some(e =>
    e.type === 'user/message' && ['user', 'dsh-bot-group', 'dsh-bot-group-user', 'dsh-bot-group-followup'].includes(e.data.source.kind)))
    throw new Error('Legacy group history held: unknown lineage');
  const target = audience(state, g), bot = target.members[0];
  if (!bot) throw new Error('Group has no audience');
  await flow.inherit(root.session.id, { readers: target.members, originTrust: 'candidate',
    sourceVersions: [], restrictions: [], grants: [] });
  const envelope = flow.draft('group-input', bot, root.session.id, call, target, content);
  return flow.admit(envelope);
}
export async function groupChild(state: GroupState, g: GroupRecord, root: Agent, bot: BotKey, content: string,
  call: string, signal: AbortSignal) {
  const flow = outlets(state.registry); if (!flow) return;
  const envelope = flow.draft('group-input', bot, root.session.id, call, { kind: 'bot', bot }, content);
  // Validate the full current group audience too, rather than only the next member.
  flow.checker.check({ ...envelope, binding: { ...envelope.binding, target: audience(state, g) } });
  const id = await flow.admit(envelope, undefined, signal), childId = SessionId(randomUUID());
  await flow.inherit(childId, envelope.label);
  return { id, childId };
}
export async function groupResult<T>(state: GroupState, g: GroupRecord, bot: BotKey, childId: string,
  root: Agent, content: string, call: string, send: () => T, signal: AbortSignal): Promise<T> {
  const flow = outlets(state.registry); if (!flow) return send();
  const envelope = flow.draft('group-result', bot, childId, call, audience(state, g), content);
  const id = await flow.admit(envelope, undefined, signal);
  await flow.inherit(root.session.id, envelope.label);
  return flow.dispatch(id, send, signal);
}

export async function followupInput<T>(state: GroupState, g: GroupRecord, root: Agent, bot: BotKey,
  childId: string, content: string, call: string, signal: AbortSignal, send: () => Promise<T>): Promise<T> {
  const flow = outlets(state.registry); if (!flow) return send();
  const envelope = flow.draft('group-input', bot, root.session.id, call, { kind: 'bot', bot }, content);
  flow.checker.check({ ...envelope, binding: { ...envelope.binding, target: audience(state, g) } });
  const id = await flow.admit(envelope, undefined, signal);
  await flow.inherit(childId, envelope.label);
  return flow.dispatch(id, send, signal);
}
