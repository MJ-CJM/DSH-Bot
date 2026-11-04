import assert from 'node:assert/strict';
import { SlotCore, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '../../src/client/group-execution.js';
import { describe, expect, it, vi } from 'vitest';
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import type { GroupDelivery, GroupTurn } from '../../src/shared/groups.js';
import { aggregateStatistics, cachePercent, contextPercent, defaultStatisticsTurn, groupStatisticsWorkers, GroupStatsSource, loadingStatistics, readStatistics, readStatisticsOnce, statisticsDeliveries, tokenTotal } from '../../src/client/group-statistics.js';
const usage = (input: number, read: number) => ({ uncachedInputTokens: input - read, cacheReadTokens: read, cacheWriteTokens: 0, outputTokens: 20 });
function native() {
  const values: Record<string, unknown> = { tokenUsage: usage(100, 80), sessionStats: { turns: 1, steps: 2, decodeMs: 1000, decodeTokens: 20 } };
  const listeners = new Set<() => void>();
  const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
  const binding = { session: { getSnapshot: () => ({ openState: 'ready' }), subscribe,
    projections: { faceOf: (key: string) => ({ getSnapshot: () => values[key], subscribe }) } } } as unknown as SessionBinding;
  const release = vi.fn(), retain = vi.fn(() => ({ binding, ready: Promise.resolve(binding), release }));
  return { values, binding, release, retain, listeners, sessions: { retain } as unknown as ISessions };
}
describe('native group statistics', () => {
  it('weights cache by input, adds four buckets once, preserves known partial usage', () => {
    const sum = aggregateStatistics([{ state: 'ready', usage: usage(100, 80) }, { state: 'ready', usage: usage(900, 90) }, { state: 'unavailable' }]);
    assert.ok(sum.usage); expect(cachePercent(sum.usage)).toBe(17); expect(tokenTotal(sum.usage)).toBe(1040); expect(sum.readable).toBe(2);
    expect(aggregateStatistics([{ state: 'ready' }]).usage).toBeUndefined();
    expect(cachePercent(usage(0, 0))).toBeUndefined();
  });
  it('does not invent missing fields or context capacity', () => {
    const f = native(); f.values.tokenUsage = { inputTokens: 10 }; f.values.contextPressure = { pressureTokens: 100 };
    expect(readStatistics(f.binding).usage).toBeUndefined(); expect(contextPercent(readStatistics(f.binding))).toBeUndefined();
    f.values.contextPressure = { pressureTokens: 100, projectedTokens: 200, contextWindow: 1000 };
    expect(contextPercent(readStatistics(f.binding))).toBe(20);
    f.values.sessionStats = { turns: 1, steps: -1 }; expect(readStatistics(f.binding).activity).toBeUndefined();
  });
  it('deduplicates multi-round receipts, keeps failed/legacy workers, excludes ownership conflicts', () => {
    const row = (id: string, extra = {}) => ({ id, turnId: 't1', memberId: 'm', childSessionId: 'c1', state: 'completed', ...extra }) as GroupDelivery;
    const deliveries = [row('a'), row('b'), row('receipt', { reasonCode: 'message-published' }), row('join', { joinedDeliveryId: 'a' }), row('legacy', { childSessionId: 'c2', state: 'cancelled' })];
    expect(statisticsDeliveries({ deliveries }, 't1')).toHaveLength(2);
    deliveries.push(row('conflict', { turnId: 't2' }));
    expect(statisticsDeliveries({ deliveries }, 't1').map(r => r.conflict)).toEqual([true, false]);
  });
  it('defaults to recent active question, then recent question', () => {
    const turns = [{ id: 'old', createdAt: 1, state: 'running' }, { id: 'new', createdAt: 2, state: 'idle' }] as GroupTurn[];
    expect(defaultStatisticsTurn(turns)?.id).toBe('old'); assert.ok(turns[0]); turns[0].state = 'idle'; expect(defaultStatisticsTurn(turns)?.id).toBe('new');
  });
  it('shares exact child bindings, live projections and releases all listeners over 20 reopen cycles', async () => {
    const f = native(), source = new GroupStatsSource(() => f.sessions);
    for (let n = 0; n < 20; n++) {
      const a = source.source('parent', 'child'), b = source.source('parent', 'child'); expect(a).toBe(b);
      const offA = a.subscribe(() => {}), offB = b.subscribe(() => {}); await Promise.resolve();
      expect(f.retain).toHaveBeenLastCalledWith({ parentSessionId: 'parent', childSessionId: 'child', mode: 'unknown' }, { source: 'dshBotGroupStatistics' });
      expect(a.getSnapshot().usage).toEqual(usage(100, 80));
      offA(); expect(f.release).toHaveBeenCalledTimes(n); offB(); offB(); expect(f.listeners.size).toBe(0);
      expect(f.release).toHaveBeenCalledTimes(n + 1);
    }
    expect(f.retain).toHaveBeenCalledTimes(20); source.dispose();
  });
  it('ignores late readiness after release and disposes live refs on unload', async () => {
    const f = native(); let ready!: (b: SessionBinding) => void;
    f.retain.mockReturnValue({ binding: f.binding, release: f.release, ready: new Promise(resolve => { ready = resolve; }) });
    const source = new GroupStatsSource(() => f.sessions), item = source.source('p', 'c');
    const listener = vi.fn(), off = item.subscribe(listener); off(); ready(f.binding); await Promise.resolve();
    expect(listener).not.toHaveBeenCalled(); expect(f.listeners.size).toBe(0);
    item.subscribe(listener); await Promise.resolve(); source.dispose(); expect(f.listeners.size).toBe(0); expect(f.release).toHaveBeenCalledTimes(2);
  });
});

it('updates from public projection events without reopening or mixing parent identities', async () => {
  const f = native(), source = new GroupStatsSource(() => f.sessions);
  const first = source.source('p1', 'child'), second = source.source('p2', 'child');
  expect(first).not.toBe(second);
  const notify = vi.fn(), off = first.subscribe(notify); await Promise.resolve();
  f.values.tokenUsage = usage(900, 90); for (const listener of f.listeners) listener(); await Promise.resolve();
  expect(first.getSnapshot().usage).toEqual(usage(900, 90)); expect(f.retain).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledTimes(2); off(); source.dispose(); expect(f.listeners.size).toBe(0);
});

it('native slot core rejects redeclaring the composer dock on another entry', () => {
  const core = new SlotCore();
  const root = core.register({ name: 'root', children: {
    'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
    'dsh-bot.group.execution': { kind: 'single', scope: 'session' },
  } }, (_props: PropsRenderSlots<'conversation.composer.bar' | 'dsh-bot.group.execution'>) => null);
  const bar = core.register({ name: 'conversation.composer.bar', children: { 'conversation.composer.dock': { kind: 'list', scope: 'session' } } }, (_props: PropsRenderSlots<'conversation.composer.dock'>) => null);
  expect(() => core.register({ name: 'dsh-bot.group.execution', children: { 'conversation.composer.dock': { kind: 'list', scope: 'session' } } }, (_props: PropsRenderSlots<'conversation.composer.dock'>) => null)).toThrow('already declared');
  bar(); root();
});

it('lists every started group session once, keeping a shared one under its first question', () => {
  const delivery = (id: string, turnId: string, childSessionId: string | undefined, state: GroupDelivery['state'], extra: Partial<GroupDelivery> = {}) =>
    ({ id, turnId, memberId: 'm', childSessionId, state, bot: { botId: 'b', botCreatedAt: 1 }, ...extra }) as GroupDelivery;
  const rows = groupStatisticsWorkers({
    turns: [{ id: 'a', state: 'completed' }, { id: 'b', state: 'running' }] as GroupTurn[],
    deliveries: [delivery('1', 'a', 'c1', 'completed'), delivery('2', 'b', 'c1', 'running'), delivery('3', 'b', 'c2', 'completed'),
      delivery('4', 'a', 'c3', 'pending'), delivery('5', 'a', undefined, 'starting'), delivery('6', 'a', 'c4', 'completed', { reasonCode: 'message-published' } as Partial<GroupDelivery>),
      delivery('7', 'a', 'c5', 'completed', { joinedDeliveryId: '1' } as Partial<GroupDelivery>), delivery('8', 'a', 'c6', 'unknown')],
  });
  expect(rows.map(row => [row.childId, row.delivery.turnId, row.live])).toEqual([['c1', 'a', false], ['c2', 'b', true], ['c6', 'a', true]]);
});

it('reads a session once and lets its lease go, also on abort or timeout', async () => {
  vi.useFakeTimers();
  try {
    const listeners = new Set<() => void>(); let snapshot = loadingStatistics;
    const source = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
    const reading = readStatisticsOnce(source, new AbortController().signal);
    expect(listeners.size).toBe(1);
    snapshot = { state: 'ready', usage: { uncachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }; for (const listener of [...listeners]) listener();
    expect((await reading).state).toBe('ready'); expect(listeners.size).toBe(0);
    snapshot = loadingStatistics;
    const controller = new AbortController(), aborted = readStatisticsOnce(source, controller.signal);
    controller.abort(); expect((await aborted).state).toBe('loading'); expect(listeners.size).toBe(0);
    const late = readStatisticsOnce(source, new AbortController().signal, 1000);
    await vi.advanceTimersByTimeAsync(1000); expect((await late).state).toBe('unavailable'); expect(listeners.size).toBe(0);
  } finally { vi.useRealTimers(); }
});
