import { required } from '../fixtures/required.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { rebuild } from '../../src/host/memory/projection.js';
import { command, v2Fixture } from './v2-fixtures.js';

describe('I10 restart and uncertain commits', () => {
  it('forgets one subject of a batch without deleting another subject payload', async () => {
    const f = await v2Fixture();
    try {
      const a = command(f, 'BATCH_ERASE'), b = command(f, 'BATCH_KEEP');
      await f.kernel.commit({ ...a, subjectIds: [...a.subjectIds, ...b.subjectIds],
        versions: [...a.versions, ...b.versions], payloads: { ...a.payloads, ...b.payloads } });
      await f.alpha.forget({ id: required(a.subjectIds[0]) });
      await f.reopen();
      expect(f.kernel.domain.table('payloads').size).toBe(1);
      expect([...f.kernel.domain.table('payloads').entries()].map(([, p]) => p.content)).toEqual(['BATCH_KEEP']);
      expect(f.kernel.blocked).toBe(true);
    } finally { await f.close(); }
  });
  it.each([false, true])('freezes after op I/O uncertainty and reconciles actual durable presence (committed=%s)', async persisted => {
    const f = await v2Fixture();
    try {
      const c = command(f), table = f.kernel.domain.table('ops'), original = table.put.bind(table);
      const fault = vi.spyOn(table, 'put').mockImplementationOnce(async (id, row) => {
        if (persisted) await original(id, row); throw new Error('synthetic lost acknowledgement');
      });
      await expect(f.kernel.commit(c)).rejects.toThrow('outcome unknown'); fault.mockRestore();
      expect(() => f.kernel.snapshot).toThrow('reconciliation');
      await expect(f.kernel.commit(c)).rejects.toThrow('reconciliation');
      await f.reopen();
      expect(f.kernel.seq).toBe(Number(persisted));
      expect(f.kernel.domain.table('ops').get(c.opId) !== undefined).toBe(persisted);
      expect(f.kernel.domain.table('payloads').size).toBe(Number(persisted));
      if (persisted) expect(await f.kernel.commit(c)).toMatchObject({ opId: c.opId });
      else { await f.kernel.commit(c); expect(f.kernel.seq).toBe(1); }
    } finally { await f.close(); }
  });
  it('rebuilds stale/failed projection caches, deletes orphan payloads and keeps forgotten IDs erased across reopen', async () => {
    const f = await v2Fixture();
    try {
      const c = command(f), cache = f.kernel.domain.table('projections');
      const fault = vi.spyOn(cache, 'put').mockRejectedValueOnce(new Error('cache unavailable'));
      await f.kernel.commit(c); fault.mockRestore(); expect(f.kernel.cacheFailures).toBe(1);
      await cache.put(required(c.subjectIds[0]), { invalidCache: 'must rebuild from log' });
      await f.kernel.domain.table('payloads').put(randomUUID(), required(c.payloads[required(c.versions[0]).contentRef]));
      await f.reopen(); expect(f.kernel.snapshot).toEqual(rebuild(f.kernel.domain));
      expect(f.kernel.domain.table('projections').size).toBe(1);
      expect(f.kernel.domain.table('payloads').size).toBe(1);
      await f.kernel.commit({ opId: randomUUID(), kind: 'forget', subjectIds: c.subjectIds, expectedRevision: 1, forgetEpoch: 1 });
      await f.reopen(); expect(f.kernel.snapshot.versions.size).toBe(0); expect(f.kernel.domain.table('payloads').size).toBe(0);
      expect(f.kernel.blocked).toBe(true); expect(f.kernel.epoch).toBe(1);
      const resurrection = command(f); required(resurrection.versions[0]).memoryId = required(c.subjectIds[0]);
      await expect(f.kernel.commit(resurrection)).rejects.toThrow();
    } finally { await f.close(); }
  });
});
