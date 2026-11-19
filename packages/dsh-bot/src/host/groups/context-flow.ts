import { isDeepStrictEqual } from 'node:util';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { GROUP_ROOT_PRESET, type GroupRecord } from '../../shared/groups.js';
import type { EgressTarget } from '../../shared/data-flow.js';
import type { DshBotRegistry } from '../registry.js';
import type { GroupState } from './state.js';
import { digest, OperationError } from '../common/operations.js';
import { outlets } from '../data-flow/tool-guard.js';
import { sameGroupReaders } from './model.js';
import { groupReaders } from './supergroup-admission.js';

export type GroupPublicationIndex = Map<string, { bodies: Map<string, string[]>; messages: Map<string, UserMessage[]> }>;
const publicationKey = (g: Pick<GroupRecord, 'id' | 'createdAt'>) => JSON.stringify([g.id, g.createdAt]);
/** Operation-local candidate index. It never caches an authorization decision. */
export function groupPublicationIndex(registry: DshBotRegistry): GroupPublicationIndex {
  const index: GroupPublicationIndex = new Map(), flow = outlets(registry);
  if (!flow?.kernel || !flow.checker) return index;
  for (const [id, row] of flow.kernel.domain.table('flows').entries()) {
    const e = row.envelope;
    if (!e || !['group-result', 'group-input'].includes(e.outlet) || e.binding.target.kind !== 'group') continue;
    const key = publicationKey({ id: e.binding.target.groupId, createdAt: e.binding.target.groupCreatedAt });
    const group = index.get(key) ?? { bodies: new Map<string, string[]>(), messages: new Map<string, UserMessage[]>() };
    const ids = group.bodies.get(e.content) ?? [];
    if (!ids.length) {
      try {
        const message = JSON.parse(e.content) as UserMessage;
        if (typeof message.id === 'string' && Array.isArray(message.content))
          group.messages.set(message.id, [...group.messages.get(message.id) ?? [], message]);
      } catch { /* Non-native envelopes cannot supply a group recall source. */ }
    }
    ids.push(id); group.bodies.set(e.content, ids); index.set(key, group);
  }
  return index;
}
export function indexedGroupMessages(index: GroupPublicationIndex, g: GroupRecord, ids: Iterable<string>) {
  const messages = index.get(publicationKey(g))?.messages;
  return [...ids].flatMap(id => messages?.get(id) ?? []);
}
/** Exact native bytes prove publication; every indexed hit is revalidated against the current ledger. */
export function publishedGroupCopy(registry: DshBotRegistry, g: GroupRecord, message: UserMessage, target: EgressTarget,
  index = groupPublicationIndex(registry)) {
  const flow = outlets(registry), content = JSON.stringify(message);
  let managed = false;
  if (!flow?.kernel || !flow.checker) return { managed };
  for (const id of index.get(publicationKey(g))?.bodies.get(content) ?? []) {
    const e = flow.kernel.domain.table('flows').get(id)?.envelope;
    // A redacted/changed entry remains managed, so a legacy root cannot resurrect it.
    managed = true;
    if (!e || !['group-result', 'group-input'].includes(e.outlet) || e.content !== content ||
      e.binding.target.kind !== 'group' || e.binding.target.groupId !== g.id || e.binding.target.groupCreatedAt !== g.createdAt) continue;
    try { flow.checker.checkGroupCopies([id], target); return { managed, id }; } catch { /* Another exact publication may be readable. */ }
  }
  return { managed };
}

export function assertGroupAudience(state: GroupState, g: GroupRecord) {
  const current = state.record({ groupId: g.id, groupCreatedAt: g.createdAt });
  if (current.archived || current.membershipRevision !== g.membershipRevision ||
    !isDeepStrictEqual(groupReaders(state, current), groupReaders(state, g))) throw new OperationError('group-data-blocked');
}

function rootMessages(g: GroupRecord, root: Agent) {
  const header = root.session.header;
  if (root.session.id !== g.rootSessionId || header.agentPreset !== GROUP_ROOT_PRESET || header.parentSession || header.isSeeded)
    throw new OperationError('group-data-blocked');
  const surface = root.session.surface?.nodes;
  const current = surface && new Set(surface);
  return root.session.snapshotEvents().filter(event => event.type === 'user/message' && (!current || current.has(event.seq)))
    .flatMap(event => event.type === 'user/message' ? [event.data] : []);
}

export function groupMessageDigests(g: GroupRecord, root: Agent) {
  return new Map(rootMessages(g, root).map(message => [message.id, digest(message)]));
}

/** Filtering happens before rendering; explicit questions/replies are checked separately, never silently substituted. */
export function readableGroupMessages(state: GroupState, g: GroupRecord, root: Agent, index = groupPublicationIndex(state.registry)): Set<string> {
  if (!outlets(state.registry) || g.supergroup) return new Set(root.session.snapshotEvents().flatMap(e => e.type === 'user/message' ? [e.data.id] : []));
  assertGroupAudience(state, g);
  const target = { kind: 'group' as const, groupId: g.id, groupCreatedAt: g.createdAt, members: groupReaders(state, g) };
  return new Set(rootMessages(g, root).filter(message => publishedGroupCopy(state.registry, g, message, target, index).id).map(message => message.id));
}

/** Only the final rendered message set seeds a projection. An empty set is a fresh owner input, not old root history. */
export async function groupContextSession(state: GroupState, g: GroupRecord, root: Agent, selectedIds?: readonly string[], messageDigests?: ReadonlyMap<string, string>) {
  const flow = outlets(state.registry);
  if (!flow || g.supergroup) return root.session.id;
  try {
    assertGroupAudience(state, g);
    const messages = rootMessages(g, root);
    const selected = selectedIds ?? messages.filter(message => {
      const source = message.source;
      return state.turns(g).some(t => t.inputMessageId === message.id) || 'group' in source &&
        isDeepStrictEqual(source.group, { groupId: g.id, groupCreatedAt: g.createdAt });
    }).map(message => message.id);
    const target = { kind: 'group' as const, groupId: g.id, groupCreatedAt: g.createdAt, members: groupReaders(state, g) };
    const index = groupPublicationIndex(state.registry);
    const byId = new Map<string, UserMessage[]>();
    for (const message of messages) byId.set(message.id, [...byId.get(message.id) ?? [], message]);
    const copies = [...new Set(selected)].map(id => {
      const matches = byId.get(id) ?? [];
      const copy = matches.length === 1 && (!messageDigests || messageDigests.get(id) === digest(matches[0])) && publishedGroupCopy(state.registry, g, matches[0]!, target, index).id;
      if (!copy) throw new Error('Unverified or unreadable selected group message');
      return copy;
    });
    flow.checker.checkGroupCopies(copies, target);
    const session = `group-context-${digest([g.id, g.createdAt, g.membershipRevision, copies])}`;
    await flow.inherit(session, { readers: target.members, originTrust: 'candidate', sourceVersions: [],
      restrictions: ['no-egress'], grants: [], ...(copies.length ? { groupCopies: copies } : {}) });
    assertGroupAudience(state, g);
    return session;
  } catch { throw new OperationError('group-data-blocked'); }
}

export function autoExportAllowed(state: GroupState, g: GroupRecord, bot: import('../../shared/identity.js').BotKey) {
  const current = state.record({ groupId: g.id, groupCreatedAt: g.createdAt });
  return current.exportApprovals?.some(p => p.membershipRevision === current.membershipRevision &&
    isDeepStrictEqual(p.bot, bot) && sameGroupReaders(p.members, groupReaders(state, current))) ?? false;
}
