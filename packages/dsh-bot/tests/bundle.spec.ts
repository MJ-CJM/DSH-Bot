import type {} from '@deepseek-ai/dsh-jobs';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire, SourceMap } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { describe, expect, it, vi } from 'vitest';
import { assertClientInput } from '../build/client-policy.js';
import * as host from '../lib/index.js';
import en from '../locale/en.json';
import zh from '../locale/zh.json';
import * as primitives from './client/platform-primitives.js';

const require = createRequire(import.meta.url);

describe('built bundle contract', () => {
  it('excludes all test/spike registrars from the publish allowlist and production entry', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.files).not.toContain('tests'); expect(manifest.files).not.toContain('scripts');
    expect(manifest.files).not.toContain('spikes');
    const text = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8') + readFileSync(new URL('../lib/host/index.js', import.meta.url), 'utf8');
    expect(text).not.toMatch(/b2b-(?:spike|host|release)-profile|fixture-approved|B2B_PERSONA/);
  });
  it('distributes relocatable Client CSS labels and sourcemaps without the build checkout path', () => {
    const packageRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
    for (const file of ['client.js', 'client.js.map']) {
      const text = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
      expect(text).not.toContain(packageRoot);
    }
  });
  it('allows only package Client code and the exact public Remote helper', () => {
    const packageRoot = fileURLToPath(new URL('../', import.meta.url));
    const remoteInfo = require.resolve('@deepseek-ai/dsh-typert-protocol/remote-info');
    const allowed = new Set([remoteInfo]);
    expect(() => assertClientInput(join(packageRoot, 'src/shared/remote-contract.ts'), packageRoot, allowed)).not.toThrow();
    expect(() => assertClientInput(remoteInfo, packageRoot, allowed)).not.toThrow();
    expect(() => assertClientInput(join(packageRoot, 'src/host/registry.ts'), packageRoot, allowed)).toThrow('Host module');
    expect(() => assertClientInput(require.resolve('@deepseek-ai/dsh-typert-protocol'), packageRoot, allowed))
      .toThrow('unapproved dependency');
    expect(() => assertClientInput(require.resolve('zod'), packageRoot, allowed)).toThrow('unapproved dependency');
    expect(() => assertClientInput(join(packageRoot, '../../spikes/fixture.ts'), packageRoot, allowed))
      .toThrow('outside this package');
  });

  it.each([true, false, 'corrupt-memory', 'corrupt-transfer'])('loads Host case %s and disposes exactly once', async nativeEnabled => {
    const isolatedHome = fileURLToPath(new URL('../../../.dsh-dev/', import.meta.url));
    await mkdir(isolatedHome, { recursive: true });
    const root = await mkdtemp(join(isolatedHome, 't04-bundle-'));
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;
    const ctx = new Context();
    const messages: unknown[] = [];
    ctx.logger.exporter({ export: (message) => messages.push(message.args.length === 1 ? message.args[0] : message.args) });
    try {
      await ctx.plugin(Storage).await();
      await ctx.plugin(storageJson, { root }).await();
      await ctx.plugin(storageDomain, { backend: 'json' }).await();
      await ctx.plugin(SystemPrompt, {}).await();
      await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
      ctx.provide('agentPresets', {
        async register(definition: { id: string }) { expect(definition.id).toBe('dsh-bot-group-root'); return async () => {}; },
        list: () => [],
      } as unknown as Context['agentPresets']);
      ctx.provide('loader', { await: async () => {} } as unknown as Context['loader']);
      ctx.provide('agents', { get: () => undefined } as unknown as Context['agents']);
      // This bundle test verifies activation/cleanup only; the real execution
      // services are exercised separately by automation-profile.mts.
      ctx.provide('sessionController', {} as Context['sessionController']);
      ctx.provide('sessionPersistence', {} as Context['sessionPersistence']);
      ctx.provide('sessions', {} as Context['sessions']);
      ctx.provide('workspaceRegistry', {} as Context['workspaceRegistry']);
      if (nativeEnabled) ctx.provide('schedule', { catalog: async () => [] } as unknown as Context['schedule']);
      ctx.provide('subagents', {} as Context['subagents']);
      ctx.provide('jobs', { attachController: () => () => {} } as unknown as Context['jobs']);
      const registrations: string[] = [];
      ctx.provide('typert', {
        register(contribution: { package: string }) {
          registrations.push(contribution.package);
          return async () => { registrations.splice(registrations.indexOf(contribution.package), 1); };
        },
      } as unknown as Context['typert']);
      if (nativeEnabled === 'corrupt-memory') await writeFile(join(root, 'dsh_bot_reference_memory.json'), '{synthetic-invalid');
      if (nativeEnabled === 'corrupt-transfer') await writeFile(join(root, 'dsh_bot_workspace.json'), '{synthetic-invalid');
      const fork = ctx.plugin(host, { seedExamples: false, dataDir: root, presetIdPrefix: 'bot-', presetOrder: 50 });
      await fork.await();
      await vi.waitFor(() => {
        const failure = messages.find((message) => typeof message === 'string'
          && message.startsWith('[dsh-bot] startup failed bot='));
        if (typeof failure === 'string') throw new Error(failure);
        expect(messages).toContain('[dsh-bot] loaded');
      });
      expect(registrations).toEqual(['dsh-bot/automation', 'dsh-bot', 'dsh-bot/integrations', 'dsh-bot/messaging', 'dsh-bot/workspace',
        'dsh-bot/collaboration', 'dsh-bot/groups']);
      if (nativeEnabled === 'corrupt-memory') expect(ctx.get('dshBotReferenceMemory')).toBeUndefined();
      if (nativeEnabled === 'corrupt-transfer') expect(ctx.get('dshBotWorkspace')).toBeUndefined();
      await fork.dispose();
      await fork.dispose();
      expect(registrations).toEqual([]);
      expect(messages.filter((message) => message === '[dsh-bot] unloaded')).toHaveLength(1);
    } finally {
      try { await ctx.fiber.dispose(); } finally {
        if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('registers a lazy Client factory using only the supplied platform require', () => {
    const source = readFileSync(require.resolve('dsh-bot/client'), 'utf8');
    expect(source.startsWith('window.__ModuleLoader__.load(')).toBe(true);
    const registrations: {
      id: string;
      factory: (require: (id: string) => unknown) => { inject: string[]; apply: unknown };
    }[] = [];
    runInNewContext(source, {
      window: { __ModuleLoader__: { load: (entry: typeof registrations[number]) => registrations.push(entry) } },
    }, { timeout: 1000 });
    expect(registrations).toHaveLength(1);
    const entry = registrations[0];
    expect(entry?.id).toBe('dsh-bot');
    const requests: string[] = [];
    const plugin = entry?.factory((id) => {
      requests.push(id);
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
      if (!['react', 'react/jsx-runtime', 'zod'].includes(id)) throw new Error(`Unexpected platform import: ${id}`);
      return require(id);
    });
    expect([...new Set(requests)].sort()).toEqual(['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime', 'zod']);
    expect(plugin?.inject).toEqual(['slots', 'locale', 'remote', 'uiWorkspace', 'workspaces', 'sessions', 'layout']);
    expect(typeof plugin?.apply).toBe('function');
  });

  it('ships a linked source map with original sources and correct wrapper offsets', () => {
    const clientPath = require.resolve('dsh-bot/client');
    const source = readFileSync(clientPath, 'utf8');
    expect(source).toMatch(/\/\/# sourceMappingURL=client\.js\.map\s*$/);
    const payload = JSON.parse(readFileSync(`${clientPath}.map`, 'utf8'));
    expect(payload.version).toBe(3);
    const dependencySources = payload.sources.filter((path: string) => path.includes('/node_modules/'));
    expect(dependencySources).toHaveLength(5);
    const publicDependency = new RegExp(`@deepseek-ai/(${[
      'dsh-typert-protocol/lib/types/remote-info\\.js', 'dsh-schedule/lib/typert\\.remote-client\\.js',
      'dsh-session/lib/types/surface\\.js', 'schemastery/lib/index\\.mjs', 'cosmokit/lib/index\\.js',
    ].join('|')})$`);
    expect(dependencySources.every((path: string) => publicDependency.test(path))).toBe(true);
    expect(payload.sources.some((path: string) => /\/(?:host|spikes)\//.test(path))).toBe(false);
    const generatedLine = source.split('\n').findIndex((line) => line.startsWith('function BotsIcon('));
    expect(generatedLine).toBeGreaterThan(0);
    const entry = new SourceMap(payload).findEntry(generatedLine, 0);
    if (!('originalSource' in entry) || !('originalLine' in entry)) {
      throw new Error('Icon declaration is not mapped to its original source');
    }
    expect(entry.originalSource).toMatch(/src\/client\/index\.tsx$/);
    const sourceIndex = payload.sources.indexOf(entry.originalSource);
    const originalLines = payload.sourcesContent[sourceIndex].split('\n');
    expect(originalLines[entry.originalLine]).toContain('function BotsIcon(');
  });

  it('ships component-owned theme CSS without literal colors or embedded shared runtimes', () => {
    const source = readFileSync(require.resolve('dsh-bot/client'), 'utf8');
    const payload = JSON.parse(readFileSync(`${require.resolve('dsh-bot/client')}.map`, 'utf8'));
    expect(source).toContain('--dsw-alias-bg-layer-1');
    expect(source).toContain('bots_page');
    expect(source).not.toMatch(/#[\da-f]{6}\b/i);
    expect(payload.sources.some((path: string) => /node_modules\/(@deepseek-ai\/cordis|react(?:-dom)?|zod)\//.test(path))).toBe(false);
    expect(source).not.toContain('document.createElement("style")');
  });

  it('exports matching bilingual resources and an SVG within the icon limit', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    expect(Object.keys(en.meta).sort()).toEqual(Object.keys(zh.meta).sort());
    expect(Object.keys(en.ui).sort()).toEqual(Object.keys(zh.ui).sort());
    expect(Object.keys(en.tools).sort()).toEqual(Object.keys(zh.tools).sort());
    for (const dictionary of [en.tools, zh.tools]) {
      expect(Object.keys(dictionary).sort()).toEqual([
        'bot_delegate.approval', 'bot_delegate.description',
        'bot_manage.approval.combined', 'bot_manage.approval.create', 'bot_manage.approval.delete',
        'bot_manage.approval.deleteMemories', 'bot_manage.approval.keepMemories',
        'bot_manage.approval.selfDelete', 'bot_manage.approval.selfUpdate', 'bot_manage.approval.update',
        'bot_message.approval', 'bot_message.description', 'bot_notify.approval', 'bot_notify.description', 'schedule.guidance',
      ]);
      for (const value of Object.values(dictionary)) expect(value.trim()).not.toBe('');
    }
    for (const key of Object.keys(en.tools) as Array<keyof typeof en.tools>) {
      expect(en.tools[key].match(/\{\w+\}/g)?.sort()).toEqual(zh.tools[key].match(/\{\w+\}/g)?.sort());
    }
    expect(en.meta.title).toBe('DSH-Bot Personal Agents');
    expect(zh.meta.title).toBe('DSH-Bot 个人智能体');
    expect(require.resolve('dsh-bot/locale/en.json')).toMatch(/locale\/en\.json$/);
    expect(require.resolve('dsh-bot/locale/zh.json')).toMatch(/locale\/zh\.json$/);
    const icon = require.resolve('dsh-bot/icon');
    expect(statSync(icon).size).toBeLessThanOrEqual(256 * 1024);
    expect(readFileSync(icon, 'utf8')).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
  });

  it('keeps bot_manage opt-in for standard sessions in the public Host Config', () => {
    expect(host.Config({}).enableBotManageInStandard).toBe(false);
    expect(host.Config({ enableBotManageInStandard: true }).enableBotManageInStandard).toBe(true);
    expect(() => host.Config({ enableBotManageInStandard: 'yes' } as never)).toThrow();
  });

  it.each(['native', 'missing-service', 'missing-registry', 'missing-slot', 'registration-failure'] as const)(
    'activates the built Client with a peer-owned Conversation service (%s) and releases resources',
    async (mode) => {
    const ctx = new Context();
    const active = new Set<string>();
    const releases: string[] = [];
    const register = (resource: string) => {
      active.add(resource);
      return () => { active.delete(resource); releases.push(resource); };
    };
    // Service doubles check the plugin's ownership contract, not browser rendering.
    ctx.provide('locale', {
      bind: () => (key: keyof typeof en.ui) => en.ui[key],
      register: () => {
        expect(active.has('remote.dshBot')).toBe(true);
        return register('dictionaries');
      },
    } as unknown as Context['locale']);
    ctx.provide('slots', {
      inject: (name: string, callback: () => () => void) => mode === 'missing-slot' && name === 'conversation.chat.node' ? () => {} : callback(),
      register: (options: { name: string }) => register(options.name),
    } as unknown as Context['slots']);
    ctx.provide('uiWorkspace', { openWorkspace: vi.fn() } as unknown as Context['uiWorkspace']);
    ctx.provide('layout', { selectPanel: vi.fn() } as unknown as Context['layout']);
    ctx.provide('workspaces', { list: {} } as unknown as Context['workspaces']);
    ctx.provide('sessions', { list: {} } as unknown as Context['sessions']);
    const mountedEndpoints: string[] = [];
    ctx.provide('remote', {
      $on: () => register('schedule.changed'),
      async $mount(contribution: { package: string; descriptors: { namespace: string; method: string }[] }) {
        expect(['dsh-bot', 'dsh-bot/automation', '@deepseek-ai/dsh-schedule', 'dsh-bot/integrations', 'dsh-bot/messaging', 'dsh-bot/workspace',
          'dsh-bot/collaboration', 'dsh-bot/groups']).toContain(contribution.package);
        await Promise.resolve();
        mountedEndpoints.push(...contribution.descriptors.map((entry) => `${entry.namespace}/${entry.method}`));
        const dispose = register(contribution.package === 'dsh-bot' ? 'remote.dshBot' :
          contribution.package === 'dsh-bot/automation' ? 'remote.automation' : contribution.package === 'dsh-bot/integrations' ?
          'remote.p34' :
          contribution.package === 'dsh-bot/collaboration' ? 'remote.collaboration' : contribution.package === 'dsh-bot/groups' ?
          'remote.groups' :
          contribution.package === 'dsh-bot/messaging' ? 'remote.messaging' : contribution.package === 'dsh-bot/workspace' ?
          'remote.workspace' :
          'remote.schedule');
        return async () => { dispose(); };
      },
    } as unknown as Context['remote']);
    let conversation: typeof import('@deepseek-ai/dsh-client-ui-conversation/client') | undefined;
    new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8'))({
      __ModuleLoader__: { load(entry: { factory: (load: (id: string) => unknown) => typeof conversation }) {
        conversation = entry.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives :
          id === '@deepseek-ai/dsh-client-store' ? { notifySubscribers: (listeners: Set<() => void>) => { for (const listener of listeners) listener(); } }
            : require(id));
      } },
    });
    if (!conversation) throw Error('Native Conversation factory did not load');
    const api = conversation;
    let assembly: InstanceType<typeof api.UiConversation> | undefined;
    const owner = ctx.plugin({ apply(scope: Context) {
      if (mode === 'missing-service') return;
      if (mode === 'missing-registry') { scope.provide('uiConversation', {} as Context['uiConversation']); return; }
      assembly = new api.UiConversation(scope, ctx.sessions as never);
      if (mode === 'registration-failure') vi.spyOn(assembly.events, 'register').mockImplementation(() => { throw Error('Unsupported registry'); });
    } });
    await owner.await();
    let plugin: { inject: string[]; apply: (ctx: Context) => Promise<void> } | undefined;
    runInNewContext(readFileSync(require.resolve('dsh-bot/client'), 'utf8'), {
      window: { __ModuleLoader__: {
        load: (entry: { factory: (require: (id: string) => unknown) => typeof plugin }) => {
          plugin = entry.factory((id) => id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(id));
        },
      } },
    }, { timeout: 1000 });
    if (!plugin) throw new Error('Client factory did not register');
    try {
      const fork = ctx.plugin(plugin);
      await fork.await();
      expect(fork.state).toBe(2);
      expect(assembly?.events.entries().map(d => d.kind) ?? []).toEqual(mode === 'native' ? ['dsh-bot-message'] : []);
      const resources = [...(mode === 'native' ?
        ['conversation.chat.node'] :
        []), 'conversation.session.header.utilities', 'dictionaries', 'main',
        'remote.automation', 'remote.collaboration', 'remote.dshBot', 'remote.groups', 'remote.messaging', 'remote.p34', 'remote.schedule',
        'remote.workspace', 'schedule.changed',
        'sidebar.footer.action', 'sidebar.panellist', 'sidebar.session.row.hover', 'sidebar.session.row.leading'];
      expect([...active].sort()).toEqual(resources);
      expect(mountedEndpoints.sort()).toEqual([
        'dshBot.activity/list', 'dshBot.activity/markRead', 'dshBot.automation/status',
        'dshBot.collaboration/board', 'dshBot.collaboration/createTask', 'dshBot.collaboration/ensure', 'dshBot.collaboration/updateTask',
        'dshBot.connectors/applyIdle', 'dshBot.connectors/catalog', 'dshBot.connectors/importLegacy', 'dshBot.connectors/saveAssignment',
          'dshBot.connectors/saveDefinition',
        'dshBot.groups/archive', 'dshBot.groups/cancel', 'dshBot.groups/create', 'dshBot.groups/edit', 'dshBot.groups/list', 'dshBot.groups/markRead',
          'dshBot.groups/send', 'dshBot.groups/view',
        'dshBot.im/status', 'dshBot.memory/count', 'dshBot.memory/delete', 'dshBot.memory/list', 'dshBot.memory/quarantineCount', 'dshBot.memory/save',
          'dshBot.memory/search', 'dshBot.memory/update', 'dshBot.messaging/request',
        'dshBot.nativeSchedule/aggregate', 'dshBot.nativeSchedule/deleteLegacy', 'dshBot.nativeSchedule/runNow', 'dshBot.notifications/markRead',
          'dshBot.notifications/savePolicy', 'dshBot.notifications/test', 'dshBot.referenceMemory/request', 'dshBot.run/get', 'dshBot.run/list',
          'dshBot.workspace/request',
        'dshBot/catalogInfo', 'dshBot/create', 'dshBot/delete', 'dshBot/duplicate', 'dshBot/ensureBotsWorkspace', 'dshBot/ensureHome', 'dshBot/get',
          'dshBot/list', 'dshBot/openConversation', 'dshBot/status', 'dshBot/update', 'dshBot/watch',
        'schedule/catalog', 'schedule/delete', 'schedule/history', 'schedule/list', 'schedule/update',
      ]);
      await fork.dispose();
      await fork.dispose();
      expect([...active]).toEqual([]);
      expect(assembly?.events.entries() ?? []).toEqual([]);
      expect(releases.sort()).toEqual([...resources, ...(mode === 'registration-failure' ?
        ['conversation.chat.node'] :
        []),
        'conversation.session.header.utilities', 'sidebar.session.row.leading', 'sidebar.session.row.hover'].sort());
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
