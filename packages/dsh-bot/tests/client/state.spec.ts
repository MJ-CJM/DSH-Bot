import { Context } from '@deepseek-ai/cordis';
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBotCatalog } from '../../src/client/state.js';
import type { BotStatus } from '../../src/shared/remote-contract.js';
import { botCreateSchema, botSchema, type BotRecord } from '../../src/shared/schema.js';

const contexts: Context[] = [];
const makeBot = (name = 'First Bot'): BotRecord => botSchema.parse({
  ...botCreateSchema.parse({ id: 'test-bot', name }),
  createdAt: 1, updatedAt: 1, schemaVersion: 1,
});
const healthy: BotStatus = { id: 'test-bot', presetId: 'host-selected-id', preset: { state: 'ok' } };
const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup(mount = true) {
  const ctx = new Context();
  contexts.push(ctx);
  const list = vi.fn(async (): Promise<RemoteResult<BotRecord[]>> => ok([makeBot()]));
  const status = vi.fn(async (): Promise<RemoteResult<BotStatus[]>> => ok([healthy]));
  const remote = { list, status, catalogInfo: vi.fn(async () => ok({ presetIdPrefix: 'custom-' })) };
  if (mount) ctx.provide('remote.dshBot', remote);
  return { ctx, remote, list, status };
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Bot catalog refresh lifecycle', () => {
  it('loads one joint catalog on first subscribe and retains the Host preset id', async () => {
    const { ctx, list, status } = setup();
    const catalog = createBotCatalog(ctx);
    expect(list).not.toHaveBeenCalled();
    expect(catalog.getSnapshot()).toMatchObject({ loaded: false });
    const listener = vi.fn();
    const first = catalog.subscribe(listener);
    const second = catalog.subscribe(listener);
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    expect(catalog.getSnapshot()).toEqual({
      entries: [{ bot: makeBot(), status: healthy }], loading: false, loaded: true, pollIntervalMs: 5_000, presetIdPrefix: 'custom-',
    });
    first();
    ctx.emit('connection/reset');
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    second();
    ctx.emit('connection/reset');
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('preserves broken/missing status and leaves absent status unavailable', async () => {
    const { ctx, list, status } = setup();
    const broken = { ...healthy, preset: { state: 'broken' as const, reason: 'Preset failed' } };
    status.mockResolvedValue(ok([broken]));
    const catalog = createBotCatalog(ctx);
    await catalog.refresh();
    expect(catalog.getSnapshot().entries[0]?.status).toEqual(broken);
    status.mockResolvedValue(ok([{ ...healthy, preset: { state: 'missing' } }]));
    await catalog.refresh();
    expect(catalog.getSnapshot().entries[0]?.status?.preset.state).toBe('missing');
    status.mockResolvedValue(ok([]));
    await catalog.refresh();
    expect(catalog.getSnapshot().entries[0]?.status).toBeUndefined();
    list.mockResolvedValue(ok([]));
    await catalog.refresh();
    expect(catalog.getSnapshot()).toEqual({ entries: [], loading: false, loaded: true, pollIntervalMs: 5_000, presetIdPrefix: 'custom-' });
  });

  it('reports an unmounted namespace without declaring an authoritative empty list', async () => {
    const { ctx, remote } = setup(false);
    const catalog = createBotCatalog(ctx);
    catalog.subscribe(() => {});
    await settle();
    expect(catalog.getSnapshot()).toMatchObject({
      loaded: false, loading: false, entries: [], error: { code: 'bot/unavailable' },
    });
    ctx.provide('remote.dshBot', remote);
    ctx.emit('connection/reset');
    await settle();
    expect(catalog.getSnapshot().loaded).toBe(true);
    expect(catalog.getSnapshot().error).toBeUndefined();
  });

  it('retains prior records on list/status Remote failures and transport rejection', async () => {
    const { ctx, list, status } = setup();
    const catalog = createBotCatalog(ctx);
    await catalog.refresh();
    const previous = catalog.getSnapshot().entries;
    list.mockResolvedValueOnce({ ok: false, error: new RemoteError('store/unavailable', 'Store unavailable', {}) });
    await catalog.refresh();
    expect(catalog.getSnapshot()).toMatchObject({ loaded: true, error: { code: 'store/unavailable', message: 'Store unavailable' } });
    expect(catalog.getSnapshot().entries).toBe(previous);
    status.mockResolvedValueOnce({ ok: false, error: new RemoteError('bot/unavailable', 'Status unavailable', {}) });
    await catalog.refresh();
    expect(catalog.getSnapshot().error?.message).toBe('Status unavailable');
    expect(catalog.getSnapshot().entries).toBe(previous);
    list.mockRejectedValueOnce(new Error('Disconnected'));
    await catalog.refresh();
    expect(catalog.getSnapshot().error?.message).toBe('Disconnected');
    expect(catalog.getSnapshot().entries).toBe(previous);
    await catalog.refresh();
    expect(catalog.getSnapshot().error).toBeUndefined();
  });

  it('supersedes pre-mutation reads and promptly resolves their aborted local waits', async () => {
    const { ctx, list } = setup();
    const stale = deferred<RemoteResult<BotRecord[]>>();
    list.mockReturnValueOnce(stale.promise);
    const catalog = createBotCatalog(ctx);
    const oldRefresh = catalog.refresh();
    const oldSettled = vi.fn();
    void oldRefresh.then(oldSettled);
    list.mockResolvedValueOnce(ok([makeBot('Saved Bot')]));
    await catalog.refresh();
    expect(oldSettled).toHaveBeenCalledTimes(1);
    expect(catalog.getSnapshot().entries[0]?.bot.name).toBe('Saved Bot');
    stale.resolve(ok([makeBot('Stale Bot')]));
    await settle();
    expect(catalog.getSnapshot().entries[0]?.bot.name).toBe('Saved Bot');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale rejection after a newer catalog succeeds', async () => {
    const { ctx, list } = setup();
    const stale = deferred<RemoteResult<BotRecord[]>>();
    list.mockReturnValueOnce(stale.promise);
    const catalog = createBotCatalog(ctx);
    const previous = catalog.refresh();
    await catalog.refresh();
    stale.reject(new Error('Stale transport error'));
    await previous;
    await settle();
    expect(catalog.getSnapshot().error).toBeUndefined();
    expect(catalog.getSnapshot().loaded).toBe(true);
  });

  it('never carries an old healthy status into a new same-id record missing from status()', async () => {
    const { ctx, list, status } = setup();
    const catalog = createBotCatalog(ctx);
    await catalog.refresh();
    const pendingStatus = deferred<RemoteResult<BotStatus[]>>();
    list.mockResolvedValueOnce(ok([{ ...makeBot('Recreated Bot'), createdAt: 2, updatedAt: 2 }]));
    status.mockReturnValueOnce(pendingStatus.promise);
    const refreshing = catalog.refresh();
    await settle();
    // Until the two reads settle, consumers must gate actions on loading/error.
    expect(catalog.getSnapshot().loading).toBe(true);
    expect(catalog.getSnapshot().entries[0]?.bot.name).toBe('First Bot');
    pendingStatus.resolve(ok([]));
    await refreshing;
    expect(catalog.getSnapshot().entries[0]?.bot.name).toBe('Recreated Bot');
    expect(catalog.getSnapshot().entries[0]?.status).toBeUndefined();
  });

  it('polls every 5 seconds only while subscribed and visible, then refetches on visibility', async () => {
    vi.useFakeTimers();
    class Page extends EventTarget { visibilityState = 'visible'; }
    const page = new Page();
    vi.stubGlobal('document', page);
    const add = vi.spyOn(page, 'addEventListener');
    const remove = vi.spyOn(page, 'removeEventListener');
    const { ctx, list } = setup();
    const catalog = createBotCatalog(ctx);
    const unsubscribe = catalog.subscribe(() => {});
    await settle();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockResolvedValue(ok([makeBot('Other client change')]));
    await vi.advanceTimersByTimeAsync(1);
    expect(catalog.getSnapshot().entries[0]?.bot.name).toBe('Other client change');
    expect(list).toHaveBeenCalledTimes(2);
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(2);
    page.visibilityState = 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(list).toHaveBeenCalledTimes(3);
    unsubscribe();
    expect(add).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    page.dispatchEvent(new Event('visibilitychange'));
    ctx.emit('connection/reset');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(3);
    catalog.subscribe(() => {});
    await settle();
    expect(list).toHaveBeenCalledTimes(4);
  });

  it('does not starve a slow request when the configurable poll interval expires', async () => {
    vi.useFakeTimers();
    const { ctx, list } = setup();
    const pending = deferred<RemoteResult<BotRecord[]>>();
    list.mockReturnValueOnce(pending.promise);
    const catalog = createBotCatalog(ctx, { pollIntervalMs: 1_000 });
    catalog.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(3_000);
    expect(list).toHaveBeenCalledTimes(1);
    pending.resolve(ok([makeBot()]));
    await settle();
    expect(catalog.getSnapshot().loaded).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('invalidates pending reads on last unsubscribe and fully cleans up on owner disposal', async () => {
    vi.useFakeTimers();
    const { ctx, list } = setup();
    const pending = deferred<RemoteResult<BotRecord[]>>();
    list.mockReturnValueOnce(pending.promise);
    const catalog = createBotCatalog(ctx);
    const unsubscribe = catalog.subscribe(() => {});
    unsubscribe();
    pending.resolve(ok([makeBot('Unmounted result')]));
    await settle();
    expect(catalog.getSnapshot().loaded).toBe(false);
    catalog.subscribe(() => {});
    await settle();
    expect(catalog.getSnapshot().entries[0]?.bot.name).toBe('First Bot');
    await ctx.fiber.dispose();
    expect(vi.getTimerCount()).toBe(0);
    const calls = list.mock.calls.length;
    ctx.emit('connection/reset');
    catalog.subscribe(() => {});
    await catalog.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(calls);
  });

  it('rejects invalid polling configuration before allocating resources', () => {
    const { ctx } = setup();
    for (const pollIntervalMs of [0, -1, 0.5, 999, 60_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createBotCatalog(ctx, { pollIntervalMs })).toThrow(RangeError);
    }
  });

  it('reschedules configurable polling without aborting a read and retains it through remount', async () => {
    vi.useFakeTimers();
    const { ctx, list } = setup();
    const pending = deferred<RemoteResult<BotRecord[]>>();
    list.mockReturnValueOnce(pending.promise);
    const catalog = createBotCatalog(ctx);
    const unsubscribe = catalog.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(2_000);
    catalog.setPollIntervalMs(1_000);
    expect(catalog.getSnapshot().pollIntervalMs).toBe(1_000);
    expect(catalog.getSnapshot().loading).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(1);
    pending.resolve(ok([makeBot('Slow read remains valid')]));
    await settle();
    expect(catalog.getSnapshot().entries[0]?.bot.name).toBe('Slow read remains valid');
    expect(catalog.getSnapshot().pollIntervalMs).toBe(1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(2);
    unsubscribe();
    catalog.setPollIntervalMs(60_000);
    expect(vi.getTimerCount()).toBe(0);
    catalog.subscribe(() => {});
    await settle();
    expect(catalog.getSnapshot().pollIntervalMs).toBe(60_000);
    expect(list).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(list).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(4);
  });

  it('rejects invalid interval updates and preserves the active timer and interval', async () => {
    vi.useFakeTimers();
    const { ctx } = setup();
    const catalog = createBotCatalog(ctx);
    catalog.subscribe(() => {});
    await settle();
    const before = catalog.getSnapshot();
    for (const value of [0, 999, 1_000.5, 60_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => catalog.setPollIntervalMs(value)).toThrow(RangeError);
      expect(catalog.getSnapshot()).toBe(before);
      expect(vi.getTimerCount()).toBe(1);
    }
    catalog.setPollIntervalMs(5_000);
    expect(catalog.getSnapshot()).toBe(before);
  });

  it('removes reset owner effects across repeated subscribe cycles and explicit disposal', async () => {
    vi.useFakeTimers();
    const { ctx, list } = setup();
    const originalEffects = ctx.fiber.getEffects().length;
    const catalog = createBotCatalog(ctx);
    const catalogEffects = ctx.fiber.getEffects().length;
    expect(catalogEffects).toBe(originalEffects + 1);
    for (let iteration = 0; iteration < 5; iteration++) {
      const unsubscribe = catalog.subscribe(() => {});
      await settle();
      expect(ctx.fiber.getEffects().filter((effect) => effect.label === 'ctx.on("connection/reset")')).toHaveLength(1);
      unsubscribe();
      expect(ctx.fiber.getEffects()).toHaveLength(catalogEffects);
      expect(vi.getTimerCount()).toBe(0);
    }
    const calls = list.mock.calls.length;
    ctx.emit('connection/reset');
    await settle();
    expect(list).toHaveBeenCalledTimes(calls);
    catalog.dispose();
    catalog.dispose();
    expect(ctx.fiber.getEffects()).toHaveLength(originalEffects);
  });
});
