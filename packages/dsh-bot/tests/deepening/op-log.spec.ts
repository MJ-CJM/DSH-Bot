import { required } from '../fixtures/required.js';
import { describe, expect, it } from 'vitest';
import { command, v2Fixture } from './v2-fixtures.js';

describe('I09 durable op commit', () => {
  it('reuses opId exactly once and rejects a changed payload under that identity', async () => {
    const f = await v2Fixture();
    try {
      const c = command(f); const first = await f.kernel.commit(c);
      expect(await f.kernel.commit(c)).toEqual(first);
      expect(f.kernel.seq).toBe(1); expect(f.kernel.domain.table('ops').size).toBe(1);
      expect(() => (f.kernel.snapshot.versions as Map<string, unknown>).clear()).toThrow('immutable');
      const changed = structuredClone(c); required(changed.payloads[required(c.versions[0]).contentRef]).content = 'different';
      await expect(f.kernel.commit(changed)).rejects.toThrow('opId reused');
      const serialized = JSON.stringify([...f.kernel.domain.table('ops').entries()]);
      expect(serialized).not.toContain('SYNTHETIC_V2');
    } finally { await f.close(); }
  });
  it('serializes concurrent normalized saves and enforces epoch/CAS before persistent writes', async () => {
    const f = await v2Fixture();
    try {
      const results = await Promise.all(['Ｕｓｅ  tea', 'Use\ttea'].map(content => f.alpha.save({ content })));
      expect(new Set(results.map(r => r.id)).size).toBe(1);
      const c = command(f); await f.alpha.save({ content: 'other' });
      await expect(f.kernel.commit(c)).rejects.toThrow('revision conflict');
      const { id } = required(results[0]); await f.alpha.forget({ id });
      expect(f.kernel.epoch).toBe(1); expect(f.kernel.blocked).toBe(true);
      expect((await f.alpha.list()).some(r => r.id === id)).toBe(false);
      await expect(f.alpha.save({ content: 'Use tea' })).rejects.toThrow('cleanup pending');
    } finally { await f.close(); }
  });
});
