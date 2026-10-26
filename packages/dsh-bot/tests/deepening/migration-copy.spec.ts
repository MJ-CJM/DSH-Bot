import { required } from '../fixtures/required.js';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migratePrivate, FENCE_KEY, assertCompatibleRecovery } from '../../src/host/memory/migration.js';
import { memorySchema } from '../../src/shared/schema.js';
import { v2Fixture } from './v2-fixtures.js';

describe('I22 private migration and restart gates', () => {
  it('copies and verifies all content/source/time/mappings, quarantines unproven ownership and retains the Fence', async () => {
    const f = await v2Fixture(false);
    try {
      const rows = ['alpha', 'orphan'].map((botId, i) => memorySchema.parse({ id: `legacy-${i}`, botId,
        content: `SYNTHETIC_LEGACY_${i}`, kind: 'fact', tags: ['legacy'], pinned: true,
        source: { by: 'user', at: 10, sessionId: 'synthetic-source' }, createdAt: 10, updatedAt: 20 }));
      for (const row of rows) await f.legacy.table('memories').put(row.id, row);
      const result = await migratePrivate(f.legacy, f.kernel);
      expect(result).toMatchObject({ phase: 'done', counts: { source: 2, copied: 2, quarantined: 2 } });
      expect(result.sourceDigest).toBeUndefined(); expect(f.legacy.table('memories').size).toBe(1);
      expect(f.legacy.table('memories').get(FENCE_KEY)).toMatchObject({ kind: 'migration-fence' });
      expect(await f.alpha.list()).toEqual([]);
      for (const [, v] of f.kernel.snapshot.versions) {
        expect(v).toMatchObject({ scope: 'private', trust: 'candidate', status: 'proposed', legacyKind: 'fact', recordedAt: 10 });
        const p = required(f.kernel.domain.table('payloads').get(v.contentRef));
        const row = required(rows.find(r => r.id === required(p.legacy).id));
        expect({ ...p.legacy, content: p.content }).toEqual(row); expect(p.valid.basis).toBe('unknown');
      }
      await f.reopen(); const again = await migratePrivate(f.legacy, f.kernel);
      expect(again).toEqual(result); expect(f.kernel.seq).toBe(2);
    } finally { await f.close(); }
  });
  it('resumes a Fence-before-cutover failure with the same IDs and never double copies', async () => {
    const f = await v2Fixture(false);
    try {
      const row = memorySchema.parse({ id: 'legacy', botId: 'alpha', content: 'safe', kind: 'note', tags: [],
        pinned: false, createdAt: 10, updatedAt: 10 });
      await f.legacy.table('memories').put(row.id, row);
      const table = f.kernel.domain.table('migration'), put = table.put.bind(table);
      const fault = vi.spyOn(table, 'put').mockImplementation(async (key, value) => {
        if (value.phase === 'cutover') throw new Error('synthetic cutover I/O'); return put(key, value);
      });
      await expect(migratePrivate(f.legacy, f.kernel)).rejects.toThrow('cutover I/O'); fault.mockRestore();
      expect(f.legacy.table('memories').get(FENCE_KEY)).toBeDefined();
      const mapping = [...f.kernel.domain.table('migration_items').entries()]; await f.reopen();
      await migratePrivate(f.legacy, f.kernel);
      expect([...f.kernel.domain.table('migration_items').entries()]).toEqual(mapping); expect(f.kernel.seq).toBe(1);
    } finally { await f.close(); }
  });
  it('rejects reserved-key collision and incompatible recovery, and preserves forgotten tombstones on a compatible reopen', async () => {
    const f = await v2Fixture(false);
    try {
      const row = memorySchema.parse({ id: FENCE_KEY, botId: 'alpha', content: 'collision', kind: 'note', tags: [],
        pinned: false, createdAt: 10, updatedAt: 10 });
      await f.legacy.table('memories').put(FENCE_KEY, row);
      await expect(migratePrivate(f.legacy, f.kernel)).rejects.toThrow('Fence key conflict');
      await f.legacy.table('memories').delete(FENCE_KEY); await migratePrivate(f.legacy, f.kernel);
      const { id } = await f.alpha.save({ content: 'FORGET_BEFORE_RECOVERY' }); await f.alpha.forget({ id });
      await f.reopen();
      expect(() => assertCompatibleRecovery(f.kernel, { fence: true, tombstone: false, epoch: true })).toThrow('Incompatible');
      assertCompatibleRecovery(f.kernel, { fence: true, tombstone: true, epoch: true });
      expect(f.kernel.snapshot.forgotten.has(id)).toBe(true); expect(f.kernel.blocked).toBe(true);
      expect(JSON.stringify([...f.kernel.domain.table('ops').entries()])).not.toContain('FORGET_BEFORE_RECOVERY');
      await expect(f.kernel.commit({ opId: randomUUID(), kind: 'policy', subjectIds: [], expectedRevision: f.kernel.seq,
        forgetEpoch: f.kernel.epoch })).rejects.toThrow('cleanup pending');
    } finally { await f.close(); }
  });
});
