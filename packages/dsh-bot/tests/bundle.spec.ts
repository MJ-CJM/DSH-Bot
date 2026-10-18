import { readFileSync, statSync } from 'node:fs';
import { createRequire, SourceMap } from 'node:module';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import * as host from '../lib/index.js';
import en from '../locale/en.json';
import zh from '../locale/zh.json';

const require = createRequire(import.meta.url);

describe('built bundle contract', () => {
  it('loads the built Host and disposes its effect exactly once', async () => {
    const ctx = new Context();
    const messages: unknown[] = [];
    ctx.logger.exporter({ export: (message) => messages.push(message.args[0]) });
    try {
      const fork = ctx.plugin(host);
      await fork.await();
      expect(messages).toContain('[dsh-bot] loaded');
      await fork.dispose();
      await fork.dispose();
      expect(messages.filter((message) => message === '[dsh-bot] unloaded')).toHaveLength(1);
    } finally {
      await ctx.fiber.dispose();
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
      if (id !== 'react/jsx-runtime') throw new Error(`Unexpected platform import: ${id}`);
      return require(id);
    });
    expect(requests).toEqual(['react/jsx-runtime']);
    expect(plugin?.inject).toEqual(['slots', 'locale']);
    expect(typeof plugin?.apply).toBe('function');
  });

  it('ships a linked source map with original sources and correct wrapper offsets', () => {
    const clientPath = require.resolve('dsh-bot/client');
    const source = readFileSync(clientPath, 'utf8');
    expect(source).toMatch(/\/\/# sourceMappingURL=client\.js\.map\s*$/);
    const payload = JSON.parse(readFileSync(`${clientPath}.map`, 'utf8'));
    expect(payload.version).toBe(3);
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

  it('releases Client dictionaries and slot registration on Cordis unload', async () => {
    const ctx = new Context();
    const active = new Set<string>();
    const releases: string[] = [];
    const register = (resource: string) => {
      active.add(resource);
      return () => { active.delete(resource); releases.push(resource); };
    };
    // Service doubles check the plugin's ownership contract, not browser rendering.
    ctx.provide('locale', {
      register: () => register('dictionaries'),
    } as unknown as Context['locale']);
    ctx.provide('slots', {
      inject: (_name: string, callback: () => () => void) => callback(),
      register: () => register('badge'),
    } as unknown as Context['slots']);
    let plugin: { inject: string[]; apply: (ctx: Context) => void } | undefined;
    runInNewContext(readFileSync(require.resolve('dsh-bot/client'), 'utf8'), {
      window: { __ModuleLoader__: {
        load: (entry: { factory: (require: NodeJS.Require) => typeof plugin }) => { plugin = entry.factory(require); },
      } },
    }, { timeout: 1000 });
    if (!plugin) throw new Error('Client factory did not register');
    try {
      const fork = ctx.plugin(plugin);
      await fork.await();
      expect([...active].sort()).toEqual(['badge', 'dictionaries']);
      await fork.dispose();
      await fork.dispose();
      expect([...active]).toEqual([]);
      expect(releases.sort()).toEqual(['badge', 'dictionaries']);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
