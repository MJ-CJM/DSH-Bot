import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import type { KvUnit } from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import { describe, expect, it, vi } from 'vitest';
import { BotStore, botDomain, MemoryStore, openBotStores } from '../src/host/store.js';
import { DshBotError, type DshBotErrorCode } from '../src/host/errors.js';
import {
  avatarSchema, botCreateSchema, botPatchSchema, BOT_NAME_MAX_CHARS, botSchema,
  MEMORY_LIST_MAX_LIMIT, memorySchema, PERSONA_PREFIX_MAX_BYTES,
} from '../src/shared/schema.js';

const isolatedHome = fileURLToPath(new URL('../../../.dsh-dev/', import.meta.url));

async function withFacility(run: (ctx: Context, root: string) => Promise<void>) {
  await mkdir(isolatedHome, { recursive: true });
  const root = await mkdtemp(join(isolatedHome, 't03-store-'));
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

async function openOwned(ctx: Context) {
  let domain!: Domain<typeof botDomain>;
  const close = ctx.effect(async () => {
    domain = await ctx.storageDomain.open(botDomain);
    return () => domain.close();
  });
  await close;
  return { domain, bots: new BotStore(domain), memories: new MemoryStore(domain), close };
}

type Fixture = Awaited<ReturnType<typeof openOwned>> & { ctx: Context; root: string };
async function withStores(run: (fixture: Fixture) => Promise<void>) {
  await withFacility(async (ctx, root) => run({ ...await openOwned(ctx), ctx, root }));
}

async function expectCode(operation: () => unknown, code: DshBotErrorCode) {
  let failure: unknown;
  try { await operation(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(DshBotError);
  expect(failure).toMatchObject({ name: 'DshBotError', code });
  return failure as DshBotError;
}

describe('BotStore with the published JSON storage backend', () => {
  it('reads legacy seed-only registry state and validates/persists the optional Bots workspace id', async () => withStores(async ({ ctx, domain, bots, close }) => {
    await domain.table('registry_state').put('examples', { status: 'complete' });
    expect(bots.botsWorkspaceId()).toBeUndefined();
    await bots.saveBotsWorkspaceId('workspace-one');
    await expect(bots.saveBotsWorkspaceId('')).rejects.toMatchObject({ code: 'bot/invalid' });
    expect(bots.botsWorkspaceId()).toBe('workspace-one');
    await close();
    const reopened = await openOwned(ctx);
    expect(reopened.bots.botsWorkspaceId()).toBe('workspace-one');
    expect(reopened.domain.table('registry_state').get('examples')).toEqual({ status: 'complete' });
    await reopened.bots.seedExamples([{ id: 'unexpected-seed', name: 'Not seeded' }]);
    expect(reopened.bots.list()).toEqual([]);
  }));
  it('keeps version-one records without colors compatible and persists only the curated theme palette', async () => withStores(async ({ ctx, bots, close }) => {
    const old = await bots.create({ id: 'legacy-color', name: 'Legacy' });
    expect(old).not.toHaveProperty('avatarColor');
    expect(old).not.toHaveProperty('avatarVariant');
    expect(botSchema.parse(old)).toEqual(old);
    expect(old.schemaVersion).toBe(1);
    const colored = await bots.update(old.id, { avatarColor: '--dsw-alias-state-success-primary', avatarVariant: 'glasses' });
    await expectCode(() => bots.update(old.id, { avatarVariant: 'invalid' } as never), 'bot/invalid');
    expect(colored.avatarColor).toBe('--dsw-alias-state-success-primary');
    for (const avatarColor of ['#123456', 'red', '--dsw-alias-bg-base', 'var(--dsw-alias-state-error-primary)']) {
      await expectCode(() => bots.update(old.id, { avatarColor } as never), 'bot/invalid');
      expect(bots.get(old.id)).toEqual(colored);
    }
    await close();
    const reopened = await openOwned(ctx);
    expect(reopened.bots.get(old.id)).toEqual(colored);
    expect(await reopened.bots.update(old.id, { avatarColor: null })).not.toHaveProperty('avatarColor');
    expect(await reopened.bots.update(old.id, { avatarVariant: null })).not.toHaveProperty('avatarVariant');
    expect(await reopened.bots.update(old.id, { avatarVariant: 'auto', avatarColor: 'purple' })).toMatchObject({ avatarVariant: 'auto', avatarColor: 'purple' });
  }));

  it('shares strict raster base64 avatar validation across write and wire schemas', async () => withStores(async ({ bots }) => {
    for (const type of ['png', 'jpeg', 'gif', 'webp']) {
      const avatar = `data:image/${type};base64,aGVsbG8=`;
      expect(avatarSchema.parse(avatar)).toBe(avatar);
      expect(botCreateSchema.parse({ id: 'alpha', name: 'Alpha', avatar }).avatar).toBe(avatar);
      expect(botPatchSchema.parse({ avatar }).avatar).toBe(avatar);
    }
    await bots.create({ id: 'alpha', name: 'Alpha', avatar: '🤖' });
    for (const avatar of ['data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png,hello', 'data:image/png;base64,', 'data:image/png;base64,???', 'data:image/png;base64,a',
      'data:image/png;base64,a===', 'data:image/png;base64,aGVs bG8=', 'https://example.com/a.png']) {
      expect(avatarSchema.safeParse(avatar).success).toBe(false);
      expect(botCreateSchema.safeParse({ id: 'beta', name: 'Beta', avatar }).success).toBe(false);
      expect(botPatchSchema.safeParse({ avatar }).success).toBe(false);
      await expectCode(() => bots.create({ id: 'beta', name: 'Beta', avatar }), 'bot/invalid');
      await expectCode(() => bots.update('alpha', { avatar }), 'bot/invalid');
    }
  }));

  it('keeps invalid legacy avatars on disk but serves valid records and diagnostics after reopen', async () => withStores(async ({ ctx, root, domain, bots, close }) => {
    const original = await bots.create({ id: 'legacy', name: 'Legacy' });
    const healthy = await bots.create({ id: 'healthy', name: 'Healthy', avatar: '🤖' });
    const avatar = 'data:text/html;base64,PHNjcmlwdD4=';
    // Simulate an older writer; Domain.put intentionally does not validate.
    await domain.table('bots').put('legacy', { ...original, avatar });
    await close();
    const before = await readFile(join(root, 'dsh_bot.json'), 'utf8');
    const reopened = await openOwned(ctx);
    expect(reopened.bots.get('legacy')).toEqual(original);
    expect(reopened.bots.list()).toEqual([healthy, original]);
    expect(reopened.bots.avatarWarnings()).toEqual(['legacy']);
    expect(await readFile(join(root, 'dsh_bot.json'), 'utf8')).toBe(before);
    await expectCode(() => reopened.bots.update('legacy', { name: 'Still legacy' }), 'bot/invalid');
    expect(reopened.domain.table('bots').get('legacy')?.avatar).toBe(avatar);
    await reopened.bots.update('legacy', { avatar: null });
    expect(reopened.bots.avatarWarnings()).toEqual([]);
    expect(reopened.bots.get('healthy')).toEqual(healthy);
  }));

  it('bounds names by Unicode code points and persona prefixes by UTF-8 bytes', async () => withStores(async ({ bots }) => {
    const prefix = `${'界'.repeat(Math.floor(PERSONA_PREFIX_MAX_BYTES / 3))}a`;
    const original = await bots.create({ id: 'alpha', name: ` ${'🤖'.repeat(BOT_NAME_MAX_CHARS)} `,
      persona: { prefix } });
    expect(original.name).toBe('🤖'.repeat(BOT_NAME_MAX_CHARS));
    for (const fields of [{ name: 'a'.repeat(BOT_NAME_MAX_CHARS + 1) },
      { name: '🤖'.repeat(BOT_NAME_MAX_CHARS + 1) }, { persona: { prefix: `${prefix}a` } }]) {
      await expectCode(() => bots.create({ id: 'invalid', name: 'Invalid', ...fields }), 'bot/invalid');
      await expectCode(() => bots.update('alpha', fields), 'bot/invalid');
    }
    expect(bots.get('alpha')).toStrictEqual(original);
    await expectCode(() => bots.remove('alpha', { deleteMemories: 'false' } as never), 'bot/invalid');
    expect(bots.get('alpha')).toStrictEqual(original);
  }));

  it('creates defaults, lists, reads, updates and removes records', async () => withStores(async ({ bots, root }) => {
    expect(bots.list()).toEqual([]);
    const created = await bots.create({ id: 'alpha', name: 'Alpha' });
    expect(botSchema.safeParse(created).success).toBe(true);
    expect(created).toMatchObject({
      id: 'alpha', name: 'Alpha', description: '', persona: { prefix: '' }, template: 'standard',
      tools: { deny: [] }, skills: { extraDirs: [] }, memory: { enabled: true, injectLimit: 20 },
      mcpServers: [], channels: [], schemaVersion: 1,
    });
    expect(created.createdAt).toBe(created.updatedAt);
    expect(bots.get('alpha')).toEqual(created);
    expect(bots.list()).toEqual([created]);
    const updated = await bots.update('alpha', {
      name: 'Renamed', avatar: '🤖', description: 'A helper', template: 'minimal',
      persona: { prefix: 'Be precise', suffix: 'Use citations', complete: true },
      model: { provider: 'test', model: 'local', reasoningEffort: 'off' },
      tools: { deny: ['shell'] }, skills: { extraDirs: ['./skills'] },
      memory: { enabled: false, injectLimit: 3 }, defaultCwd: root, order: 2,
      mcpServers: [{ serverName: 'docs', transport: 'stdio', command: 'docs-server', args: [] }],
      channels: [{ kind: 'desktop', target: 'self', policy: { dailyLimit: 5, cooldownSec: 10 } }],
    }, created.updatedAt);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
    expect(updated.name).toBe('Renamed');
    expect(updated.persona.suffix).toBe('Use citations');
    const replaced = await bots.update('alpha', { persona: { prefix: 'Replacement' } });
    expect(replaced.persona).toEqual({ prefix: 'Replacement' });
    await bots.remove('alpha');
    expect(bots.list()).toEqual([]);
    await expectCode(() => bots.get('alpha'), 'bot/not-found');
  }));

  it('validates ids and full nested inputs before persisting', async () => withStores(async ({ bots }) => {
    for (const id of ['', 'a', '-ab', 'Ab', 'ab_', 'éé', 'a'.repeat(33), 123]) {
      await expectCode(() => bots.create({ id, name: 'Invalid' } as never), 'bot/invalid');
    }
    for (const fields of [
      { name: '' }, { name: 42 }, { name: '   ' }, { unknown: true }, { template: 'other' },
      { persona: { prefix: 42 } }, { tools: { deny: [42] } }, { skills: { extraDirs: 'bad' } },
      { memory: { enabled: true, injectLimit: -1 } }, { model: { provider: 'test' } },
      { channels: [{ kind: 'unknown' }] }, { mcpServers: [{ serverName: 'bad', transport: 'http' }] },
      { createdAt: 1 }, { schemaVersion: 1 }, { avatar: 'ordinary text' },
    ]) {
      await expectCode(() => bots.create({ id: 'invalid', name: 'Invalid', ...fields } as never), 'bot/invalid');
    }
    expect(bots.list()).toEqual([]);
    await bots.create({ id: 'a0', name: 'Shortest' });
    await bots.create({ id: 'a'.repeat(32), name: 'Longest' });
    expect(bots.list()).toHaveLength(2);
  }));

  it('enforces the UTF-8 avatar limit and rejects writable metadata', async () => withStores(async ({ bots }) => {
    const prefix = 'data:image/png;base64,';
    const avatar = prefix + 'a'.repeat(Math.floor((64 * 1024 - prefix.length) / 4) * 4);
    const original = await bots.create({ id: 'alpha', name: 'Alpha', avatar });
    await expectCode(() => bots.update('alpha', { avatar: `${avatar}aaaa` }), 'bot/invalid');
    for (const patch of [{ id: 'beta' }, { createdAt: 1 }, { updatedAt: 1 }, { schemaVersion: 1 }, { extra: true }]) {
      await expectCode(() => bots.update('alpha', patch as never), 'bot/invalid');
    }
    expect(bots.get('alpha')).toEqual(original);
    await expectCode(() => bots.update('absent', { name: 'Missing' }), 'bot/not-found');
    await expectCode(() => bots.remove('absent'), 'bot/not-found');
    await expectCode(() => bots.get('BAD'), 'bot/invalid');
    await expectCode(() => bots.update('alpha', {}, -1), 'bot/invalid');
  }));

  it('serializes duplicate creates across store instances without overwriting', async () => withStores(async ({ bots, domain }) => {
    const other = new BotStore(domain);
    const results = await Promise.allSettled([
      bots.create({ id: 'alpha', name: 'First' }), other.create({ id: 'alpha', name: 'Second' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection?.reason).toBeInstanceOf(DshBotError);
    expect(rejection?.reason).toMatchObject({ code: 'bot/conflict' });
    expect(bots.list()).toHaveLength(1);
    await expectCode(() => other.create({ id: 'alpha', name: 'Third' }), 'bot/conflict');
    expect(bots.get('alpha').name).toBe('First');
  }));

  it('detects concurrent stale updates even when the clock does not advance', async () => withStores(async ({ bots, domain }) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const original = await bots.create({ id: 'alpha', name: 'Alpha' });
      const other = new BotStore(domain);
      const results = await Promise.allSettled([
        bots.update('alpha', { name: 'Winner' }, original.updatedAt),
        other.update('alpha', { name: 'Stale' }, original.updatedAt),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({ code: 'bot/conflict' });
      const winner = bots.get('alpha');
      expect(winner.updatedAt).toBeGreaterThan(original.updatedAt);
      const updates = await Promise.all([
        bots.update('alpha', { description: 'Retained' }), other.update('alpha', { name: 'Latest' }),
      ]);
      expect(updates[1]?.updatedAt).toBeGreaterThan(updates[0]?.updatedAt ?? 0);
      expect(bots.get('alpha')).toMatchObject({ name: 'Latest', description: 'Retained' });
      await expectCode(() => bots.update('alpha', { name: 'Stale' }, winner.updatedAt), 'bot/conflict');
    } finally { now.mockRestore(); }
  }));

  it('keeps caller mutations out of stored nested data', async () => withStores(async ({ bots }) => {
    const input = { id: 'alpha', name: 'Alpha', tools: { deny: ['shell'] } };
    const created = await bots.create(input);
    input.tools.deny.push('input pollution');
    created.tools.deny.push('result pollution');
    bots.get('alpha').tools.deny.push('get pollution');
    const listed = bots.list();
    listed[0]?.tools.deny.push('list pollution');
    listed.pop();
    expect(bots.get('alpha').tools.deny).toEqual(['shell']);
    const updated = await bots.update('alpha', { tools: { deny: ['network'] } });
    updated.tools.deny.push('update pollution');
    expect(bots.get('alpha').tools.deny).toEqual(['network']);
  }));
});

describe('MemoryStore', () => {
  it('trims content, rejects empty text on add/update and persists normalized content', async () => withStores(async ({ ctx, bots, memories, close }) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    const added = await memories.add({ botId: 'alpha', content: ' \n 原始记忆\t ' });
    expect(added.content).toBe('原始记忆');
    for (const content of ['', ' \t\n', '\u3000\u00a0']) {
      await expectCode(() => memories.add({ botId: 'alpha', content }), 'bot/invalid');
      await expectCode(() => memories.update('alpha', added.id, { content }), 'bot/invalid');
    }
    const updated = await memories.update('alpha', added.id, { content: '\n 更新记忆 \t' });
    expect(updated.content).toBe('更新记忆');
    await close();
    const reopened = await openOwned(ctx);
    expect(reopened.memories.listByBot('alpha', { limit: 10 })).toStrictEqual([updated]);
  }));

  it('bounds list size and clones only the selected page after filtering and ordering', async () => withStores(async ({ bots, memories }) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    await bots.create({ id: 'beta', name: 'Beta' });
    await memories.add({ botId: 'alpha', content: 'Match old' });
    const pin = await memories.add({ botId: 'alpha', content: 'Match pinned', pinned: true });
    await memories.add({ botId: 'alpha', content: 'Excluded', pinned: true });
    await memories.add({ botId: 'beta', content: 'Match other Bot', pinned: true });
    const recent = await memories.add({ botId: 'alpha', content: 'Match newest' });
    // Force a distinct sort timestamp even if every insertion shares a millisecond.
    const newest = await memories.update('alpha', recent.id, { content: recent.content });
    await expectCode(() => memories.listByBot('alpha', { limit: MEMORY_LIST_MAX_LIMIT + 1 }), 'bot/invalid');
    expect(memories.listByBot('alpha', { limit: MEMORY_LIST_MAX_LIMIT })).toHaveLength(4);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      const page = memories.listByBot('alpha', { limit: 2, query: 'match' });
      expect(clone).toHaveBeenCalledTimes(2);
      expect(page).toStrictEqual([pin, newest]);
      page[0]?.tags.push('No storage mutation');
    } finally { clone.mockRestore(); }
    expect(memories.listByBot('alpha', { pinned: true, query: 'match', limit: 1 })).toStrictEqual([pin]);
  }));

  it('adds, updates and removes memories with validated defaults and provenance', async () => withStores(async ({ bots, memories }) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    const added = await memories.add({ botId: 'alpha', content: 'Remember this' });
    expect(memorySchema.safeParse(added).success).toBe(true);
    expect(added).toMatchObject({ kind: 'note', tags: [], pinned: false, content: 'Remember this' });
    const updated = await memories.update('alpha', added.id, {
      content: 'Updated', kind: 'preference', tags: ['work'], pinned: true,
      source: { by: 'user', at: 42, sessionId: 'session-example' },
    });
    expect(updated.createdAt).toBe(added.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(added.updatedAt);
    expect(memories.listByBot('alpha', { limit: 10 })).toEqual([updated]);
    await memories.remove('alpha', added.id);
    expect(memories.listByBot('alpha', { limit: 10 })).toEqual([]);
    await expectCode(() => memories.update('alpha', added.id, { pinned: false }), 'memory/not-found');
    await expectCode(() => memories.remove('alpha', added.id), 'memory/not-found');
  }));

  it('isolates reads, updates, deletes and bulk removal by Bot', async () => withStores(async ({ bots, memories }) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    await bots.create({ id: 'beta', name: 'Beta' });
    const alpha = await memories.add({ botId: 'alpha', content: 'Shared topic alpha' });
    const beta = await memories.add({ botId: 'beta', content: 'Shared topic beta' });
    await expectCode(() => memories.update('alpha', beta.id, { content: 'Cross Bot' }), 'memory/not-found');
    await expectCode(() => memories.remove('alpha', beta.id), 'memory/not-found');
    expect(memories.listByBot('alpha', { query: 'shared', limit: 10 })).toEqual([alpha]);
    expect(memories.listByBot('beta', { limit: 10 })).toEqual([beta]);
    expect(await memories.removeByBot('alpha')).toBe(1);
    expect(await memories.removeByBot('alpha')).toBe(0);
    expect(memories.listByBot('beta', { limit: 10 })).toEqual([beta]);
    await expectCode(() => memories.add({ botId: 'missing', content: 'Orphan' }), 'bot/not-found');
    await bots.remove('beta', { deleteMemories: false });
    // Retaining memories now requires an explicit opt-out of the default cascade.
    expect(memories.listByBot('beta', { limit: 10 })).toEqual([beta]);
    expect(await memories.removeByBot('beta')).toBe(1);
  }));

  it('measures the 2 KiB content boundary in UTF-8 bytes before every write', async () => withStores(async ({ bots, memories }) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    const ascii = await memories.add({ botId: 'alpha', content: 'a'.repeat(2048) });
    const chinese = await memories.add({ botId: 'alpha', content: `${'界'.repeat(682)}aa` });
    const emoji = await memories.add({ botId: 'alpha', content: '🤖'.repeat(512) });
    for (const content of ['a'.repeat(2049), `${chinese.content}a`, `${emoji.content}a`]) {
      await expectCode(() => memories.add({ botId: 'alpha', content }), 'memory/too-large');
      await expectCode(() => memories.update('alpha', ascii.id, { content }), 'memory/too-large');
    }
    expect(memories.listByBot('alpha', { limit: 10 })).toHaveLength(3);
    expect(memories.listByBot('alpha', { limit: 10 }).find((record) => record.id === ascii.id)).toEqual(ascii);
  }));

  it('rejects malformed memory data, immutable patches and invalid query options', async () => withStores(async ({ bots, memories }) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    const original = await memories.add({ botId: 'alpha', content: 'Valid' });
    for (const fields of [
      { content: 42 }, { kind: 'invalid' }, { tags: [42] }, { pinned: 'yes' },
      { source: { by: 'other', at: 1 } }, { source: { by: 'user', at: -1 } }, { extra: true },
    ]) {
      await expectCode(() => memories.add({ botId: 'alpha', content: 'Invalid', ...fields } as never), 'bot/invalid');
    }
    for (const patch of [{ id: 'changed' }, { botId: 'beta' }, { createdAt: 1 }, { updatedAt: 1 }, { extra: true }]) {
      await expectCode(() => memories.update('alpha', original.id, patch as never), 'bot/invalid');
    }
    for (const options of [
      { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: Number.NaN }, { limit: 10, query: 42 },
      { limit: 10, pinned: 'true' }, { limit: 10, tag: 42 }, { limit: 10, before: 123 },
      { limit: 10, before: { updatedAt: 1, id: original.id } }, { limit: 10, extra: true },
    ]) {
      await expectCode(() => memories.listByBot('alpha', options as never), 'bot/invalid');
    }
    expect(memories.listByBot('alpha', { limit: 10 })).toEqual([original]);
  }));

  it('matches Chinese bigrams and case-insensitive English tokens with AND semantics', async () => withStores(async ({ bots, memories }) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    const shanghai = await memories.add({ botId: 'alpha', content: '上海旅行攻略，早晨喝 COFFEE，下午喝茶' });
    const beijing = await memories.add({ botId: 'alpha', content: '北京旅行，coffee morning' });
    await memories.add({ botId: 'alpha', content: '北京的生活与周末旅行' });
    const search = (query: string) => memories.listByBot('alpha', { query, limit: 10 });
    expect(search('上海旅行')).toEqual([shanghai]);
    expect(search('北京旅行')).toEqual([beijing]);
    expect(search('上海 coffee')).toEqual([shanghai]);
    expect(search('COFFEE morning')).toEqual([beijing]);
    expect(search('茶')).toEqual([shanghai]);
    expect(search('上海 北京')).toEqual([]);
    expect(search('coffee missing')).toEqual([]);
    expect(search('   ')).toHaveLength(3);
  }));

  it('filters and pages deterministically across pinned groups and equal timestamps', async () => withStores(async ({ bots, memories, domain }) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    const fixtures = [
      { id: 'memory-01', pinned: true, updatedAt: 100, tags: ['work'] },
      { id: 'memory-02', pinned: true, updatedAt: 90, tags: [] },
      { id: 'memory-03', pinned: false, updatedAt: 200, tags: ['work'] },
      { id: 'memory-04', pinned: false, updatedAt: 200, tags: [] },
      { id: 'memory-05', pinned: false, updatedAt: 10, tags: ['work'] },
    ];
    for (const fixture of fixtures) {
      await domain.table('memories').put(fixture.id, memorySchema.parse({
        ...fixture, botId: 'alpha', kind: 'note', content: 'A matching topic', createdAt: 1,
      }));
    }
    const expected = fixtures.map((record) => record.id);
    expect(memories.listByBot('alpha', { limit: 20 }).map((record) => record.id)).toEqual(expected);
    expect(memories.listByBot('alpha', { tag: 'work', pinned: false, query: 'topic', limit: 10 })
      .map((record) => record.id)).toEqual(['memory-03', 'memory-05']);
    const first = memories.listByBot('alpha', { limit: 2 });
    const firstCursor = first.at(-1);
    if (!firstCursor) throw new Error('Expected a first page');
    const cursor = { id: firstCursor.id, pinned: firstCursor.pinned, updatedAt: firstCursor.updatedAt };
    const second = memories.listByBot('alpha', { limit: 1, before: cursor });
    const secondCursor = second.at(-1);
    if (!secondCursor) throw new Error('Expected a second page');
    const third = memories.listByBot('alpha', {
      limit: 10, before: { id: secondCursor.id, pinned: secondCursor.pinned, updatedAt: secondCursor.updatedAt },
    });
    expect([...first, ...second, ...third].map((record) => record.id)).toEqual(expected);
    await memories.remove('alpha', firstCursor.id);
    expect(memories.listByBot('alpha', { limit: 10, before: cursor }).map((record) => record.id))
      .toEqual(['memory-03', 'memory-04', 'memory-05']);
  }));

  it('returns copies and serializes updates across MemoryStore instances', async () => withStores(async ({ bots, memories, domain }) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    const input = { botId: 'alpha', content: 'Safe', tags: ['original'], source: { by: 'user' as const, at: 1 } };
    const created = await memories.add(input);
    input.tags.push('input pollution');
    created.tags.push('result pollution');
    const listed = memories.listByBot('alpha', { limit: 10 });
    listed[0]?.tags.push('list pollution');
    if (listed[0]?.source) listed[0].source.at = 999;
    const other = new MemoryStore(domain);
    const updated = await Promise.all([
      memories.update('alpha', created.id, { pinned: true }), other.update('alpha', created.id, { content: 'Latest' }),
    ]);
    updated[1]?.tags.push('update pollution');
    expect(memories.listByBot('alpha', { limit: 10 })[0])
      .toMatchObject({ content: 'Latest', pinned: true, tags: ['original'], source: { by: 'user', at: 1 } });
    expect(updated[1]?.updatedAt).toBeGreaterThan(updated[0]?.updatedAt ?? 0);
  }));

  it('applies Bot isolation before invoking a replacement retrieval predicate', async () => withStores(async ({ bots, memories, domain }) => {
    await bots.create({ id: 'alpha', name: 'Alpha' });
    await bots.create({ id: 'beta', name: 'Beta' });
    const alpha = await memories.add({ botId: 'alpha', content: 'Alpha private' });
    await memories.add({ botId: 'beta', content: 'Beta private' });
    const visited: string[] = [];
    const custom = new MemoryStore(domain, { matches(record, query) {
      visited.push(record.botId);
      expect(Object.isFrozen(record)).toBe(true);
      expect(() => (record.tags as string[]).push('retrieval mutation')).toThrow(TypeError);
      return query === 'semantic search';
    } });
    expect(custom.listByBot('alpha', { query: 'semantic search', limit: 10 }).map((record) => record.id)).toEqual([alpha.id]);
    expect(visited).toEqual(['alpha']);
    expect(memories.listByBot('alpha', { limit: 10 })).toEqual([alpha]);
  }));
});

describe('durability and ownership', () => {
  it.each([undefined, null])('clears all optional Bot fields with %s while required fields reject null', async (clear) => withStores(async ({ ctx, bots, close, root }) => {
    const original = await bots.create({ id: 'alpha', name: 'Alpha', avatar: '🤖', defaultCwd: root, order: 8,
      model: { provider: 'local', model: 'test', reasoningEffort: 'off' } });
    await bots.update('alpha', { description: 'Keep omitted optional fields' });
    for (const field of ['avatar', 'model', 'defaultCwd', 'order'] as const) {
      expect(bots.get('alpha')[field]).toStrictEqual(original[field]);
    }
    const cleared = await bots.update('alpha', { avatar: clear, model: clear, defaultCwd: clear, order: clear });
    for (const field of ['avatar', 'model', 'defaultCwd', 'order']) {
      expect(Object.hasOwn(cleared, field)).toBe(false);
      expect(Object.hasOwn(bots.get('alpha'), field)).toBe(false);
    }
    await expectCode(() => bots.update('alpha', { name: null } as never), 'bot/invalid');
    expect(bots.get('alpha')).toStrictEqual(cleared);
    await close();
    const reopened = await openOwned(ctx);
    expect(reopened.bots.get('alpha')).toStrictEqual(cleared);
  }));

  it('clears optional fields explicitly and preserves the exact record shape after reopen', async () => withStores(async ({ ctx, root, bots, memories, close }) => {
    await bots.create({ id: 'alpha', name: 'Alpha', avatar: '🤖', defaultCwd: root,
      model: { provider: 'local', model: 'test', reasoningEffort: 'off' } });
    await bots.update('alpha', { description: 'Unrelated update' });
    expect(bots.get('alpha')).toMatchObject({ avatar: '🤖', defaultCwd: root });
    const cleared = await bots.update('alpha', { avatar: undefined, defaultCwd: undefined,
      model: { provider: 'local', model: 'test', reasoningEffort: undefined } });
    expect(cleared).not.toHaveProperty('avatar');
    expect(cleared).not.toHaveProperty('defaultCwd');
    expect(cleared.model).not.toHaveProperty('reasoningEffort');
    const memory = await memories.add({ botId: 'alpha', content: 'A note', source: { by: 'user', at: 1 } });
    const clearedMemory = await memories.update('alpha', memory.id, { source: undefined });
    expect(clearedMemory).not.toHaveProperty('source');
    const disk = await readFile(join(root, 'dsh_bot.json'), 'utf8');
    expect(disk).not.toContain('"avatar"');
    expect(disk).not.toContain('"defaultCwd"');
    await close();
    const reopened = await openOwned(ctx);
    expect(reopened.bots.get('alpha')).toStrictEqual(cleared);
    expect(reopened.memories.listByBot('alpha', { limit: 10 })).toStrictEqual([clearedMemory]);
  }));

  it('cascades in one writer slot before same-id recreation, leaving other Bots untouched', async () => withStores(async ({ ctx, bots, memories, domain, close }) => {
    await bots.create({ id: 'alpha', name: 'Original' });
    await bots.create({ id: 'beta', name: 'Other' });
    await memories.add({ botId: 'alpha', content: 'Old memory' });
    const beta = await memories.add({ botId: 'beta', content: 'Keep me' });
    const events: Array<{ table: string; key: string }> = [];
    ctx.effect(() => ctx.on('domain/changed', (event) => {
      if (event.operation === 'deleted') events.push(event);
    }));
    const other = new BotStore(domain);
    await Promise.all([
      memories.add({ botId: 'alpha', content: 'Queued before removal' }),
      bots.remove('alpha'), other.create({ id: 'alpha', name: 'Recreated' }),
    ]);
    expect(events.map((event) => event.table)).toEqual(['memories', 'memories', 'bots']);
    expect(memories.listByBot('alpha', { limit: 10 })).toEqual([]);
    expect(memories.listByBot('beta', { limit: 10 })).toEqual([beta]);
    await close();
    const reopened = await openOwned(ctx);
    expect(reopened.bots.get('alpha').name).toBe('Recreated');
    expect(reopened.memories.listByBot('alpha', { limit: 10 })).toEqual([]);
    expect(reopened.memories.listByBot('beta', { limit: 10 })).toEqual([beta]);
  }));

  it('maps backend failures with their cause and retains the Bot when cascading cleanup fails', async () => withFacility(async (ctx) => {
    const kv = ctx.storage.backend.get('json').kv;
    if (!kv) throw new Error('JSON backend has no KV facet');
    const open = kv.open.bind(kv);
    let unit!: KvUnit;
    const opening = vi.spyOn(kv, 'open').mockImplementationOnce(async (descriptor) => {
      unit = await open(descriptor);
      return unit;
    });
    const stores = await openBotStores(ctx);
    opening.mockRestore();
    const bot = await stores.bots.create({ id: 'alpha', name: 'Alpha' });
    await stores.memories.add({ botId: 'alpha', content: 'First' });
    await stores.memories.add({ botId: 'alpha', content: 'Second' });
    const ioError = Object.assign(new Error('Injected backend write failure'), { code: 'EIO' });
    const put = vi.spyOn(unit, 'putRecord').mockRejectedValueOnce(ioError);
    try {
      const error = await expectCode(() => stores.bots.update('alpha', { name: 'Lost' }), 'store/unavailable');
      expect(error.cause).toBe(ioError);
      expect(stores.bots.get('alpha')).toStrictEqual(bot);
    } finally { put.mockRestore(); }
    const deleteRecord = unit.deleteRecord.bind(unit);
    const deletion = vi.spyOn(unit, 'deleteRecord')
      .mockImplementationOnce(deleteRecord).mockRejectedValueOnce(ioError);
    try {
      const error = await expectCode(() => stores.bots.remove('alpha'), 'store/unavailable');
      expect(error.cause).toBe(ioError);
      expect(stores.bots.get('alpha')).toStrictEqual(bot);
      expect(stores.memories.listByBot('alpha', { limit: 10 })).toHaveLength(1);
    } finally { deletion.mockRestore(); }
    await stores.bots.remove('alpha');
    await stores.bots.create({ id: 'alpha', name: 'Clean retry' });
    expect(stores.memories.listByBot('alpha', { limit: 10 })).toEqual([]);
    await stores.close();
    const readError = Object.assign(new Error('Injected backend read failure'), { code: 'EIO' });
    const loading = vi.spyOn(kv, 'open').mockImplementationOnce(async (descriptor) => {
      const next = await open(descriptor);
      vi.spyOn(next, 'loadAll').mockRejectedValueOnce(readError);
      return next;
    });
    try {
      const error = await expectCode(() => openBotStores(ctx), 'store/unavailable');
      expect(error.cause).toBe(readError);
    } finally { loading.mockRestore(); }
    const reopened = await openBotStores(ctx);
    expect(reopened.bots.get('alpha').name).toBe('Clean retry');
  }));

  it('persists before returning and reads the same records after close/reopen', async () => withStores(async ({ ctx, root, bots, memories, close }) => {
    const bot = await bots.create({ id: 'alpha', name: 'Persisted Bot' });
    const memory = await memories.add({ botId: 'alpha', content: 'Persisted memory', tags: ['durable'] });
    const disk = JSON.parse(await readFile(join(root, 'dsh_bot.json'), 'utf8'));
    expect(JSON.stringify(disk)).toContain('Persisted Bot');
    expect(JSON.stringify(disk)).toContain('Persisted memory');
    await close();
    const reopened = await openOwned(ctx);
    expect(reopened.bots.get('alpha')).toEqual(bot);
    expect(reopened.memories.listByBot('alpha', { limit: 10 })).toEqual([memory]);
    await reopened.memories.remove('alpha', memory.id);
    await reopened.bots.remove('alpha');
    expect(await readFile(join(root, 'dsh_bot.json'), 'utf8')).not.toContain('Persisted memory');
    await reopened.close();
    const empty = await openOwned(ctx);
    expect(empty.bots.list()).toEqual([]);
    expect(empty.memories.listByBot('alpha', { limit: 10 })).toEqual([]);
  }));

  it('maps duplicate opens and releases the domain when the consumer unloads', async () => withFacility(async (ctx) => {
    let stores: Awaited<ReturnType<typeof openBotStores>> | undefined;
    const consumer = ctx.plugin({
      inject: ['storageDomain'],
      async apply(owner: Context) { stores = await openBotStores(owner); },
    });
    await consumer.await();
    if (!stores) throw new Error('Store consumer did not activate');
    await stores.bots.create({ id: 'alpha', name: 'Owned' });
    const duplicate = await expectCode(() => openBotStores(ctx), 'store/unavailable');
    expect(duplicate.cause).toMatchObject({ code: 'already-open' });
    await consumer.dispose();
    const closed = await expectCode(() => stores?.bots.list(), 'store/unavailable');
    expect(closed.cause).toMatchObject({ code: 'closed' });
    const reopened = await openBotStores(ctx);
    expect(reopened.bots.get('alpha').name).toBe('Owned');
    await reopened.close();
    await reopened.close();
    const again = await openBotStores(ctx);
    expect(again.bots.get('alpha').name).toBe('Owned');
  }));

  it('makes concurrent close calls await pending writes before allowing reopen', async () => withFacility(async (ctx) => {
    const stores = await openBotStores(ctx);
    const writes = Promise.all([
      stores.bots.create({ id: 'alpha', name: 'Pending creation' }),
      stores.bots.update('alpha', { description: 'Pending update' }),
    ]);
    const firstClose = stores.close();
    const secondClose = stores.close();
    await secondClose;
    const reopened = await openBotStores(ctx);
    await Promise.all([firstClose, writes]);
    expect(reopened.bots.get('alpha')).toMatchObject({ name: 'Pending creation', description: 'Pending update' });
    const closed = await expectCode(() => stores.bots.create({ id: 'late', name: 'Too late' }), 'store/unavailable');
    expect(closed.cause).toMatchObject({ code: 'closed' });
  }));

  it('reports invalid persisted records through the same error boundary', async () => withStores(async ({ ctx, bots, domain, close }) => {
    const valid = await bots.create({ id: 'alpha', name: 'Alpha' });
    // Simulates an older writer: the upstream put API does not validate records.
    await domain.table('bots').put('alpha', { ...valid, name: 42 } as never);
    await close();
    const invalid = await expectCode(() => openBotStores(ctx), 'store/unavailable');
    expect(invalid.cause).toMatchObject({ code: 'invalid-record' });
  }));
});
