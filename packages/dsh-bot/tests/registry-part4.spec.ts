
import { describe, expect, it, vi } from 'vitest';
import { openBotStores } from '../lib/host/store.js';

import { withFacility, } from './fixtures/registry.js';

describe('DshBotRegistry with JSON storage and a preset service double', () => {
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

  it('honors deleteMemories while preserving other Bots and explicitly retained memories', async () => withFacility(async ({ start, memories,
    retainedMemories }) => {
    const { registry } = await start();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    await registry.create({ id: 'beta', name: 'Beta' });
    const retained = await memories().add({ botId: 'alpha', content: 'Keep explicitly' });
    const other = await memories().add({ botId: 'beta', content: 'Other Bot' });
    await registry.remove('alpha', { deleteMemories: false });
    expect(retainedMemories('alpha')).toEqual([retained]);
    expect(retainedMemories('beta')).toEqual([other]);
    await registry.remove('beta', { deleteMemories: true });
    expect(retainedMemories('beta')).toEqual([]);
    expect(retainedMemories('alpha')).toEqual([retained]);
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
