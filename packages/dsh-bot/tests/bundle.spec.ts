import { readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire, SourceMap } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import { describe, expect, it, vi } from 'vitest';
import { assertClientInput } from '../build/client-policy.js';
import * as host from '../lib/index.js';
import en from '../locale/en.json';
import zh from '../locale/zh.json';

const require = createRequire(import.meta.url);

describe('built bundle contract', () => {
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

  it('loads the built Host and disposes its effect exactly once', async () => {
    const isolatedHome = fileURLToPath(new URL('../../../.dsh-dev/', import.meta.url));
    await mkdir(isolatedHome, { recursive: true });
    const root = await mkdtemp(join(isolatedHome, 't04-bundle-'));
    const ctx = new Context();
    const messages: unknown[] = [];
    ctx.logger.exporter({ export: (message) => messages.push(message.args.length === 1 ? message.args[0] : message.args) });
    try {
      await ctx.plugin(Storage).await();
      await ctx.plugin(storageJson, { root }).await();
      await ctx.plugin(storageDomain, { backend: 'json' }).await();
      ctx.provide('agentPresets', {
        async register() { throw new Error('Empty registry must not register a preset'); },
        list: () => [],
      } as unknown as Context['agentPresets']);
      ctx.provide('loader', { await: async () => {} } as unknown as Context['loader']);
      const registrations: string[] = [];
      ctx.provide('typert', {
        register(contribution: { package: string }) {
          registrations.push(contribution.package);
          return async () => { registrations.splice(registrations.indexOf(contribution.package), 1); };
        },
      } as unknown as Context['typert']);
      const fork = ctx.plugin(host, { seedExamples: false, dataDir: root, presetIdPrefix: 'bot-', presetOrder: 50 });
      await fork.await();
      await vi.waitFor(() => {
        const failure = messages.find((message) => typeof message === 'string'
          && message.startsWith('[dsh-bot] startup failed bot='));
        if (typeof failure === 'string') throw new Error(failure);
        expect(messages).toContain('[dsh-bot] loaded');
      });
      expect(registrations).toEqual(['dsh-bot']);
      await fork.dispose();
      await fork.dispose();
      expect(registrations).toEqual([]);
      expect(messages.filter((message) => message === '[dsh-bot] unloaded')).toHaveLength(1);
    } finally {
      try { await ctx.fiber.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
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
      if (!['react/jsx-runtime', 'zod'].includes(id)) throw new Error(`Unexpected platform import: ${id}`);
      return require(id);
    });
    expect([...new Set(requests)].sort()).toEqual(['react/jsx-runtime', 'zod']);
    expect(plugin?.inject).toEqual(['slots', 'locale', 'remote']);
    expect(typeof plugin?.apply).toBe('function');
  });

  it('ships a linked source map with original sources and correct wrapper offsets', () => {
    const clientPath = require.resolve('dsh-bot/client');
    const source = readFileSync(clientPath, 'utf8');
    expect(source).toMatch(/\/\/# sourceMappingURL=client\.js\.map\s*$/);
    const payload = JSON.parse(readFileSync(`${clientPath}.map`, 'utf8'));
    expect(payload.version).toBe(3);
    const dependencySources = payload.sources.filter((path: string) => path.includes('/node_modules/'));
    expect(dependencySources).toHaveLength(1);
    expect(dependencySources[0]).toMatch(/@deepseek-ai\/dsh-typert-protocol\/lib\/types\/remote-info\.js$/);
    expect(payload.sources.some((path: string) => /\/(?:host|spikes)\//.test(path))).toBe(false);
    const generatedLine = source.split('\n').findIndex((line) => line.startsWith('function DshBotBadge('));
    expect(generatedLine).toBeGreaterThan(0);
    const entry = new SourceMap(payload).findEntry(generatedLine, 0);
    if (!('originalSource' in entry) || !('originalLine' in entry)) {
      throw new Error('Badge declaration is not mapped to its original source');
    }
    expect(entry.originalSource).toMatch(/src\/client\/index\.tsx$/);
    const sourceIndex = payload.sources.indexOf(entry.originalSource);
    const originalLines = payload.sourcesContent[sourceIndex].split('\n');
    expect(originalLines[entry.originalLine]).toContain('function DshBotBadge(');
  });

  it('exports matching bilingual resources and an SVG within the icon limit', () => {
    expect(Object.keys(en.meta).sort()).toEqual(Object.keys(zh.meta).sort());
    expect(Object.keys(en.ui).sort()).toEqual(Object.keys(zh.ui).sort());
    expect(en.meta.title).toBe('DSH-Bot');
    expect(zh.meta.title).toBe('DSH-Bot 多智能体');
    expect(require.resolve('dsh-bot/locale/en.json')).toMatch(/locale\/en\.json$/);
    expect(require.resolve('dsh-bot/locale/zh.json')).toMatch(/locale\/zh\.json$/);
    const icon = require.resolve('dsh-bot/icon');
    expect(statSync(icon).size).toBeLessThanOrEqual(256 * 1024);
    expect(readFileSync(icon, 'utf8')).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
  });

  it('awaits Remote mounting and releases its contribution, dictionaries and slot on unload', async () => {
    const ctx = new Context();
    const active = new Set<string>();
    const releases: string[] = [];
    const register = (resource: string) => {
      active.add(resource);
      return () => { active.delete(resource); releases.push(resource); };
    };
    // Service doubles check the plugin's ownership contract, not browser rendering.
    ctx.provide('locale', {
      register: () => {
        expect(active.has('remote.dshBot')).toBe(true);
        return register('dictionaries');
      },
    } as unknown as Context['locale']);
    ctx.provide('slots', {
      inject: (_name: string, callback: () => () => void) => callback(),
      register: () => register('badge'),
    } as unknown as Context['slots']);
    const mountedEndpoints: string[] = [];
    ctx.provide('remote', {
      async $mount(contribution: { package: string; descriptors: { namespace: string; method: string }[] }) {
        expect(contribution.package).toBe('dsh-bot');
        await Promise.resolve();
        mountedEndpoints.push(...contribution.descriptors.map((entry) => `${entry.namespace}/${entry.method}`));
        const dispose = register('remote.dshBot');
        return async () => { dispose(); };
      },
    } as unknown as Context['remote']);
    let plugin: { inject: string[]; apply: (ctx: Context) => Promise<void> } | undefined;
    runInNewContext(readFileSync(require.resolve('dsh-bot/client'), 'utf8'), {
      window: { __ModuleLoader__: {
        load: (entry: { factory: (require: NodeJS.Require) => typeof plugin }) => { plugin = entry.factory(require); },
      } },
    }, { timeout: 1000 });
    if (!plugin) throw new Error('Client factory did not register');
    try {
      const fork = ctx.plugin(plugin);
      await fork.await();
      expect([...active].sort()).toEqual(['badge', 'dictionaries', 'remote.dshBot']);
      expect(mountedEndpoints.sort()).toEqual([
        'dshBot/create', 'dshBot/delete', 'dshBot/duplicate', 'dshBot/get', 'dshBot/list', 'dshBot/status', 'dshBot/update',
      ]);
      await fork.dispose();
      await fork.dispose();
      expect([...active]).toEqual([]);
      expect(releases.sort()).toEqual(['badge', 'dictionaries', 'remote.dshBot']);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
