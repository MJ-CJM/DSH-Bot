import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import { type ConnectionHandle, installConnection } from '@deepseek-ai/dsh-client-connection/client';
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DshBotRegistry } from '../src/host/registry.js';
import { DshBotError } from '../src/host/errors.js';
import { type BotStatus, type DshBotMethods, type DshBotRemoteMethods, dshBotRemoteSpec } from '../src/shared/remote-contract.js';
import { type BotRecord, type BotRemoveOptions, botCreateSchema, botSchema } from '../src/shared/schema.js';
import TYPERT from '../src/typert.host.js';
import TYPERT_REMOTE from '../src/typert.remote-client.js';

const require = createRequire(import.meta.url);
const record = botSchema.parse({
  ...botCreateSchema.parse({ id: 'test-bot', name: '测试 Bot' }),
  createdAt: 1, updatedAt: 1, schemaVersion: 1,
});

describe('single-source Remote contract', () => {
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
      await expect(Reflect.apply(ctx.remote.dshBot.delete, ctx.remote.dshBot, ['test-bot']))
        .rejects.toThrow('expected 2 argument(s), got 1');
      await unmount();
      expect(ctx.get('remote.dshBot')).toBeUndefined();
    } finally { await ctx.fiber.dispose(); }
  });

  it('matches all Host and Client method signatures at compile time', () => {
    expectTypeOf<DshBotRegistry['status']>().toEqualTypeOf<DshBotMethods['status']>();
    expectTypeOf<DshBotRemoteMethods['status']>().toEqualTypeOf<() => Promise<RemoteResult<BotStatus[]>>>();
    expectTypeOf<DshBotRegistry['list']>().toEqualTypeOf<DshBotMethods['list']>();
    expectTypeOf<DshBotRegistry['get']>().toEqualTypeOf<DshBotMethods['get']>();
    expectTypeOf<DshBotRegistry['create']>().toEqualTypeOf<DshBotMethods['create']>();
    expectTypeOf<DshBotRegistry['update']>().toEqualTypeOf<DshBotMethods['update']>();
    expectTypeOf<DshBotRegistry['duplicate']>().toEqualTypeOf<DshBotMethods['duplicate']>();
    expectTypeOf<DshBotRegistry['remove']>().toEqualTypeOf<DshBotMethods['remove']>();
    expectTypeOf<TypertRemoteNamespaceMap['dshBot']>().toEqualTypeOf<DshBotRemoteMethods>();
    expectTypeOf<DshBotRemoteMethods['get']>().toEqualTypeOf<(id: string) => Promise<RemoteResult<BotRecord>>>();
    expectTypeOf<DshBotRemoteMethods['delete']>()
      .toEqualTypeOf<(id: string, options: BotRemoveOptions | undefined) => Promise<RemoteResult<void>>>();
    expectTypeOf<keyof DshBotRemoteMethods>().toEqualTypeOf<'list' | 'status' | 'get' | 'create' | 'update' | 'duplicate' | 'delete'>();
  });

  it('shares exactly seven strict descriptors between Host and Client exports', () => {
    expect(require.resolve('dsh-bot/host-contract')).toMatch(/lib\/typert\.host\.js$/);
    // The Host owns registration in ctx.effect. ./typert would also be picked
    // up by the DSH typert-loader, causing a startup-order-dependent duplicate.
    expect(() => require.resolve('dsh-bot/typert')).toThrow();
    expect(require.resolve('dsh-bot/remote')).toMatch(/lib\/typert\.remote-client\.js$/);
    expect(TYPERT.invocations).toBe(TYPERT_REMOTE.descriptors);
    expect(TYPERT.invocations).toHaveLength(7);
    expect(TYPERT.invocations.map((entry) => `${entry.namespace}/${entry.method}`))
      .toEqual(Object.keys(dshBotRemoteSpec.methods));
    for (const descriptor of TYPERT.invocations) {
      expect(descriptor.service).toBe('dshBots');
      expect(descriptor.invocation).toEqual({ kind: 'direct' });
      expect(descriptor.result.mode).toBe('strict');
      expect(descriptor.parameters.every((parameter) => parameter.codec.mode === 'strict')).toBe(true);
    }
    expect(TYPERT_REMOTE.descriptors.find((entry) => entry.method === 'delete'))
      .toMatchObject({ implementation: 'remove', namespace: 'dshBot' });
  });

  it('validates arguments, defaults and unknown fields with the T03 schemas', () => {
    const input = (method: string, value: unknown) => {
      const descriptor = TYPERT_REMOTE.methods[`dshBot/${method}`];
      if (!descriptor) throw new Error(`Missing descriptor: ${method}`);
      return descriptor.input({ strict: true }).create().parse(value);
    };
    expect(input('list', {})).toEqual({});
    expect(input('get', { id: 'test-bot' })).toEqual({ id: 'test-bot' });
    expect(input('create', { input: { id: 'test-bot', name: '测试 Bot' } }))
      .toEqual({ input: botCreateSchema.parse({ id: 'test-bot', name: '测试 Bot' }) });
    expect(input('update', { id: 'test-bot', patch: { name: 'Changed' } }))
      .toEqual({ id: 'test-bot', patch: { name: 'Changed' } });
    expect(input('duplicate', { id: 'test-bot', newId: 'clone-bot' }))
      .toEqual({ id: 'test-bot', newId: 'clone-bot' });
    expect(input('delete', { id: 'test-bot' })).toEqual({ id: 'test-bot' });
    expect(input('delete', { id: 'test-bot', options: {} }))
      .toEqual({ id: 'test-bot', options: { deleteMemories: true } });
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
    const patch = { avatar: null, model: null, defaultCwd: null, order: null };
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
      if (descriptor.method === 'status') {
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
