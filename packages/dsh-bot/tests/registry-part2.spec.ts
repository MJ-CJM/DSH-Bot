import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// Like bundle.spec, run against the current build produced by pnpm check.
// This also exercises TypeScript's lowering of the standard Remote decorators.
import { Config, DshBotRegistry } from '../lib/host/registry.js';
import { openBotStores } from '../lib/host/store.js';

import { withFacility, deferred } from './fixtures/registry.js';

describe('DshBotRegistry with JSON storage and a preset service double', () => {
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
    expect(await second.registry.status()).toContainEqual({ id: 'legacy', presetId: 'custom-review-legacy', warnings: ['avatar/invalid'],
      preset: { state: 'ok' } });
    await second.registry.update('legacy', { avatar: null });
    expect((await second.registry.status()).find((row) => row.id === 'legacy')).not.toHaveProperty('warnings');
    await second.registry.remove('legacy');
    await second.registry.remove('healthy');
    expect(await second.registry.catalogInfo()).toEqual({ presetIdPrefix: 'custom-review-' });
  }));

  it('creates separate skill directories, preserves user files and exposes detached activation snapshots',
    async () => withFacility(async ({ root, start, presets }) => {
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

  it('keeps the current preset and record if template preparation or skill directory creation fails', async () => withFacility(async ({ root,
    start, presets }) => {
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

  it('drains accepted memory writes before Host unload and rejects later facade calls', async () => withFacility(async ({ ctx, root, start, unit }) => {
    const { registry, stop } = await start();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const memory = registry.memoryFor('alpha');
    const entered = deferred();
    const commit = deferred();
    const write = unit('dsh_bot_memory').putRecord.bind(unit('dsh_bot_memory'));
    const writing = vi.spyOn(unit('dsh_bot_memory'), 'putRecord').mockImplementationOnce(async (...args) => {
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
    const reopened = await openBotStores(ctx, { memoryV2: { dataDir: join(root, 'data') } });
    expect(reopened.memories.listByBot('alpha', { limit: 10 })).toMatchObject([{ id }]);
    await reopened.close();
  }));

  it('registers durable Bots on startup and releases presets and the domain on unload', async () => withFacility(async ({ ctx, root, start, presets }) => {
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
    const reopened = await openBotStores(ctx, { memoryV2: { dataDir: join(root, 'data') } });
    expect(reopened.bots.list()).toHaveLength(2);
    await reopened.close();
  }));

  it.each(['throw', 'broken'] as const)('isolates a %s startup preset and permits repair or delete',
    async (failure) => withFacility(async ({ ctx, start, presets }) => {
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


});
