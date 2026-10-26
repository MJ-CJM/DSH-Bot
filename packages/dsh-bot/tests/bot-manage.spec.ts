import { required } from './fixtures/required.js';

import type { ApprovalOutcome, } from '@deepseek-ai/dsh-user-approval';
import { describe, expect, it, vi } from 'vitest';
import { DshBotError } from '../lib/host/errors.js';
import { Config, } from '../lib/host/registry.js';
import type { BotRecord } from '../lib/shared/schema.js';
import { BOT_MANAGE_TOOL_NAME, registerBotManageTool, } from '../lib/host/tools/bot-manage.js';

import { withFixture, successful, failure, audit, mutation, isolatedHome } from './fixtures/bot-manage.js';

describe('bot_manage through published ToolRuntime, approval audit and JSON-backed registry', () => {
  // Writes more than one page of records to real JSON storage, so allow extra I/O time.
  it('describes the target, changed fields and full deletion count in both approval languages', async () => withFixture(async ({ ctx, registry,
    create, execute, disk, presets }) => {
    const owner = create();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    await registry.create({ id: 'beta', name: 'Beta' });
    const memory = registry.memoryFor('alpha');
    for (let index = 0; index < 205; index++) await memory.save({ content: `Counted memory ${index}`, pinned: index % 2 === 0 });
    await registry.memoryFor('beta').save({ content: 'Do not count another Bot.' });
    const seen: Array<{ reason?: string; displayReason?: Readonly<Record<string, string>> }> = [];
    ctx.on('approval/request', async (req) => { seen.push(req); return 'rejected'; });
    const before = await disk();
    const calls = [...presets.calls];
    for (const args of [
      { action: 'create', input: { id: 'gamma', name: 'Gamma "quoted"\nBot' } },
      { action: 'update', id: 'alpha', input: { tools: { deny: [] }, name: 'Renamed' } },
      { action: 'delete', id: 'alpha' },
      { action: 'delete', id: 'alpha', input: { deleteMemories: false } },
      { action: 'delete', id: 'beta', input: { deleteMemories: true } },
    ]) failure(await execute(owner.agent, args));
    expect(seen).toHaveLength(5);
    for (const locale of ['en', 'zh']) {
      expect(seen[0]?.displayReason?.[locale]).toContain('"gamma"');
      expect(seen[0]?.displayReason?.[locale]).toContain(JSON.stringify('Gamma "quoted"\nBot'));
      expect(seen[1]?.displayReason?.[locale]).toContain('"alpha"');
      expect(seen[1]?.displayReason?.[locale]).toContain('["name","tools"]');
      expect(seen[2]?.displayReason?.[locale]).toContain('"alpha"');
      expect(seen[2]?.displayReason?.[locale]).toContain('205');
      expect(seen[2]?.displayReason?.[locale]).toContain('deleteMemories=true');
      expect(seen[3]?.displayReason?.[locale]).toContain('deleteMemories=false');
      expect(seen[3]?.displayReason?.[locale]).not.toContain('205');
      expect(seen[4]?.displayReason?.[locale]).toContain('"beta"');
    }
    expect(seen[4]?.displayReason?.en).toContain('ALL 1 MEMORIES');
    expect(seen[4]?.displayReason?.zh).toContain('全部 1 条记忆');
    for (const req of seen) {
      expect(req.reason).toBe(req.displayReason?.en);
      expect(JSON.stringify(req.displayReason)).not.toMatch(/\{(?:id|name|count|fields|selfWarning|memoryWarning)\}/);
    }
    expect(await disk()).toBe(before);
    expect(presets.calls).toEqual(calls);
    expect(await memory.count()).toBe(205);
  }), 20_000);

  it('warns on self-update and self-delete using the trusted Bot owner, including downstream asks', async () => withFixture(async ({ ctx,
    registry, create, execute }) => {
    await registry.create({ id: 'alpha', name: 'Alpha' });
    await registry.create({ id: 'beta', name: 'Beta' });
    // Header deliberately differs: identity is supplied by the Bot generation.
    const owner = create({ currentBotId: 'alpha', agentPreset: 'bot-beta' });
    const standard = create({ agentPreset: 'standard' });
    const seen: Array<{ reason?: string; displayReason?: Readonly<Record<string, string>> }> = [];
    ctx.on('approval/request', async (req) => { seen.push(req); return 'rejected'; });
    owner.agent.ctx.on('tools/pre-execute', async () => ({
      kind: 'ask', reason: 'Additional fixture policy', displayReason: { en: 'Existing ask', zh: '原有审批' },
    }));
    failure(await execute(owner.agent, { action: 'update', id: 'alpha', input: { tools: { deny: [] } } }));
    failure(await execute(owner.agent, { action: 'delete', id: 'alpha' }));
    failure(await execute(owner.agent, { action: 'update', id: 'beta', input: { name: 'Other' } }));
    failure(await execute(standard.agent, { action: 'update', id: 'alpha', input: { name: 'Other' } }));
    for (const req of seen.slice(0, 2)) {
      expect(req.displayReason?.en).toContain('CURRENT BOT ITSELF');
      expect(req.displayReason?.zh).toContain('当前 Bot 自身');
      expect(req.displayReason?.en).toContain('Existing ask');
      expect(req.displayReason?.zh).toContain('原有审批');
    }
    expect(seen[0]?.displayReason?.en).toContain('tools.deny');
    expect(seen[0]?.displayReason?.zh).toContain('当前 live Agent 仍保留原有限制');
    expect(seen[1]?.displayReason?.zh).toContain('全部 0 条记忆');
    for (const req of seen.slice(2)) {
      expect(req.displayReason?.en).not.toContain('CURRENT BOT ITSELF');
      expect(req.displayReason?.zh).not.toContain('当前 Bot 自身');
    }
  }));

  it('fails closed if the pre-approval memory count fails', async () => withFixture(async ({ ctx, registry, create, execute, disk, presets }) => {
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const owner = create();
    const before = await disk();
    const calls = [...presets.calls];
    const answer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once');
    ctx.on('approval/request', answer);
    const memory = registry.memoryFor('alpha');
    const counter = vi.spyOn(memory, 'count').mockRejectedValueOnce(new DshBotError('store/unavailable', 'Count unavailable'));
    const facade = vi.spyOn(registry, 'memoryFor').mockReturnValueOnce(memory);
    try { failure(await execute(owner.agent, { action: 'delete', id: 'alpha' }), 'store/unavailable'); }
    finally { counter.mockRestore(); facade.mockRestore(); }
    expect(answer).not.toHaveBeenCalled();
    expect(await disk()).toBe(before);
    expect(presets.calls).toEqual(calls);
  }));

  it('returns bounded list personas and compact avatars in both canonical values and rendered text without changing storage',
    async () => withFixture(async ({ ctx, registry, create, execute }) => {
    const owner = create();
    ctx.on('approval/request', async () => 'allowed-once');
    const avatar = `data:image/png;base64,${'A'.repeat(Math.floor((64 * 1024 - 22) / 4) * 4)}`;
    const prefix = '🧠'.repeat(201);
    const suffix = 'Suffix'.repeat(200);
    const avatarColor = '--dsw-alias-state-business-primary';
    const created = await execute(owner.agent, { action: 'create', input: { id: 'alpha', name: 'Alpha', avatar, avatarColor,
      avatarVariant: 'glasses', persona: { prefix, suffix, complete: false } } });
    const original = await registry.get('alpha');
    expect(original.avatar).toBe(avatar);
    expect(successful(created)).toMatchObject({ bots: [{ avatar: '[data-url avatar]', avatarColor, avatarVariant: 'glasses', persona: original.persona }] });
    await registry.create({ id: 'beta', name: 'Beta', avatar: '🤖', persona: { prefix: 'b'.repeat(190), suffix: 's'.repeat(11) } });
    await registry.create({ id: 'gamma', name: 'Gamma', persona: { prefix: 'c'.repeat(200) } });
    const listed = await execute(owner.agent, { action: 'list' });
    const rows = (successful(listed) as { bots: Array<BotRecord & { persona: { truncated?: boolean } }> }).bots;
    expect(rows.find((bot) => bot.id === 'alpha')).toMatchObject({ avatar: '[data-url avatar]', avatarColor, avatarVariant: 'glasses',
      persona: { prefix: '🧠'.repeat(200), suffix: '', complete: false, truncated: true } });
    expect(rows.find((bot) => bot.id === 'beta')).toMatchObject({ avatar: '🤖', persona: { prefix: 'b'.repeat(190), suffix: 's'.repeat(10), truncated: true } });
    expect(rows.find((bot) => bot.id === 'gamma')?.persona).toEqual({ prefix: 'c'.repeat(200) });
    expect(rows.every((bot) => [...bot.persona.prefix, ...(bot.persona.suffix ?? '')].length <= 200)).toBe(true);
    const fetched = await execute(owner.agent, { action: 'get', id: 'alpha' });
    expect(successful(fetched)).toMatchObject({ bots: [{ avatar: '[data-url avatar]', persona: original.persona }] });
    const updated = await execute(owner.agent, { action: 'update', id: 'alpha', input: { description: 'Updated' } });
    successful(updated);
    for (const result of [created, listed, fetched, updated]) {
      expect(JSON.stringify(result)).not.toContain(avatar);
      expect(JSON.stringify(result)).toContain('[data-url avatar]');
    }
    expect(await registry.get('alpha')).toMatchObject({ avatar, persona: { prefix, suffix, complete: false } });
    expect(Config({}).botManagePersonaPreviewChars).toBe(200);
    for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => Config({ botManagePersonaPreviewChars: value })).toThrow();
    }
    const small = registerBotManageTool(owner.agent, {
      list: registry.list.bind(registry), get: registry.get.bind(registry), create: registry.create.bind(registry),
      update: registry.update.bind(registry), remove: registry.remove.bind(registry), memoryFor: registry.memoryFor.bind(registry),
      config: { ...registry.config, botManagePersonaPreviewChars: 3 },
    });
    expect(successful(await execute(owner.agent, { action: 'list' }))).toMatchObject({ bots: expect.arrayContaining([
      expect.objectContaining({ id: 'alpha', persona: { prefix: '🧠🧠🧠', suffix: '', complete: false, truncated: true } }),
    ]) });
    small();
  }));

  it('runs all five actions through the shared registry and returns canonical records plus concise text', async () => withFixture(async ({ ctx,
    registry, create, execute, presets }) => {
    const owner = create();
    const answer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once');
    ctx.on('approval/request', answer);
    expect(successful(await execute(owner.agent, { action: 'list' }))).toEqual({ action: 'list', bots: [] });
    expect(answer).not.toHaveBeenCalled();
    const created = await execute(owner.agent, { action: 'create', input: {
      id: 'alpha', name: 'Alpha', description: 'A research assistant', persona: { prefix: 'Research carefully.' },
      template: 'minimal', memory: { enabled: false, injectLimit: 7 }, tools: { deny: [] }, skills: { extraDirs: [] },
    } });
    const original = await registry.get('alpha');
    expect(successful(created)).toEqual({ action: 'create', bots: [original] });
    expect(presets.current.get('bot-alpha')?.name).toBe('Alpha');
    expect(successful(await execute(owner.agent, { action: 'get', id: 'alpha' }))).toEqual({ action: 'get', bots: [original] });
    expect(successful(await execute(owner.agent, { action: 'list' }))).toEqual({ action: 'list', bots: [original] });
    expect(answer).toHaveBeenCalledTimes(1);
    const updated = await execute(owner.agent, { action: 'update', id: 'alpha', input: { name: 'Researcher' } });
    const current = await registry.get('alpha');
    expect(current.name).toBe('Researcher');
    expect(current.updatedAt).toBeGreaterThan(original.updatedAt);
    expect(successful(updated)).toEqual({ action: 'update', bots: [current] });
    expect(presets.calls.slice(-2)).toEqual(['unregister:bot-alpha:Alpha', 'register:bot-alpha:Researcher']);
    await registry.memoryFor('alpha').save({ content: 'Delete this with the Bot.' });
    expect(successful(await execute(owner.agent, { action: 'delete', id: 'alpha' }))).toEqual({ action: 'delete', bots: [] });
    expect(await registry.list()).toEqual([]);
    expect(required(registry.memoryKernel).snapshot.versions.size).toBe(0);
    expect(presets.current.size).toBe(0);
    expect(answer).toHaveBeenCalledTimes(3);
    const events = audit(owner.session);
    expect(events.map((event) => event.type)).toEqual(Array.from({ length: 3 }, () => ['approval/asked', 'approval/decided']).flat());
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index]).toMatchObject({ data: { toolName: BOT_MANAGE_TOOL_NAME, callId: expect.any(String), reason: expect.any(String) } });
      expect(events[index + 1]).toMatchObject({ data: { id: events[index]?.data.id, outcome: 'allowed-once' } });
    }
  }));

  it('preserves Bot memories when deleteMemories is explicitly false', async () => withFixture(async ({ ctx, registry, create, execute }) => {
    const owner = create();
    ctx.on('approval/request', async () => 'allowed-once');
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const saved = await registry.memoryFor('alpha').save({ content: 'Keep this durable preference.' });
    successful(await execute(owner.agent, { action: 'delete', id: 'alpha', input: { deleteMemories: false } }));
    expect(required(registry.memoryKernel).snapshot.versions.get(saved.id)).toMatchObject({ ownerBotKey: { botId: 'alpha' } });
  }));

  it('supports the shared optional-field clear contract and complete nested patches', async () => withFixture(async ({ ctx, registry, create, execute }) => {
    const owner = create();
    ctx.on('approval/request', async () => 'allowed-once');
    successful(await execute(owner.agent, { action: 'create', input: {
      id: 'alpha', name: 'Alpha', avatar: '🤖', avatarVariant: 'hat', avatarColor: '--dsw-alias-state-warn-label', model: { provider: 'fixture',
        model: 'fixture-model' },
      defaultCwd: isolatedHome, order: 3,
    } }));
    successful(await execute(owner.agent, { action: 'update', id: 'alpha', input: {
      avatar: null, avatarColor: null, avatarVariant: null, model: null, defaultCwd: null, order: null,
      persona: { prefix: 'Updated persona', suffix: 'Be concise.', complete: true },
      tools: { deny: ['write'] }, skills: { extraDirs: [] }, memory: { enabled: false, injectLimit: 0 },
    } }));
    const bot = await registry.get('alpha');
    for (const key of ['avatar', 'avatarColor', 'avatarVariant', 'model', 'defaultCwd', 'order']) expect(bot).not.toHaveProperty(key);
    expect(bot).toMatchObject({ persona: { prefix: 'Updated persona', suffix: 'Be concise.', complete: true },
      tools: { deny: ['write'] }, memory: { enabled: false, injectLimit: 0 } });
  }));

  it('rejects invalid action shapes and strict nested input without changing persistent data or presets', async () => withFixture(async ({ ctx,
    registry, create, execute, disk, presets }) => {
    const owner = create();
    ctx.on('approval/request', async () => 'allowed-once');
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const before = await disk();
    const calls = [...presets.calls];
    const invalid: unknown[] = [
      {}, { action: 'duplicate' }, { action: 1 }, { action: 'list', id: 'alpha' }, { action: 'list', input: {} },
      { action: 'list', extra: true }, { action: 'get' }, { action: 'get', id: '../alpha' },
      { action: 'get', id: 'alpha', input: {} }, { action: 'create' }, { action: 'create', id: 'beta', input: { id: 'beta', name: 'Beta' } },
      { action: 'create', input: { id: 'beta', name: '' } }, { action: 'create', input: { id: 'beta', name: 'Beta', arbitrary: 1 } },
      { action: 'create', input: { id: 'beta', name: 'Beta', persona: { prefix: '', extra: true } } },
      { action: 'update', id: 'alpha' }, { action: 'update', input: { name: 'Changed' } },
      { action: 'update', id: 'alpha', input: { id: 'beta' } }, { action: 'update', id: 'alpha', input: { memory: { enabled: 'yes' } } },
      { action: 'delete' }, { action: 'delete', id: 'alpha', input: { deleteMemories: 'false' } },
      { action: 'delete', id: 'alpha', input: { deleteHome: true } },
      { action: 'delete', id: 'alpha', input: { name: 'Wrong action input' } },
    ];
    for (const input of invalid) {
      const error = failure(await execute(owner.agent, input));
      expect(['bot/invalid', 'INVALID_TOOL_ARGUMENTS']).toContain(error.info?.code);
      expect(await disk()).toBe(before);
      expect(presets.calls).toEqual(calls);
    }
  }));

  it('keeps registry not-found and conflict codes in structured tool failures', async () => withFixture(async ({ ctx, registry, create, execute }) => {
    const owner = create();
    ctx.on('approval/request', async () => 'allowed-once');
    await registry.create({ id: 'alpha', name: 'Alpha' });
    failure(await execute(owner.agent, { action: 'create', input: { id: 'alpha', name: 'Duplicate' } }), 'bot/conflict');
    for (const args of [
      { action: 'get', id: 'missing' }, { action: 'update', id: 'missing', input: { name: 'Missing' } }, { action: 'delete', id: 'missing' },
    ]) failure(await execute(owner.agent, args), 'bot/not-found');
    expect((await registry.get('alpha')).name).toBe('Alpha');
  }));

  it('propagates preset and rollback failures and rejects mutations until reconciliation succeeds', async () => withFixture(async ({ ctx,
    registry, create, execute, disk, presets }) => {
    const owner = create();
    ctx.on('approval/request', async () => 'allowed-once');
    await registry.create({ id: 'alpha', name: 'Original' });
    const before = await disk();
    presets.throwNames.add('Rejected');
    failure(await execute(owner.agent, { action: 'update', id: 'alpha', input: { name: 'Rejected' } }), 'bot/preset-failed');
    expect(await disk()).toBe(before);
    expect(presets.current.get('bot-alpha')?.name).toBe('Original');
    presets.throwNames.add('Original');
    failure(await execute(owner.agent, { action: 'update', id: 'alpha', input: { name: 'Rejected' } }), 'bot/rollback-failed');
    expect(await disk()).toBe(before);
    failure(await execute(owner.agent, mutation('create')), 'bot/unavailable');
    expect(await disk()).toBe(before);
    presets.throwNames.clear();
    successful(await execute(owner.agent, mutation('create')));
    expect(presets.current.get('bot-alpha')?.name).toBe('Original');
  }));


});
