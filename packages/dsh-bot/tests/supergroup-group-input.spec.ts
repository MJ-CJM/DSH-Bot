import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import type { Groups } from '../src/host/groups/service.js';
import type { DshBotRegistry } from '../src/host/registry.js';
import { supergroupMetadata, type SupergroupAuthority } from '../src/host/groups/supergroup-admission.js';
import { bindings } from '../src/host/data-flow/agent-binding.js';
import { Supergroup, type supergroupDomain } from '../src/host/supergroup/service.js';
import { Config } from '../src/host/supergroup/config.js';
import { isAdmittedSupergroupInput } from '../src/host/supergroup/input-capability.js';
import { supergroupSendGroupInputSchema, type SupergroupWork } from '../src/shared/supergroup.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(recovered?: SupergroupWork) {
  const owner = { botId: 'owner', botCreatedAt: 1 }, peer = { botId: 'peer', botCreatedAt: 1 };
  const config = { supergroup: Config({ enabled: true }) }, bots = [owner, peer].map(key => ({ id: key.botId, createdAt: 1, updatedAt: 1 }));
  const key = { groupId: 'group', groupCreatedAt: 2 };
  const work: SupergroupWork = recovered ?? { id: 'work', revision: 1, owner, originSessionId: 'main', inputMessageId: 'original', inputMessageIds: ['original'],
    configDigest: hash(config.supergroup), readers: [owner, peer], createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 300000,
    group: key, turnIds: [], experts: [], groupInputs: [], state: 'completed' };
  const table = new Map([[work.id, structuredClone(work)]]);
  type Event = { type: string; seq: number; data: unknown };
  const rootEvents: Event[] = [], mainEvents: Event[] = [{ type: 'user/message', seq: 1, data: { id: 'original', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original main request' }] } }];
  const followups: UserMessage[] = [], sent: { text: string; memberIds: string[]; replyTo?: string }[] = [];
  let hold = false, release: (() => void) | undefined, blocked = Promise.resolve(), active = 0, maxActive = 0, flush = true, flowHeld = false;
  const agent = { id: 'main', session: { id: 'main', header: {}, snapshotEvents: () => mainEvents }, followup: (message: UserMessage) => { followups.push(message); } } as unknown as Agent;
  const root = { id: 'root', session: { id: 'root', header: {}, snapshotEvents: () => rootEvents,
    append: (_type: string, message: unknown) => { const event = { type: 'user/message', seq: rootEvents.length + 1, data: structuredClone(message) }; rootEvents.push(event); return event; } } } as unknown as Agent;
  bindings.set(agent, owner);
  const group = { id: key.groupId, createdAt: key.groupCreatedAt, revision: 1, membershipRevision: 1, rootSessionId: root.id,
    archived: false, state: 'ready', supergroup: { workId: work.id } };
  const members = [owner, peer].map((bot, index) => ({ id: `member-${index}`, bot, enabled: true }));
  const turns: { id: string; state: string; revision: number }[] = [], deliveries: { turnId: string; state: string }[] = [];
  const results: { id: string; text: string; turnId: string; authorKind: string }[] = [];
  const groups = { setExpertHandler: () => () => {}, view: async () => ({ group, members, turns: structuredClone(turns), deliveries: structuredClone(deliveries),
    messages: [...rootEvents.map(event => ({ id: (event.data as UserMessage).id, text: '', authorKind: 'user' })), ...results] }),
    refreshSupergroupAuthority: async (_key: unknown, authority: SupergroupAuthority) => {
      await authority.check();
      expect(supergroupMetadata(authority)).toMatchObject({ originSessionId: 'main', originMessageId: 'original' });
      expect(authority.groupInput?.messageId).not.toBe('original');
    },
    sendSupergroup: async (_key: unknown, input: typeof sent[number], authority: SupergroupAuthority) => {
      await authority.check(); sent.push(input); active++; maxActive = Math.max(maxActive, active);
      const turn = { id: `turn-${sent.length}`, state: 'running', revision: 1 }; turns.push(turn); deliveries.push({ turnId: turn.id, state: 'running' }); return turn;
    }, waitForTurn: async (id: string) => {
      if (hold) await blocked;
      active--; const turn = turns.find(row => row.id === id)!;
      if (turn.state === 'cancelled') return;
      turn.state = 'completed'; deliveries.find(row => row.turnId === id)!.state = 'completed';
      results.push({ id: `result-${id}`, text: 'Only approved group result', turnId: id, authorKind: 'bot' });
    }, cancel: async (_key: unknown, id: string) => { turns.find(row => row.id === id)!.state = 'cancelled'; }, drain: async () => { hold = false; release?.(); },
  } as unknown as Groups;
  const labels: { id: string; label: unknown }[] = [];
  const flow = { inherit: async (id: string, label: unknown) => { labels.push({ id, label }); },
    draft: (_outlet: unknown, _owner: unknown, _source: unknown, _call: unknown, _target: unknown, content: string) => ({ content, label: { readers: [owner, peer] } }),
    admit: async () => { if (flowHeld) throw new Error('Private or unknown source held'); return 'flow'; },
    persist: async (_id: string, save: () => unknown) => save(),
    dispatch: async (_id: string, send: () => unknown, signal?: AbortSignal, check?: () => Promise<void>) => { signal?.throwIfAborted(); await check?.(); return send(); },
  };
  let bound = 'main', invalidations = 0;
  const registry = { config, invalidate() { invalidations++; }, list: async () => bots, status: async () => bots.map(bot => ({ id: bot.id, preset: { state: 'ok' } })),
    get: async (id: string) => { const bot = bots.find(row => row.id === id); if (!bot) throw new Error('deleted'); return bot; },
    mainSessions: { find: async () => ({ sessionId: bound }) }, memoryKernel: {}, memoryOutlets: flow } as unknown as DshBotRegistry;
  const ctx = { agents: { get: (id: string) => id === 'main' ? agent : id === 'root' ? root : undefined }, sessions: { flush: async () => flush } } as unknown as Context;
  const domain = { table: () => ({ get: (id: string) => table.get(id), entries: () => [...table.entries()],
    put: async (id: string, value: SupergroupWork) => { table.set(id, structuredClone(value)); } }), close: async () => {} } as unknown as Domain<typeof supergroupDomain>;
  const service = new Supergroup(ctx, registry, groups, domain); await service.start();
  const current = () => table.get('work')!;
  const send = (operationId: string, text = 'New genuine group instruction', expectedRevision = current().revision,
    extra: { memberIds?: string[]; replyTo?: string } = {}) => service.sendGroupInput({ group: key, workId: 'work', expectedRevision, operationId, text, ...extra });
  const wait = async (condition: () => boolean) => { for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 1)); expect(condition()).toBe(true); };
  return { service, ctx, key, current, send, wait, followups, rootEvents, mainEvents, agent, sent, labels, config,
    get maxActive() { return maxActive; }, get invalidations() { return invalidations; },
    hold: () => { hold = true; blocked = new Promise(resolve => { release = resolve; }); }, release: () => { hold = false; release?.(); },
    bindElsewhere: () => { bound = 'other-main'; }, rejectFlow: () => { flowHeld = true; }, failFlush: () => { flush = false; } };
}

test('owner input is durable native group text; exact replay is inert and changed operation conflicts', async () => {
  const f = await fixture();
  try {
    const revision = f.current().revision, accepted = await f.send('one', 'Exact root text', revision, { memberIds: ['member-1'] });
    expect(accepted.receipt.state).toBe('queued');
    await f.wait(() => f.followups.length === 1);
    const duplicate = await f.send('one', 'Exact root text', revision, { memberIds: ['member-1'] });
    expect(duplicate.receipt.messageId).toBe(accepted.receipt.messageId);
    await expect(f.send('one', 'Changed source', revision, { memberIds: ['member-1'] })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    expect(f.rootEvents).toHaveLength(1); expect(f.sent).toHaveLength(1); expect(f.sent[0]?.memberIds).toEqual(['member-1']);
    expect(f.rootEvents[0]?.data).toMatchObject({ source: { kind: 'user', group: f.key, supergroupWorkId: 'work' }, content: [{ text: 'Exact root text' }] });
    expect(f.followups[0]?.source).toMatchObject({ kind: 'dsh-bot-supergroup-result', originMessageId: accepted.receipt.messageId, originSeq: accepted.receipt.seq });
    expect(f.mainEvents).toHaveLength(1); expect(f.current().groupInputs[0]?.delivery?.state).toBe('queued');
    expect(await isAdmittedSupergroupInput(f.agent, f.followups[0]!)).toBe(true);
    const forged = { ...structuredClone(f.followups[0]!), content: [{ type: 'text' as const, text: 'Impersonate approved payload' }] };
    expect(await isAdmittedSupergroupInput(f.agent, forged)).toBe(false);
    expect(await isAdmittedSupergroupInput({ ...f.agent } as Agent, f.followups[0]!)).toBe(false);
  } finally { await f.service.close(); }
});

test('stale revision retains exact human text and conflict receipt without dispatching models', async () => {
  const f = await fixture();
  try {
    const result = await f.send('stale', 'Do not lose my message', 999);
    expect(result.receipt).toMatchObject({ state: 'conflict', reason: 'work-revision-conflict', seq: 1 });
    expect(f.rootEvents).toHaveLength(1); expect(f.sent).toEqual([]); expect(f.followups).toEqual([]);
    expect((await f.service.byGroup(f.key))?.work.id).toBe('work');
    expect(await f.service.catalog({ bot: { botId: 'owner', botCreatedAt: 999 } })).toEqual([]);
  } finally { await f.service.close(); }
});

test('successive group input receipts run serially through the same work with target and reply references', async () => {
  const f = await fixture(); f.hold();
  try {
    const one = await f.send('one'); await f.wait(() => f.sent.length === 1);
    const two = await f.send('two', 'Second root input', f.current().revision, { replyTo: one.receipt.messageId });
    expect(two.receipt.state).toBe('queued'); expect(f.sent).toHaveLength(1);
    f.release(); await f.wait(() => f.followups.length === 2);
    expect(f.maxActive).toBe(1); expect(f.sent.map(row => row.text)).toEqual(['New genuine group instruction', 'Second root input']);
    expect(f.sent[1]?.replyTo).toBe(one.receipt.messageId); expect(f.current().groupInputs.map(row => row.state)).toEqual(['completed', 'completed']);
    expect(f.current().inputMessageIds).toEqual(['original', one.receipt.messageId, two.receipt.messageId]);
  } finally { f.release(); await f.service.close(); }
});

test('concurrent private input cannot replace a running group revision; cancel fences pending original Bot delivery', async () => {
  const f = await fixture(); f.hold();
  try {
    await f.send('one'); await f.wait(() => f.sent.length === 1);
    f.mainEvents.push({ type: 'user/message', seq: 2, data: { id: 'private-two', source: { kind: 'user' }, content: [{ type: 'text', text: 'Private parallel request' }] } });
    await expect(f.service.invoke(f.agent, { action: 'continue', workId: 'work' }, new AbortController().signal)).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    await f.service.cancel('work', f.current().revision);
    f.release(); await f.wait(() => f.current().groupInputs[0]?.state === 'cancelled');
    expect(f.followups).toEqual([]); expect(f.current().state).toBe('cancelled');
  } finally { f.release(); await f.service.close(); }
  const queued = await fixture();
  try {
    await queued.send('already-queued'); await queued.wait(() => queued.followups.length === 1);
    await queued.service.cancel('work', queued.current().revision);
    await expect(isAdmittedSupergroupInput(queued.agent, queued.followups[0]!)).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    expect(queued.current().groupInputs[0]?.delivery?.state).toBe('cancelled');
  } finally { await queued.service.close(); }
});

test('delivery is confirmed by exact input/answer native references and no open/query triggers a followup', async () => {
  const f = await fixture();
  try {
    await f.send('one'); await f.wait(() => f.followups.length === 1);
    f.mainEvents.push({ type: 'user/message', seq: 5, data: f.followups[0]! });
    expect((await f.service.byGroup(f.key))?.work.groupInputs[0]?.delivery?.state).toBe('queued');
    f.mainEvents.push({ type: 'assistant/message', seq: 6, data: { message: { id: 'answer-one', content: [{ type: 'text', text: 'Original Bot answer' }] } } });
    expect((await f.service.byGroup(f.key))?.work.groupInputs[0]?.delivery).toMatchObject({ state: 'delivered', inputSeq: 5, answerMessageId: 'answer-one' });
    await f.service.catalog(); await f.service.byGroup(f.key); expect(f.followups).toHaveLength(1);
  } finally { await f.service.close(); }
});

test('restart keeps uncertain delivery unknown and never replays a persisted group request', async () => {
  const before = await fixture(); await before.send('one'); await before.wait(() => before.followups.length === 1);
  const saved = structuredClone(before.current()); await before.service.close();
  const f = await fixture(saved);
  try {
    expect(f.current().groupInputs[0]?.delivery?.state).toBe('unknown');
    await f.service.catalog(); const row = f.current().groupInputs[0]!;
    await f.send('one', 'New genuine group instruction', row.expectedRevision);
    expect(f.followups).toEqual([]); expect(f.rootEvents).toEqual([]); expect(f.sent).toEqual([]);
  } finally { await f.service.close(); }
});

test('unsupported fields/attachments, foreign member and private data-flow refusal do not create root events', async () => {
  const f = await fixture();
  try {
    expect(() => supergroupSendGroupInputSchema.parse({ group: f.key, workId: 'work', operationId: 'one', expectedRevision: 1, text: 'text', files: ['private'] })).toThrow();
    await expect(f.send('invalid-member', 'text', 1, { memberIds: ['foreign-member'] })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
    await expect(f.send('invalid-reply', 'text', 1, { replyTo: 'private-message' })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
    f.rejectFlow(); await expect(f.send('held')).rejects.toThrow('Private or unknown source held');
    expect(f.rootEvents).toEqual([]); expect(f.sent).toEqual([]); expect(f.current().groupInputs).toEqual([]);
  } finally { await f.service.close(); }
});

test('failed root flush is durable unknown and rebinding prevents any original Bot delivery', async () => {
  const f = await fixture();
  try {
    f.failFlush(); expect((await f.send('flush')).receipt.state).toBe('unknown'); expect(f.rootEvents).toHaveLength(1); expect(f.sent).toEqual([]);
  } finally { await f.service.close(); }
  const rebound = await fixture(); rebound.bindElsewhere();
  try {
    await rebound.send('rebound'); await rebound.wait(() => rebound.current().groupInputs[0]?.state === 'unknown');
    expect(rebound.followups).toEqual([]); expect(rebound.sent).toEqual([]);
  } finally { await rebound.service.close(); }
});


test('a main continue racing accepted group input is rejected before it can replace the queued runtime', async () => {
  const f = await fixture();
  try {
    f.mainEvents.push({ type: 'user/message', seq: 2, data: { id: 'racing-private', source: { kind: 'user' }, content: [{ type: 'text', text: 'Private input preserved in original main' }] } });
    const results = await Promise.allSettled([f.send('racing-group'),
      f.service.invoke(f.agent, { action: 'continue', workId: 'work' }, new AbortController().signal)]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'dsh-bot/conflict' } });
    await f.wait(() => f.followups.length === 1); expect(f.sent).toHaveLength(1); expect(f.mainEvents).toHaveLength(2);
  } finally { await f.service.close(); }
});

test('a persisted root event mutated behind a queued receipt cannot gain an input capability', async () => {
  const f = await fixture(); f.hold();
  try {
    await f.send('first'); await f.wait(() => f.sent.length === 1);
    const queued = await f.send('second', 'Original exact second body');
    const event = f.rootEvents.find(row => (row.data as UserMessage).id === queued.receipt.messageId)!;
    event.data = { ...(event.data as UserMessage), content: [{ type: 'text', text: 'Forged owner body' }] };
    f.release(); await f.wait(() => f.current().groupInputs[1]?.state === 'unknown');
    expect(f.sent).toHaveLength(1); expect(f.followups).toHaveLength(1);
  } finally { f.release(); await f.service.close(); }
});

test('mode changes notify owner watchers even when no work or delivery is active', async () => {
  const f = await fixture();
  try {
    const before = f.invalidations;
    f.config.supergroup.enabled = false; await f.service.configChanged();
    expect(f.invalidations).toBe(before + 1);
    f.config.supergroup.enabled = true; await f.service.configChanged();
    expect(f.invalidations).toBe(before + 2); expect(f.sent).toEqual([]); expect(f.followups).toEqual([]);
  } finally { await f.service.close(); }
});
