import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import type { KvUnit } from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import { describe, expect, it, vi } from 'vitest';
import { ActivityStore, botDomain, openBotStores } from '../src/host/store.js';
import type { ActivityStoreOptions } from '../src/host/store.js';
import { ACTIVITY_HIDDEN_PREVIEW } from '../src/host/activity/preview.js';
import { activityListResultSchema } from '../src/shared/activity.js';

const isolatedHome = fileURLToPath(new URL('../../../.dsh-dev/', import.meta.url));
type Stores = Awaited<ReturnType<typeof openBotStores>>;
async function facility(run: (ctx: Context, root: string) => Promise<void>) {
  await mkdir(isolatedHome, { recursive: true });
  const root = await mkdtemp(join(isolatedHome, 't08c-store-'));
  const ctx = new Context();
  try {
    await ctx.plugin(Storage).await();
    await ctx.plugin(storageJson, { root }).await();
    await ctx.plugin(storageDomain, { backend: 'json' }).await();
    await run(ctx, root);
  } finally {
    try { await ctx.fiber.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}
async function stores(run: (stores: Stores, ctx: Context, root: string) => Promise<void>, options: ActivityStoreOptions = {}) {
  await facility(async (ctx, root) => { await run(await openBotStores(ctx, options), ctx, root); });
}
const event = (sessionId: string, at: number, botId = 'alpha') =>
  ({ sessionId, botId, role: 'assistant' as const, text: `Reply ${sessionId}`, at, seq: at });

describe('ActivityStore with the published JSON storage backend', () => {
  it('aggregates all Bots, filters by botId and returns independent public values', async () => stores(async ({ bots, activities }) => {
    for (const id of ['alpha', 'beta', 'empty']) await bots.create({ id, name: id });
    await activities.record(event('a1', 1));
    await activities.record({ ...event('a2', 2), role: 'user' });
    await activities.record(event('b1', 3, 'beta'));
    const result = activities.list();
    expect(activityListResultSchema.safeParse(result).success).toBe(true);
    expect(result.sessions.map((row) => row.sessionId)).toEqual(['b1', 'a2', 'a1']);
    expect(result.bots).toEqual([
      { botId: 'alpha', lastActivityAt: 2, unreadCount: 1,
        latest: { sessionId: 'a2', preview: 'Reply a2', role: 'user', at: 2 } },
      { botId: 'beta', lastActivityAt: 3, unreadCount: 1,
        latest: { sessionId: 'b1', preview: 'Reply b1', role: 'assistant', at: 3 } },
      { botId: 'empty', lastActivityAt: 0, unreadCount: 0 },
    ]);
    expect(activities.list({ botId: 'alpha' }).sessions.map((row) => row.sessionId)).toEqual(['a2', 'a1']);
    expect(activities.list({ botId: 'absent' })).toEqual({ sessions: [], bots: [] });
    const first = result.sessions[0];
    if (!first) throw new Error('Expected first session');
    first.lastMessage.preview = 'polluted';
    expect(activities.list().sessions[0]?.lastMessage.preview).toBe('Reply b1');
    expect(result.sessions[0]).not.toHaveProperty('lastEventSeq');
  }));

  it('persists safe summaries and resumes with read state and sequence intact', async () => stores(async (current, ctx, root) => {
    await current.bots.create({ id: 'alpha', name: 'Alpha' });
    await current.activities.record({ ...event('session', 1), title: ' # **Title** ', text: '**Hello**\nworld' });
    await current.activities.markRead('session');
    const expected = current.activities.list();
    const disk = JSON.parse(await readFile(join(root, 'dsh_bot.json'), 'utf8'));
    expect(disk.unit).toEqual({ name: 'dsh_bot', version: 1 });
    expect(disk.tables.activities.session).toMatchObject({ title: 'Title', lastEventSeq: 1,
      lastMessage: { preview: 'Hello world' } });
    expect(disk.tables.activities.session).not.toHaveProperty('text');
    await current.close();
    const restored = await openBotStores(ctx);
    expect(restored.activities.list()).toEqual(expected);
    await restored.activities.record({ ...event('session', 1), text: 'duplicate' });
    expect(restored.activities.list()).toEqual(expected);
    await restored.activities.record({ ...event('session', 2), text: 'Next' });
    expect(restored.activities.list().sessions[0]).toMatchObject({ title: 'Title', unread: true,
      lastMessage: { preview: 'Next' } });
  }));

  it('opens older version-one domains with no activity table without losing other data', async () => stores(async (current, ctx, root) => {
    const bot = await current.bots.create({ id: 'alpha', name: 'Legacy' });
    const memory = await current.memories.add({ botId: 'alpha', content: 'Keep' });
    await current.close();
    const file = join(root, 'dsh_bot.json');
    const legacy = JSON.parse(await readFile(file, 'utf8'));
    delete legacy.tables.activities;
    await writeFile(file, JSON.stringify(legacy));
    const restored = await openBotStores(ctx);
    expect(restored.bots.get('alpha')).toEqual(bot);
    expect(restored.memories.listByBot('alpha', { limit: 20 })).toEqual([memory]);
    expect(restored.activities.list()).toEqual({ sessions: [], bots: [{ botId: 'alpha', lastActivityAt: 0, unreadCount: 0 }] });
    await restored.activities.record(event('new', 1));
    expect(restored.memories.listByBot('alpha', { limit: 20 })).toEqual([memory]);
  }));

  it('never writes suspected secrets from text or titles, even beyond the truncation boundary', async () => stores(async ({ bots, activities }, _ctx, root) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    const secret = `sk-${'a'.repeat(24)}`;
    await activities.record({ ...event('session', 1), text: 'safe '.repeat(40) + secret, title: secret });
    expect(activities.list().sessions[0]).toMatchObject({ title: ACTIVITY_HIDDEN_PREVIEW,
      lastMessage: { preview: ACTIVITY_HIDDEN_PREVIEW } });
    const disk = await readFile(join(root, 'dsh_bot.json'), 'utf8');
    expect(disk).not.toContain(secret);
    expect(disk).not.toContain('safe safe');
  }));

  it('marks read idempotently without changing message recency and makes a same-ms reply unread', async () => stores(async ({ bots, activities }, ctx) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);
    let activityWrites = 0;
    ctx.effect(() => ctx.on('domain/changed', (change) => {
      if (change.table === 'activities') activityWrites++;
    }));
    try {
      await activities.record({ ...event('session', 100), seq: 1 });
      const firstRead = await activities.markRead('session');
      expect(firstRead).toMatchObject({ lastReadAt: 100, updatedAt: 100, unread: false });
      expect(await activities.markRead('session')).toEqual(firstRead);
      expect(activityWrites).toBe(2);
      await activities.record({ ...event('session', 100), seq: 2, text: 'Again' });
      expect(activities.list().sessions[0]).toMatchObject({ updatedAt: 101, unread: true });
      expect(await activities.markRead('session')).toMatchObject({ lastReadAt: 101, updatedAt: 101, unread: false });
      now.mockReturnValue(50);
      expect(await activities.markRead('session')).toMatchObject({ lastReadAt: 101, unread: false });
      expect(activityWrites).toBe(4);
    } finally { now.mockRestore(); }
  }));

  it('wraps unknown session errors and rejects invalid filters instead of hiding them', async () => stores(async ({ activities }) => {
    await expect(activities.markRead('missing')).rejects.toMatchObject({ code: 'activity/not-found', details: {} });
    await expect(activities.markRead('')).rejects.toMatchObject({ code: 'bot/invalid' });
    expect(() => activities.list({ botId: 'BAD' })).toThrowError(expect.objectContaining({ code: 'bot/invalid' }));
  }));

  it('ignores duplicate/stale sequence events while accepting distinct same-time identical messages', async () => stores(async ({ bots, activities }, ctx) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    let writes = 0;
    ctx.effect(() => ctx.on('domain/changed', (change) => { if (change.table === 'activities') writes++; }));
    await activities.record({ ...event('session', 10), seq: 3 });
    await activities.record({ ...event('session', 20), seq: 2 });
    await activities.record({ ...event('session', 10), seq: 3 });
    expect(writes).toBe(1);
    await activities.record({ ...event('session', 10), seq: 4 });
    expect(writes).toBe(2);
    expect(activities.list().sessions[0]).toMatchObject({ updatedAt: 11, lastMessage: { at: 11 } });
  }));

  it('evicts least recently updated sessions per Bot, with stable session-id ties', async () => stores(async ({ bots, activities }) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    await bots.create({ id: 'beta', name: 'Beta' });
    for (const id of ['a', 'b', 'c']) await activities.record(event(id, 1));
    expect(activities.list().sessions.map((row) => row.sessionId)).toEqual(['a', 'b']);
    await activities.record(event('a', 2));
    await activities.markRead('b');
    await activities.record(event('d', 3));
    await activities.record(event('beta', 1, 'beta'));
    expect(activities.list().sessions.map((row) => row.sessionId)).toEqual(['d', 'a', 'beta']);
  }, { activityMaxSessionsPerBot: 2 }));

  it('applies a global cap across Bots and applies lowered caps on reopen', async () => stores(async (current, ctx) => {
    for (const id of ['alpha', 'beta']) await current.bots.create({ id, name: id });
    for (const [id, at, botId] of [['a', 1, 'alpha'], ['b', 2, 'beta'], ['c', 3, 'alpha'], ['d', 4, 'beta']] as const) {
      await current.activities.record(event(id, at, botId));
    }
    expect(current.activities.list().sessions.map((row) => row.sessionId)).toEqual(['d', 'c', 'b']);
    await current.close();
    const restored = await openBotStores(ctx, { activityMaxSessionsTotal: 1 });
    expect(restored.activities.list().sessions.map((row) => row.sessionId)).toEqual(['d']);
  }, { activityMaxSessionsTotal: 3 }));

  it('clears activity for both cascade modes and preserves other Bots and requested memories', async () => stores(async ({ bots, memories, activities }) => {
    for (const id of ['alpha', 'beta', 'gamma']) {
      await bots.create({ id, name: id });
      await memories.add({ botId: id, content: id });
      await activities.record(event(id, 1, id));
    }
    await bots.remove('alpha');
    await bots.remove('beta', { deleteMemories: false });
    expect(activities.list().sessions.map((row) => row.botId)).toEqual(['gamma']);
    expect(memories.listByBot('alpha', { limit: 20 })).toEqual([]);
    expect(memories.listByBot('beta', { limit: 20 })).toHaveLength(1);
    await bots.create({ id: 'alpha', name: 'Recreated' });
    await bots.create({ id: 'beta', name: 'Recreated' });
    expect(activities.list({ botId: 'alpha' }).sessions).toEqual([]);
    expect(activities.list({ botId: 'beta' }).sessions).toEqual([]);
  }));

  it('serializes cross-instance writes with deletion and rejects late old-incarnation events', async () => stores(async ({ bots, activities }, ctx) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1);
    try {
      const bot = await bots.create({ id: 'alpha', name: 'Alpha' });
      const domain = ctx.storageDomain.get(botDomain.name);
      if (!domain) throw new Error('domain missing');
      const other = new ActivityStore(domain as unknown as Domain<typeof botDomain>);
      await Promise.all([activities.record(event('first', 1)), other.record(event('second', 2)), bots.remove('alpha')]);
      expect(activities.list()).toEqual({ sessions: [], bots: [] });
      expect(await activities.record(event('late', 3))).toBeUndefined();
      now.mockReturnValue(2);
      await bots.create({ id: 'alpha', name: 'New' });
      expect(await activities.record({ ...event('old', 3), expectedBotCreatedAt: bot.createdAt })).toBeUndefined();
      expect(activities.list().sessions).toEqual([]);
    } finally { now.mockRestore(); }
  }));

  it('returns empty lists on closed storage but wraps write failures', async () => stores(async (current) => {
    await current.bots.create({ id: 'alpha', name: 'Alpha' });
    await current.activities.record(event('session', 1));
    await current.close();
    expect(current.activities.list()).toEqual({ sessions: [], bots: [] });
    await expect(current.activities.markRead('session')).rejects.toMatchObject({ code: 'store/unavailable' });
    await expect(current.activities.record(event('next', 2))).rejects.toMatchObject({ code: 'store/unavailable' });
  }));

  it('preserves Bot on activity cleanup I/O failure and permits a safe retry', async () => facility(async (ctx) => {
    const kv = ctx.storage.backend.get('json').kv;
    if (!kv) throw new Error('missing JSON backend');
    let unit!: KvUnit;
    const open = kv.open.bind(kv);
    const opening = vi.spyOn(kv, 'open').mockImplementationOnce(async (descriptor) => { unit = await open(descriptor); return unit; });
    const current = await openBotStores(ctx);
    opening.mockRestore();
    const bot = await current.bots.create({ id: 'alpha', name: 'Alpha' });
    await current.activities.record(event('session', 1));
    const failure = new Error('injected activity cleanup failure');
    const deletion = vi.spyOn(unit, 'deleteRecord').mockRejectedValueOnce(failure);
    try {
      await expect(current.bots.remove('alpha', { deleteMemories: false })).rejects.toMatchObject({ code: 'store/unavailable', cause: failure });
      expect(current.bots.get('alpha')).toEqual(bot);
      expect(current.activities.list().sessions).toHaveLength(1);
    } finally { deletion.mockRestore(); }
    await current.bots.remove('alpha', { deleteMemories: false });
    expect(current.activities.list()).toEqual({ sessions: [], bots: [] });
  }));
});
