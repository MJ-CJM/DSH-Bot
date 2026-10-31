import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import { describe, expect, it, vi } from 'vitest';
import { audit, failure, successful, withFixture } from './fixtures/bot-manage.js';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('lasting roles use the existing native approval and Bot snapshot', () => {
  it('keeps Host-owned onboarding eligibility out of model-facing Bot records', async () => withFixture(async f => {
    const bot = await f.registry.create({ id: 'alpha', name: 'Alpha' });
    const owner = f.create();
    const get = vi.spyOn(f.registry, 'get').mockResolvedValueOnce({ ...bot, onboarding: {
      operationId: 'a6d45778-b1b9-4b6e-8b90-cd1c68f4bfb0', language: 'en', policyVersion: 1, inputDigest: 'a'.repeat(64),
    } });
    try {
      expect(successful(await f.execute(owner.agent, { action: 'get', id: bot.id }))).toEqual({ action: 'get', bots: [bot] });
    } finally { get.mockRestore(); }
  }));

  it('checks generation independently of version before any preset transition', async () => withFixture(async f => {
    const original = await f.registry.create({ id: 'alpha', name: 'Original' });
    await f.registry.remove(original.id, { deleteMemories: false });
    const replacement = await f.registry.create({ id: original.id, name: 'Replacement' });
    const disk = await f.disk(), calls = [...f.presets.calls];
    await expect(f.registry.update(replacement.id, { persona: { prefix: 'Wrong generation' },
      expectedCreatedAt: original.createdAt, expectedUpdatedAt: replacement.updatedAt,
    })).rejects.toMatchObject({ code: 'bot/conflict' });
    expect(await f.disk()).toBe(disk);
    expect(f.presets.calls).toEqual(calls);
    expect(await f.registry.get(replacement.id)).toEqual(replacement);
  }));

  it('previews the exact draft and preserves suffix/complete for a prefix-only update', async () => withFixture(async f => {
    const bot = await f.registry.create({ id: 'alpha', name: 'Alpha',
      persona: { prefix: 'Before', suffix: 'Keep this suffix.', complete: true } });
    const owner = f.create();
    const seen: Array<{ reason?: string; displayReason?: Readonly<Record<string, string>> }> = [];
    f.ctx.on('approval/request', async request => { seen.push(request); return 'allowed-once'; });
    const fetched = successful(await f.execute(owner.agent, { action: 'get', id: bot.id })) as { bots: typeof bot[] };
    const snapshot = fetched.bots[0];
    if (!snapshot) throw new Error('Missing Bot snapshot');
    const prefix = '以后负责迁移验收。\nUse "device" evidence, not a name guess. 🧠';
    const updated = successful(await f.execute(owner.agent, { action: 'update', id: bot.id, input: {
      persona: { prefix }, expectedCreatedAt: snapshot.createdAt, expectedUpdatedAt: snapshot.updatedAt,
    } }));
    const persona = { ...bot.persona, prefix };
    expect(updated).toMatchObject({ bots: [{ persona }] });
    expect((await f.registry.get(bot.id)).persona).toEqual(persona);
    for (const locale of ['en', 'zh']) {
      expect(seen[0]?.displayReason?.[locale]).toContain(JSON.stringify(prefix));
      expect(seen[0]?.displayReason?.[locale]).toContain(JSON.stringify(persona));
      expect(seen[0]?.displayReason?.[locale]).toContain(`createdAt=${bot.createdAt}`);
      expect(seen[0]?.displayReason?.[locale]).toContain(`updatedAt=${bot.updatedAt}`);
    }
    expect(audit(owner.session).map(event => event.type)).toEqual(['approval/asked', 'approval/decided']);
    expect(audit(owner.session).at(-1)).toMatchObject({ data: { outcome: 'allowed-once' } });
    expect(await f.registry.get(bot.id)).not.toHaveProperty('expectedUpdatedAt');
  }));

  it.each([true, false])('rejects a concurrent window update during approval (explicit snapshot: %s)', async explicit => withFixture(async f => {
    const bot = await f.registry.create({ id: 'alpha', name: 'Alpha', persona: { prefix: 'Initial', suffix: 'Suffix' } });
    const owner = f.create();
    const entered = gate<void>(), answer = gate<ApprovalOutcome>();
    f.ctx.on('approval/request', async () => { entered.resolve(); return answer.promise; });
    const pending = f.execute(owner.agent, { action: 'update', id: bot.id, input: { persona: { prefix: 'Stale draft' },
      ...(explicit ? { expectedCreatedAt: bot.createdAt, expectedUpdatedAt: bot.updatedAt } : {}),
    } });
    await entered.promise;
    const newest = await f.registry.update(bot.id, { persona: { prefix: 'New role from another window', complete: true } });
    const disk = await f.disk(), calls = [...f.presets.calls];
    answer.resolve('allowed-once');
    failure(await pending, 'bot/conflict');
    expect(await f.registry.get(bot.id)).toEqual(newest);
    expect(await f.disk()).toBe(disk);
    expect(f.presets.calls).toEqual(calls);
    expect(audit(owner.session).at(-1)).toMatchObject({ data: { outcome: 'allowed-once' } });
  }));

  it.each([true, false])('cannot overwrite a deleted and recreated ID during approval (explicit snapshot: %s)', async explicit => withFixture(async f => {
    const bot = await f.registry.create({ id: 'alpha', name: 'Original', persona: { prefix: 'Original role' } });
    const owner = f.create();
    const entered = gate<void>(), answer = gate<ApprovalOutcome>();
    f.ctx.on('approval/request', async () => { entered.resolve(); return answer.promise; });
    const pending = f.execute(owner.agent, { action: 'update', id: bot.id, input: { persona: { prefix: 'Old generation draft' },
      ...(explicit ? { expectedCreatedAt: bot.createdAt, expectedUpdatedAt: bot.updatedAt } : {}),
    } });
    await entered.promise;
    await f.registry.remove(bot.id, { deleteMemories: false });
    const replacement = await f.registry.create({ id: bot.id, name: 'Replacement', persona: { prefix: 'Replacement role' } });
    const disk = await f.disk(), calls = [...f.presets.calls];
    answer.resolve('allowed-once');
    failure(await pending, 'bot/conflict');
    expect(replacement.createdAt).not.toBe(bot.createdAt);
    expect(await f.registry.get(bot.id)).toEqual(replacement);
    expect(await f.disk()).toBe(disk);
    expect(f.presets.calls).toEqual(calls);
  }));

  it('refuses an already stale get before requesting approval and permits a newly reviewed draft', async () => withFixture(async f => {
    const bot = await f.registry.create({ id: 'alpha', name: 'Alpha' });
    const owner = f.create();
    const newest = await f.registry.update(bot.id, { persona: { prefix: 'New role', suffix: 'Keep' } });
    const answer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once');
    f.ctx.on('approval/request', answer);
    const disk = await f.disk();
    failure(await f.execute(owner.agent, { action: 'update', id: bot.id, input: {
      persona: { prefix: 'Stale' }, expectedCreatedAt: bot.createdAt, expectedUpdatedAt: bot.updatedAt,
    } }), 'bot/conflict');
    expect(answer).not.toHaveBeenCalled();
    expect(await f.disk()).toBe(disk);
    successful(await f.execute(owner.agent, { action: 'update', id: bot.id, input: {
      persona: { prefix: 'Freshly reviewed' }, expectedCreatedAt: newest.createdAt, expectedUpdatedAt: newest.updatedAt,
    } }));
    expect(answer).toHaveBeenCalledTimes(1);
    expect((await f.registry.get(bot.id)).persona).toEqual({ prefix: 'Freshly reviewed', suffix: 'Keep' });
  }));

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('writes no role for %s approval', async outcome => withFixture(async f => {
    const bot = await f.registry.create({ id: 'alpha', name: 'Alpha', persona: { prefix: 'Unchanged', suffix: 'Keep', complete: true } });
    const owner = f.create();
    const disk = await f.disk(), calls = [...f.presets.calls];
    f.ctx.on('approval/request', async () => outcome);
    failure(await f.execute(owner.agent, { action: 'update', id: bot.id, input: { persona: { prefix: 'Denied role' },
      expectedCreatedAt: bot.createdAt, expectedUpdatedAt: bot.updatedAt,
    } }));
    expect(await f.registry.get(bot.id)).toEqual(bot);
    expect(await f.disk()).toBe(disk);
    expect(f.presets.calls).toEqual(calls);
  }));

  it('discards a late approval after cancellation or tool unload', async () => withFixture(async f => {
    const bot = await f.registry.create({ id: 'alpha', name: 'Alpha' });
    for (const mode of ['abort', 'unload']) {
      const owner = f.create(), entered = gate<void>(), answer = gate<ApprovalOutcome>();
      const off = f.ctx.on('approval/request', async () => { entered.resolve(); return answer.promise; });
      const controller = new AbortController();
      const disk = await f.disk(), calls = [...f.presets.calls];
      const pending = f.execute(owner.agent, { action: 'update', id: bot.id, input: { persona: { prefix: 'Late draft' } } }, controller.signal);
      await entered.promise;
      if (mode === 'abort') controller.abort(); else owner.dispose?.();
      answer.resolve('allowed-once');
      failure(await pending);
      off();
      expect(await f.disk()).toBe(disk);
      expect(f.presets.calls).toEqual(calls);
      expect(await f.registry.get(bot.id)).toEqual(bot);
    }
  }));

  it('cannot prepare a new approval after unloading across an asynchronous snapshot read', async () => withFixture(async f => {
    const bot = await f.registry.create({ id: 'alpha', name: 'Alpha' });
    const owner = f.create(), entered = gate<void>(), resume = gate<void>();
    const answer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once');
    f.ctx.on('approval/request', answer);
    const disk = await f.disk(), calls = [...f.presets.calls];
    const get = vi.spyOn(f.registry, 'get').mockImplementationOnce(async () => {
      entered.resolve(); await resume.promise; return bot;
    });
    try {
      const pending = f.execute(owner.agent, { action: 'update', id: bot.id, input: { persona: { prefix: 'Late draft' } } });
      await entered.promise;
      owner.dispose?.();
      resume.resolve();
      failure(await pending, 'bot/unavailable');
    } finally { resume.resolve(); get.mockRestore(); }
    expect(answer).not.toHaveBeenCalled();
    expect(await f.disk()).toBe(disk);
    expect(f.presets.calls).toEqual(calls);
  }));
});
