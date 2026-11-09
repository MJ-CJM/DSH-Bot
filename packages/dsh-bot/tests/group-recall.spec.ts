import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { describe, expect, it, vi } from 'vitest';
import { need, Serial } from '../src/host/common/operations.js';
import { GroupRecall, groupRecallReference } from '../src/host/groups/recall.js';
import type { GroupState } from '../src/host/groups/state.js';
import { GROUP_ROOT_PRESET, type GroupDelivery, type GroupKey, type GroupMember, type GroupRecord, type GroupTurn } from '../src/shared/groups.js';

const bot = { botId: 'recall-bot', botCreatedAt: 1 };
const other = { botId: 'other-bot', botCreatedAt: 2 };
const group: GroupKey = { groupId: 'group', groupCreatedAt: 3 };
const rootId = SessionId('group-root');
const preset = 'bot-recall-bot';
const config = { maxResults: 5, maxCandidates: 16, maxSourceChars: 160, maxOutputChars: 1000, timeoutMs: 1000,
  maxSessionBytes: 4 * 1024 * 1024, maxSessionEvents: 20_000, maxTrackedReads: 64 };

function session(id: string, meta: Partial<SessionHeader>) {
  return Session.create(SessionId(id), [], { id: SessionId(id), version: 4, createdAt: 3, isSeeded: false, ...meta });
}
function write(target: Session, text: string, source: Parameters<typeof createUserMessage>[0]['source']) {
  return target.append('user/message', createUserMessage({ source, content: [{ type: 'text', text }] }), { surfaceOp: 'append' });
}

function fixture() {
  const root = session(rootId, { agentPreset: GROUP_ROOT_PRESET });
  const sessions = new Map<string, Session>([[root.id, root]]);
  const groups = new Map<string, GroupRecord>([[group.groupId, { id: group.groupId, createdAt: group.groupCreatedAt,
    rootSessionId: root.id, rootPresetId: GROUP_ROOT_PRESET, archived: false, state: 'ready', name: 'Project group',
    schemaVersion: 1, operationId: 'group-create', createDigest: '', cwd: '/', mode: 'round-robin', membershipRevision: 1, revision: 1, updatedAt: 4 }]]);
  const members = new Map<string, GroupMember>([['member', { id: 'member', group, bot, enabled: true, joinedAt: 4, order: 0 }],
    ['other-member', { id: 'other-member', group, bot: other, enabled: true, joinedAt: 4, order: 1 }]]);
  const turns = new Map<string, GroupTurn>(), deliveries = new Map<string, GroupDelivery>();
  const tables = { groups, members, turns, deliveries };
  const flags = { enabled: true, updatedAt: 2, epoch: 0, blocked: false, label: true, native: true, cold: false, size: 0 };
  const readers = [bot];
  const label = { readers, originTrust: 'candidate', sourceVersions: [] as string[], restrictions: [] as string[], grants: [] };
  const forgotten = new Set<string>(), retired = new Set<string>();
  const oldVersion = { versionId: 'previous-version', memoryId: 'memory', shard: bot, labels: label, contentRef: 'previous-content', status: 'active' };
  const native = {
    readSurface: vi.fn(async (id: string) => {
      const target = sessions.get(id);
      if (!target) throw new Error('missing');
      return { session: target.header, events: target.surface.nodes.flatMap(seq => target.eventAt(seq) ?? []) };
    }),
    observeSession: vi.fn(async (id: string) => {
      const target = sessions.get(id);
      if (!target) throw new Error('missing');
      return { header: target.header, events: target.snapshotEvents(), [Symbol.dispose]: () => {} };
    }),
    searchEvents: vi.fn(),
  };
  const stat = vi.fn(async (id: string) => ({ sizeBytes: flags.size, header: sessions.get(id)?.header }));
  const close = vi.fn(async () => {});
  const open = vi.fn(async (id: string, _access: string) => {
    const target = sessions.get(id);
    if (!target) throw new Error('missing');
    return { id, header: target.header, inheritedEventCount: 0, read: async () => ({ events: target.snapshotEvents() }), close };
  });
  const state = {
    ctx: { get: (name: string) => name === 'sessionQuery' ? flags.native ? native : undefined : name === 'sessions' ?
      flags.native || flags.cold ? undefined : sessions : name === 'sessionPersistence' ? { stat, open } : undefined },
    registry: {
      config: { groupRecall: { ...config } },
      onboardingSnapshot: (id: string, createdAt: number) => id === bot.botId && createdAt === bot.botCreatedAt ?
        { memory: { enabled: flags.enabled }, updatedAt: flags.updatedAt } : undefined,
      memoryKernel: {
        get epoch() { return flags.epoch; }, get blocked() { return flags.blocked; },
        assertReadable() {}, assertOwnership() {}, snapshot: { forgotten, retired, versions: new Map() },
        domain: { table: (name: string) => ({
          get: (id: string) => (name === 'flow_sessions' && flags.label && id === rootId) || (name === 'payloads' && id === oldVersion.contentRef),
          entries: () => [['previous-op', { versions: [oldVersion] }]],
        }) },
      },
      memoryOutlets: { label: () => label },
    },
    startup: new AbortController(), queue: new Serial(), table: (name: keyof typeof tables) => tables[name],
    turns: (row: GroupRecord) => [...turns.values()].filter(t => t.group.groupId === row.id),
    deliveries: (id: string) => [...deliveries.values()].filter(d => d.turnId === id),
  };
  function add(id: string, at: number, options: {
    memberId?: string; rootText?: string; answer?: string; context?: string[]; recordedContext?: string[];
    child?: 'entered' | 'inbox-only' | 'wrong-parent' | 'wrong-preset' | 'none'; state?: GroupDelivery['state']; owner?: boolean;
  } = {}) {
    const memberId = options.memberId ?? 'member', owner = need(members.get(memberId));
    const ownerFollowUp = options.owner ? { cardId: 'card', cardRevision: 1, predecessorTurnId: 'previous', predecessorTurnRevision: 1,
      membershipRevision: 1, modelRevision: 0, memberId, bot: owner.bot, botRevision: 2, modelSelection: { provider: 'fixture', model: 'fixture' } } : undefined;
    const source = ownerFollowUp ? { kind: 'dsh-bot-group-owner-followup' as const, group, turnId: id,
      cardId: ownerFollowUp.cardId, predecessorTurnId: ownerFollowUp.predecessorTurnId } : { kind: 'user' as const, group, turnId: id };
    const question = write(root, options.rootText ?? `问题 ${id}`, source);
    const turn: GroupTurn = { id, group, operationId: id, requestDigest: '', inputMessageId: question.data.id, inputSeq: question.seq,
      createdAt: at - 1, updatedAt: at, revision: 1, schemaVersion: 1, membershipRevision: 1, orderedMemberIds: [memberId],
      mode: 'round-robin', contextThroughSeq: -1, state: 'completed', ...(ownerFollowUp ? { ownerFollowUp } : {}) };
    turns.set(id, turn);
    const child = session(`${id}-child`, { parentSession: options.child === 'wrong-parent' ? SessionId('foreign-root') : root.id,
      origin: 'subagent', agentPreset: options.child === 'wrong-preset' ? 'foreign-preset' : preset });
    const prompt = `Group: "Project group"\n${JSON.stringify({ questionSource: { id: question.data.id },
      history: (options.context ?? []).map(contextId => ({ id: contextId })) })}`;
    const message = createUserMessage({ source, content: [{ type: 'text', text: prompt }] });
    if (options.child !== 'none') sessions.set(child.id, child);
    if (options.child === 'inbox-only') child.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
    else if (options.child !== 'none') {
      child.append('turn/start', { turn: 1 });
      child.append('step/start', { turn: 1, step: 1 });
      child.append('user/message', message, { surfaceOp: 'append' });
      write(child, 'PRIVATE-CHILD-CANARY', { kind: 'user' });
      child.append('step/end', { turn: 1, step: 1 });
      child.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    }
    const answer = options.answer && write(root, options.answer, { kind: 'dsh-bot-group', group, turnId: id,
      memberId, speaker: { bot: owner.bot, name: memberId }, childSessionId: child.id, stopReason: 'completed' });
    const delivery: GroupDelivery = { id: `${id}:delivery`, turnId: id, memberId, ordinal: 0, bot: owner.bot, botRevision: 2,
      presetId: preset, state: options.state ?? 'completed', startedAt: at, childSessionId: child.id, revision: 2,
      contextOutputMessageIds: options.recordedContext ?? options.context ?? [], contextTruncated: false,
      ...(ownerFollowUp || options.child === 'inbox-only' ? { childMessageId: message.id } : {}),
      ...(answer ? { outputMessageId: answer.data.id, outputSeq: answer.seq } : {}) };
    deliveries.set(delivery.id, delivery);
    return { turn, delivery, question, answer: answer || undefined };
  }
  function shadow(event: Extract<SessionEvent, { type: 'user/message' }>) {
    root.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'erased replacement' }] }), {
      surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq],
    });
  }
  return { root, groups, members, deliveries, state, native, flags, label, forgotten, oldVersion, open, close, add, shadow,
    recall: new GroupRecall(state as unknown as GroupState) };
}

describe('read-only group recall', () => {
  it('returns only exact current root sources for work this Bot entered, including delivered context', async () => {
    const f = fixture();
    const otherWork = f.add('other-work', 10, { memberId: 'other-member', rootText: '同词 未参与提问', answer: '同词 已收到的上下文' });
    const unrelated = f.add('unrelated', 11, { memberId: 'other-member', answer: 'PRIVATE-ROOT-CANARY' });
    const exactContext = need(otherWork.answer).data.id;
    const mine = f.add('my-work', 12, { rootText: '同词 本人提问', answer: '本人结果', context: [exactContext],
      recordedContext: [exactContext, need(unrelated.answer).data.id] });
    f.add('queued', 13, { child: 'none', state: 'pending' });
    const page = await f.recall.query(bot, { query: '同词', group });
    expect(page.items.map(row => row.turnId)).toEqual(['my-work']);
    expect(page.items[0]?.sources.map(source => [source.role, source.text])).toEqual([
      ['question', '同词 本人提问'], ['answer', '本人结果'], ['context', '同词 已收到的上下文'],
    ]);
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE|未参与/);
    expect(f.native.observeSession.mock.calls.map(([id]) => id)).toEqual([mine.delivery.childSessionId]);
    expect(f.native.searchEvents).not.toHaveBeenCalled();
    expect((await f.recall.query(bot, { turnId: 'other-work' })).items).toEqual([]);
    expect((await f.recall.query(bot, { query: 'Project group' })).items.map(row => row.turnId)).toEqual(['my-work']);
    expect((await f.recall.query(bot, { turnId: 'my-work', group: { ...group, groupCreatedAt: 99 } })).items).toEqual([]);
    expect(await f.recall.validate(bot, page.items)).toBe(true);
  });

  it('rejects inbox-only, wrong-parent and wrong-preset children before opening the root', async () => {
    const f = fixture();
    f.add('unclaimed', 10, { child: 'inbox-only', state: 'running' });
    f.add('bad-parent', 11, { child: 'wrong-parent' });
    f.add('bad-preset', 12, { child: 'wrong-preset' });
    expect(await f.recall.query(bot, {})).toEqual({ items: [], incomplete: true, unavailable: true });
    expect(f.native.observeSession.mock.calls.map(([id]) => id)).toEqual(['unclaimed-child']);
    expect(f.native.readSurface).not.toHaveBeenCalled();
  });

  it('supports exact owner follow-up provenance and persists a text-free independently verifiable reference', async () => {
    const f = fixture();
    const row = f.add('owner', 10, { owner: true, rootText: `${'a'.repeat(300)} 复查通过`, answer: 'approved work' });
    const page = await f.recall.query(bot, { query: '复查' });
    const item = need(page.items[0]);
    expect(item.sources[0]).toMatchObject({ text: expect.stringContaining('复查通过'), offset: expect.any(Number) });
    expect(page.incomplete).toBe(true);
    const ref = groupRecallReference(item);
    expect(JSON.stringify(ref)).not.toMatch(/复查通过|approved work|"text"/);
    expect(await f.recall.validateReferences(bot, [ref])).toBe(true);
    const changed = structuredClone(ref);
    need(changed.sources[0]).sha256 = '0'.repeat(64);
    expect(await f.recall.validateReferences(bot, [changed])).toBe(false);
    f.shadow(row.question);
    expect(await f.recall.validateReferences(bot, [ref])).toBe(false);
    expect((await f.recall.query(bot, { query: '复查' })).items).toEqual([]);
  });

  it('does not let a removed and re-added member or a new Bot generation inherit old work', async () => {
    const f = fixture();
    f.add('old-work', 10);
    const page = await f.recall.query(bot, {});
    const member = need(f.members.get('member'));
    f.members.set(member.id, { ...member, enabled: false, removedAt: 20 });
    f.members.set('new-member', { ...member, id: 'new-member', joinedAt: 21 });
    f.add('new-work', 25, { memberId: 'new-member' });
    expect((await f.recall.query(bot, {})).items.map(row => row.turnId)).toEqual(['new-work']);
    expect(await f.recall.validate(bot, page.items)).toBe(false);
    expect((await f.recall.query({ ...bot, botCreatedAt: 99 }, {})).unavailable).toBe(true);
  });

  it('does not read unknown or revoked root labels, blocked cleanup, or disabled memory', async () => {
    const f = fixture();
    f.add('my-work', 10);
    f.flags.label = false;
    expect((await f.recall.query(bot, {})).unavailable).toBe(true);
    f.flags.label = true;
    f.label.restrictions.push('revoked');
    expect((await f.recall.query(bot, {})).unavailable).toBe(true);
    f.label.restrictions.length = 0;
    f.label.sourceVersions.push('missing-version');
    expect((await f.recall.query(bot, {})).unavailable).toBe(true);
    f.label.sourceVersions.length = 0;
    f.flags.blocked = true;
    expect((await f.recall.query(bot, {})).unavailable).toBe(true);
    f.flags.blocked = false;
    f.flags.enabled = false;
    expect((await f.recall.query(bot, {})).unavailable).toBe(true);
    expect(f.native.observeSession).not.toHaveBeenCalled();
    expect(f.native.readSurface).not.toHaveBeenCalled();
  });

  it('discards a page if the forget epoch or Bot revision changes mid-read', async () => {
    const f = fixture();
    f.add('my-work', 10);
    const read = need(f.native.readSurface.getMockImplementation());
    f.native.readSurface.mockImplementationOnce(async id => { const result = await read(id); f.flags.epoch++; return result; });
    expect(await f.recall.query(bot, {})).toEqual({ items: [], incomplete: true, unavailable: true });
    f.native.readSurface.mockImplementationOnce(async id => { const result = await read(id); f.flags.updatedAt++; return result; });
    expect(await f.recall.query(bot, {})).toEqual({ items: [], incomplete: true, unavailable: true });
  });

  it('halts new recall when memory is turned off and still verifies previously read history', async () => {
    const f = fixture();
    const row = f.add('my-work', 10);
    const page = await f.recall.query(bot, {});
    const ref = groupRecallReference(need(page.items[0]));
    f.flags.enabled = false;
    expect((await f.recall.query(bot, {})).unavailable).toBe(true);
    expect(await f.recall.validateReferences(bot, [ref])).toBe(false);
    expect(await f.recall.validateReferences(bot, [ref], undefined, { retainedRead: true })).toBe(true);
    f.shadow(row.question);
    expect(await f.recall.validateReferences(bot, [ref], undefined, { retainedRead: true })).toBe(false);
  });

  it('retains a historical version as provenance across a normal memory revision and revokes it after forgetting', async () => {
    const f = fixture();
    f.add('my-work', 10);
    f.label.sourceVersions.push(f.oldVersion.versionId);
    const page = await f.recall.query(bot, {});
    expect(page.items).toHaveLength(1);
    f.forgotten.add(f.oldVersion.memoryId);
    expect(await f.recall.validate(bot, page.items)).toBe(false);
    expect((await f.recall.query(bot, {})).unavailable).toBe(true);
  });

  it('bounds native reads, pages by committed participation and binds cursors to the original query', async () => {
    const f = fixture();
    f.state.registry.config.groupRecall.maxCandidates = 1;
    f.add('first', 10, { rootText: 'a test' });
    f.add('second', 11, { rootText: 'a test' });
    const first = await f.recall.query(bot, { query: 'test' });
    expect(first.items.map(row => row.turnId)).toEqual(['second']);
    expect(first.incomplete).toBe(true);
    expect(f.native.observeSession).toHaveBeenCalledTimes(1);
    const second = await f.recall.query(bot, { query: 'test', cursor: first.nextCursor });
    expect(second.items.map(row => row.turnId)).toEqual(['first']);
    expect(second.nextCursor).toBeUndefined();
    await expect(f.recall.query(bot, { query: 'changed', cursor: first.nextCursor })).rejects.toThrow(/invalid/);
    f.flags.size = f.state.registry.config.groupRecall.maxSessionBytes + 1;
    const reads = f.native.observeSession.mock.calls.length;
    expect((await f.recall.query(bot, {})).unavailable).toBe(true);
    expect(f.native.observeSession).toHaveBeenCalledTimes(reads);
  });

  it('can use exact live Sessions without the query service and stops waiting on caller cancellation', async () => {
    const f = fixture();
    f.add('my-work', 10);
    f.flags.native = false;
    expect((await f.recall.query(bot, {})).items.map(row => row.turnId)).toEqual(['my-work']);
    f.flags.native = true;
    const abort = new AbortController();
    f.native.observeSession.mockImplementationOnce(async () => {
      abort.abort(new Error('caller cancelled'));
      return new Promise(() => {});
    });
    await expect(f.recall.query(bot, {}, abort.signal)).rejects.toThrow('caller cancelled');
    expect(f.native.readSurface).not.toHaveBeenCalled();
  });

  it('reads and closes only the admitted cold handles when the query service is missing', async () => {
    const f = fixture();
    const row = f.add('my-work', 10);
    f.add('unrelated', 11, { memberId: 'other-member' });
    f.flags.native = false;
    f.flags.cold = true;
    expect((await f.recall.query(bot, {})).items.map(item => item.turnId)).toEqual(['my-work']);
    expect(f.open.mock.calls.map(([id, access]) => [id, access])).toEqual([
      [row.delivery.childSessionId, 'read'], [rootId, 'read'], [rootId, 'read'],
    ]);
    expect(f.close).toHaveBeenCalledTimes(3);
  });
});
