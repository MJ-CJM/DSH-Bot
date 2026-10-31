import { required } from '../fixtures/required.js';
import { describe, expect, it, vi } from 'vitest';
import { memoryContext, nextDayBoundary, registerMemoryContext } from '../../src/host/memory/context.js';
import { v2Fixture, command } from './v2-fixtures.js';

const policy = { maxInjectChars: 4000, privateShare: 0.6, journalShare: 0.25, journalDays: 30 };
describe('I12 synchronous dynamic context', () => {
  it('limits automatic group context to its audience and invalidates the cache when the audience changes', async () => {
    const f = await v2Fixture();
    try {
      await f.alpha.save({ content: 'PRIVATE_ALPHA_ONLY' });
      const alpha = { botId: 'alpha', botCreatedAt: 1 }, beta = { botId: 'beta', botCreatedAt: 2 };
      let audience = [alpha];
      const observed = vi.fn();
      const provider = memoryContext(f.kernel, alpha, policy, 20, Date.now, observed, () => audience);
      expect(provider()).toContain('PRIVATE_ALPHA_ONLY');
      audience = [alpha, beta];
      expect(provider()).not.toContain('PRIVATE_ALPHA_ONLY');
      expect(observed).toHaveBeenLastCalledWith([]);
      audience = [alpha];
      expect(provider()).toContain('PRIVATE_ALPHA_ONLY');
    } finally { await f.close(); }
  });
  it('refreshes every committed revision, keeps literal interpolation and excludes the other Bot', async () => {
    const f = await v2Fixture();
    try {
      const provider = memoryContext(f.kernel, { botId: 'alpha', botCreatedAt: 1 }, policy, 20);
      expect(provider()).toBe('');
      const { id } = await f.alpha.save({ content: 'SYNTHETIC_OLD {{literal}}' });
      await f.beta.save({ content: 'SYNTHETIC_OTHER_BOT' });
      expect(provider()).toContain('SYNTHETIC_OLD {{literal}}'); expect(provider()).not.toContain('OTHER_BOT');
      await f.alpha.update(id, { content: 'SYNTHETIC_NEW' });
      expect(provider()).toContain('SYNTHETIC_NEW'); expect(provider()).not.toContain('SYNTHETIC_OLD');
      await f.alpha.forget({ id }); expect(provider()).toBe(''); expect(f.kernel.blocked).toBe(true);
    } finally { await f.close(); }
  });
  it('invalidates at future from/to, midnight and clock rollback without any writes', async () => {
    expect(nextDayBoundary(Date.parse('2026-03-08T08:00:00Z'), 'America/Los_Angeles'))
      .toBe(Date.parse('2026-03-09T07:00:00Z'));
    expect(nextDayBoundary(Date.parse('2026-01-01T15:59:59.999Z'), 'Asia/Shanghai'))
      .toBe(Date.parse('2026-01-01T16:00:00Z'));
    const f = await v2Fixture();
    try {
      const c = command(f, 'FUTURE_FACT'), p = required(c.payloads[required(c.versions[0]).contentRef]);
      p.valid = { from: 100, to: 200, basis: 'explicit' }; await f.kernel.commit(c);
      let now = 99; const provider = memoryContext(f.kernel, { botId: 'alpha', botCreatedAt: 1 }, policy, 20, () => now);
      expect(provider()).toBe(''); now = 100; expect(provider()).toContain('FUTURE_FACT');
      now = 199; expect(provider()).toContain('FUTURE_FACT'); now = 200; expect(provider()).toBe('');
      now = 120; expect(provider()).toContain('FUTURE_FACT'); now = 86400000; expect(provider()).toBe('');
    } finally { await f.close(); }
  });
  it('counts full Unicode code points including framing, never truncates an oversize pin or injects disputed/shared rows', async () => {
    const f = await v2Fixture();
    try {
      await f.alpha.save({ content: '😀'.repeat(250), pinned: true });
      await f.alpha.save({ content: 'whole small fact' });
      const c = command(f, 'DISPUTED'); required(c.versions[0]).status = 'disputed'; await f.kernel.commit(c);
      const text = memoryContext(f.kernel, { botId: 'alpha', botCreatedAt: 1 }, { ...policy, maxInjectChars: 220 }, 20)();
      expect([...text].length).toBeLessThanOrEqual(220); expect(text).toContain('whole small fact');
      expect(text).not.toContain('😀'); expect(text).not.toContain('DISPUTED'); expect(text).toContain('More memories');
    } finally { await f.close(); }
  });
});

describe('B3-rework Host calendar policy and configured context order', () => {
  it.each([
    ['Asia/Shanghai', '2026-01-01T15:59:59.999Z', '2026-01-01T16:00:00Z'],
    ['America/Los_Angeles', '2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z'],
    ['America/Los_Angeles', '2026-11-01T07:00:00Z', '2026-11-02T08:00:00Z'],
  ])('invalidates cached payload reads at %s midnight across DST (%s)', async (zone, from, to) => {
    const f = await v2Fixture(true, zone);
    try {
      expect(f.kernel.scope).toMatchObject({ quotaTimeZone: zone, policyRevision: 1 });
      const c = command(f, 'CALENDAR_FACT'); await f.kernel.commit(c);
      let now = Date.parse(from);
      const provider = memoryContext(f.kernel, { botId: 'alpha', botCreatedAt: 1 }, policy, 20, () => now);
      const spy = vi.spyOn(f.kernel.domain.table('payloads'), 'get');
      expect(provider()).toContain('CALENDAR_FACT'); expect(spy).toHaveBeenCalledTimes(1);
      now = Date.parse(to) - 1; provider(); expect(spy).toHaveBeenCalledTimes(1);
      now++; provider(); expect(spy).toHaveBeenCalledTimes(2);
      provider(); expect(spy).toHaveBeenCalledTimes(2); spy.mockRestore();
      await f.reopen(); expect(f.kernel.scope).toMatchObject({ quotaTimeZone: zone, policyRevision: 1 });
    } finally { await f.close(); }
  });
  it('resolves the Host default at startup and keeps its policy on recovery with another requested zone', async () => {
    const f = await v2Fixture();
    try {
      const before = f.kernel.scope;
      expect(before.quotaTimeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      await f.kernel.recover(before.quotaTimeZone === 'UTC' ? 'Asia/Shanghai' : 'UTC');
      expect(f.kernel.scope).toEqual(before);
    } finally { await f.close(); }
  });
  it('registers the configured order with required literal context and returns its disposer', async () => {
    const f = await v2Fixture();
    try {
      const dispose = vi.fn(), context = vi.fn((_input: unknown) => dispose), observed = vi.fn();
      const agent = { ctx: { systemPrompt: { context } }, session: { id: 'synthetic-order' } };
      const off = registerMemoryContext(agent as unknown as Parameters<typeof registerMemoryContext>[0],
        { botId: 'alpha', botCreatedAt: 1 }, f.kernel,
        { observed } as unknown as Parameters<typeof registerMemoryContext>[3], { ...policy, memorySectionOrder: 175 }, 20);
      expect(context).toHaveBeenCalledWith(expect.objectContaining({ order: 175, required: true, interpolate: false }));
      const provider = required(context.mock.calls[0]) as unknown as [{ text: () => string }];
      provider[0].text(); expect(observed).toHaveBeenCalledWith('synthetic-order', []);
      off(); expect(dispose).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
});
