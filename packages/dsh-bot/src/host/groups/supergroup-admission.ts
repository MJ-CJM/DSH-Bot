import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { BotKey } from '../../shared/identity.js';
import type { GroupKey, GroupRecord } from '../../shared/groups.js';
import { digest, OperationError } from '../common/operations.js';
import { isCommittedLiveMain } from '../registry/snapshot.js';
import { sameBot, textOf } from './model.js';
import type { GroupState } from './state.js';
import type { WorkerBinding } from './worker-tool.js';

/** Host capability, never accepted from Remote/tool JSON or reconstructed on restart. */
export interface SupergroupAuthority {
  workId: string;
  origin: Agent;
  messageId: string;
  /** Host-only projection of separately admitted task materials; never a Remote/model argument. */
  projectInput?(text: string): Promise<string>;
  /** Exact persisted owner input; origin remains the initiating Bot main Agent. */
  groupInput?: { root: Agent; group: GroupKey; messageId: string; seq: number; digest: string; originMainMessageId: string };
  owner: BotKey;
  readers: readonly BotKey[];
  expiresAt: number;
  maxRequests?: number;
  /** Shared work budget. Called outside the Groups queue to avoid lock inversion. */
  reserveRequest?(): Promise<void>;
  /** Synchronous snapshot of that same work counter for enqueue admission. */
  requestsUsed?(): number;
  /** Must not reenter the Groups queue or data-flow kernel queue. */
  check(): Promise<void>;
}
export interface SupergroupExpertRequest {
  group: GroupKey;
  workId: string;
  agent: Agent;
  binding: WorkerBinding;
  callId: string;
  botId: string;
  question: string;
}
export type SupergroupExpertHandler = (request: SupergroupExpertRequest) => Promise<unknown>;

export function supergroupMetadata(authority: SupergroupAuthority) {
  return { workId: authority.workId, originSessionId: authority.origin.session.id,
    originMessageId: authority.groupInput?.originMainMessageId ?? authority.messageId, owner: authority.owner,
    readers: authority.readers.map(key => ({ ...key })), expiresAt: authority.expiresAt };
}
export async function validateSupergroupAuthority(state: GroupState, authority: SupergroupAuthority, group?: GroupRecord) {
  state.check();
  const header = authority.origin.session.header;
  if (!authority.workId || !Number.isFinite(authority.expiresAt) || Date.now() >= authority.expiresAt ||
      header.parentSession || header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0 ||
      state.ctx.agents.get(SessionId(authority.origin.session.id)) !== authority.origin ||
      !authority.readers.length || new Set(authority.readers.map(key => key.botId)).size !== authority.readers.length ||
      !authority.readers.some(key => sameBot(key, authority.owner))) throw new OperationError('approval-denied');
  if (group && JSON.stringify(group.supergroup) !== JSON.stringify(supergroupMetadata(authority)))
    throw new OperationError('approval-denied');
  await authority.check();
  const checkBot = (key: BotKey) =>
    typeof state.botSnapshot === 'function' ? state.botSnapshot(key) : state.bot(key);
  await checkBot(authority.owner);
  if (!(await isCommittedLiveMain(state.registry, authority.owner, authority.origin)))
    throw new OperationError('approval-denied');
  for (const reader of authority.readers) await checkBot(reader);
  if (authority.groupInput) {
    const input = authority.groupInput;
    const originatingEvent = authority.origin.session.snapshotEvents().find(event => event.type === 'user/message' &&
      event.data.id === input.originMainMessageId && event.data.source.kind === 'user');
    if (!originatingEvent) throw new OperationError('approval-denied');
    const key = { groupId: group?.id, groupCreatedAt: group?.createdAt };
    if (!group || key.groupId !== input.group.groupId || key.groupCreatedAt !== input.group.groupCreatedAt ||
      group.rootSessionId !== input.root.id || state.ctx.agents.get(SessionId(input.root.id)) !== input.root)
      throw new OperationError('approval-denied');
    const event = input.root.session.snapshotEvents().find(row => row.type === 'user/message' && row.data.id === input.messageId);
    if (event?.type !== 'user/message' || Number(event.seq) !== input.seq || event.data.source.kind !== 'user' ||
      JSON.stringify((event.data.source as { group?: GroupKey }).group) !== JSON.stringify(input.group) ||
      event.data.content.some(block => block.type !== 'text') || digest(event.data.content) !== input.digest || !textOf(event.data.content).trim())
      throw new OperationError('approval-denied');
    const original = textOf(event.data.content), text = authority.projectInput ? await authority.projectInput(original) : original;
    return { message: event.data, seq: input.seq, text, existing: true as const, projected: text !== original };
  }
  const event = authority.origin.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user');
  if (event?.type !== 'user/message' || event.data.id !== authority.messageId ||
      event.data.content.some(block => block.type !== 'text') || !textOf(event.data.content).trim() ||
      Date.now() >= authority.expiresAt) throw new OperationError('approval-denied');
  const original = textOf(event.data.content), text = authority.projectInput ? await authority.projectInput(original) : original;
  return { message: event.data, seq: Number(event.seq), text, projected: text !== original };
}
export async function checkSupergroup(state: GroupState, group: GroupRecord) {
  if (!group.supergroup) return;
  const current = state.record({ groupId: group.id, groupCreatedAt: group.createdAt });
  if (current.archived || current.state !== 'ready' || JSON.stringify(current.supergroup) !== JSON.stringify(group.supergroup))
    throw new OperationError('approval-denied');
  const authority = state.supergroupAuthorities.get(group.id);
  if (!authority) throw new OperationError('approval-denied');
  return validateSupergroupAuthority(state, authority, current);
}
export function groupReaders(state: GroupState, group: GroupRecord): BotKey[] {
  return group.supergroup?.readers.map(key => ({ ...key })) ??
    state.members(group).filter(member => member.enabled && member.removedAt === undefined).map(member => member.bot);
}
/** Reserve actual native requests, including extra tool/followup steps. */
export async function reserveSupergroupRequest(state: GroupState, group: GroupRecord) {
  if (!group.supergroup) return;
  const authority = state.supergroupAuthorities.get(group.id);
  if (authority?.reserveRequest) {
    await checkSupergroup(state, group);
    if (state.supergroupAuthorities.get(group.id) !== authority) throw new OperationError('approval-denied');
    await authority.reserveRequest();
    return;
  }
  return state.queue.run(async () => {
    const current = state.record({ groupId: group.id, groupCreatedAt: group.createdAt });
    await checkSupergroup(state, current);
    const limit = state.supergroupAuthorities.get(group.id)?.maxRequests;
    const table = state.table('supergroup_requests'), used = table.get(group.id)?.count ?? 0;
    if (!Number.isSafeInteger(limit) || !limit || limit < 1 || used >= limit) throw new OperationError('approval-denied');
    await table.put(group.id, { group: { groupId: group.id, groupCreatedAt: group.createdAt }, count: used + 1 });
  });
}
export function checkSupergroupEnqueue(state: GroupState, group: GroupRecord) {
  if (!group.supergroup) return;
  const authority = state.supergroupAuthorities.get(group.id), limit = authority?.maxRequests;
  const used = authority?.reserveRequest ? authority.requestsUsed?.() : state.table('supergroup_requests').get(group.id)?.count ?? 0;
  if (!Number.isSafeInteger(limit) || !limit || typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0 || used >= limit)
    throw new OperationError('approval-denied');
}
