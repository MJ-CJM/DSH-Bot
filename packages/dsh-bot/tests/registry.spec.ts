import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import Storage from '@deepseek-ai/dsh-storage';
import type { KvUnit } from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import { describe, expect, it, vi } from 'vitest';
// Like bundle.spec, run against the current build produced by pnpm check.
// This also exercises TypeScript's lowering of the standard Remote decorators.
import { Config, DshBotRegistry } from '../lib/host/registry.js';
import { type botDomain, MemoryStore, openBotStores } from '../lib/host/store.js';

const isolatedHome = fileURLToPath(new URL('../../../.dsh-dev/', import.meta.url));

/** The double deliberately implements duplicate-id and broken-roster semantics. */
class PresetDouble extends Service {
  readonly calls: string[] = [];
  readonly current = new Map<string, PresetDefinition>();
  readonly brokenNames = new Set<string>();
  readonly throwNames = new Set<string>();
  beforeRegister?: (definition: PresetDefinition) => Promise<void>;
  beforeUnregister?: (definition: PresetDefinition) => Promise<void>;

  constructor(ctx: Context) { super(ctx, 'agentPresets'); }

  async readDocument(agentPreset: string) {
    return { agentPreset, content: '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n- id: skill-filesystem\n  name: "@deepseek-ai/dsh-skill-filesystem"\n' };
  }

  async register(definition: PresetDefinition): Promise<() => Promise<void>> {
    this.calls.push(`register:${definition.id}:${definition.name}`);
    if (this.current.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
    await this.beforeRegister?.(definition);
    if (this.throwNames.has(definition.name ?? '')) throw new Error(`Registration rejected: ${definition.name}`);
    this.current.set(definition.id, structuredClone(definition));
    let disposed = false;
    return async () => {
      if (disposed) return;
      this.calls.push(`unregister:${definition.id}:${definition.name}`);
      await this.beforeUnregister?.(definition);
      disposed = true;
      this.current.delete(definition.id);
    };
  }

  async list() {
    return [...this.current.values()].map(({ id, name, description }) => ({
      id, name, description, isDefault: false,
      ...(this.brokenNames.has(name ?? '') ? { broken: `Activation rejected: ${name}` } : {}),
    }));
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function facility() {
  await mkdir(isolatedHome, { recursive: true });
  const root = await mkdtemp(join(isolatedHome, 't04-registry-'));
  const ctx = new Context();
  try {
    await ctx.plugin(Storage).await();
    await ctx.plugin(storageJson, { root }).await();
    await ctx.plugin(storageDomain, { backend: 'json' }).await();
    await ctx.plugin(PresetDouble).await();
    const presets = ctx.agentPresets as unknown as PresetDouble;
    const kv = ctx.storage.backend.get('json').kv;
    if (!kv) throw new Error('JSON backend has no KV facet');
    const units = new Map<string, KvUnit>();
    const open = kv.open.bind(kv);
    const opening = vi.spyOn(kv, 'open').mockImplementation(async (descriptor) => {
      const unit = await open(descriptor);
      units.set(descriptor.name, unit);
      return unit;
    });
    const start = async (options: Partial<Config> = {}) => {
      const previousHome = process.env.DSH_HOME;
      process.env.DSH_HOME = root;
      const fork = ctx.plugin(DshBotRegistry, {
        seedExamples: false, presetIdPrefix: 'bot-', presetOrder: 50, dataDir: join(root, 'data'), ...options,
      });
      try { await fork.await(); }
      finally {
        if (previousHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previousHome;
      }
      const registry = ctx.dshBots;
      await registry.list();
      return { registry, stop: () => fork.dispose() };
    };
    return {
      ctx, root, presets, start,
      unit: () => {
        const unit = units.get('dsh_bot');
        if (!unit) throw new Error('Bot domain has not been opened');
        return unit;
      },
      memories: () => {
        const domain = ctx.storageDomain.get('dsh_bot');
        if (!domain) throw new Error('Bot domain has not been opened');
        return new MemoryStore(domain as unknown as Domain<typeof botDomain>);
      },
      close: async () => {
        opening.mockRestore();
        try { await ctx.fiber.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    try { await ctx.fiber.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof facility>>;
async function withFacility(run: (fixture: Fixture) => Promise<void>) {
  const fixture = await facility();
  try { await run(fixture); } finally { await fixture.close(); }
}

describe('DshBotRegistry with JSON storage and a preset service double', () => {
  it('ensures a private home under the public DSH home, separately from configured skill data', async () => withFacility(async ({ start, root }) => {
    const { registry, stop } = await start();
    await registry.create({ id: 'alpha', name: 'Alpha', defaultCwd: root });
    const expected = join(root, 'dsh-bot', 'bots', 'alpha', 'home');
    await expect(stat(expected)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await registry.ensureHome('alpha')).toEqual({ path: expected });
    expect(await registry.ensureHome('alpha')).toEqual({ path: expected });
    expect((await stat(expected)).mode & 0o777).toBe(0o700);
    await expect(registry.ensureHome('missing')).rejects.toMatchObject({ code: 'bot/not-found' });
    await expect(registry.ensureHome('../escape')).rejects.toMatchObject({ code: 'bot/invalid' });
    await stop();
    const restarted = await start();
    expect(await restarted.registry.ensureHome('alpha')).toEqual({ path: expected });
  }));

  it('validates supplied default directories before changing storage or presets', async () => withFacility(async ({ start, root, presets }) => {
    const { registry } = await start();
    const file = join(root, 'plain-file');
    await writeFile(file, 'Not a directory');
    const original = await registry.create({ id: 'alpha', name: 'Alpha', defaultCwd: root });
    const calls = [...presets.calls];
    for (const defaultCwd of ['./relative', '', join(root, 'missing'), file]) {
      await expect(registry.create({ id: 'beta', name: 'Beta', defaultCwd })).rejects.toMatchObject({ code: 'bot/invalid' });
      await expect(registry.update('alpha', { defaultCwd })).rejects.toMatchObject({ code: 'bot/invalid' });
    }
    expect(presets.calls).toEqual(calls);
    expect(await registry.get('alpha')).toEqual(original);
    expect(await registry.update('alpha', { defaultCwd: null })).not.toHaveProperty('defaultCwd');
  }));

  it('preserves homes by default and deletes only explicitly requested owned homes, never defaultCwd', async () => withFacility(async ({ start, root }) => {
    const { registry } = await start();
    const user = join(root, 'chosen-directory');
    await mkdir(user); await writeFile(join(user, 'keep.txt'), 'User data');
    await registry.create({ id: 'alpha', name: 'Alpha', defaultCwd: user });
    const home = (await registry.ensureHome('alpha')).path;
    await writeFile(join(home, 'keep.txt'), 'Private data');
    await registry.remove('alpha');
    expect(await readFile(join(home, 'keep.txt'), 'utf8')).toBe('Private data');
    await registry.create({ id: 'alpha', name: 'Recreated', defaultCwd: user });
    expect(await registry.ensureHome('alpha')).toEqual({ path: home });
    await registry.remove('alpha', { deleteHome: true, deleteMemories: false });
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(user, 'keep.txt'), 'utf8')).toBe('User data');
  }));

  it('rejects unsafe home cleanup before Bot deletion, while default deletion never touches an unowned home', async () => withFacility(async ({ start, root }) => {
    const { registry } = await start();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const home = join(root, 'dsh-bot', 'bots', 'alpha', 'home');
    await mkdir(join(home, '..'), { recursive: true });
    const outside = join(root, 'user-directory');
    await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'User data');
    await symlink(outside, home, 'dir');
    await expect(registry.remove('alpha', { deleteHome: true })).rejects.toMatchObject({ code: 'bot/invalid' });
    expect((await registry.get('alpha')).name).toBe('Alpha');
    await registry.remove('alpha');
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('User data');
    expect((await stat(home)).isDirectory()).toBe(true);
  }));

  it('keeps home data and restores the preset if record deletion fails', async () => withFacility(async ({ start, unit }) => {
    const { registry } = await start();
    const original = await registry.create({ id: 'alpha', name: 'Alpha' });
    const home = (await registry.ensureHome('alpha')).path;
    await writeFile(join(home, 'keep.txt'), 'Preserved');
    const deletion = vi.spyOn(unit(), 'deleteRecord').mockRejectedValueOnce(new Error('Injected deletion failure'));
    try { await expect(registry.remove('alpha', { deleteHome: true })).rejects.toMatchObject({ code: 'store/unavailable' }); }
    finally { deletion.mockRestore(); }
    expect(await registry.get('alpha')).toEqual(original);
    expect(await readFile(join(home, 'keep.txt'), 'utf8')).toBe('Preserved');
  }));

  it('reports committed deletion separately if home ownership changes before cleanup', async () => withFacility(async ({ start, unit }) => {
    const { registry } = await start();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const home = (await registry.ensureHome('alpha')).path;
    const originalDelete = unit().deleteRecord.bind(unit());
    const deletion = vi.spyOn(unit(), 'deleteRecord').mockImplementationOnce(async (...args) => {
      const result = await originalDelete(...args);
      await rename(home, `${home}-saved`);
      await mkdir(home);
      await writeFile(join(home, 'user.txt'), 'Not our inode');
      return result;
    });
    try {
      await expect(registry.remove('alpha', { deleteHome: true })).rejects.toMatchObject({
        code: 'bot/home-cleanup-failed', message: expect.stringContaining('Bot was deleted'),
      });
    } finally { deletion.mockRestore(); }
    await expect(registry.get('alpha')).rejects.toMatchObject({ code: 'bot/not-found' });
    expect(await readFile(join(home, 'user.txt'), 'utf8')).toBe('Not our inode');
  }));

  it('streams opening and coalesced catalog/activity invalidations, and drains cancelled/Host-disposed watchers', async () => withFacility(async ({ start }) => {
    const { registry, stop } = await start();
    const abort = new AbortController();
    const iterator = registry.watch(abort.signal)[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { revision: 0 } });
    await registry.create({ id: 'alpha', name: 'Alpha' });
    await registry.update('alpha', { name: 'Updated' });
    // Slow readers get the latest invalidation instead of an unbounded queue.
    expect(await iterator.next()).toEqual({ done: false, value: { revision: 2 } });
    const input = { sessionId: 'session-1', botId: 'alpha', role: 'assistant' as const, text: 'Reply', at: 100, seq: 1 };
    await registry.recordActivity(input);
    expect(await iterator.next()).toEqual({ done: false, value: { revision: 3 } });
    await registry.recordActivity(input); // replay does not invalidate
    await registry.markActivityRead('session-1');
    expect(await iterator.next()).toEqual({ done: false, value: { revision: 4 } });
    const pending = iterator.next();
    abort.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    const stopped = new AbortController(); stopped.abort();
    expect(await registry.watch(stopped.signal)[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
    const next = registry.watch(new AbortController().signal)[Symbol.asyncIterator]();
    expect(await next.next()).toEqual({ done: false, value: { revision: 4 } });
    const waiting = next.next();
    await stop();
    expect(await waiting).toEqual({ done: true, value: undefined });
  }));

  it('validates configurable activity retention limits', () => {
    expect(Config({})).toMatchObject({ activityMaxSessionsPerBot: 50, activityMaxSessionsTotal: 1000 });
    for (const field of ['activityMaxSessionsPerBot', 'activityMaxSessionsTotal']) {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => Config({ [field]: value })).toThrow();
      }
      expect(Config({ [field]: 2 })).toHaveProperty(field, 2);
    }
  });

  it('keeps the preset creation identity equal to storage across delayed activation', async () => withFacility(async ({ start, presets }) => {
    const { registry } = await start();
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);
    let generationCreatedAt = 0;
    presets.beforeRegister = async () => {
      generationCreatedAt = registry.presetBot('alpha').createdAt;
      now.mockReturnValue(200);
    };
    try {
      const bot = await registry.create({ id: 'alpha', name: 'Alpha' });
      expect(bot.createdAt).toBe(generationCreatedAt);
      await registry.recordActivity({ sessionId: 'session-1', botId: 'alpha', role: 'assistant',
        text: 'Completed', at: 200, seq: 1, expectedBotCreatedAt: generationCreatedAt });
      expect((await registry.listActivity()).sessions[0]).toMatchObject({ unread: true, lastMessage: { preview: 'Completed' } });
    } finally { now.mockRestore(); }
  }));

  it('rejects old Agent activity after same-id recreation when the clock does not advance', async () => withFacility(async ({ start }) => {
    const { registry } = await start();
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);
    try {
      const old = await registry.create({ id: 'alpha', name: 'Old' });
      await registry.remove('alpha');
      now.mockReturnValue(50);
      const current = await registry.create({ id: 'alpha', name: 'New' });
      expect(current.createdAt).toBeGreaterThan(old.createdAt);
      await registry.recordActivity({ sessionId: 'old-session', botId: 'alpha', role: 'assistant', text: 'Late',
        at: 100, seq: 1, expectedBotCreatedAt: old.createdAt });
      expect((await registry.listActivity()).sessions).toEqual([]);
      await registry.recordActivity({ sessionId: 'new-session', botId: 'alpha', role: 'assistant', text: 'Current',
        at: 100, seq: 1, expectedBotCreatedAt: current.createdAt });
      expect((await registry.listActivity()).sessions).toHaveLength(1);
    } finally { now.mockRestore(); }
  }));
  it('exposes the configured prefix even with zero Bots and reports isolated legacy avatar warnings', async () => withFacility(async ({ start, unit }) => {
    const first = await start({ presetIdPrefix: 'custom-review-' });
    expect(await first.registry.catalogInfo()).toEqual({ presetIdPrefix: 'custom-review-' });
    const legacy = await first.registry.create({ id: 'legacy', name: 'Legacy' });
    await first.registry.create({ id: 'healthy', name: 'Healthy' });
    await unit().putRecord('bots', 'legacy', { ...legacy, avatar: 'data:image/svg+xml;base64,PHN2Zz4=' });
    await first.stop();
    const second = await start({ presetIdPrefix: 'custom-review-' });
    expect(await second.registry.list()).toHaveLength(2);
    expect(await second.registry.get('legacy')).not.toHaveProperty('avatar');
    expect(await second.registry.status()).toContainEqual({ id: 'legacy', presetId: 'custom-review-legacy', warnings: ['avatar/invalid'], preset: { state: 'ok' } });
    await second.registry.update('legacy', { avatar: null });
    expect((await second.registry.status()).find((row) => row.id === 'legacy')).not.toHaveProperty('warnings');
    await second.registry.remove('legacy');
    await second.registry.remove('healthy');
    expect(await second.registry.catalogInfo()).toEqual({ presetIdPrefix: 'custom-review-' });
  }));

  it('creates separate skill directories, preserves user files and exposes detached activation snapshots', async () => withFacility(async ({ root, start, presets }) => {
    const { registry } = await start();
    const captured: Array<{ id: string; deny: string[] }> = [];
    presets.beforeRegister = async (definition) => {
      const bot = registry.presetBot(definition.id.slice('bot-'.length));
      captured.push({ id: bot.id, deny: [...bot.tools.deny] });
      bot.tools.deny.push('must-not-leak');
    };
    await registry.create({ id: 'alpha', name: 'Alpha', tools: { deny: ['read'] } });
    const skills = join(root, 'data/bots/alpha/skills');
    expect((await stat(skills)).isDirectory()).toBe(true);
    await writeFile(join(skills, 'keep.md'), 'user skill');
    await registry.duplicate('alpha', 'beta');
    expect((await stat(join(root, 'data/bots/beta/skills'))).isDirectory()).toBe(true);
    await expect(readFile(join(root, 'data/bots/beta/skills/keep.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    presets.brokenNames.add('Rejected');
    await expect(registry.update('alpha', { name: 'Rejected', tools: { deny: ['write'] } }))
      .rejects.toMatchObject({ code: 'bot/preset-failed' });
    expect(captured).toEqual([
      { id: 'alpha', deny: ['read'] }, { id: 'beta', deny: ['read'] },
      { id: 'alpha', deny: ['write'] }, { id: 'alpha', deny: ['read'] },
    ]);
    expect(registry.presetBot('alpha').tools.deny).toEqual(['read']);
    await registry.remove('alpha');
    expect(await readFile(join(skills, 'keep.md'), 'utf8')).toBe('user skill');
    expect(() => registry.presetBot('alpha')).toThrow();
  }));

  it('keeps the current preset and record if template preparation or skill directory creation fails', async () => withFacility(async ({ root, start, presets }) => {
    const { registry } = await start();
    const original = await registry.create({ id: 'alpha', name: 'Alpha' });
    const calls = [...presets.calls];
    const templateRead = vi.spyOn(presets, 'readDocument').mockRejectedValueOnce(new Error('template unavailable'));
    await expect(registry.update('alpha', { name: 'Changed' })).rejects.toMatchObject({ code: 'bot/preset-failed' });
    templateRead.mockRestore();
    expect(presets.calls).toEqual(calls);
    expect(await registry.get('alpha')).toEqual(original);
    await writeFile(join(root, 'data/bots/blocked'), 'not a directory');
    await expect(registry.create({ id: 'blocked', name: 'Blocked' })).rejects.toMatchObject({
      code: 'bot/preset-failed', cause: expect.any(Error),
    });
    expect(presets.calls).toEqual(calls);
    expect(await registry.list()).toEqual([original]);
  }));

  it('reports template read failures as broken with reasons on startup and later queries', async () => withFacility(async ({ ctx, start, presets }) => {
    const stores = await openBotStores(ctx);
    await stores.bots.create({ id: 'alpha', name: 'Alpha' });
    await stores.close();
    const read = vi.spyOn(presets, 'readDocument').mockRejectedValue(new Error('standard template missing'));
    const { registry } = await start();
    expect(await registry.status()).toEqual([{ id: 'alpha', presetId: 'bot-alpha', preset: {
      state: 'broken', reason: expect.stringContaining('standard template missing'),
    } }]);
    read.mockRestore();
    await registry.update('alpha', { name: 'Repaired' });
    expect((await registry.status())[0]?.preset.state).toBe('ok');
    const calls = [...presets.calls];
    const lost = vi.spyOn(presets, 'readDocument').mockRejectedValue(new Error('readDocument unavailable'));
    expect((await registry.status())[0]?.preset).toEqual({ state: 'broken', reason: expect.stringContaining('readDocument unavailable') });
    expect(presets.calls).toEqual(calls);
    lost.mockRestore();
    expect((await registry.status())[0]?.preset.state).toBe('ok');
  }));

  it('exports validated default configuration', () => {
    expect(Config(undefined)).toMatchObject({ seedExamples: true, presetIdPrefix: 'bot-', presetOrder: 50,
      maxInjectChars: 4000, memorySectionOrder: 100, memoryListLimit: 20 });
    expect(Config({ maxInjectChars: 0, memorySectionOrder: 500, memoryListLimit: 200 })).toMatchObject({
      maxInjectChars: 0, memorySectionOrder: 500, memoryListLimit: 200,
    });
    for (const input of [{ presetIdPrefix: '' }, { presetOrder: Number.NaN }, { seedExamples: 'true' },
      { maxInjectChars: -1 }, { maxInjectChars: 1.5 }, { maxInjectChars: Infinity },
      { memorySectionOrder: 0 }, { memorySectionOrder: 800 }, { memorySectionOrder: Number.NaN },
      { memoryListLimit: 0 }, { memoryListLimit: 201 }, { memoryListLimit: 1.5 }]) {
      expect(() => Config(input as never)).toThrow();
    }
  });

  it('shares the domain with Bot-bound memory access and stops retained facades after deletion', async () => withFacility(async ({ start, memories }) => {
    const { registry } = await start({ memoryListLimit: 1 });
    await registry.create({ id: 'alpha', name: 'Alpha' });
    await registry.create({ id: 'beta', name: 'Beta' });
    const alpha = registry.memoryFor('alpha');
    const beta = registry.memoryFor('beta');
    const { id } = await alpha.save({ content: 'Private preference' });
    await alpha.save({ content: 'New preference' });
    expect(await alpha.list()).toHaveLength(1);
    expect(memories().listByBot('alpha', { limit: 10 })).toHaveLength(2);
    expect(await beta.list()).toEqual([]);
    await expect(beta.forget({ id })).rejects.toMatchObject({ code: 'memory/not-found' });
    await registry.remove('alpha', { deleteMemories: false });
    await expect(alpha.list()).rejects.toMatchObject({ code: 'bot/not-found' });
    await expect(alpha.save({ content: 'Late write' })).rejects.toMatchObject({ code: 'bot/not-found' });
  }));

  it('drains accepted memory writes before Host unload and rejects later facade calls', async () => withFacility(async ({ ctx, start, unit }) => {
    const { registry, stop } = await start();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const memory = registry.memoryFor('alpha');
    const entered = deferred();
    const commit = deferred();
    const write = unit().putRecord.bind(unit());
    const writing = vi.spyOn(unit(), 'putRecord').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await commit.promise;
      await write(...args);
    });
    const saving = memory.save({ content: 'Accepted durable memory' });
    await entered.promise;
    const reading = memory.list();
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
    } finally { commit.resolve(); }
    const [{ id }, rows] = await Promise.all([saving, reading, stopping]);
    writing.mockRestore();
    expect(rows).toMatchObject([{ id, content: 'Accepted durable memory' }]);
    await expect(memory.list()).rejects.toMatchObject({ code: 'bot/unavailable' });
    const reopened = await openBotStores(ctx);
    expect(reopened.memories.listByBot('alpha', { limit: 10 })).toMatchObject([{ id }]);
    await reopened.close();
  }));

  it('registers durable Bots on startup and releases presets and the domain on unload', async () => withFacility(async ({ ctx, start, presets }) => {
    const stores = await openBotStores(ctx);
    await stores.bots.create({ id: 'alpha', name: 'Alpha', persona: { prefix: '简洁地回答问题' } });
    await stores.bots.create({ id: 'beta', name: 'Beta', order: 7 });
    await stores.close();
    const { registry, stop } = await start({ presetIdPrefix: 'custom-', presetOrder: 42 });
    expect(DshBotRegistry.inject).toEqual(['storageDomain', 'agentPresets']);
    expect(registry.typertRemote).toMatchObject({ serviceKey: 'dshBots', namespace: 'dshBot' });
    expect(presets.calls).toEqual(['register:custom-alpha:Alpha', 'register:custom-beta:Beta']);
    expect(presets.current.get('custom-alpha')).toMatchObject({ id: 'custom-alpha', order: 42 });
    expect(presets.current.get('custom-alpha')?.plugins).toContainEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-persona', config: expect.objectContaining({ prefix: '简洁地回答问题' }),
    }));
    expect(presets.current.get('custom-beta')).toMatchObject({ order: 7 });
    expect((await registry.list()).map(({ id }) => id)).toEqual(['alpha', 'beta']);
    await stop();
    expect(presets.current.size).toBe(0);
    expect(presets.calls.filter((call) => call.startsWith('unregister:')).sort()).toEqual([
      'unregister:custom-alpha:Alpha', 'unregister:custom-beta:Beta',
    ]);
    expect(ctx.storageDomain.get('dsh_bot')).toBeUndefined();
    const reopened = await openBotStores(ctx);
    expect(reopened.bots.list()).toHaveLength(2);
    await reopened.close();
  }));

  it.each(['throw', 'broken'] as const)('isolates a %s startup preset and permits repair or delete', async (failure) => withFacility(async ({ ctx, start, presets }) => {
    const stores = await openBotStores(ctx);
    const alpha = await stores.bots.create({ id: 'alpha', name: 'Alpha' });
    const beta = await stores.bots.create({ id: 'beta', name: 'Beta' });
    await stores.close();
    if (failure === 'throw') presets.throwNames.add('Alpha');
    else presets.brokenNames.add('Alpha');
    const { registry } = await start({ presetIdPrefix: 'custom-' });
    expect(await registry.list()).toStrictEqual([alpha, beta]);
    expect(presets.current.get('custom-beta')?.name).toBe('Beta');
    expect(await registry.status()).toEqual([
      { id: 'alpha', presetId: 'custom-alpha', preset: { state: failure === 'throw' ? 'missing' : 'broken', reason: expect.stringContaining('Alpha') } },
      { id: 'beta', presetId: 'custom-beta', preset: { state: 'ok' } },
    ]);
    presets.throwNames.add('Rejected');
    await expect(registry.update('alpha', { name: 'Rejected' })).rejects.toMatchObject({ code: 'bot/preset-failed' });
    // Restoring an originally broken definition must not poison healthy Bot writes.
    await registry.update('beta', { name: 'Still healthy' });
    await registry.update('alpha', { name: 'Repaired' });
    expect((await registry.status())[0]?.preset).toEqual({ state: 'ok' });
    await registry.remove('alpha');
    expect(await registry.status()).toEqual([{ id: 'beta', presetId: 'custom-beta', preset: { state: 'ok' } }]);
  }));

  it('can delete a broken startup Bot without repairing it first', async () => withFacility(async ({ ctx, start, presets }) => {
    const stores = await openBotStores(ctx);
    await stores.bots.create({ id: 'alpha', name: 'Broken' });
    await stores.close();
    presets.brokenNames.add('Broken');
    const { registry } = await start();
    await registry.remove('alpha');
    expect(await registry.status()).toEqual([]);
    expect(presets.current.size).toBe(0);
  }));

  it('returns bot/unavailable before readiness', async () => withFacility(async ({ ctx }) => {
    const gate = deferred();
    const registry = new DshBotRegistry(ctx, Config({ seedExamples: false }), () => gate.promise);
    await expect(registry.list()).rejects.toMatchObject({ code: 'bot/unavailable' });
    await expect(registry.status()).rejects.toMatchObject({ code: 'bot/unavailable' });
    gate.resolve();
    await registry.waitUntilReady();
    expect(await registry.list()).toEqual([]);
  }));

  it('keeps a typed unavailable service after storage startup fails', async () => withFacility(async ({ ctx, root }) => {
    const opening = vi.spyOn(ctx.storageDomain, 'open').mockRejectedValueOnce(new Error('Injected storage failure'));
    try {
      const fork = ctx.plugin(DshBotRegistry, Config({ seedExamples: false, dataDir: root }));
      await fork.await();
      await expect(ctx.dshBots.waitUntilReady()).rejects.toMatchObject({ code: 'bot/unavailable' });
      await expect(ctx.dshBots.list()).rejects.toThrow('Injected storage failure');
      await expect(ctx.dshBots.create({ id: 'alpha', name: 'Alpha' })).rejects.toMatchObject({ code: 'bot/unavailable' });
      await fork.dispose();
    } finally { opening.mockRestore(); }
  }));

  it('uses stable preset ids and awaits unregister before registering each updated definition', async () => withFacility(async ({ start, presets }) => {
    const { registry } = await start();
    const original = await registry.create({ id: 'alpha', name: 'Alpha' });
    const unregistration = deferred();
    const entered = deferred();
    presets.beforeUnregister = async () => { entered.resolve(); await unregistration.promise; };
    const updating = registry.update('alpha', { name: 'Renamed' });
    try {
      await entered.promise;
      expect(presets.calls).toEqual(['register:bot-alpha:Alpha', 'unregister:bot-alpha:Alpha']);
    } finally { unregistration.resolve(); }
    const updated = await updating;
    expect(updated.updatedAt).toBeGreaterThan(original.updatedAt);
    expect(presets.calls).toEqual([
      'register:bot-alpha:Alpha', 'unregister:bot-alpha:Alpha', 'register:bot-alpha:Renamed',
    ]);
    await registry.remove('alpha', { deleteMemories: true });
    expect(presets.calls.at(-1)).toBe('unregister:bot-alpha:Renamed');
    expect(await registry.list()).toEqual([]);
    expect(presets.current.size).toBe(0);
  }));

  it.each(['throw', 'broken'] as const)('rolls back a %s preset update without altering the durable record', async (failure) => withFacility(async ({ start, presets, root }) => {
    const { registry } = await start();
    const original = await registry.create({ id: 'alpha', name: 'Original', persona: { prefix: '原始人设' } });
    const before = await readFile(join(root, 'dsh_bot.json'), 'utf8');
    if (failure === 'throw') presets.throwNames.add('Rejected');
    else presets.brokenNames.add('Rejected');
    await expect(registry.update('alpha', { name: 'Rejected', persona: { prefix: '失败人设' } }))
      .rejects.toThrow(/Rejected/);
    expect(await registry.get('alpha')).toStrictEqual(original);
    expect(await readFile(join(root, 'dsh_bot.json'), 'utf8')).toBe(before);
    expect(presets.current.get('bot-alpha')?.name).toBe('Original');
    expect(presets.calls).toEqual([
      'register:bot-alpha:Original', 'unregister:bot-alpha:Original', 'register:bot-alpha:Rejected',
      ...(failure === 'broken' ? ['unregister:bot-alpha:Rejected'] : []), 'register:bot-alpha:Original',
    ]);
    await expect(registry.update('alpha', { name: 'Recovered' })).resolves.toMatchObject({ name: 'Recovered' });
  }));

  it('cleans a broken newly registered preset and leaves no Bot record', async () => withFacility(async ({ start, presets }) => {
    const { registry } = await start();
    presets.brokenNames.add('Broken');
    await expect(registry.create({ id: 'alpha', name: 'Broken' })).rejects.toThrow(/Broken/);
    expect(presets.calls).toEqual(['register:bot-alpha:Broken', 'unregister:bot-alpha:Broken']);
    expect(presets.current.size).toBe(0);
    expect(await registry.list()).toEqual([]);
    await expect(registry.create({ id: 'alpha', name: 'Retry' })).resolves.toMatchObject({ id: 'alpha' });
  }));

  it('reconciles before the next write after rollback failure, or remains unavailable on failure', async () => withFacility(async ({ ctx, start, presets }) => {
    const { registry } = await start();
    const original = await registry.create({ id: 'alpha', name: 'Original' });
    presets.throwNames.add('Rejected');
    presets.throwNames.add('Original');
    await expect(registry.update('alpha', { name: 'Rejected' })).rejects.toMatchObject({ code: 'bot/rollback-failed' });
    expect(ctx.storageDomain.get('dsh_bot')?.table('bots').get('alpha')).toStrictEqual(original);
    expect(await registry.list()).toEqual([original]);
    expect((await registry.status())[0]?.preset.state).toBe('missing');
    await expect(registry.create({ id: 'beta', name: 'Later' })).rejects.toMatchObject({ code: 'bot/unavailable' });
    expect(await registry.list()).toEqual([original]);
    presets.throwNames.clear();
    await registry.create({ id: 'beta', name: 'Later' });
    expect(presets.current.get('bot-alpha')?.name).toBe('Original');
    expect((await registry.status()).every((row) => row.preset.state === 'ok')).toBe(true);
    presets.calls.length = 0;
    await registry.update('beta', { name: 'Final' });
    expect(presets.calls).toEqual(['unregister:bot-beta:Later', 'register:bot-beta:Final']);
  }));

  it('reconciliation removes owned orphan presets but preserves foreign presets with the same prefix', async () => withFacility(async ({ start, presets }) => {
    const { registry } = await start();
    presets.brokenNames.add('Orphan');
    presets.beforeUnregister = async (definition) => { if (definition.name === 'Orphan') throw new Error('Dispose failed'); };
    await expect(registry.create({ id: 'orphan', name: 'Orphan' })).rejects.toMatchObject({ code: 'bot/rollback-failed' });
    expect(await registry.list()).toEqual([]);
    await presets.register({ id: 'bot-foreign', name: 'Foreign', plugins: [] });
    presets.beforeUnregister = undefined;
    await registry.create({ id: 'alpha', name: 'Healthy' });
    expect(presets.current.has('bot-orphan')).toBe(false);
    expect(presets.current.has('bot-foreign')).toBe(true);
    expect(presets.current.has('bot-alpha')).toBe(true);
  }));

  it('reconciliation replaces a healthy but uncommitted preset with the stored definition', async () => withFacility(async ({ start, presets, unit }) => {
    const { registry } = await start();
    const original = await registry.create({ id: 'alpha', name: 'Original' });
    const writing = vi.spyOn(unit(), 'putRecord').mockRejectedValueOnce(new Error('Write failed'));
    presets.beforeUnregister = async (definition) => {
      if (definition.name === 'Uncommitted') throw new Error('Dispose failed');
    };
    try {
      await expect(registry.update('alpha', { name: 'Uncommitted' })).rejects.toMatchObject({ code: 'bot/rollback-failed' });
    } finally { writing.mockRestore(); }
    expect(await registry.get('alpha')).toStrictEqual(original);
    expect(await registry.status()).toEqual([{ id: 'alpha', presetId: 'bot-alpha', preset: {
      state: 'broken', reason: 'Preset differs from the stored Bot',
    } }]);
    presets.beforeUnregister = undefined;
    presets.calls.length = 0;
    await registry.create({ id: 'beta', name: 'Healthy' });
    expect(presets.calls).toEqual([
      'unregister:bot-alpha:Uncommitted', 'register:bot-alpha:Original', 'register:bot-beta:Healthy',
    ]);
    expect((await registry.status()).every((row) => row.preset.state === 'ok')).toBe(true);
  }));

  it('restores the previous preset when a create or update cannot commit to storage', async () => withFacility(async ({ start, presets, unit }) => {
    const { registry } = await start();
    const ioError = Object.assign(new Error('Injected persistence failure'), { code: 'EIO' });
    const creating = vi.spyOn(unit(), 'putRecord').mockRejectedValueOnce(ioError);
    try { await expect(registry.create({ id: 'alpha', name: 'Uncommitted' })).rejects.toMatchObject({ code: 'store/unavailable' }); }
    finally { creating.mockRestore(); }
    expect(await registry.list()).toEqual([]);
    expect(presets.calls).toEqual(['register:bot-alpha:Uncommitted', 'unregister:bot-alpha:Uncommitted']);
    const original = await registry.create({ id: 'alpha', name: 'Original' });
    presets.calls.length = 0;
    const updating = vi.spyOn(unit(), 'putRecord').mockRejectedValueOnce(ioError);
    try { await expect(registry.update('alpha', { name: 'Uncommitted' })).rejects.toMatchObject({ code: 'store/unavailable' }); }
    finally { updating.mockRestore(); }
    expect(await registry.get('alpha')).toStrictEqual(original);
    expect(presets.current.get('bot-alpha')?.name).toBe('Original');
    expect(presets.calls).toEqual([
      'unregister:bot-alpha:Original', 'register:bot-alpha:Uncommitted',
      'unregister:bot-alpha:Uncommitted', 'register:bot-alpha:Original',
    ]);
  }));

  it('restores a removed preset if deleting the Bot record fails, then permits retry', async () => withFacility(async ({ start, presets, unit }) => {
    const { registry } = await start();
    const original = await registry.create({ id: 'alpha', name: 'Original' });
    const deletion = vi.spyOn(unit(), 'deleteRecord').mockRejectedValueOnce(new Error('Injected deletion failure'));
    try { await expect(registry.remove('alpha')).rejects.toMatchObject({ code: 'store/unavailable' }); }
    finally { deletion.mockRestore(); }
    expect(await registry.get('alpha')).toStrictEqual(original);
    expect(presets.current.get('bot-alpha')?.name).toBe('Original');
    expect(presets.calls).toEqual([
      'register:bot-alpha:Original', 'unregister:bot-alpha:Original', 'register:bot-alpha:Original',
    ]);
    await registry.remove('alpha');
    expect(await registry.list()).toEqual([]);
    expect(presets.current.size).toBe(0);
  }));

  it('serializes simultaneous mutations and applies the second patch to the committed first result', async () => withFacility(async ({ start, presets }) => {
    const { registry } = await start();
    await registry.create({ id: 'alpha', name: 'Original' });
    const registration = deferred();
    const entered = deferred();
    presets.beforeRegister = async (definition) => {
      if (definition.name === 'First' && definition.description === '') {
        entered.resolve();
        await registration.promise;
      }
    };
    const first = registry.update('alpha', { name: 'First' });
    const second = registry.update('alpha', { description: 'Second patch' });
    try {
      await entered.promise;
      expect(presets.calls).toEqual([
        'register:bot-alpha:Original', 'unregister:bot-alpha:Original', 'register:bot-alpha:First',
      ]);
    } finally { registration.resolve(); }
    const [one, two] = await Promise.all([first, second]);
    expect(two).toMatchObject({ name: 'First', description: 'Second patch' });
    expect(two.updatedAt).toBeGreaterThan(one.updatedAt);
    expect(await registry.get('alpha')).toStrictEqual(two);
    expect(presets.current.get('bot-alpha')).toMatchObject({ name: 'First', description: 'Second patch' });
    expect(presets.calls).toEqual([
      'register:bot-alpha:Original', 'unregister:bot-alpha:Original', 'register:bot-alpha:First',
      'unregister:bot-alpha:First', 'register:bot-alpha:First',
    ]);
  }));

  it('drains an in-flight write and its queued update on unload before releasing presets and storage', async () => withFacility(async ({ ctx, start, presets, unit }) => {
    const { registry, stop } = await start();
    const commit = deferred();
    const entered = deferred();
    const write = unit().putRecord.bind(unit());
    const writing = vi.spyOn(unit(), 'putRecord').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await commit.promise;
      await write(...args);
    });
    const creating = registry.create({ id: 'alpha', name: 'Pending' });
    await entered.promise;
    const updating = registry.update('alpha', { description: 'Accepted before unloading' });
    // enqueue() first awaits ready; let this accepted call join the queue.
    await Promise.resolve();
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(presets.current.has('bot-alpha')).toBe(true);
    } finally { commit.resolve(); }
    await Promise.all([creating, updating, stopping]);
    writing.mockRestore();
    expect(presets.current.size).toBe(0);
    expect(ctx.storageDomain.get('dsh_bot')).toBeUndefined();
    await expect(registry.create({ id: 'late', name: 'Late' })).rejects.toMatchObject({ code: 'bot/unavailable' });
    const reopened = await openBotStores(ctx);
    expect(reopened.bots.get('alpha')).toMatchObject({ name: 'Pending', description: 'Accepted before unloading' });
    await reopened.close();
  }));

  it('emits Host invalidations only after successful persistence and never for a rolled-back change', async () => withFacility(async ({ ctx, start, presets, unit }) => {
    const { registry } = await start();
    const events: unknown[] = [];
    const snapshots: unknown[] = [];
    ctx.effect(() => ctx.on('dsh-bot/changed', (event) => {
      events.push(event);
      snapshots.push(ctx.storageDomain.get('dsh_bot')?.table('bots').get('alpha'));
    }));
    const commit = deferred();
    const entered = deferred();
    const write = unit().putRecord.bind(unit());
    const writing = vi.spyOn(unit(), 'putRecord').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await commit.promise;
      await write(...args);
    });
    const creating = registry.create({ id: 'alpha', name: 'Original' });
    try {
      await entered.promise;
      expect(events).toEqual([]);
    } finally { commit.resolve(); }
    const created = await creating;
    writing.mockRestore();
    expect(events).toHaveLength(1);
    expect(snapshots[0]).toStrictEqual(created);
    presets.throwNames.add('Rejected');
    await expect(registry.update('alpha', { name: 'Rejected' })).rejects.toThrow(/Rejected/);
    expect(events).toHaveLength(1);
    const updated = await registry.update('alpha', { name: 'Committed' });
    expect(events).toHaveLength(2);
    expect(snapshots[1]).toStrictEqual(updated);
    await registry.remove('alpha');
    expect(events).toHaveLength(3);
    expect(snapshots[2]).toBeUndefined();
  }));

  it('allows changed listeners to refetch and keeps listener failures outside the committed mutation', async () => withFacility(async ({ ctx, start }) => {
    const { registry } = await start();
    const snapshots: unknown[] = [];
    ctx.effect(() => ctx.on('dsh-bot/changed', async () => {
      snapshots.push(await registry.list());
      throw new Error('Injected listener failure');
    }));
    const created = await registry.create({ id: 'alpha', name: 'Committed' });
    await vi.waitFor(() => expect(snapshots).toEqual([[created]]));
    expect(await registry.get('alpha')).toStrictEqual(created);
    const updated = await registry.update('alpha', { description: 'Still writable' });
    await vi.waitFor(() => expect(snapshots.at(-1)).toEqual([updated]));
  }));

  it('duplicates editable fields under a new identity without sharing nested data or copying memories', async () => withFacility(async ({ start, memories, presets }) => {
    const { registry } = await start();
    const original = await registry.create({ id: 'alpha', name: 'Original', avatarColor: '--dsw-alias-state-success-primary', persona: { prefix: '原始人设' },
      tools: { deny: ['shell'] }, memory: { enabled: true, injectLimit: 5 }, template: 'minimal' });
    await memories().add({ botId: 'alpha', content: 'Original private memory' });
    const copied = await registry.duplicate('alpha', 'beta');
    expect(copied).toMatchObject({ id: 'beta', persona: original.persona, template: original.template,
      tools: original.tools, memory: original.memory, avatarColor: original.avatarColor });
    copied.tools.deny.push('caller mutation');
    expect((await registry.get('beta')).tools.deny).toEqual(['shell']);
    expect(await registry.get('alpha')).toStrictEqual(original);
    expect(memories().listByBot('beta', { limit: 10 })).toEqual([]);
    expect(presets.current.has('bot-alpha')).toBe(true);
    expect(presets.current.has('bot-beta')).toBe(true);
    await expect(registry.duplicate('alpha', 'beta')).rejects.toMatchObject({ code: 'bot/conflict' });
  }));

  it('clears optional fields with JSON null and registers the configured order fallback', async () => withFacility(async ({ start, presets, root }) => {
    const { registry, stop } = await start({ presetOrder: 67 });
    await registry.create({ id: 'alpha', name: 'Alpha', avatar: '🤖', defaultCwd: root, order: 8,
      model: { provider: 'local', model: 'test', reasoningEffort: 'off' } });
    expect(presets.current.get('bot-alpha')?.order).toBe(8);
    const cleared = await registry.update('alpha', { avatar: null, model: null, defaultCwd: null, order: null });
    expect(cleared.name).toBe('Alpha');
    const read = await registry.get('alpha');
    for (const field of ['avatar', 'model', 'defaultCwd', 'order']) {
      expect(Object.hasOwn(cleared, field)).toBe(false);
      expect(Object.hasOwn(read, field)).toBe(false);
    }
    expect(presets.current.get('bot-alpha')?.order).toBe(67);
    const calls = [...presets.calls];
    await expect(registry.update('alpha', { name: null } as never)).rejects.toMatchObject({ code: 'bot/invalid' });
    expect(presets.calls).toEqual(calls);
    expect(await registry.get('alpha')).toStrictEqual(cleared);
    await stop();
    const reopened = await start({ presetOrder: 67 });
    expect(await reopened.registry.get('alpha')).toStrictEqual(cleared);
    expect(presets.current.get('bot-alpha')?.order).toBe(67);
  }));

  it('honors deleteMemories while preserving other Bots and explicitly retained memories', async () => withFacility(async ({ start, memories }) => {
    const { registry } = await start();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    await registry.create({ id: 'beta', name: 'Beta' });
    const retained = await memories().add({ botId: 'alpha', content: 'Keep explicitly' });
    const other = await memories().add({ botId: 'beta', content: 'Other Bot' });
    await registry.remove('alpha', { deleteMemories: false });
    expect(memories().listByBot('alpha', { limit: 10 })).toEqual([retained]);
    expect(memories().listByBot('beta', { limit: 10 })).toEqual([other]);
    await registry.remove('beta', { deleteMemories: true });
    expect(memories().listByBot('beta', { limit: 10 })).toEqual([]);
    expect(memories().listByBot('alpha', { limit: 10 })).toEqual([retained]);
  }));

  it('seeds the two Chinese examples only once, including after users delete both and restart', async () => withFacility(async ({ start, presets }) => {
    const first = await start({ seedExamples: true });
    expect(await first.registry.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'assistant', name: '通用助手', persona: { prefix: expect.stringMatching(/\p{Script=Han}/u) } }),
      expect.objectContaining({ id: 'researcher', name: '研究员', persona: { prefix: expect.stringMatching(/\p{Script=Han}/u) } }),
    ]));
    expect(presets.current.size).toBe(2);
    const original = await first.registry.list();
    await first.stop();
    const second = await start({ seedExamples: true });
    expect(await second.registry.list()).toStrictEqual(original);
    await second.registry.remove('assistant');
    await second.registry.remove('researcher');
    await second.stop();
    const third = await start({ seedExamples: true });
    expect(await third.registry.list()).toEqual([]);
    expect(presets.current.size).toBe(0);
  }));

  it('does not seed when disabled or when existing records already occupy storage', async () => withFacility(async ({ start }) => {
    const disabled = await start({ seedExamples: false });
    expect(await disabled.registry.list()).toEqual([]);
    const existing = await disabled.registry.create({ id: 'existing', name: 'Existing' });
    await disabled.stop();
    const enabled = await start({ seedExamples: true });
    expect(await enabled.registry.list()).toStrictEqual([existing]);
  }));

  it('resumes an interrupted initial seed without overwriting the first durable example', async () => withFacility(async ({ ctx, start, unit }) => {
    const stores = await openBotStores(ctx);
    const write = unit().putRecord.bind(unit());
    const writing = vi.spyOn(unit(), 'putRecord').mockImplementationOnce(write).mockImplementationOnce(write)
      .mockRejectedValueOnce(new Error('Interrupted seed write'));
    try {
      await expect(stores.bots.seedExamples([
        { id: 'assistant', name: '通用助手', persona: { prefix: '已持久化的示例人设' } },
        { id: 'researcher', name: '研究员', persona: { prefix: '待写入的人设' } },
      ])).rejects.toMatchObject({ code: 'store/unavailable' });
    } finally { writing.mockRestore(); }
    const persisted = stores.bots.get('assistant');
    expect(stores.bots.list()).toEqual([persisted]);
    await stores.close();
    const { registry } = await start({ seedExamples: true });
    expect(await registry.get('assistant')).toStrictEqual(persisted);
    expect(await registry.get('researcher')).toMatchObject({ name: '研究员' });
    expect(await registry.list()).toHaveLength(2);
  }));

  it('rejects invalid inputs, missing ids and conflicts before touching any registered preset', async () => withFacility(async ({ start, presets }) => {
    const { registry } = await start();
    await registry.create({ id: 'alpha', name: 'Original' });
    presets.calls.length = 0;
    await expect(registry.create({ id: 'alpha', name: 'Duplicate' })).rejects.toMatchObject({ code: 'bot/conflict' });
    await expect(registry.create({ id: 'INVALID', name: 'Invalid' })).rejects.toMatchObject({ code: 'bot/invalid' });
    await expect(registry.update('alpha', { name: '' })).rejects.toMatchObject({ code: 'bot/invalid' });
    await expect(registry.update('absent', { name: 'Missing' })).rejects.toMatchObject({ code: 'bot/not-found' });
    await expect(registry.remove('alpha', { deleteMemories: 'false' } as never)).rejects.toMatchObject({ code: 'bot/invalid' });
    await expect(registry.get('absent')).rejects.toMatchObject({ code: 'bot/not-found' });
    expect(presets.calls).toEqual([]);
    expect(presets.current.get('bot-alpha')?.name).toBe('Original');
  }));
});
