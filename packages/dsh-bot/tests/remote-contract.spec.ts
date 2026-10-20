import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import { type ConnectionHandle, installConnection } from '@deepseek-ai/dsh-client-connection/client';
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import type { RemoteResult, RemoteStreamHandle, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DshBotRegistry } from '../src/host/registry.js';
import type { DshBotMemoryRemote } from '../src/host/memory/remote.js';
import type { DshBotActivityRemote } from '../src/host/activity/remote.js';
import { DshBotError } from '../src/host/errors.js';
import {
  type CatalogInfo, type BotStatus, type DshBotMethods, type DshBotMemoryMethods,
  type DshBotMemoryRemoteMethods, type DshBotRemoteMethods, dshBotRemoteSpec,
  type DshBotActivityMethods, type DshBotActivityRemoteMethods, type BotChange,
} from '../src/shared/remote-contract.js';
import { type BotRecord, type BotRemoveOptions, botCreateSchema, botSchema, memorySchema } from '../src/shared/schema.js';
import TYPERT from '../src/typert.host.js';
import TYPERT_REMOTE from '../src/typert.remote-client.js';
import { createActivityCatalog, type ActivityCatalog } from '../src/client/activity-state.js';

const require = createRequire(import.meta.url);
const record = botSchema.parse({
  ...botCreateSchema.parse({ id: 'test-bot', name: '测试 Bot' }),
  createdAt: 1, updatedAt: 1, schemaVersion: 1,
});
const memory = memorySchema.parse({
  id: 'memory-1', botId: 'test-bot', content: 'Prefer concise text', kind: 'preference', tags: [], pinned: true,
  source: { by: 'user', at: 1 }, createdAt: 1, updatedAt: 1,
});

describe('single-source Remote contract', () => {
  it('loads activity from a plugin scope through real Gateway result decoding and rejects storage fields on the wire', async () => {
    const ctx = new Context();
    const row = { sessionId: 'session-1', botId: 'test-bot', lastMessage: { role: 'assistant', preview: 'Reply', at: 1 }, updatedAt: 1, unread: true };
    let invalid = false;
    let catalog: ActivityCatalog | undefined;
    try {
      new TypertRegistry(ctx);
      installConnection(ctx, { interactions: 'none', transport: { async fetch(_input, init) {
        const { rpcId } = JSON.parse(String(init.body));
        return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: {
          sessions: [{ ...row, ...(invalid ? { lastEventSeq: 3 } : {}) }], bots: [],
        } } });
      } } });
      await ctx.plugin(Gateway).await();
      await ctx.effect(() => ctx.remote.$mount(TYPERT_REMOTE));
      await ctx.plugin({ inject: ['remote'], apply(owner: Context) { catalog = createActivityCatalog(owner); } }).await();
      if (!catalog) throw new Error('Missing production catalog');
      await catalog.refresh();
      expect(catalog.getSnapshot().error).toBeUndefined();
      expect(catalog.getSnapshot().sessions).toEqual([row]);
      invalid = true;
      await catalog.refresh();
      expect(catalog.getSnapshot().error).toBeDefined();
      expect(catalog.getSnapshot().sessions).toEqual([row]);
      for (const method of ['list', 'markRead']) {
        const result = TYPERT_REMOTE.descriptors.find((descriptor) => descriptor.namespace === 'dshBot.activity' && descriptor.method === method)?.result;
        if (result?.mode !== 'strict' || !result.encode || !result.decode) throw new Error('Missing activity wire validation');
        const valid = method === 'list' ? { sessions: [row], bots: [] } : row;
        const bad = method === 'list' ? { sessions: [{ ...row, lastEventSeq: 3 }], bots: [] } : { ...row, lastEventSeq: 3 };
        expect(result.decode(JSON.parse(JSON.stringify(result.encode(valid, () => null))))).toEqual(valid);
        expect(() => result.encode?.(bad, () => null)).toThrow();
        expect(() => result.decode?.(bad)).toThrow();
      }
    } finally { await ctx.fiber.dispose(); }
  });
  it('preserves domain failures through the published Connection JSON response parser', async () => {
    const ctx = new Context();
    const error = new DshBotError('bot/not-found', 'Missing Bot');
    let omitDetails = false;
    try {
      expect(remoteErrorOf(error)).toMatchObject({ code: 'bot/not-found', details: {} });
      installConnection(ctx, {
        interactions: 'none',
        transport: {
          async fetch(_input, init) {
            const { rpcId } = JSON.parse(String(init.body));
            return Response.json({
              type: 'server-response', rpcId,
              result: { ok: false, error: {
                code: error.code, message: error.message,
                details: omitDetails ? undefined : error.details,
              } },
            });
          },
        },
      });
      const connection = ctx.get('connection') as ConnectionHandle;
      await expect(connection.rpc.call('/api', 'dshBot/get', { args: { id: 'missing-bot' } }))
        .resolves.toEqual({ ok: false, error: { code: 'bot/not-found', message: 'Missing Bot', details: {} } });
      omitDetails = true;
      await expect(connection.rpc.call('/api', 'dshBot/get', { args: { id: 'missing-bot' } }))
        .rejects.toThrow('invalid server-response failure');
    } finally { await ctx.fiber.dispose(); }
  });

  it('mounts the real published Gateway namespace and observes its explicit optional-argument convention', async () => {
    const ctx = new Context();
    const calls: { endpoint: string; payload: unknown }[] = [];
    try {
      new TypertRegistry(ctx);
      // Only the carrier is doubled; namespace reservation, mounting, invocation
      // arity and unmounting run through the published Gateway implementation.
      ctx.provide('connection', {
        interactions: 'none',
        rpc: {
          open() { throw new Error('Unary methods must not open a stream'); },
          async call(_path: string, endpoint: string, payload: unknown) {
            calls.push({ endpoint, payload });
            return { ok: true, value: undefined };
          },
        },
      } as unknown as ConnectionHandle);
      const gateway = ctx.plugin(Gateway);
      await gateway.await();
      expect(ctx.get('remote.dshBot')).toBeUndefined();
      const unmount = await ctx.effect(() => ctx.remote.$mount(TYPERT_REMOTE));
      expect(ctx.get('remote.dshBot')).toBeDefined();
      await expect(ctx.remote.dshBot.delete('test-bot', undefined)).resolves.toEqual({ ok: true, value: undefined });
      expect(calls).toEqual([{ endpoint: 'dshBot/delete', payload: { args: { id: 'test-bot' } } }]);
      expect(ctx.get('remote.dshBot.memory')).toBeDefined();
      await ctx.remote.dshBot.memory.list('test-bot', { limit: 50 });
      await ctx.remote.dshBot.memory.search('test-bot', { query: 'concise' });
      await ctx.remote.dshBot.memory.save('test-bot', { content: 'Prefer concise text' });
      await ctx.remote.dshBot.memory.update('test-bot', 'memory-1', { pinned: false });
      await ctx.remote.dshBot.memory.delete('test-bot', 'memory-1');
      await ctx.remote.dshBot.memory.count('test-bot');
      expect(calls.slice(1)).toEqual([
        { endpoint: 'dshBot.memory/list', payload: { args: { botId: 'test-bot', options: { limit: 50 } } } },
        { endpoint: 'dshBot.memory/search', payload: { args: { botId: 'test-bot', input: { query: 'concise' } } } },
        { endpoint: 'dshBot.memory/save', payload: { args: { botId: 'test-bot', input: { content: 'Prefer concise text' } } } },
        { endpoint: 'dshBot.memory/update', payload: { args: { botId: 'test-bot', id: 'memory-1', patch: { pinned: false } } } },
        { endpoint: 'dshBot.memory/delete', payload: { args: { botId: 'test-bot', id: 'memory-1' } } },
        { endpoint: 'dshBot.memory/count', payload: { args: { botId: 'test-bot' } } },
      ]);
      expect(ctx.get('remote.dshBot.activity')).toBeDefined();
      await ctx.remote.dshBot.activity.list();
      await ctx.remote.dshBot.activity.markRead('session-1');
      expect(calls.slice(-2)).toEqual([
        { endpoint: 'dshBot.activity/list', payload: { args: {} } },
        { endpoint: 'dshBot.activity/markRead', payload: { args: { sessionId: 'session-1' } } },
      ]);
      await expect(Reflect.apply(ctx.remote.dshBot.delete, ctx.remote.dshBot, ['test-bot']))
        .rejects.toThrow('expected 2 argument(s), got 1');
      await unmount();
      expect(ctx.get('remote.dshBot')).toBeUndefined();
      expect(ctx.get('remote.dshBot.memory')).toBeUndefined();
      expect(ctx.get('remote.dshBot.activity')).toBeUndefined();
    } finally { await ctx.fiber.dispose(); }
  });

  it('matches all Host and Client method signatures at compile time', () => {
    expectTypeOf<DshBotRegistry['watch']>().toEqualTypeOf<DshBotMethods['watch']>();
    expectTypeOf<DshBotRemoteMethods['watch']>().toEqualTypeOf<(signal?: AbortSignal) => RemoteStreamHandle<BotChange, never>>();
    expectTypeOf<DshBotActivityRemote['list']>().toEqualTypeOf<DshBotActivityMethods['list']>();
    expectTypeOf<DshBotActivityRemote['markRead']>().toEqualTypeOf<DshBotActivityMethods['markRead']>();
    expectTypeOf<TypertRemoteNamespaceMap['dshBot.activity']>().toEqualTypeOf<DshBotActivityRemoteMethods>();
    expectTypeOf<DshBotRemoteMethods['activity']>().toEqualTypeOf<DshBotActivityRemoteMethods>();
    expectTypeOf<DshBotRegistry['catalogInfo']>().toEqualTypeOf<DshBotMethods['catalogInfo']>();
    expectTypeOf<DshBotRemoteMethods['catalogInfo']>().toEqualTypeOf<() => Promise<RemoteResult<CatalogInfo>>>();
    expectTypeOf<DshBotRegistry['status']>().toEqualTypeOf<DshBotMethods['status']>();
    expectTypeOf<DshBotRemoteMethods['status']>().toEqualTypeOf<() => Promise<RemoteResult<BotStatus[]>>>();
    expectTypeOf<DshBotRegistry['list']>().toEqualTypeOf<DshBotMethods['list']>();
    expectTypeOf<DshBotRegistry['get']>().toEqualTypeOf<DshBotMethods['get']>();
    expectTypeOf<DshBotRegistry['ensureHome']>().toEqualTypeOf<DshBotMethods['ensureHome']>();
    expectTypeOf<DshBotRemoteMethods['ensureHome']>().toEqualTypeOf<(botId: string) => Promise<RemoteResult<{ path: string }>>>();
    expectTypeOf<DshBotRegistry['ensureBotsWorkspace']>().toEqualTypeOf<DshBotMethods['ensureBotsWorkspace']>();
    expectTypeOf<DshBotRemoteMethods['ensureBotsWorkspace']>().toEqualTypeOf<() => Promise<RemoteResult<{ workspaceId: string; path: string }>>>();
    expectTypeOf<DshBotRegistry['create']>().toEqualTypeOf<DshBotMethods['create']>();
    expectTypeOf<DshBotRegistry['update']>().toEqualTypeOf<DshBotMethods['update']>();
    expectTypeOf<DshBotRegistry['duplicate']>().toEqualTypeOf<DshBotMethods['duplicate']>();
    expectTypeOf<DshBotRegistry['remove']>().toEqualTypeOf<DshBotMethods['remove']>();
    expectTypeOf<DshBotMemoryRemote['list']>().toEqualTypeOf<DshBotMemoryMethods['list']>();
    expectTypeOf<DshBotMemoryRemote['search']>().toEqualTypeOf<DshBotMemoryMethods['search']>();
    expectTypeOf<DshBotMemoryRemote['save']>().toEqualTypeOf<DshBotMemoryMethods['save']>();
    expectTypeOf<DshBotMemoryRemote['update']>().toEqualTypeOf<DshBotMemoryMethods['update']>();
    expectTypeOf<DshBotMemoryRemote['remove']>().toEqualTypeOf<DshBotMemoryMethods['remove']>();
    expectTypeOf<DshBotMemoryRemote['count']>().toEqualTypeOf<DshBotMemoryMethods['count']>();
    expectTypeOf<TypertRemoteNamespaceMap['dshBot.memory']>().toEqualTypeOf<DshBotMemoryRemoteMethods>();
    expectTypeOf<DshBotRemoteMethods['memory']>().toEqualTypeOf<DshBotMemoryRemoteMethods>();
    expectTypeOf<TypertRemoteNamespaceMap['dshBot']>().toEqualTypeOf<DshBotRemoteMethods>();
    expectTypeOf<DshBotRemoteMethods['get']>().toEqualTypeOf<(id: string) => Promise<RemoteResult<BotRecord>>>();
    expectTypeOf<DshBotRemoteMethods['delete']>()
      .toEqualTypeOf<(id: string, options: BotRemoveOptions | undefined) => Promise<RemoteResult<void>>>();
    expectTypeOf<keyof DshBotRemoteMethods>()
      .toEqualTypeOf<'watch' | 'list' | 'status' | 'catalogInfo' | 'get' | 'ensureHome' | 'ensureBotsWorkspace' | 'create' | 'update' | 'duplicate' | 'delete' | 'memory' | 'activity'>();
    expectTypeOf<keyof DshBotMemoryRemoteMethods>().toEqualTypeOf<'list' | 'search' | 'save' | 'update' | 'delete' | 'count'>();
  });

  it('shares all nineteen strict descriptors between Host and Client exports', () => {
    expect(require.resolve('dsh-bot/host-contract')).toMatch(/lib\/typert\.host\.js$/);
    // The Host owns registration in ctx.effect. ./typert would also be picked
    // up by the DSH typert-loader, causing a startup-order-dependent duplicate.
    expect(() => require.resolve('dsh-bot/typert')).toThrow();
    expect(require.resolve('dsh-bot/remote')).toMatch(/lib\/typert\.remote-client\.js$/);
    expect(TYPERT.invocations).toBe(TYPERT_REMOTE.descriptors);
    expect(TYPERT.invocations).toHaveLength(19);
    expect(TYPERT.invocations.map((entry) => `${entry.namespace}/${entry.method}`))
      .toEqual(Object.keys(dshBotRemoteSpec.methods));
    for (const descriptor of TYPERT.invocations) {
      expect(descriptor.service).toBe(descriptor.namespace === 'dshBot.memory' ? 'dshBotMemory'
        : descriptor.namespace === 'dshBot.activity' ? 'dshBotActivity' : 'dshBots');
      expect(descriptor.invocation).toEqual({ kind: 'direct' });
      expect(descriptor.result.mode).toBe('strict');
      expect(descriptor.parameters.every((parameter) => parameter.codec.mode === 'strict')).toBe(true);
    }
    expect(TYPERT_REMOTE.descriptors.find((entry) => entry.method === 'delete'))
      .toMatchObject({ implementation: 'remove', namespace: 'dshBot' });
  });

  it('declares a zero-argument Bots workspace Remote and validates its path and identity on both wire directions', () => {
    const descriptor = TYPERT_REMOTE.descriptors.find((entry) => entry.method === 'ensureBotsWorkspace');
    expect(descriptor?.parameters).toEqual([]);
    if (descriptor?.result.mode !== 'strict' || !descriptor.result.encode || !descriptor.result.decode) throw new Error('Missing workspace codec');
    const result = descriptor.result;
    const valid = { workspaceId: 'workspace-one', path: '/dsh/dsh-bot/bots' };
    expect(result.decode?.(result.encode?.(valid, () => null))).toEqual(valid);
    for (const invalid of [{ ...valid, workspaceId: '' }, { ...valid, path: 'relative' }, { ...valid, cwd: valid.path }, {}]) {
      expect(() => result.encode?.(invalid, () => null)).toThrow();
      expect(() => result.decode?.(invalid)).toThrow();
    }
  });

  it('declares a zero-argument cancellable stream and validates every invalidation frame', () => {
    const watch = TYPERT_REMOTE.descriptors.find((entry) => entry.method === 'watch');
    expect(watch).toMatchObject({ service: 'dshBots', namespace: 'dshBot', mode: 'stream', parameters: [], cancellation: { parameter: 'signal' } });
    if (watch?.result.mode !== 'strict' || !watch.result.encode || !watch.result.decode) throw new Error('Missing watch codec');
    const result = watch.result;
    expect(result.decode?.(result.encode?.({ revision: 0 }, () => null))).toEqual({ revision: 0 });
    for (const invalid of [{ revision: -1 }, { revision: 0.5 }, { revision: 1, title: 'private' }, {}]) {
      expect(() => result.encode?.(invalid, () => null)).toThrow();
      expect(() => result.decode?.(invalid)).toThrow();
    }
  });

  it('strictly validates activity arguments and wrapped unknown-session errors', () => {
    const list = TYPERT_REMOTE.methods['dshBot.activity/list']?.input({ strict: true }).create();
    const mark = TYPERT_REMOTE.methods['dshBot.activity/markRead']?.input({ strict: true }).create();
    expect(list?.parse({})).toEqual({});
    expect(() => list?.parse({ botId: 'test-bot' })).toThrow();
    expect(mark?.parse({ sessionId: 'session-1' })).toEqual({ sessionId: 'session-1' });
    expect(() => mark?.parse({ sessionId: '' })).toThrow();
    expect(() => mark?.parse({ sessionId: 'session-1', lastReadAt: 99 })).toThrow();
    expect(remoteErrorOf(new DshBotError('activity/not-found', 'Unknown activity')))
      .toMatchObject({ code: 'activity/not-found', details: {} });
  });

  it('validates every memory method with strict identity, cursor and provenance boundaries', () => {
    const input = (method: string, value: unknown) => {
      const descriptor = TYPERT_REMOTE.methods[`dshBot.memory/${method}`];
      if (!descriptor) throw new Error(`Missing memory descriptor: ${method}`);
      return descriptor.input({ strict: true }).create().parse(value);
    };
    const before = { id: 'memory-1', updatedAt: 1, pinned: true };
    expect(input('list', { botId: 'test-bot', options: { limit: 50, before } }))
      .toEqual({ botId: 'test-bot', options: { limit: 50, before } });
    expect(input('search', { botId: 'test-bot', input: { query: 'text', tag: 'writing' } }))
      .toEqual({ botId: 'test-bot', input: { query: 'text', tag: 'writing' } });
    expect(input('save', { botId: 'test-bot', input: { content: 'Text' } }))
      .toEqual({ botId: 'test-bot', input: { content: 'Text', kind: 'note', tags: [], pinned: false } });
    expect(input('update', { botId: 'test-bot', id: 'memory-1', patch: { pinned: false } }))
      .toEqual({ botId: 'test-bot', id: 'memory-1', patch: { pinned: false } });
    expect(input('delete', { botId: 'test-bot', id: 'memory-1' })).toEqual({ botId: 'test-bot', id: 'memory-1' });
    expect(input('count', { botId: 'test-bot' })).toEqual({ botId: 'test-bot' });
    for (const value of [
      { content: 'Text', botId: 'other' }, { content: 'Text', id: 'chosen' },
      { content: 'Text', source: { by: 'model', at: 0, sessionId: 'forged' } },
      { content: 'Text', unknown: true }, { content: 'a'.repeat(2049) },
    ]) expect(() => input('save', { botId: 'test-bot', input: value })).toThrow();
    for (const patch of [{ source: { by: 'user', at: 0 } }, { botId: 'other' }, { createdAt: 0 }]) {
      expect(() => input('update', { botId: 'test-bot', id: 'memory-1', patch })).toThrow();
    }
    expect(() => input('list', { botId: 'test-bot', options: { limit: 201 } })).toThrow();
    expect(() => input('list', { botId: 'test-bot', options: { before: { ...before, unknown: true } } })).toThrow();
    expect(() => input('search', { botId: 'test-bot', input: {} })).toThrow();
    expect(() => input('delete', { botId: '../escape', id: 'memory-1' })).toThrow();
    expect(() => input('count', { botId: 'test-bot', unknown: true })).toThrow();
  });

  it('validates arguments, defaults and unknown fields with the T03 schemas', () => {
    const input = (method: string, value: unknown) => {
      const descriptor = TYPERT_REMOTE.methods[`dshBot/${method}`];
      if (!descriptor) throw new Error(`Missing descriptor: ${method}`);
      return descriptor.input({ strict: true }).create().parse(value);
    };
    expect(input('list', {})).toEqual({});
    expect(input('get', { id: 'test-bot' })).toEqual({ id: 'test-bot' });
    expect(input('ensureHome', { botId: 'test-bot' })).toEqual({ botId: 'test-bot' });
    expect(() => input('ensureHome', { botId: '../escape' })).toThrow();
    expect(input('create', { input: { id: 'test-bot', name: '测试 Bot' } }))
      .toEqual({ input: botCreateSchema.parse({ id: 'test-bot', name: '测试 Bot' }) });
    expect(input('update', { id: 'test-bot', patch: { name: 'Changed' } }))
      .toEqual({ id: 'test-bot', patch: { name: 'Changed' } });
    expect(input('duplicate', { id: 'test-bot', newId: 'clone-bot' }))
      .toEqual({ id: 'test-bot', newId: 'clone-bot' });
    expect(input('delete', { id: 'test-bot' })).toEqual({ id: 'test-bot' });
    expect(input('delete', { id: 'test-bot', options: {} }))
      .toEqual({ id: 'test-bot', options: { deleteMemories: true, deleteHome: false } });
    expect(input('delete', { id: 'test-bot', options: { deleteHome: true } }))
      .toEqual({ id: 'test-bot', options: { deleteMemories: true, deleteHome: true } });
    expect(() => input('list', { unknown: true })).toThrow();
    expect(() => input('get', { id: '../escape' })).toThrow();
    expect(() => input('create', { input: { id: 'test-bot', name: 'Bot', unexpected: true } })).toThrow();
    expect(() => input('update', { id: 'test-bot', patch: { id: 'other' } })).toThrow();
    expect(() => input('duplicate', { id: 'test-bot' })).toThrow();
    expect(() => input('delete', { id: 'test-bot', options: { deleteMemories: 'yes' } })).toThrow();
  });

  it('preserves explicit optional-field clears through strict Client codec, JSON and Host codec', () => {
    const descriptor = TYPERT_REMOTE.methods['dshBot/update'];
    if (!descriptor) throw new Error('Missing update descriptor');
    const input = descriptor.input({ strict: true }).create();
    expect(input.parse({ id: 'test-bot', patch: {} })).toEqual({ id: 'test-bot', patch: {} });
    const patch = { avatar: null, avatarColor: null, model: null, defaultCwd: null, order: null };
    const parsed = input.parse({ id: 'test-bot', patch });
    expect(parsed).toEqual({ id: 'test-bot', patch });
    const wire = JSON.parse(JSON.stringify(parsed));
    expect(wire).toEqual({ id: 'test-bot', patch });
    const hostPatch = TYPERT.invocations.find((entry) => entry.method === 'update')?.parameters[1]?.codec;
    if (hostPatch?.mode !== 'strict') throw new Error('Missing strict Host patch codec');
    expect(hostPatch.create().parse(wire.patch)).toEqual(patch);
    for (const field of ['name', 'description', 'persona', 'template', 'tools', 'skills', 'memory', 'mcpServers', 'channels']) {
      expect(() => input.parse({ id: 'test-bot', patch: { [field]: null } })).toThrow();
    }
  });

  it('accepts complete stored records and rejects malformed successful results', () => {
    for (const descriptor of TYPERT.invocations) {
      if (descriptor.result.mode !== 'strict') throw new Error('Expected strict result codec');
      const codec = descriptor.result.create();
      if (descriptor.namespace === 'dshBot.activity') {
        const session = { sessionId: 'session-1', botId: 'test-bot',
          lastMessage: { role: 'assistant', preview: 'Hello', at: 1 }, updatedAt: 1, unread: true };
        const value = descriptor.method === 'list' ? { sessions: [session], bots: [{
          botId: 'test-bot', lastActivityAt: 1, unreadCount: 1,
          latest: { sessionId: 'session-1', role: 'assistant', preview: 'Hello', at: 1 },
        }] } : session;
        expect(codec.parse(value)).toEqual(value);
        expect(() => codec.parse({ ...value, unexpected: true })).toThrow();
        expect(() => codec.parse({ sessions: [], bots: [{ botId: 'test-bot', unreadCount: -1 }] })).toThrow();
      } else if (descriptor.namespace === 'dshBot.memory') {
        const values: Record<string, [unknown, unknown]> = {
          list: [[memory], [{ ...memory, unknown: true }]],
          search: [[memory], [{ id: 'bad' }]],
          save: [{ id: 'memory-1', deduplicated: false }, { id: 'memory-1', deduplicated: 'false' }],
          update: [memory, { ...memory, source: { by: 'untrusted', at: 1 } }],
          delete: [undefined, { removed: true }], count: [201, -1],
        };
        const value = values[descriptor.method];
        if (!value) throw new Error(`Missing memory result case ${descriptor.method}`);
        expect(codec.parse(value[0])).toEqual(value[0]);
        expect(() => codec.parse(value[1])).toThrow();
      } else if (descriptor.method === 'watch') {
        expect(codec.parse({ revision: 0 })).toEqual({ revision: 0 });
        expect(() => codec.parse({ revision: -1 })).toThrow();
      } else if (descriptor.method === 'ensureHome') {
        expect(codec.parse({ path: '/private/home' })).toEqual({ path: '/private/home' });
        expect(() => codec.parse({ path: 'relative' })).toThrow();
        expect(() => codec.parse({ path: '/home', unexpected: true })).toThrow();
      } else if (descriptor.method === 'ensureBotsWorkspace') {
        const value = { workspaceId: 'workspace-one', path: '/private/bots' };
        expect(codec.parse(value)).toEqual(value);
        expect(() => codec.parse({ ...value, workspaceId: '' })).toThrow();
      } else if (descriptor.method === 'catalogInfo') {
        expect(codec.parse({ presetIdPrefix: 'custom-' })).toEqual({ presetIdPrefix: 'custom-' });
        expect(() => codec.parse({ presetIdPrefix: '', extra: true })).toThrow();
      } else if (descriptor.method === 'status') {
        const value = [{ id: 'test-bot', presetId: 'custom-test-bot', preset: { state: 'broken', reason: 'Failed' } }];
        expect(codec.parse(value)).toEqual(value);
        expect(() => codec.parse([{ ...value[0], preset: { state: 'unknown' } }])).toThrow();
        expect(() => codec.parse([{ id: 'test-bot', preset: { state: 'ok' } }])).toThrow();
      } else if (descriptor.method === 'delete') {
        expect(codec.parse(undefined)).toBeUndefined();
        expect(() => codec.parse({ removed: true })).toThrow();
      } else {
        const result = descriptor.method === 'list' ? [record] : record;
        expect(codec.parse(result)).toEqual(result);
        expect(() => codec.parse(descriptor.method === 'list' ? [{ id: 'bad' }] : { id: 'bad' })).toThrow();
        const invalid = { ...record, unexpected: true };
        expect(() => codec.parse(descriptor.method === 'list' ? [invalid] : invalid)).toThrow();
      }
    }
  });
});
