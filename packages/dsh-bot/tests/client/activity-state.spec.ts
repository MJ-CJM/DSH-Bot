// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis';
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActivityCatalog } from '../../src/client/activity-state.js';
import type { ActivityListResult, ActivitySession } from '../../src/shared/activity.js';

const contexts: Context[] = [];
const row: ActivitySession = { sessionId: 'session-one', botId: 'alpha-bot', lastMessage: { role: 'assistant', preview: 'Reply', at: 10 }, updatedAt: 10, unread: true };
const empty: ActivityListResult = { sessions: [], bots: [] };
const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const ctx = new Context(); contexts.push(ctx);
  const list = vi.fn(async (): Promise<RemoteResult<ActivityListResult>> => ok({ ...empty, sessions: [row] }));
  const markRead = vi.fn(async (): Promise<RemoteResult<ActivitySession>> => ok({ ...row, unread: false, lastReadAt: 10 }));
  ctx.provide('remote.dshBot.activity', { list, markRead });
  return { ctx, list, markRead, catalog: createActivityCatalog(ctx) };
}
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe('shared activity refresh and read ordering', () => {
  it('keeps the last successful session/aggregate snapshot on polling failure and recovers on retry', async () => {
    const { catalog, list } = setup();
    await catalog.refresh();
    const previous = catalog.getSnapshot();
    list.mockResolvedValueOnce({ ok: false, error: new RemoteError('store/unavailable', '', {}) });
    await catalog.refresh();
    expect(catalog.getSnapshot()).toMatchObject({ loaded: true, loading: false, error: { code: 'store/unavailable' } });
    expect(catalog.getSnapshot().sessions).toBe(previous.sessions);
    expect(catalog.getSnapshot().bots).toBe(previous.bots);
    await catalog.refresh();
    expect(catalog.getSnapshot().error).toBeUndefined();
    expect(catalog.getSnapshot().sessions).toEqual([row]);
  });
  it('calls zero-argument list, polls only while visible, and clears resources at the last subscriber', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
    const { catalog, list, ctx } = setup();
    const stop = catalog.subscribe(() => {}); await settle();
    expect(list.mock.calls).toEqual([[]]);
    await vi.advanceTimersByTimeAsync(5000); expect(list).toHaveBeenCalledTimes(2);
    visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10000); expect(list).toHaveBeenCalledTimes(2);
    visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); await settle();
    expect(list).toHaveBeenCalledTimes(3);
    ctx.emit('connection/reset'); await settle(); expect(list).toHaveBeenCalledTimes(4);
    stop(); expect(vi.getTimerCount()).toBe(0);
    ctx.emit('connection/reset'); await settle(); expect(list).toHaveBeenCalledTimes(4);
  });

  it('coalesces concurrent read actions and supersedes a stale poll only after the write commits', async () => {
    const { catalog, list, markRead } = setup();
    const stale = deferred<RemoteResult<ActivityListResult>>();
    const write = deferred<RemoteResult<ActivitySession>>();
    list.mockReturnValueOnce(stale.promise);
    markRead.mockReturnValueOnce(write.promise);
    const poll = catalog.refresh();
    const first = catalog.markRead(row.sessionId); const second = catalog.markRead(row.sessionId);
    expect(first).toBe(second); expect(markRead).toHaveBeenCalledTimes(1); expect(list).toHaveBeenCalledTimes(1);
    list.mockResolvedValue(ok({ ...empty, sessions: [{ ...row, unread: false }] }));
    write.resolve(ok({ ...row, unread: false })); await first;
    stale.resolve(ok({ ...empty, sessions: [row] })); await poll; await settle();
    expect(catalog.getSnapshot().sessions[0]?.unread).toBe(false);
  });

  it('keeps a reply completed after markRead unread, permits missing activity, and rejects real write failures', async () => {
    const { catalog, list, markRead } = setup();
    list.mockResolvedValue(ok({ ...empty, sessions: [{ ...row, lastMessage: { ...row.lastMessage, at: 11 } }] }));
    await catalog.markRead(row.sessionId);
    expect(catalog.getSnapshot().sessions[0]?.unread).toBe(true);
    markRead.mockResolvedValueOnce({ ok: false, error: new RemoteError('activity/not-found', '', {}) });
    await expect(catalog.markRead('evicted')).resolves.toBeUndefined();
    markRead.mockResolvedValueOnce({ ok: false, error: new RemoteError('store/unavailable', '', {}) });
    await expect(catalog.markRead(row.sessionId)).rejects.toMatchObject({ code: 'store/unavailable' });
  });

  it('discards late reads and forbids further actions after owner unload', async () => {
    const { catalog, ctx, list, markRead } = setup();
    const pending = deferred<RemoteResult<ActivityListResult>>(); list.mockReturnValueOnce(pending.promise);
    const reading = catalog.refresh(); await ctx.fiber.dispose();
    pending.resolve(ok({ ...empty, sessions: [row] })); await reading;
    expect(catalog.getSnapshot().sessions).toEqual([]);
    await catalog.markRead(row.sessionId); expect(markRead).not.toHaveBeenCalled();
  });
});
