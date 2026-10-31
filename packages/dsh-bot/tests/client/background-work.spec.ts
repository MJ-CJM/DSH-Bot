import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackgroundActions } from '../../src/client/background-work-state.js';
const contexts: Context[] = [];
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); });
const ok = <T>(value: T) => ({ ok: true as const, value });
function fixture() {
  const ctx = new Context(); contexts.push(ctx);
  const bot = { id: 'alpha', createdAt: 1 };
  const own = { get: vi.fn(async () => ok(bot)), status: vi.fn(async () => ok([{ id: 'alpha', mainSessionId: 'main' }])) };
  ctx.provide('remote.dshBot', own as never);
  const state = { byId: {}, projectionsBySession: { main: { state: 'ready', values: { subagentCatalog: [
    { id: 'A', mode: 'continuable', label: 'Task A' }, { id: 'B', mode: 'continuable', label: 'Task B' },
    { id: 'old', mode: 'one-shot', label: 'History' },
  ] } } } };
  const refreshProjections = vi.fn(async () => {});
  ctx.provide('sessions', { refreshProjections, list: { getSnapshot: () => state } } as never);
  const statuses = new Map<string, { running: boolean }>([['A', { running: true }], ['B', { running: true }]]);
  ctx.provide('uiSession', { sessionStatus: { getSnapshot: () => statuses } } as never);
  const native = { interruptByParent: vi.fn(async () => ok({ accepted: true })), prompt: vi.fn(async () => ok({ messageId: 'message' })) };
  ctx.provide('remote.subagents', native as never);
  const openSession = vi.fn(); ctx.provide('uiWorkspace', { openSession } as never);
  const source = createBackgroundActions(ctx).forBot(bot);
  return { source, native, own, state, statuses, openSession };
}
describe('Bot native child catalog actions', () => {
  it('uses Host status for unlisted children, opens addressed native UI and stops only A', async () => {
    const f = fixture(); await f.source.catalog.refresh();
    const [a, b] = f.source.catalog.getSnapshot().tasks;
    if (!a || !b) throw new Error('Missing tasks');
    expect(a.running).toBe(true); expect(b.running).toBe(true); expect(f.state.byId).toEqual({});
    await f.source.open(a); expect(f.openSession).toHaveBeenCalledWith({ parentSessionId: 'main', childSessionId: 'A', mode: 'continuable' });
    await f.source.stop(a); expect(f.native.interruptByParent.mock.calls).toEqual([['A', 'main', 'continuable']]);
  });
  it('supplement uses native queue/steer prompt only on explicit human action', async () => {
    const f = fixture(); await f.source.catalog.refresh(); const a = f.source.catalog.getSnapshot().tasks[0];
    if (!a) throw new Error('Missing task'); expect(f.native.prompt).not.toHaveBeenCalled();
    await f.source.supplement(a, ' more details ', 'steer');
    expect(f.native.prompt).toHaveBeenCalledWith(expect.objectContaining({ parentSessionId: 'main', childSessionId: 'A', delivery: 'steer',
      content: [{ type: 'text', text: 'more details' }] }));
  });
  it('rejects inactive or unknown continuation and rechecks state after selection', async () => {
    const f = fixture(); await f.source.catalog.refresh(); const a = f.source.catalog.getSnapshot().tasks[0];
    if (!a) throw new Error('Missing task');
    f.statuses.set('A', { running: false });
    await expect(f.source.supplement(a, 'late input', 'queue')).rejects.toThrow('Only a running task');
    f.statuses.delete('A');
    await expect(f.source.supplement(a, 'unknown input', 'steer')).rejects.toThrow('Only a running task');
    expect(f.native.prompt).not.toHaveBeenCalled();
    await f.source.open(a); await f.source.stop(a);
    expect(f.openSession).toHaveBeenCalledOnce(); expect(f.native.interruptByParent).toHaveBeenCalledOnce();
  });
  it('unknown stays unknown; explicit stop-all includes possibly running children and excludes history', async () => {
    const f = fixture(); f.statuses.delete('B'); await f.source.catalog.refresh();
    expect(f.source.catalog.getSnapshot().tasks[1]?.running).toBeUndefined();
    await f.source.stopAll(); expect(f.native.interruptByParent.mock.calls).toEqual([['A', 'main', 'continuable'], ['B', 'main', 'continuable']]);
  });
  it('rejects a recreated Bot or stale child instead of operating on another identity', async () => {
    const f = fixture(); await f.source.catalog.refresh(); const a = f.source.catalog.getSnapshot().tasks[0]; if (!a) throw new Error('Missing task');
    f.own.get.mockResolvedValue(ok({ id: 'alpha', createdAt: 2 }));
    await expect(f.source.stop(a)).rejects.toThrow('Bot identity changed'); expect(f.native.interruptByParent).not.toHaveBeenCalled();
    f.own.get.mockResolvedValue(ok({ id: 'alpha', createdAt: 1 })); f.state.projectionsBySession.main.values.subagentCatalog = [];
    await expect(f.source.supplement(a, 'input', 'queue')).rejects.toThrow('Child no longer belongs'); expect(f.native.prompt).not.toHaveBeenCalled();
  });
});
