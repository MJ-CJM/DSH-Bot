import { required } from '../fixtures/required.js';
import { describe, expect, it } from 'vitest';
import { memoryContext, nextDayBoundary } from '../../src/host/memory/context.js';
import { v2Fixture, command } from './v2-fixtures.js';

const policy = { maxInjectChars: 4000, privateShare: 0.6, journalShare: 0.25, journalDays: 30 };
describe('I12 synchronous dynamic context', () => {
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
