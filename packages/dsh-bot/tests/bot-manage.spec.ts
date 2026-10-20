import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import Storage, { type KvUnit } from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool, type PreToolDecision, type ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import ApprovalService, { type ApprovalOutcome, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { describe, expect, it, vi } from 'vitest';
import { DshBotError } from '../lib/host/errors.js';
import { Config, DshBotRegistry } from '../lib/host/registry.js';
import type { BotRecord } from '../lib/shared/schema.js';
import { BOT_MANAGE_TOOL_NAME, registerBotManageTool, registerStandardBotManage } from '../lib/host/tools/bot-manage.js';

const isolatedHome = fileURLToPath(new URL('../../../.dsh-dev/', import.meta.url));

/** Only preset loading is doubled; duplicate ids and activation errors stay observable. */
class PresetDouble extends Service {
  readonly calls: string[] = [];
  readonly current = new Map<string, PresetDefinition>();
  readonly composed = new Map<Context, string>();
  readonly throwNames = new Set<string>();

  constructor(ctx: Context) { super(ctx, 'agentPresets'); }

  async readDocument(agentPreset: string) {
    return { agentPreset, content: '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n- id: skill-filesystem\n  name: "@deepseek-ai/dsh-skill-filesystem"\n' };
  }

  async register(definition: PresetDefinition) {
    this.calls.push(`register:${definition.id}:${definition.name}`);
    if (this.current.has(definition.id)) throw new Error(`Duplicate preset: ${definition.id}`);
    if (this.throwNames.has(definition.name ?? '')) throw new Error(`Rejected preset: ${definition.name}`);
    this.current.set(definition.id, structuredClone(definition));
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      this.calls.push(`unregister:${definition.id}:${definition.name}`);
      this.current.delete(definition.id);
    };
  }

  async list() {
    return [...this.current.values()].map(({ id, name, description }) => ({ id, name, description, isDefault: false }));
  }

  composedPreset(ctx: Context) { return this.composed.get(ctx); }
}

async function fixture(ctx: Context, root: string, approval: boolean) {
  await ctx.plugin(SystemPrompt, {}).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(Storage).await();
  await ctx.plugin(storageJson, { root }).await();
  await ctx.plugin(storageDomain, { backend: 'json' }).await();
  await ctx.plugin(PresetDouble).await();
  const presets = ctx.agentPresets as unknown as PresetDouble;
  if (approval) await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  const kv = ctx.storage.backend.get('json').kv;
  if (!kv) throw new Error('JSON backend has no KV facet');
  let unit: KvUnit | undefined;
  const open = kv.open.bind(kv);
  const opening = vi.spyOn(kv, 'open').mockImplementation(async (descriptor) => {
    const result = await open(descriptor);
    if (descriptor.name === 'dsh_bot') unit = result;
    return result;
  });
  const registryPlugin = ctx.plugin(DshBotRegistry, {
    seedExamples: false, presetIdPrefix: 'bot-', presetOrder: 50, dataDir: join(root, 'data'),
  });
  await registryPlugin.await();
  const registry = ctx.dshBots;
  await registry.list();
  opening.mockRestore();
  const liveAgents = new Map<SessionId, Agent>();
  ctx.provide('agents', { get: (id: SessionId) => liveAgents.get(id) } as Context['agents']);
  let owner!: Context;
  await ctx.plugin({
    inject: ['tools', 'systemPrompt', 'dshBots', 'agentPresets', 'agents'],
    apply(injected: Context) { owner = injected; },
  }).await();
  let sequence = 0;
  const create = (options: { install?: boolean; agentPreset?: string; composedPreset?: string; blank?: boolean; resume?: boolean; currentBotId?: string } = {}) => {
    const id = SessionId(`bot-manage-session-${++sequence}`);
    let session = Session.create(id, undefined, {
      version: 4, id, createdAt: Date.now(), isSeeded: false,
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    });
    const composedPreset = options.composedPreset ?? options.agentPreset;
    if (composedPreset !== undefined && composedPreset !== options.agentPreset) {
      session.append('agent-preset/selected', { agentPreset: composedPreset });
    }
    if (options.resume) session = Session.fromRestore(id, structuredClone(session.snapshotEvents()), session.header, SessionLogOffset(0), 'detached');
    if (!options.blank) session.append('turn/start', { turn: 1 });
    // Agent identity is a fixture; Session, approval audit, scope routing, tools,
    // registry transactions and JSON writes are the published/production services.
    const payload = { id: `bot-manage-agent-${sequence}`, ctx: owner, session };
    const agent = payload as Agent;
    const scope = createScope(owner, agent);
    payload.ctx = scope.ctx;
    liveAgents.set(session.id, agent);
    agent.ctx.effect(() => () => { liveAgents.delete(session.id); });
    if (composedPreset !== undefined) presets.composed.set(agent.ctx, composedPreset);
    const dispose = options.install === false ? undefined : registerBotManageTool(agent, registry, undefined, options.currentBotId);
    return {
      agent, scope, session, dispose,
      announce: () => ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: options.resume ? 'resume' : 'startup' }),
      select: async (agentPreset: string) => {
        // The registry double models successful composition; use the real Session
        // event and public notification contract without mutating its header.
        presets.composed.set(agent.ctx, agentPreset);
        session.append('agent-preset/selected', { agentPreset });
        await ctx.serial('agent-preset/selected', session.id, agentPreset);
      },
    };
  };
  const execute = (agent: Agent | undefined, args: unknown, signal = new AbortController().signal, name = BOT_MANAGE_TOOL_NAME) => ctx.tools.execute({
    callId: ToolCallId(`bot-manage-call-${++sequence}`), name, arguments: args, signal,
    ...(agent === undefined ? {} : { agent }),
  });
  return {
    ctx, registry, create, execute, presets,
    disk: () => readFile(join(root, 'dsh_bot.json'), 'utf8'),
    unit: () => { if (!unit) throw new Error('Missing dsh_bot KV unit'); return unit; },
    stopRegistry: () => registryPlugin.dispose(),
  };
}

async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>, options: { approval?: boolean } = {}) {
  await mkdir(isolatedHome, { recursive: true });
  const root = await mkdtemp(join(isolatedHome, 't07-bot-manage-'));
  const ctx = new Context();
  try { await run(await fixture(ctx, root, options.approval !== false)); }
  finally {
    try { await ctx.fiber.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

function successful(result: ToolExecutionResult) {
  expect(result.isError, JSON.stringify(result)).toBe(false);
  if (result.isError) throw new Error(result.error.message);
  const text = result.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
  expect(text).toContain(JSON.stringify(result.value));
  expect(text.length).toBeGreaterThan(JSON.stringify(result.value).length);
  return result.value;
}

function failure(result: ToolExecutionResult, code?: string) {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  if (!result.isError) throw new Error('Expected a rejected tool call');
  expect(result).not.toHaveProperty('value');
  if (code !== undefined) expect(result.error.info?.code).toBe(code);
  return result.error;
}

function audit(session: Session) {
  return session.snapshotEvents().filter((event) => event.type === 'approval/asked' || event.type === 'approval/decided');
}

function mutation(action: 'create' | 'update' | 'delete') {
  if (action === 'create') return { action, input: { id: 'beta', name: 'Beta' } };
  if (action === 'update') return { action, id: 'alpha', input: { name: 'Changed' } };
  return { action, id: 'alpha' };
}

describe('bot_manage through published ToolRuntime, approval audit and JSON-backed registry', () => {
  // Writes more than one page of records to real JSON storage, so allow extra I/O time.
  it('describes the target, changed fields and full deletion count in both approval languages', async () => withFixture(async ({ ctx, registry, create, execute, disk, presets }) => {
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

  it('warns on self-update and self-delete using the trusted Bot owner, including downstream asks', async () => withFixture(async ({ ctx, registry, create, execute }) => {
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

  it('returns bounded list personas and compact avatars in both canonical values and rendered text without changing storage', async () => withFixture(async ({ ctx, registry, create, execute }) => {
    const owner = create();
    ctx.on('approval/request', async () => 'allowed-once');
    const avatar = `data:image/png;base64,${'A'.repeat(Math.floor((64 * 1024 - 22) / 4) * 4)}`;
    const prefix = '🧠'.repeat(201);
    const suffix = 'Suffix'.repeat(200);
    const avatarColor = '--dsw-alias-state-business-primary';
    const created = await execute(owner.agent, { action: 'create', input: { id: 'alpha', name: 'Alpha', avatar, avatarColor, persona: { prefix, suffix, complete: false } } });
    const original = await registry.get('alpha');
    expect(original.avatar).toBe(avatar);
    expect(successful(created)).toMatchObject({ bots: [{ avatar: '[data-url avatar]', avatarColor, persona: original.persona }] });
    await registry.create({ id: 'beta', name: 'Beta', avatar: '🤖', persona: { prefix: 'b'.repeat(190), suffix: 's'.repeat(11) } });
    await registry.create({ id: 'gamma', name: 'Gamma', persona: { prefix: 'c'.repeat(200) } });
    const listed = await execute(owner.agent, { action: 'list' });
    const rows = (successful(listed) as { bots: Array<BotRecord & { persona: { truncated?: boolean } }> }).bots;
    expect(rows.find((bot) => bot.id === 'alpha')).toMatchObject({ avatar: '[data-url avatar]', avatarColor, persona: { prefix: '🧠'.repeat(200), suffix: '', complete: false, truncated: true } });
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

  it('runs all five actions through the shared registry and returns canonical records plus concise text', async () => withFixture(async ({ ctx, registry, create, execute, presets }) => {
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
    expect(ctx.storageDomain.get('dsh_bot')?.table('memories').size).toBe(0);
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
    expect(ctx.storageDomain.get('dsh_bot')?.table('memories').get(saved.id)).toMatchObject({ botId: 'alpha' });
  }));

  it('supports the shared optional-field clear contract and complete nested patches', async () => withFixture(async ({ ctx, registry, create, execute }) => {
    const owner = create();
    ctx.on('approval/request', async () => 'allowed-once');
    successful(await execute(owner.agent, { action: 'create', input: {
      id: 'alpha', name: 'Alpha', avatar: '🤖', avatarColor: '--dsw-alias-state-warn-label', model: { provider: 'fixture', model: 'fixture-model' },
      defaultCwd: isolatedHome, order: 3,
    } }));
    successful(await execute(owner.agent, { action: 'update', id: 'alpha', input: {
      avatar: null, avatarColor: null, model: null, defaultCwd: null, order: null,
      persona: { prefix: 'Updated persona', suffix: 'Be concise.', complete: true },
      tools: { deny: ['write'] }, skills: { extraDirs: [] }, memory: { enabled: false, injectLimit: 0 },
    } }));
    const bot = await registry.get('alpha');
    for (const key of ['avatar', 'avatarColor', 'model', 'defaultCwd', 'order']) expect(bot).not.toHaveProperty(key);
    expect(bot).toMatchObject({ persona: { prefix: 'Updated persona', suffix: 'Be concise.', complete: true },
      tools: { deny: ['write'] }, memory: { enabled: false, injectLimit: 0 } });
  }));

  it('rejects invalid action shapes and strict nested input without changing persistent data or presets', async () => withFixture(async ({ ctx, registry, create, execute, disk, presets }) => {
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

  it('propagates preset and rollback failures and rejects mutations until reconciliation succeeds', async () => withFixture(async ({ ctx, registry, create, execute, disk, presets }) => {
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

  it('propagates storage failures after approval while restoring the previous preset and JSON', async () => withFixture(async ({ ctx, registry, create, execute, unit, disk, presets }) => {
    const owner = create();
    ctx.on('approval/request', async () => 'allowed-once');
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const before = await disk();
    const write = vi.spyOn(unit(), 'putRecord').mockRejectedValueOnce(new Error('Injected JSON write failure'));
    try { failure(await execute(owner.agent, mutation('update')), 'store/unavailable'); }
    finally { write.mockRestore(); }
    expect(await disk()).toBe(before);
    expect(presets.current.get('bot-alpha')?.name).toBe('Alpha');
  }));

  it.each(['create', 'update', 'delete'] as const)('does not persist %s after rejected, cancelled or unavailable approval', async (action) => withFixture(async ({ ctx, registry, create, execute, disk, presets }) => {
    const owner = create();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    await registry.memoryFor('alpha').save({ content: 'Unchanged by a denied delete.' });
    const before = await disk();
    const calls = [...presets.calls];
    let outcome: ApprovalOutcome = 'rejected';
    ctx.on('approval/request', async () => outcome);
    for (const selected of ['rejected', 'cancelled', 'unavailable'] as const) {
      outcome = selected;
      failure(await execute(owner.agent, mutation(action)));
      expect(audit(owner.session).at(-1)).toMatchObject({ type: 'approval/decided', data: { outcome } });
      expect(await disk()).toBe(before);
      expect(presets.calls).toEqual(calls);
      expect((await registry.get('alpha')).name).toBe('Alpha');
    }
  }));

  it('fails closed with no approval service while list/get remain available', async () => withFixture(async ({ registry, create, execute, disk, presets }) => {
    const owner = create();
    const original = await registry.create({ id: 'alpha', name: 'Alpha' });
    const before = await disk();
    const calls = [...presets.calls];
    for (const action of ['create', 'update', 'delete'] as const) failure(await execute(owner.agent, mutation(action)));
    expect(await disk()).toBe(before);
    expect(presets.calls).toEqual(calls);
    expect(successful(await execute(owner.agent, { action: 'list' }))).toEqual({ action: 'list', bots: [original] });
    expect(successful(await execute(owner.agent, { action: 'get', id: 'alpha' }))).toEqual({ action: 'get', bots: [original] });
    expect(audit(owner.session)).toEqual([]);
  }, { approval: false }));

  it('honors session never policy and fails closed when no answerer is present', async () => withFixture(async ({ ctx, registry, create, execute, disk, presets }) => {
    const owner = create();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const before = await disk();
    const calls = [...presets.calls];
    failure(await execute(owner.agent, mutation('update')));
    expect(audit(owner.session).at(-1)).toMatchObject({ data: { outcome: 'unavailable' } });
    const answer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once');
    ctx.on('approval/request', answer);
    setApprovalPolicy(owner.session, 'never');
    failure(await execute(owner.agent, mutation('delete')));
    expect(audit(owner.session).at(-1)).toMatchObject({ data: { outcome: 'rejected' } });
    expect(answer).not.toHaveBeenCalled();
    expect(await disk()).toBe(before);
    expect(presets.calls).toEqual(calls);
  }));

  it('asks afresh after a one-shot grant and never reuses it for the next mutation', async () => withFixture(async ({ ctx, registry, create, execute, disk }) => {
    const owner = create();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const answer = vi.fn<() => Promise<ApprovalOutcome>>()
      .mockResolvedValueOnce('allowed-once').mockResolvedValueOnce('rejected');
    ctx.on('approval/request', answer);
    successful(await execute(owner.agent, mutation('create')));
    const before = await disk();
    failure(await execute(owner.agent, mutation('update')));
    expect(answer).toHaveBeenCalledTimes(2);
    expect(await disk()).toBe(before);
    const asked = audit(owner.session).filter((event) => event.type === 'approval/asked');
    expect(asked).toHaveLength(2);
    expect(asked[0]?.data.id).not.toBe(asked[1]?.data.id);
  }));

  it('cancels a pending approval without writing, including after a late allow answer', async () => withFixture(async ({ ctx, registry, create, execute, disk, presets }) => {
    const owner = create();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const before = await disk();
    const calls = [...presets.calls];
    let entered!: () => void;
    let release!: (value: ApprovalOutcome) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const answer = new Promise<ApprovalOutcome>((resolve) => { release = resolve; });
    ctx.on('approval/request', async () => { entered(); return answer; });
    const controller = new AbortController();
    const pending = execute(owner.agent, mutation('update'), controller.signal);
    await started;
    controller.abort();
    try { failure(await pending, 'ABORTED_BEFORE_DISPATCH'); }
    finally { release('allowed-once'); }
    expect(audit(owner.session).at(-1)).toMatchObject({ data: { outcome: 'cancelled' } });
    expect(await disk()).toBe(before);
    expect(presets.calls).toEqual(calls);
  }));

  it.each(['deny', 'cancel'] as const)('preserves an existing %s policy instead of replacing it with approval', async (kind) => withFixture(async ({ ctx, registry, create, execute, disk }) => {
    const owner = create();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const before = await disk();
    const answer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once');
    ctx.on('approval/request', answer);
    owner.agent.ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => kind === 'deny'
      ? { kind, reason: 'Existing deny policy', info: { name: 'FixturePolicyError', code: 'fixture/denied' } } : { kind });
    const rejected = await execute(owner.agent, mutation('update'));
    failure(rejected, kind === 'deny' ? 'fixture/denied' : 'ABORTED_BEFORE_DISPATCH');
    expect(answer).not.toHaveBeenCalled();
    expect(audit(owner.session)).toEqual([]);
    expect(await disk()).toBe(before);
  }));

  it('isolates Agent scopes, leaves unrelated tools unprompted and disposes tool plus approval hook', async () => withFixture(async ({ ctx, registry, create, execute }) => {
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const first = create();
    const second = create();
    const plain = create({ install: false });
    const answer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once');
    ctx.on('approval/request', answer);
    const passthrough = defineTool({
      name: 'fixture_read', description: 'A harmless unrelated tool', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'read',
    });
    first.agent.ctx.effect(() => first.agent.ctx.tools.register(passthrough));
    expect(await execute(first.agent, {}, undefined, 'fixture_read')).toMatchObject({ isError: false, value: 'read' });
    expect(answer).not.toHaveBeenCalled();
    expect(ctx.tools.schemas()).toEqual([]);
    failure(await execute(plain.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    failure(await execute(undefined, { action: 'list' }), 'UNKNOWN_TOOL');
    first.dispose?.();
    first.dispose?.();
    failure(await execute(first.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    // A replacement under the same name proves the old ask listener was removed.
    first.agent.ctx.effect(() => first.agent.ctx.tools.register({ ...passthrough, name: BOT_MANAGE_TOOL_NAME }));
    expect(await execute(first.agent, mutation('create'))).toMatchObject({ isError: false, value: 'read' });
    expect(answer).not.toHaveBeenCalled();
    successful(await execute(second.agent, { action: 'list' }));
    await second.scope.dispose();
    failure(await execute(second.agent, { action: 'list' }), 'UNKNOWN_TOOL');
  }));

  it('hands ownership to a replacement registration while stale disposers cannot remove its tool or approval hook', async () => withFixture(async ({ ctx, registry, create, execute }) => {
    const owner = create({ install: false });
    const originalList = vi.fn(async () => []);
    const originalDisposed = vi.fn();
    const currentDisposed = vi.fn();
    const old = registerBotManageTool(owner.agent, {
      list: originalList, get: registry.get.bind(registry), create: registry.create.bind(registry),
      update: registry.update.bind(registry), remove: registry.remove.bind(registry),
      memoryFor: registry.memoryFor.bind(registry), config: registry.config,
    }, originalDisposed);
    successful(await execute(owner.agent, { action: 'list' }));
    expect(originalList).toHaveBeenCalledTimes(1);
    const current = registerBotManageTool(owner.agent, registry, currentDisposed);
    expect(originalDisposed).toHaveBeenCalledTimes(1);
    old();
    old();
    expect(currentDisposed).not.toHaveBeenCalled();
    const answer = vi.fn<() => Promise<ApprovalOutcome>>()
      .mockResolvedValueOnce('rejected').mockResolvedValueOnce('allowed-once');
    ctx.on('approval/request', answer);
    failure(await execute(owner.agent, mutation('create')));
    expect(await registry.list()).toEqual([]);
    successful(await execute(owner.agent, mutation('create')));
    expect(answer).toHaveBeenCalledTimes(2);
    successful(await execute(owner.agent, { action: 'list' }));
    expect(originalList).toHaveBeenCalledTimes(1);
    expect(ctx.tools.schemas(owner.agent).filter((tool) => tool.name === BOT_MANAGE_TOOL_NAME)).toHaveLength(1);
    current();
    current();
    expect(currentDisposed).toHaveBeenCalledTimes(1);
    owner.agent.ctx.effect(() => owner.agent.ctx.tools.register(defineTool({
      name: BOT_MANAGE_TOOL_NAME, description: 'Replacement after complete cleanup', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'clean',
    })));
    expect(await execute(owner.agent, {})).toMatchObject({ isError: false, value: 'clean' });
    expect(answer).toHaveBeenCalledTimes(2);
    await owner.scope.dispose();
    expect(originalDisposed).toHaveBeenCalledTimes(1);
    expect(currentDisposed).toHaveBeenCalledTimes(1);
  }));

  it('defaults standard exposure off and gives only exact standard sessions a disposable registration', async () => withFixture(async ({ ctx, create, execute }) => {
    expect(Config(undefined).enableBotManageInStandard).toBe(false);
    expect(Config({ enableBotManageInStandard: true }).enableBotManageInStandard).toBe(true);
    expect(() => Config({ enableBotManageInStandard: 'true' } as never)).toThrow();
    const before = create({ install: false, agentPreset: 'standard' });
    await before.announce();
    failure(await execute(before.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    const plugin = ctx.plugin({ inject: ['tools', 'dshBots', 'agentPresets', 'agents'], apply: registerStandardBotManage });
    await plugin.await();
    const first = create({ install: false, agentPreset: 'standard' });
    const second = create({ install: false, agentPreset: 'standard' });
    const bot = create({ agentPreset: 'bot-alpha' });
    for (const subject of [first, second, bot]) await subject.announce();
    // Replayed creation announcements must not install a duplicate local tool.
    await first.announce();
    successful(await execute(first.agent, { action: 'list' }));
    for (const agentPreset of ['minimal', 'standard-copy', 'bot-standard', undefined]) {
      const other = create({ install: false, ...(agentPreset === undefined ? {} : { agentPreset }) });
      await other.announce();
      failure(await execute(other.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    }
    expect(ctx.tools.schemas()).toEqual([]);
    await first.scope.dispose();
    failure(await execute(first.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    successful(await execute(second.agent, { action: 'list' }));
    await plugin.dispose();
    failure(await execute(second.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    successful(await execute(bot.agent, { action: 'list' }));
    const after = create({ install: false, agentPreset: 'standard' });
    await after.announce();
    failure(await execute(after.agent, { action: 'list' }), 'UNKNOWN_TOOL');
  }));

  it('uses the restored composition when persisted selection differs from the creation header', async () => withFixture(async ({ ctx, create, execute }) => {
    await ctx.plugin({ inject: ['tools', 'dshBots', 'agentPresets', 'agents'], apply: registerStandardBotManage }).await();
    const intoStandard = create({ install: false, agentPreset: 'minimal', composedPreset: 'standard', blank: true, resume: true });
    const fromStandard = create({ install: false, agentPreset: 'standard', composedPreset: 'minimal', blank: true, resume: true });
    for (const subject of [intoStandard, fromStandard]) await subject.announce();
    expect(intoStandard.session.header.agentPreset).toBe('minimal');
    expect(intoStandard.session.snapshotEvents().findLast((event) => event.type === 'agent-preset/selected')).toMatchObject({ data: { agentPreset: 'standard' } });
    expect(fromStandard.session.header.agentPreset).toBe('standard');
    expect(fromStandard.session.snapshotEvents().findLast((event) => event.type === 'agent-preset/selected')).toMatchObject({ data: { agentPreset: 'minimal' } });
    successful(await execute(intoStandard.agent, { action: 'list' }));
    failure(await execute(fromStandard.agent, { action: 'list' }), 'UNKNOWN_TOOL');
  }));

  it('follows standard/minimal switches on blank sessions and removes switch listeners on disposal', async () => withFixture(async ({ ctx, create, execute }) => {
    const plugin = ctx.plugin({ inject: ['tools', 'dshBots', 'agentPresets', 'agents'], apply: registerStandardBotManage });
    await plugin.await();
    const standard = create({ install: false, agentPreset: 'standard', blank: true });
    const minimal = create({ install: false, agentPreset: 'minimal', blank: true });
    for (const subject of [standard, minimal]) await subject.announce();
    successful(await execute(standard.agent, { action: 'list' }));
    failure(await execute(minimal.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    await standard.select('minimal');
    await minimal.select('standard');
    failure(await execute(standard.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    successful(await execute(minimal.agent, { action: 'list' }));
    await standard.select('standard');
    await minimal.select('minimal');
    successful(await execute(standard.agent, { action: 'list' }));
    failure(await execute(minimal.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    expect(standard.session.header.agentPreset).toBe('standard');
    expect(minimal.session.header.agentPreset).toBe('minimal');
    expect([standard, minimal].every(({ session }) => !session.snapshotEvents().some((event) => event.type === 'turn/start'))).toBe(true);
    await minimal.scope.dispose();
    await minimal.select('standard');
    failure(await execute(minimal.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    await plugin.dispose();
    await standard.select('minimal');
    await standard.select('standard');
    failure(await execute(standard.agent, { action: 'list' }), 'UNKNOWN_TOOL');
  }));
});
