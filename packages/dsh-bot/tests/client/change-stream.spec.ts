import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { describe, expect, it, vi } from 'vitest';
import { createChangeStream } from '../../src/client/change-stream.js';
import TYPERT_REMOTE from '../../src/typert.remote-client.js';

/** Only the transport is doubled. Published Connection + Gateway mounting,
 * stream arity/signal forwarding and RemoteStreamHandle disposal stay real. */
async function fixture(endAfterOpening = false) {
  const ctx = new Context();
  const runs: { signal: AbortSignal; push(value: unknown): void; stopped: boolean }[] = [];
  new TypertRegistry(ctx);
  installConnection(ctx, { interactions: 'none', transport: {
    fetch: vi.fn(async () => { throw new Error('Watch must use the stream carrier'); }),
    openStream(endpoint: string, payload: unknown, signal: AbortSignal) {
      expect([endpoint, payload]).toEqual(['dshBot/watch', { args: {} }]);
      const queue: unknown[] = [{ revision: 0 }];
      let wake: (() => void) | undefined;
      const run = { signal, stopped: false, push(value: unknown) { queue.push(value); wake?.(); } };
      runs.push(run);
      return (async function* () {
        const abort = () => wake?.();
        signal.addEventListener('abort', abort, { once: true });
        try {
          while (!signal.aborted) {
            if (queue.length) { yield queue.shift(); if (endAfterOpening) return; continue; }
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        } finally { run.stopped = true; signal.removeEventListener('abort', abort); }
      })();
    },
  } });
  await ctx.plugin(Gateway).await();
  await ctx.effect(() => ctx.remote.$mount(TYPERT_REMOTE));
  const changed = vi.fn();
  let stream!: ReturnType<typeof createChangeStream>;
  const owner = ctx.plugin({ inject: ['remote'], apply(scope: Context) { stream = createChangeStream(scope, changed); } });
  await owner.await();
  return { ctx, owner, changed, runs, stream };
}

describe('public Remote change invalidations', () => {
  it('opens one foreground stream, delivers opening/changes, and releases it on stop and plugin unload', async () => {
    const f = await fixture();
    try {
      f.stream.start(); f.stream.start();
      await vi.waitFor(() => expect(f.changed).toHaveBeenCalledTimes(1));
      expect(f.runs).toHaveLength(1);
      f.runs[0]?.push({ revision: 1 });
      await vi.waitFor(() => expect(f.changed).toHaveBeenCalledTimes(2));
      await f.stream.stop(); await f.stream.stop();
      expect(f.runs[0]?.signal.aborted).toBe(true);
      expect(f.runs[0]?.stopped).toBe(true);
      f.runs[0]?.push({ revision: 2 });
      f.stream.start();
      await vi.waitFor(() => expect(f.changed).toHaveBeenCalledTimes(3));
      expect(f.runs).toHaveLength(2);
      await f.owner.dispose();
      expect(f.runs[1]?.stopped).toBe(true);
      f.stream.start();
      expect(f.runs).toHaveLength(2);
    } finally { await f.ctx.fiber.dispose(); }
  });

  it('validates raw stream frames, stops bad generations and retries only when the scheduler starts it again', async () => {
    const f = await fixture();
    try {
      f.stream.start();
      await vi.waitFor(() => expect(f.changed).toHaveBeenCalledTimes(1));
      f.runs[0]?.push({ revision: 1, unexpected: 'private' });
      await vi.waitFor(() => expect(f.runs[0]?.stopped).toBe(true));
      expect(f.changed).toHaveBeenCalledTimes(1);
      expect(f.runs).toHaveLength(1);
      f.stream.start();
      await vi.waitFor(() => expect(f.changed).toHaveBeenCalledTimes(2));
      await f.stream.stop();
    } finally { await f.ctx.fiber.dispose(); }
  });

  it('keeps older Hosts on polling when no watch namespace is available', async () => {
    const ctx = new Context();
    try {
      const changed = vi.fn();
      const stream = createChangeStream(ctx, changed);
      expect(() => stream.start()).not.toThrow();
      await stream.stop();
      expect(changed).not.toHaveBeenCalled();
    } finally { await ctx.fiber.dispose(); }
  });

  it('does not recursively reopen a generation that ends immediately after its opening', async () => {
    const f = await fixture(true);
    try {
      f.stream.start();
      await vi.waitFor(() => expect(f.runs[0]?.stopped).toBe(true));
      expect(f.changed).toHaveBeenCalledTimes(1);
      expect(f.runs).toHaveLength(1);
      f.stream.start(); // only a later scheduler cycle can request another open
      await vi.waitFor(() => expect(f.runs[1]?.stopped).toBe(true));
      expect(f.changed).toHaveBeenCalledTimes(2);
      expect(f.runs).toHaveLength(2);
    } finally { await f.ctx.fiber.dispose(); }
  });
});
