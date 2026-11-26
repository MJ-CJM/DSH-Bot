import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { describe, expect, it, vi } from 'vitest';
import { createChangeStream, sharedChangeStream } from '../../src/client/change-stream.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import { createSupergroupUiBridge } from '../../src/client/supergroup.js';
import { createTaskSupportActions } from '../../src/client/task-support.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
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

  it('shares one remote.watch stream across scheduler, supergroup, and task-support without duplicate refreshes, and cleans up on dispose', async () => {
    const runs: { signal: AbortSignal; push(revision: number): void; stopped: boolean }[] = [];
    const watch = vi.fn((signal: AbortSignal) => {
      const queue: Array<{ revision: number }> = [{ revision: 0 }];
      let wake: (() => void) | undefined;
      const run = { signal, stopped: false, push(revision: number) { queue.push({ revision }); wake?.(); } };
      runs.push(run);
      const iterable = (async function* () {
        const abort = () => wake?.();
        signal.addEventListener('abort', abort, { once: true });
        try {
          while (!signal.aborted) {
            const next = queue.shift();
            if (next) { yield next; continue; }
            await new Promise<void>(resolve => { wake = resolve; });
          }
        } finally { run.stopped = true; signal.removeEventListener('abort', abort); }
      })();
      return Object.assign(iterable, { dispose() { wake?.(); } });
    });

    const ctx = new Context();
    let groupVersion = 0;
    const groupList = vi.fn(async () => ({
      ok: true as const,
      value: [{
        group: {
          id: `g-${++groupVersion}`, name: 'Team', cwd: '/tmp', rootSessionId: 'root', mode: 'natural' as const,
          createdAt: 1, updatedAt: groupVersion, revision: groupVersion, membershipRevision: 1,
          schemaVersion: 1, archived: false, state: 'ready' as const,
        },
        members: [],
        running: false,
      }],
    }));
    const forSession = vi.fn(async () => ({ ok: true as const, value: null }));
    ctx.provide('remote.dshBot', { watch } as never);
    ctx.provide('remote.dshBot.groups', { list: groupList } as unknown as GroupMethods);
    ctx.provide('remote.dshBotSupergroup', { forSession } as never);

    try {
      const groups = createGroupActions(ctx, {});
      const supergroup = createSupergroupUiBridge(ctx, groups);
      const taskSupport = createTaskSupportActions(ctx, listener => groups.catalog.watch?.(listener) ?? (() => {}));
      const taskListener = vi.fn();

      const offCatalog = groups.catalog.subscribe(() => {});
      const offSupergroup = supergroup.source('origin', 'msg-1').subscribe(() => {});
      const offTask = taskSupport.subscribe?.(taskListener);

      // Wait for initial mount reads AND the opening `{ revision: 0 }` frame to settle.
      await vi.waitFor(() => expect(taskListener).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(groupList.mock.calls.length).toBeGreaterThanOrEqual(2));
      await vi.waitFor(() => expect(forSession.mock.calls.length).toBeGreaterThanOrEqual(2));
      for (let i = 0; i < 6; i++) await Promise.resolve();
      expect(watch).toHaveBeenCalledTimes(1);
      expect(sharedChangeStream(ctx).isActive()).toBe(true);

      const supergroupCallsBefore = forSession.mock.calls.length;
      const taskCallsBefore = taskListener.mock.calls.length;
      const listCallsBefore = groupList.mock.calls.length;

      runs[0]?.push(1);
      await vi.waitFor(() => expect(groupList).toHaveBeenCalledTimes(listCallsBefore + 1));
      await vi.waitFor(() => expect(forSession).toHaveBeenCalledTimes(supergroupCallsBefore + 1));
      await vi.waitFor(() => expect(taskListener).toHaveBeenCalledTimes(taskCallsBefore + 1));
      // Allow catalog.watch to settle and confirm neither supergroup nor task-support double-refreshed.
      for (let i = 0; i < 6; i++) await Promise.resolve();
      expect(watch).toHaveBeenCalledTimes(1);
      expect(forSession).toHaveBeenCalledTimes(supergroupCallsBefore + 1);
      expect(taskListener).toHaveBeenCalledTimes(taskCallsBefore + 1);

      offCatalog();
      offSupergroup();
      offTask?.();
      await vi.waitFor(() => expect(runs[0]?.stopped).toBe(true));
      expect(runs[0]?.signal.aborted).toBe(true);

      // Re-subscribe and verify ctx.fiber.dispose() cleans up the active shared stream.
      groups.catalog.subscribe(() => {});
      supergroup.source('origin', 'msg-1').subscribe(() => {});
      taskSupport.subscribe?.(taskListener);
      await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(2));
      await ctx.fiber.dispose();
      expect(runs[1]?.signal.aborted).toBe(true);
      expect(runs[1]?.stopped).toBe(true);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
