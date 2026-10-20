/** Execute the shipped browser factory in a real Cordis plugin scope. Only the
 * shell/visual services are doubles; Gateway, codecs and Connection are real.
 * This is a transport/scope probe, not browser rendering evidence. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import remoteContribution from 'dsh-bot/remote';

/** Existing profile callers provide the actual authenticated Connection, so
 * this exercises the real Host/Gateway WebSocket without a model prompt. The
 * temporary Bot is removed before callers inspect their seeded activity. */
async function verifyChangeStream(ctx) {
  const remote = ctx.get('remote.dshBot');
  assert.equal(typeof remote?.watch, 'function', 'Shipped Client mounts the public watch stream');
  const descriptor = remoteContribution.descriptors.find((entry) => entry.namespace === 'dshBot' && entry.method === 'watch');
  assert.equal(descriptor?.result.mode, 'strict', 'Watch has a strict frame contract');
  const schema = descriptor.result.create();
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15_000);
  const stream = remote.watch(abort.signal);
  const iterator = stream[Symbol.asyncIterator]();
  const botId = `watch-${randomUUID().slice(0, 20)}`;
  let created = false;
  const next = async () => {
    const value = await iterator.next();
    assert.equal(value.done, false, 'Watch produces its next invalidation before timeout');
    return schema.parse(value.value).revision;
  };
  try {
    const openingRevision = await next();
    const result = await remote.create({ id: botId, name: 'Watch verification' });
    assert.equal(result.ok, true, 'Temporary watch probe Bot created');
    created = true;
    const createRevision = await next();
    assert.ok(createRevision > openingRevision, 'Real watch observes committed catalog creation');
    const removed = await remote.delete(botId, { deleteMemories: true });
    assert.equal(removed.ok, true, 'Temporary watch probe Bot removed');
    created = false;
    const removeRevision = await next();
    assert.ok(removeRevision > createRevision, 'Real watch observes committed catalog removal');
    const pending = iterator.next();
    abort.abort(); stream.dispose();
    assert.equal((await pending).done, true, 'Real watch cancels a pending pull');
    return { openingRevision, createRevision, removeRevision, cancelled: true, temporaryBotRemoved: true };
  } finally {
    clearTimeout(timeout);
    abort.abort(); stream.dispose();
    await iterator.return?.();
    if (created) {
      const removed = await remote.delete(botId, { deleteMemories: true });
      assert.equal(removed.ok, true, 'Failed watch probe cleans up its temporary Bot');
    }
  }
}

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
    const changeStream = await verifyChangeStream(ctx);
    return { routines: page.routines, activity: page.hooks.activity, openSession: page.onOpenSession, openedSessions,
      changeStream,
      dispose: () => ctx.fiber.dispose() };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}
