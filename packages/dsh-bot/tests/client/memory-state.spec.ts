import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryCatalog } from '../../src/client/memory-state.js';
import type { MemoryRecord } from '../../src/shared/schema.js';

const contexts: Context[] = [];
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function row(id: string): MemoryRecord {
  return { id, botId: 'alpha', content: id, tags: [], kind: 'note', pinned: false, createdAt: 1, updatedAt: 2 };
}
function setup() {
  const ctx = new Context();
  contexts.push(ctx);
  const memory = {
    list: vi.fn(async (_botId: string, _input: unknown) => ({ ok: true as const, value: [row('one'), row('two'), row('three')] })),
    search: vi.fn(async (_botId: string, _input: unknown) => ({ ok: true as const, value: [row('match')] })),
    count: vi.fn(async (_botId: string) => ({ ok: true as const, value: 205 })),
  };
  ctx.provide('remote.dshBot.memory', memory);
  const catalog = createMemoryCatalog(ctx, 'alpha', { pageSize: 2 });
  return { ctx, memory, catalog };
}
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers();
});
describe('memory catalog pagination and lifetime', () => {
  it('uses Bot-scoped count beyond pagination and requests lookahead with stable cursor', async () => {
    const { memory, catalog } = setup();
    await catalog.refresh();
    expect(memory.list).toHaveBeenCalledWith('alpha', { limit: 3, before: undefined });
    expect(memory.count).toHaveBeenCalledWith('alpha');
    expect(catalog.getSnapshot()).toMatchObject({ total: 205, hasNext: true, records: [row('one'), row('two')] });
    memory.list.mockResolvedValueOnce({ ok: true, value: [row('three')] });
    catalog.nextPage();
    await settle();
    expect(memory.list).toHaveBeenLastCalledWith('alpha', { limit: 3, before: { id: 'two', pinned: false, updatedAt: 2 } });
    expect(catalog.getSnapshot()).toMatchObject({ hasNext: false, records: [row('three')] });
    catalog.setQuery('  hello  ');
    await settle();
    expect(memory.search).toHaveBeenCalledWith('alpha', { query: 'hello', limit: 3, before: undefined });
    catalog.setQuery('');
    await settle();
    expect(catalog.getSnapshot().query).toBe('');
  });

  it('discards responses from a previous search and a disposed panel', async () => {
    const { memory, catalog } = setup();
    let resolve!: (value: Awaited<ReturnType<typeof memory.list>>) => void;
    memory.list.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const old = catalog.refresh();
    catalog.setQuery('new query');
    await settle();
    resolve({ ok: true, value: [row('stale')] });
    await old;
    expect(catalog.getSnapshot().records).toEqual([row('match')]);
    const listener = vi.fn();
    catalog.subscribe(listener);
    catalog.dispose();
    await settle();
    listener.mockClear();
    await catalog.refresh();
    expect(listener).not.toHaveBeenCalled();
  });

  it('retains a failed page, recovers on reset, polls and releases after the last subscriber', async () => {
    vi.useFakeTimers();
    const { ctx, memory, catalog } = setup();
    const stop = catalog.subscribe(() => {});
    await settle();
    memory.list.mockRejectedValueOnce(new Error('offline'));
    await catalog.refresh();
    expect(catalog.getSnapshot()).toMatchObject({ records: [row('one'), row('two')], error: { message: 'offline' } });
    ctx.emit('connection/reset');
    await settle();
    expect(catalog.getSnapshot().error).toBeUndefined();
    const calls = memory.list.mock.calls.length;
    catalog.setPollIntervalMs(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(memory.list).toHaveBeenCalledTimes(calls + 1);
    stop();
    ctx.emit('connection/reset');
    await vi.advanceTimersByTimeAsync(5000);
    expect(memory.list).toHaveBeenCalledTimes(calls + 1);
  });
});
