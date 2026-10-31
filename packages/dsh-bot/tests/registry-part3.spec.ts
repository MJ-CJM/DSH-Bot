import { readFile, } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openBotStores } from '../lib/host/store.js';

import { withFacility, deferred } from './fixtures/registry.js';

describe('DshBotRegistry with JSON storage and a preset service double', () => {
  it.each(['throw', 'broken'] as const)('rolls back a %s preset update without altering the durable record',
    async (failure) => withFacility(async ({ start, presets, root }) => {
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

  it('drains an in-flight write and its queued update on unload before releasing presets and storage', async () => withFacility(async ({ ctx,
    root, start, presets, unit }) => {
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
    const reopened = await openBotStores(ctx, { memoryV2: { dataDir: join(root, 'data') } });
    expect(reopened.bots.get('alpha')).toMatchObject({ name: 'Pending', description: 'Accepted before unloading' });
    await reopened.close();
  }));

  it('emits Host invalidations only after successful persistence and never for a rolled-back change', async () => withFacility(async ({ ctx,
    start, presets, unit }) => {
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

  it('duplicates editable fields under a new identity without sharing nested data or copying memories', async () => withFacility(async ({ start,
    memories, presets }) => {
    const { registry } = await start();
    const original = await registry.create({ id: 'alpha', name: 'Original', avatarVariant: 'spout',
      avatarColor: '--dsw-alias-state-success-primary', persona: { prefix: '原始人设' },
      tools: { deny: ['shell'] }, memory: { enabled: true, injectLimit: 5 }, template: 'minimal' });
    await memories().add({ botId: 'alpha', content: 'Original private memory' });
    const copied = await registry.duplicate('alpha', 'beta');
    expect(copied).toMatchObject({ id: 'beta', persona: original.persona, template: original.template,
      tools: original.tools, memory: original.memory, avatarColor: original.avatarColor, avatarVariant: original.avatarVariant });
    copied.tools.deny.push('caller mutation');
    expect((await registry.get('beta')).tools.deny).toEqual(['shell']);
    expect(await registry.get('alpha')).toStrictEqual(original);
    expect(memories().listByBot('beta', { limit: 10 })).toEqual([]);
    expect(presets.current.has('bot-alpha')).toBe(true);
    expect(presets.current.has('bot-beta')).toBe(true);
    await expect(registry.duplicate('alpha', 'beta')).rejects.toMatchObject({ code: 'bot/conflict' });
  }));


});
