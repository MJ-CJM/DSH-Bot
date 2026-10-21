import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  ctx.provide('sessionController', { resolveAgent: resolve } as unknown as Context['sessionController']);
  // Session persistence is a lifecycle double; schedule records use real JSON.
  ctx.provide('sessionPersistence', {
    create: async () => ({ append: async () => {}, flush: async () => {}, close: async () => {} }),
  } as unknown as Context['sessionPersistence']);
  await ctx.plugin(ScheduleService, {}).await();
  const records = new Map<string, ReturnType<typeof botSchema.parse>>();
  ctx.provide('dshBots', {
    config: RegistryConfig({ dataDir: root }),
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
  return { ctx, preset, names, text, execute, resolve };
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
