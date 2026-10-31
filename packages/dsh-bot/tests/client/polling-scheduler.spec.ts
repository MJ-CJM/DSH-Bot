import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPollingCatalog } from '../../src/client/state.js';

const contexts: Context[] = [];
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup(focused = true, remote?: object) {
  vi.useFakeTimers();
  class Page extends EventTarget {
    visibilityState = 'visible';
    focused = focused;
    hasFocus() { return this.focused; }
  }
  const page = new Page();
  const view = new EventTarget();
  vi.stubGlobal('document', page);
  vi.stubGlobal('window', view);
  const ctx = new Context(); contexts.push(ctx);
  if (remote) ctx.provide('remote.dshBot', remote);
  const load = vi.fn(async () => ({ records: [{ id: 'alpha', value: 1 }] }));
  const otherLoad = vi.fn(async () => ({ records: [{ id: 'beta', value: 1 }] }));
  const catalog = createPollingCatalog(ctx, { records: [] as { id: string; value: number }[] }, load);
  const other = createPollingCatalog(ctx, { records: [] as { id: string; value: number }[] }, otherLoad);
  catalog.subscribe(() => {}); other.subscribe(() => {});
  return { ctx, page, view, load, otherLoad, catalog, other };
}
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('one foreground polling scheduler per Client context', () => {
  it('uses one timer and backs unchanged stores off to 30 seconds, then resets on change', async () => {
    const { load, otherLoad } = setup(); await settle();
    expect(vi.getTimerCount()).toBe(1);
    for (const delay of [5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 30_000]) {
      const calls = load.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(load).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(load).toHaveBeenCalledTimes(calls + 1);
      expect(otherLoad).toHaveBeenCalledTimes(calls + 1);
      expect(vi.getTimerCount()).toBe(1);
    }
    otherLoad.mockResolvedValue({ records: [{ id: 'beta', value: 2 }] });
    await vi.advanceTimersByTimeAsync(30_000);
    const calls = load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(calls + 1);
  });

  it('stops on blur/hidden and immediately refreshes both stores on foreground focus/visibility', async () => {
    const { page, view, load, otherLoad } = setup(false); await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    page.focused = true; view.dispatchEvent(new Event('focus')); await settle();
    expect(load).toHaveBeenCalledTimes(2); expect(otherLoad).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    page.focused = false; view.dispatchEvent(new Event('blur'));
    expect(vi.getTimerCount()).toBe(0);
    page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'));
    page.focused = true; view.dispatchEvent(new Event('focus')); await settle();
    expect(load).toHaveBeenCalledTimes(2);
    page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange')); await settle();
    expect(load).toHaveBeenCalledTimes(3); expect(otherLoad).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('returns to 5 seconds on user interaction and refreshes explicit mutations immediately even in the background', async () => {
    const { page, view, load, catalog } = setup(); await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    const calls = load.mock.calls.length;
    page.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(4_999); expect(load).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(calls + 1);
    page.dispatchEvent(new Event('keydown'));
    await vi.advanceTimersByTimeAsync(5_000); expect(load).toHaveBeenCalledTimes(calls + 2);
    page.focused = false; view.dispatchEvent(new Event('blur'));
    await catalog.refresh(); expect(load).toHaveBeenCalledTimes(calls + 3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one change stream, refreshes both catalogs immediately and cancels it outside the foreground', async () => {
    const runs: { signal: AbortSignal; push(): void; stopped: boolean }[] = [];
    const watch = vi.fn((signal: AbortSignal) => {
      let queued = 1; let wake: (() => void) | undefined;
      const run = { signal, stopped: false, push() { queued++; wake?.(); } }; runs.push(run);
      const iterable = (async function* () {
        const abort = () => wake?.(); signal.addEventListener('abort', abort, { once: true });
        try {
          while (!signal.aborted) {
            if (queued) { queued--; yield { revision: 0 }; continue; }
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        } finally { run.stopped = true; signal.removeEventListener('abort', abort); }
      })();
      return Object.assign(iterable, { dispose() { wake?.(); } });
    });
    const { page, view, load, otherLoad, ctx } = setup(true, { watch }); await settle();
    expect(watch).toHaveBeenCalledTimes(1);
    const calls = load.mock.calls.length;
    runs[0]?.push(); await settle();
    expect(load).toHaveBeenCalledTimes(calls + 1); expect(otherLoad).toHaveBeenCalledTimes(calls + 1);
    expect(vi.getTimerCount()).toBe(1);
    page.focused = false; view.dispatchEvent(new Event('blur')); await settle();
    expect(runs[0]?.signal.aborted).toBe(true); expect(runs[0]?.stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    page.focused = true; view.dispatchEvent(new Event('focus')); await settle();
    expect(watch).toHaveBeenCalledTimes(2);
    page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange')); await settle();
    expect(runs[1]?.signal.aborted).toBe(true);
    await ctx.fiber.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry an opening stream that immediately closes until the next polling boundary', async () => {
    const watch = vi.fn(() => Object.assign((async function* () { yield { revision: 0 }; })(), { dispose() {} }));
    setup(true, { watch }); await settle();
    expect(watch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999); expect(watch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(watch).toHaveBeenCalledTimes(2);
  });
});
