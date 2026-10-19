/** Execute the shipped browser factory in a real Cordis plugin scope. Only the
 * shell/visual services are doubles; Gateway, codecs and Connection are real.
 * This is a transport/scope probe, not browser rendering evidence. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';

export async function createClientActivityProbe(connection) {
  const require = createRequire(import.meta.url);
  let plugin;
  new Function('window', readFileSync(require.resolve('dsh-bot/client'), 'utf8'))({ __ModuleLoader__: {
    load: ({ factory }) => { plugin = factory((id) => id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(id)); },
  } });
  assert.ok(plugin, 'Built Client factory loaded');
  const ctx = new Context();
  const registrations = new Map();
  const openedSessions = [];
  let navigation = new AbortController();
  const beginNavigation = () => { navigation.abort(); navigation = new AbortController(); return navigation.signal; };
  const source = (value) => ({ getSnapshot: () => value, subscribe: () => () => {} });
  try {
    ctx.provide('connection', connection);
    new TypertRegistry(ctx);
    ctx.provide('locale', { bind: () => (key) => key, register: () => () => {} });
    ctx.provide('slots', { inject: (_key, register) => register(), register: (options) => {
      registrations.set(options.name, options);
      return () => registrations.delete(options.name);
    } });
    ctx.provide('layout', { beginNavigation, selectPanel: () => { beginNavigation(); } });
    ctx.provide('uiWorkspace', { openSession: (id) => { openedSessions.push(id); beginNavigation(); } });
    ctx.provide('workspaces', { list: source({ items: [], archivedSessionIds: [], phase: 'ready', state: 'idle' }) });
    ctx.provide('sessions', { list: source({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }) });
    await ctx.plugin(Gateway).await();
    await ctx.plugin(plugin).await();
    const page = registrations.get('main')?.inject();
    assert.ok(page?.hooks.activity, 'Production page activity source is registered');
    return { activity: page.hooks.activity, openSession: page.onOpenSession, openedSessions,
      dispose: () => ctx.fiber.dispose() };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}
