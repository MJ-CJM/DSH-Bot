import { registerAutomationGuard } from '../lib/host/delegate/guard.js';
import { NativeSchedules, bindingDomain, legacyDomain } from '../lib/host/native-schedule/service.js';
import { NativeScheduleRemote } from '../lib/host/automation/remote.js';
import { openAutomationStores } from '../lib/host/automation/store.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import ScheduleService from '@deepseek-ai/dsh-schedule';
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as toolSchedule from '@deepseek-ai/dsh-tool-schedule';
import { dump, load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import * as botContext from '../lib/host/bot-context.js';
import { composeBotPreset } from '../lib/host/composer.js';
import { Config as RegistryConfig } from '../lib/host/registry.js';
import { botCreateSchema, botSchema } from '../lib/shared/schema.js';

const nativeNames = ['schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update'];
const retiredNames = ['routine_create', 'routine_delete', 'routine_list', 'routine_run_now', 'routine_update'];
type Template = 'standard' | 'minimal';

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const home = fileURLToPath(new URL('../../../.dsh-dev/p2/r01/', import.meta.url));
  await mkdir(home, { recursive: true });
  const root = await mkdtemp(join(home, 'native-tools-'));
  const ctx = new Context();
  try { await test(await setup(ctx, root)); }
  finally {
    try { await ctx.fiber.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

async function setup(ctx: Context, root: string) {
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } });
  await mountAgentLoopTestHarness(ctx);
  await ctx.plugin(Storage).await();
  await ctx.plugin(storageJson, { root }).await();
  await ctx.plugin(storageDomain, { backend: 'json' }).await();
  // Actual schedule storage/tools; this fixture does not exercise delivery or
  // cold restoration. All reminders are future-dated and no model is called.
  const resolve = vi.fn(async () => { throw new Error('Delivery is outside R01'); });
  const headers = new Map<string, { createdAt: number; agentPreset: string; isSeeded?: boolean }>();
  ctx.provide('sessionController', { resolveAgent: resolve, inspect: async (id: string) => { const meta = headers.get(id); if (!meta) throw new Error('missing'); return { meta }; } } as unknown as Context['sessionController']);
  // Session persistence is a lifecycle double; schedule records use real JSON.
  ctx.provide('sessionPersistence', {
    stat: async (id: string) => headers.has(id) ? { header: headers.get(id) } : undefined,
    create: async () => ({ append: async () => {}, flush: async () => {}, close: async () => {} }),
  } as unknown as Context['sessionPersistence']);
  await ctx.plugin(ScheduleService, {}).await();
  const records = new Map<string, ReturnType<typeof botSchema.parse>>();
  ctx.provide('dshBots', {
    config: RegistryConfig({ dataDir: root }),
    list: async () => [...records.values()],
    get: async (id: string) => { const bot = records.get(id); if (!bot) throw new Error('missing'); return bot; },
    status: async () => [...records.values()].map(b => ({ id: b.id, presetId: `bot-${b.id}`, preset: { state: 'ok' } })),
    presetBot: (id: string) => structuredClone(records.get(id)),
    ensureHome: async (id: string) => ({ path: join(root, 'bots', id, 'home') }),
  } as unknown as Context['dshBots']);
  const readDocument = async (template: Template) => {
    const source = await readFile(new URL(`./fixtures/presets/${template}.patch.yml`, import.meta.url), 'utf8');
    const patch = load(source, { schema: entryListSchema }) as { insert: { config: PresetDefinition }[] }[];
    const declaration = patch[0]?.insert[0]?.config;
    if (!declaration) throw new Error('Missing template fixture');
    return { agentPreset: template, content: dump(declaration.plugins, { schema: entryListSchema }) };
  };
  let owner!: Context;
  await ctx.plugin({ inject: ['agents', 'tools', 'systemPrompt', 'dshBots', 'schedule'],
    apply(value: Context) { owner = value; } }).await();
  const preset = async (template: Template, deny: string[] = [], isBot = true) => {
    const id = `bot-${randomUUID().slice(0, 8)}`;
    const bot = botSchema.parse({ ...botCreateSchema.parse({ id, name: id, template, tools: { deny },
      memory: { enabled: false, injectLimit: 20 } }), createdAt: 1, updatedAt: 1, schemaVersion: 1 });
    records.set(id, bot);
    const definition = isBot ? await composeBotPreset(bot, {
      agentPresets: { readDocument } as unknown as Context['agentPresets'],
    }, { dataDir: root, presetIdPrefix: 'bot-', presetOrder: 50 }) : undefined;
    const rows = definition?.plugins ?? load((await readDocument(template)).content, { schema: entryListSchema }) as PresetDefinition['plugins'];
    const key = {};
    const scope = createScope(owner, key);
    // Mount the relevant composed rows via their public package entries. Other
    // template plugins (shell, web, etc.) are outside this focused runtime test.
    if (rows.some(row => row.name === '@deepseek-ai/dsh-tool-schedule')) {
      await scope.ctx.plugin(toolSchedule).await();
    }
    const plugin = isBot ? scope.ctx.plugin(botContext, { botId: id }) : undefined;
    await plugin?.await();
    const create = () => owner.agents.create({
      sessionId: SessionId(`r01-${randomUUID()}`),
      agentOptions: { provider: 'unused-mock', model: 'unused-mock', maxTokens: 128 },
      setup(agentCtx) {
        const agentKey = scopeOf(agentCtx);
        if (!agentKey) throw new Error('Agent scope missing');
        bindScopeParent(agentKey, key);
      },
    });
    return { create, plugin, scope, bot };
  };
  const names = (agent: Agent) => ctx.tools.schemas(agent).map(tool => tool.name).sort();
  const text = async (agent: Agent) => (await ctx.systemPrompt.assemble({ scope: agent, agent })).sections;
  const execute = (agent: Agent, name: string, args: unknown = {}) => ctx.tools.execute({
    agent, name, arguments: args, callId: ToolCallId(randomUUID()), signal: new AbortController().signal,
  });
  return { ctx, root, records, headers, preset, names, text, execute, resolve };
}

describe('R01 native scheduling with real Agents, ToolRuntime, schedule plugin and JSON storage', () => {
  it.each(['standard', 'minimal'] as const)('%s Bot exposes native scheduling, concise guidance and no retired tools', async template => fixture(async f => {
    const preset = await f.preset(template);
    const { agent } = await preset.create();
    expect(f.names(agent).filter(name => name.startsWith('schedule_'))).toEqual(nativeNames);
    expect(f.names(agent).some(name => name.startsWith('routine_'))).toBe(false);
    expect(f.names(agent)).toContain('bot_manage');
    expect(f.names(agent)).toContain('bot_delegate');
    expect(await f.text(agent)).toContainEqual(expect.objectContaining({
      name: 'dsh-bot:schedule', text: 'Use schedule_* for scheduled tasks.',
    }));
    expect(JSON.stringify(await f.text(agent))).not.toContain('routine_');
    for (const name of retiredNames) {
      expect(await f.execute(agent, name)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } });
    }
    if (!preset.plugin) throw new Error('Missing Bot context plugin');
    await preset.plugin.dispose();
    expect((await f.text(agent)).some(section => section.name === 'dsh-bot:schedule')).toBe(false);
    expect(f.names(agent).filter(name => name.startsWith('schedule_'))).toEqual(nativeNames);
    await preset.scope.dispose();
    expect(f.names(agent).filter(name => name.startsWith('schedule_'))).toEqual([]);
  }));

  it('ignores only retired deny entries without rewriting saved policy or weakening native denial', async () => fixture(async f => {
    const preset = await f.preset('standard', [...retiredNames, 'schedule_delete']);
    const { agent } = await preset.create();
    expect(botContext.getBotBinding(agent)?.botId).toBe(preset.bot.id);
    expect(f.names(agent).filter(name => name.startsWith('schedule_'))).toEqual(nativeNames.filter(name => name !== 'schedule_delete'));
    expect(preset.bot.tools.deny).toEqual([...retiredNames, 'schedule_delete']);
    expect(await f.execute(agent, 'schedule_delete', { id: 'missing' })).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } });
    const staleOnly = await f.preset('minimal', retiredNames);
    expect(f.names((await staleOnly.create()).agent).filter(name => name.startsWith('schedule_'))).toEqual(nativeNames);
    for (const unknown of ['routine_typo', 'unavailable_tool']) {
      const invalid = await f.preset('standard', [unknown]);
      await expect(invalid.create()).rejects.toThrow();
    }
  }));

  it('keeps native CRUD session-scoped and leaves non-Bot standard/minimal unchanged', async () => fixture(async f => {
    const plain = (await (await f.preset('standard', [], false)).create()).agent;
    const minimal = (await (await f.preset('minimal', [], false)).create()).agent;
    const before = f.names(plain);
    const bot = (await (await f.preset('standard')).create()).agent;
    expect(f.names(plain)).toEqual(before);
    expect(before.filter(name => name.startsWith('schedule_'))).toEqual(nativeNames);
    expect(f.names(minimal).filter(name => name.startsWith('schedule_'))).toEqual([]);
    for (const agent of [plain, minimal]) {
      expect(botContext.getBotBinding(agent)).toBeUndefined();
      expect((await f.text(agent)).some(section => section.name === 'dsh-bot:schedule')).toBe(false);
      expect(f.names(agent).some(name => name.startsWith('routine_'))).toBe(false);
    }
    for (const agent of [bot, plain]) {
      const created = await f.execute(agent, 'schedule_create', { title: 'Review', prompt: 'Review the project', every_seconds: 3600 });
      expect(created).toMatchObject({ isError: false, value: { kind: 'every', title: 'Review' } });
      const [record] = await f.ctx.schedule.list({ sessionId: agent.session.id });
      if (!record) throw new Error('Native create did not persist a schedule');
      expect(await f.execute(agent, 'schedule_list')).toMatchObject({ isError: false, value: [expect.objectContaining({ id: record.id })] });
      const other = agent === bot ? plain : bot;
      expect(await f.execute(other, 'schedule_update', { id: record.id, title: 'Wrong owner' })).toMatchObject({
        value: { code: 'schedule_not_found' },
      });
      expect(await f.execute(agent, 'schedule_update', { id: record.id, title: 'Edited' })).toMatchObject({
        isError: false, value: { title: 'Edited' },
      });
      expect(await f.execute(agent, 'schedule_delete', { id: record.id })).toMatchObject({ isError: false, value: { deleted: true } });
      expect(await f.ctx.schedule.list({ sessionId: agent.session.id })).toEqual([]);
    }
    expect(await f.ctx.schedule.catalog()).toEqual([]);
    expect(f.resolve).not.toHaveBeenCalled();
  }));
});


describe('R02 native task association and retired storage', () => {
  it('allows native schedule creation only from the authoritative main Bot conversation', async () => fixture(async f => {
    const preset = await f.preset('standard');
    const main = await preset.create(); const legacy = await preset.create();
    f.ctx.dshBots.mainSessions = {} as NonNullable<Context['dshBots']['mainSessions']>;
    f.ctx.dshBots.get = async () => preset.bot;
    f.ctx.dshBots.openConversation = vi.fn(async () => ({ sessionId: main.agent.session.id }));
    registerAutomationGuard(f.ctx, {} as Parameters<typeof registerAutomationGuard>[1]);
    const args = { title: 'Main only', prompt: 'Task', every_seconds: 3600 };
    expect((await f.execute(legacy.agent, 'schedule_create', args)).isError).toBe(true);
    expect(await f.ctx.schedule.catalog()).toEqual([]);
    expect((await f.execute(main.agent, 'schedule_create', args)).isError).toBe(false);
    expect((await f.ctx.schedule.catalog()).map(row => row.sessionId)).toEqual([main.agent.session.id]);
  }));

  it('maps real native tool creation on changed, persists, follows native edits/deletion and refuses same-ID replacement', async () => fixture(async f => {
    const p = await f.preset('standard'); const { agent } = await p.create();
    const native = new NativeSchedules(f.ctx, f.ctx.dshBots); await native.start();
    const result = await f.execute(agent, 'schedule_create', { title: 'Native task', prompt: 'Native prompt', every_seconds: 3600 });
    expect(result.isError, JSON.stringify(result)).toBe(false);
    const task = (await f.ctx.schedule.catalog())[0]; if (!task) throw new Error('Missing task');
    // Read the durable sidecar, without triggering aggregate/reconcile ourselves.
    await vi.waitFor(async () => {
      const saved = await readFile(join(f.root, `${bindingDomain.name}.json`), 'utf8');
      expect(saved).toContain(task.id); expect(saved).toContain(agent.session.id);
    });
    const first = await native.aggregate();
    expect(first.bindings).toEqual([{ botId: p.bot.id, botCreatedAt: p.bot.createdAt, sessionId: agent.session.id, nativeScheduleId: task.id }]);
    const { sessionId: _session, status: _status, lastDelivery: _last, ...expected } = task;
    const changed = await f.ctx.schedule.update({ id: task.id, sessionId: task.sessionId, expected, title: 'Edited natively' });
    expect(changed).toMatchObject({ updated: true });
    expect((await native.task(task.id)).task.title).toBe('Edited natively');
    await native.close();
    const reopened = new NativeSchedules(f.ctx, f.ctx.dshBots); await reopened.start();
    expect((await reopened.aggregate()).bindings).toEqual(first.bindings);
    f.records.set(p.bot.id, { ...p.bot, createdAt: 100, updatedAt: 100 });
    expect((await reopened.aggregate()).bindings).toEqual([]);
    await expect(reopened.task(task.id)).rejects.toMatchObject({ code: 'automation/not-found' });
    await f.ctx.schedule.delete({ id: task.id, sessionId: task.sessionId });
    expect((await reopened.aggregate()).bindings).toEqual([]);
    expect(await f.ctx.schedule.catalog()).toEqual([]);
  }));
  it('reconciles reliable cold session headers only, skips old/foreign/unreadable sessions and bad legacy rows', async () => fixture(async f => {
    const p = await f.preset('minimal');
    const native = new NativeSchedules(f.ctx, f.ctx.dshBots);
    const old = await f.ctx.storageDomain.open(legacyDomain);
    const legacyId = randomUUID();
    await old.table('routines').put(legacyId, { id: legacyId, botId: p.bot.id, botCreatedAt: 1, title: 'Old task', prompt: 'Old prompt', rule: { kind: 'every', everySeconds: 60 }, timeZone: 'UTC', enabled: true, misfirePolicy: 'latest', schemaVersion: 1, revision: 1, ruleRevision: 1, createdBy: { kind: 'user' }, workspacePolicy: 'bots', anchorAt: 1, nextRunAt: 60001, createdAt: 1, updatedAt: 1 });
    await old.table('routines').put('broken', { bad: true });
    await old.table('runs').put('untouched', { unknown: 'preserved' });
    await old.close();
    const before = await readFile(join(f.root, 'dsh_bot_automation.json'), 'utf8');
    f.headers.set('cold', { createdAt: 2, agentPreset: `bot-${p.bot.id}` });
    f.headers.set('old', { createdAt: 0, agentPreset: `bot-${p.bot.id}` });
    f.headers.set('foreign', { createdAt: 2, agentPreset: 'standard' });
    f.headers.set('fork', { createdAt: 2, agentPreset: `bot-${p.bot.id}`, isSeeded: true });
    for (const id of ['cold', 'old', 'foreign', 'missing', 'fork']) await f.ctx.schedule.create(SessionId(id), { title: p.bot.name, prompt: 'Task', every_seconds: 3600 });
    await native.start();
    const result = await native.aggregate();
    expect(result.bindings.map(b => b.sessionId)).toEqual(['cold']);
    expect(result.legacy).toHaveLength(1); expect(result.legacySkipped).toBe(1);
    expect(await readFile(join(f.root, 'dsh_bot_automation.json'), 'utf8')).toBe(before);
    f.records.delete(p.bot.id);
    expect((await native.aggregate()).legacy).toHaveLength(1); // Orphans remain deletable from the overview.
    await native.deleteLegacy(legacyId); await native.close();
    const after = await readFile(join(f.root, 'dsh_bot_automation.json'), 'utf8');
    expect(after).toContain('preserved'); expect(after).toContain('broken'); expect(after).not.toContain('Old task');
  }));
  it('ignores malformed legacy files without overwriting them', async () => fixture(async f => {
    const path = join(f.root, 'dsh_bot_automation.json'); await writeFile(path, '{ broken JSON');
    const native = new NativeSchedules(f.ctx, f.ctx.dshBots); await native.start();
    expect(await native.aggregate()).toMatchObject({ legacy: [], legacyUnavailable: true });
    await native.close(); expect(await readFile(path, 'utf8')).toBe('{ broken JSON');
  }));
  it('manual Remote requires confirmation, rejects stale prompt and dedupes concurrent requests without touching native timing', async () => fixture(async f => {
    const p = await f.preset('minimal'); const { agent } = await p.create();
    const native = new NativeSchedules(f.ctx, f.ctx.dshBots); await native.start();
    const task = await f.ctx.schedule.create(agent.session.id, { title: 'Manual', prompt: 'Execute once', every_seconds: 3600 });
    const stores = await openAutomationStores(f.ctx, { resolveBot: async () => ({ bot: p.bot, presetId: `bot-${p.bot.id}` }) });
    const remote = new NativeScheduleRemote(f.ctx, native, request => stores.runs.enqueue(request));
    const expected = { title: task.title, prompt: task.prompt, botCreatedAt: p.bot.createdAt };
    await expect(remote.runNow(task.id, randomUUID(), expected, false as true)).rejects.toMatchObject({ code: 'automation/invalid' });
    await expect(remote.runNow(task.id, randomUUID(), { ...expected, prompt: 'stale' }, true)).rejects.toMatchObject({ code: 'automation/conflict' });
    expect(stores.runs.list()).toEqual([]);
    const op = randomUUID(); const [a,b] = await Promise.all([remote.runNow(task.id, op, expected, true), remote.runNow(task.id, op, expected, true)]);
    expect(a).toEqual(b); expect(stores.runs.list()).toHaveLength(1);
    expect((await f.ctx.schedule.catalog())[0]?.scheduledAt).toBe(task.scheduledAt);
    const admitted = await stores.runs.reserve(a.id);
    expect(admitted).toMatchObject({ status: 'running', slotHeld: true });
    // No daily quota or concurrency admission policy remains.
    for (let i = 0; i < 21; i++) {
      const run = await remote.runNow(task.id, randomUUID(), expected, true); await stores.runs.reserve(run.id);
    }
    expect(stores.runs.list().filter(r => r.slotHeld)).toHaveLength(22);
    await stores.close();
    const again = await openAutomationStores(f.ctx, { resolveBot: async () => ({ bot: p.bot, presetId: `bot-${p.bot.id}` }) });
    expect(again.runs.list().every(r => r.status === 'recovery_needed')).toBe(true);
    expect(await remote.runNow(task.id, op, expected, true).catch(() => undefined)).toBeUndefined();
  }));
});
