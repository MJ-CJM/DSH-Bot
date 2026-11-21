import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DshBotMemoryRemote } from '../../lib/host/memory/remote.js';
import type { DshBotRegistry } from '../../src/host/registry.js';
import { dshBotRemoteSpec } from '../../src/shared/remote-contract.js';
import { v2Fixture } from './v2-fixtures.js';
import { management } from './shared-fixtures.js';
import { memoryVersionSchema } from '../../src/shared/memory-v2.js';

describe('retained memory changes and safe restore', () => {
  it('permits a ledger-authorized publication while its source permissions remain intact; tightening the source hides every derived old body', async () => {
    const f = await v2Fixture();
    try {
      const m = management(f);
      const privateId = await m.create({ scope: 'private', botId: 'alpha', kind: 'user_fact', content: 'DERIVED_OLD_SECRET_BODY',
        valid: { from: null, to: null, basis: 'unknown' }, expectedRevision: f.kernel.seq });
      const publishedId = await m.confirm({ id: privateId, versionId: f.kernel.snapshot.versions.get(privateId)!.versionId, botId: 'alpha', scope: 'shared', expectedRevision: f.kernel.seq });
      const published = m.changes({ botId: 'beta' }).rows.find(row => row.version.memoryId === publishedId);
      expect(published?.payload.content).toBe('DERIVED_OLD_SECRET_BODY');
      if (!published) throw new Error('Missing authorized publication');
      await m.revise({ id: publishedId, expectedRevision: f.kernel.seq, patch: { content: 'Published safe edit' } });
      await m.restore({ botId: 'beta', id: publishedId, versionId: published.version.versionId, expectedRevision: f.kernel.seq });
      const current = f.kernel.snapshot.versions.get(privateId); if (!current) throw new Error('Missing source');
      const contentRef = randomUUID();
      const version = memoryVersionSchema.parse({ ...current, versionId: randomUUID(), contentRef, scope: 'private',
        ownerBotKey: { botId: 'beta', botCreatedAt: 2 }, shard: { botId: 'beta', botCreatedAt: 2 },
        revision: current.revision + 1, commitSeq: f.kernel.seq + 1, recordedAt: Date.now(),
        labels: { ...current.labels, readers: [{ botId: 'beta', botCreatedAt: 2 }] } });
      await f.kernel.commit({ opId: randomUUID(), kind: 'revise', subjectIds: [privateId], expectedRevision: f.kernel.seq,
        forgetEpoch: f.kernel.epoch, versions: [version], payloads: { [contentRef]: {
          content: 'Current source only for a different reader', valid: { from: null, to: null, basis: 'unknown' },
        } } });
      for (const botId of ['alpha', 'beta']) {
        expect(JSON.stringify(m.changes({ botId }))).not.toContain('DERIVED_OLD_SECRET_BODY');
        await expect(m.restore({ botId, id: publishedId, versionId: published.version.versionId, expectedRevision: f.kernel.seq })).rejects.toThrow();
      }
    } finally { await f.close(); }
  });
  it.each(['secret', 'revoked', 'pending-cleanup', 'unknown-readers', 'unknown-source', 'other-reader'] as const)(
    'checks current ledger permissions before returning any old payload or diff (%s)', async mode => {
      const f = await v2Fixture();
      try {
        f.ctx.provide('dshBots', { manageMemory: (operation: (m: ReturnType<typeof management>) => unknown) => operation(management(f)),
          invalidate() {} } as unknown as DshBotRegistry);
        await f.ctx.plugin({ inject: ['dshBots'], apply(ctx) { new DshBotMemoryRemote(ctx); } }).await();
        const remote = f.ctx.dshBotMemory;
        const id = await remote.createManaged({ scope: mode === 'other-reader' ? 'shared' : 'private', botId: 'alpha', kind: 'user_fact',
          content: 'OLD_BODY_MUST_NEVER_REAPPEAR', valid: { from: null, to: null, basis: 'unknown' }, expectedRevision: f.kernel.seq });
        const first = (await remote.changes({ botId: 'alpha' })).rows.find(row => row.version.memoryId === id);
        if (!first) throw new Error('Missing original');
        const current = f.kernel.snapshot.versions.get(id); if (!current) throw new Error('Missing current');
        const contentRef = randomUUID();
        const version = memoryVersionSchema.parse({ ...current, versionId: randomUUID(), contentRef,
          revision: current.revision + 1, commitSeq: f.kernel.seq + 1, recordedAt: Date.now(),
          ...(mode === 'other-reader' ? { scope: 'private', ownerBotKey: { botId: 'beta', botCreatedAt: 2 }, shard: { botId: 'beta', botCreatedAt: 2 } } : {}),
          labels: { ...current.labels,
            ...(mode === 'other-reader' ? { readers: [{ botId: 'beta', botCreatedAt: 2 }] } : {}),
            ...(mode === 'unknown-readers' ? { readers: [], originTrust: 'candidate' } : {}),
            ...(mode === 'unknown-source' ? { sourceVersions: [randomUUID()] } : {}),
            ...(['secret', 'revoked', 'pending-cleanup'].includes(mode) ? { restrictions: [mode] } : {}),
          } });
        await f.kernel.commit({ opId: randomUUID(), kind: 'revise', subjectIds: [id], expectedRevision: f.kernel.seq,
          forgetEpoch: f.kernel.epoch, versions: [version], payloads: { [contentRef]: {
            content: 'Current safe replacement', valid: { from: null, to: null, basis: 'unknown' },
          } } });
        for (const botId of ['alpha', 'beta']) {
          const page = await remote.changes({ botId });
          expect(JSON.stringify(page)).not.toContain('OLD_BODY_MUST_NEVER_REAPPEAR');
          await expect(remote.restore({ botId, id, versionId: first.version.versionId, expectedRevision: page.revision })).rejects.toThrow();
        }
        await f.reopen();
        expect(JSON.stringify(await remote.changes({ botId: 'alpha' }))).not.toContain('OLD_BODY_MUST_NEVER_REAPPEAR');
      } finally { await f.close(); }
    });

  it('blocks history and restore after an unknown durable commit outcome', async () => {
    const f = await v2Fixture();
    try {
      const m = management(f);
      const id = await m.create({ scope: 'private', botId: 'alpha', kind: 'user_fact', content: 'Before unknown outcome',
        valid: { from: null, to: null, basis: 'unknown' }, expectedRevision: f.kernel.seq });
      const first = m.changes({ botId: 'alpha' }).rows[0]; if (!first) throw new Error('No original');
      const put = vi.spyOn(f.kernel.domain.table('ops'), 'put').mockRejectedValueOnce(new Error('Unknown durability'));
      await expect(m.revise({ id, expectedRevision: f.kernel.seq, patch: { content: 'Unknown write' } })).rejects.toThrow('outcome unknown');
      expect(() => m.changes({ botId: 'alpha' })).toThrow('reconciliation');
      await expect(m.restore({ botId: 'alpha', id, versionId: first.version.versionId, expectedRevision: f.kernel.seq })).rejects.toThrow();
      put.mockRestore();
    } finally { await f.close(); }
  });
  it('uses real decorated Remote, durable versions, source/time/diff and creates a CAS revision after reopen', async () => {
    const f = await v2Fixture();
    try {
      f.ctx.provide('dshBots', { manageMemory: (operation: (m: ReturnType<typeof management>) => unknown) => operation(management(f)),
        invalidate() {} } as unknown as DshBotRegistry);
      await f.ctx.plugin({ inject: ['dshBots'], apply(ctx) { new DshBotMemoryRemote(ctx); } }).await();
      const remote = f.ctx.dshBotMemory;
      const id = await remote.createManaged({ scope: 'private', botId: 'alpha', kind: 'user_fact', content: 'Original statement',
        valid: { from: null, to: null, basis: 'unknown' }, expectedRevision: f.kernel.seq });
      const first = (await remote.changes({ botId: 'alpha' })).rows[0];
      if (!first) throw new Error('Missing first change');
      await remote.revise({ id, expectedRevision: f.kernel.seq, patch: { content: 'Edited statement', qualifiers: { context: 'work' } } });
      await f.reopen();
      const changes = await remote.changes({ botId: 'alpha' });
      expect(changes.rows.map(row => row.payload.content)).toEqual(['Edited statement', 'Original statement']);
      expect(changes.rows[0]).toMatchObject({ previous: { content: 'Original statement' }, changed: ['content', 'qualifiers'],
        version: { revision: 2, provenance: { channel: 'management' } } });
      expect(changes.rows[0]?.version.recordedAt).toBeGreaterThan(first.version.recordedAt);
      expect(changes.rows[1]?.restorable).toBe(true);
      expect((await remote.changes({ botId: 'beta' })).rows).toEqual([]);
      const spec = dshBotRemoteSpec.methods['dshBot.memory/changes'];
      expect(spec.result.decode(spec.result.encode(changes))).toEqual(changes);
      await expect(remote.restore({ botId: 'alpha', id, versionId: first.version.versionId,
        expectedRevision: changes.revision - 1 })).rejects.toThrow();
      await expect(remote.restore({ botId: 'beta', id, versionId: first.version.versionId,
        expectedRevision: changes.revision })).rejects.toThrow();
      await remote.restore({ botId: 'alpha', id, versionId: first.version.versionId, expectedRevision: changes.revision });
      const restored = (await remote.query({ scope: 'private', botId: 'alpha', view: 'all' })).rows.find(row => row.version.memoryId === id);
      expect(restored).toMatchObject({ payload: { content: 'Original statement' }, version: { revision: 3 } });
      expect(restored?.payload.qualifiers).toBeUndefined();
      expect(restored?.version.sourceRefs).toContainEqual({ parentVersionId: first.version.versionId });
      expect(restored?.version.labels.restrictions).toContain('no-egress');
      await expect(remote.restore({ botId: 'alpha', id, versionId: first.version.versionId,
        expectedRevision: changes.revision })).rejects.toThrow();
      await f.reopen();
      expect((await remote.changes({ botId: 'alpha' })).rows[0]).toMatchObject({ version: { revision: 3 }, payload: { content: 'Original statement' } });
    } finally { await f.close(); }
  });

  it('hides erased history and refuses resurrection even while old op metadata remains', async () => {
    const f = await v2Fixture();
    try {
      const m = management(f);
      const id = await m.create({ scope: 'private', botId: 'alpha', kind: 'user_fact', content: 'Forget this',
        valid: { from: null, to: null, basis: 'unknown' }, expectedRevision: f.kernel.seq });
      const versionId = m.changes({ botId: 'alpha' }).rows[0]?.version.versionId;
      if (!versionId) throw new Error('Missing version');
      await m.revise({ id, expectedRevision: f.kernel.seq, patch: { content: 'Forget this too' } });
      await f.kernel.commit({ opId: randomUUID(), kind: 'forget', subjectIds: [id],
        expectedRevision: f.kernel.seq, forgetEpoch: f.kernel.epoch + 1 });
      expect(m.changes({ botId: 'alpha' }).rows).toEqual([]);
      await expect(m.restore({ botId: 'alpha', id, versionId, expectedRevision: f.kernel.seq })).rejects.toThrow();
      await f.reopen();
      expect(management(f).changes({ botId: 'alpha' }).rows).toEqual([]);
      await expect(management(f).restore({ botId: 'alpha', id, versionId, expectedRevision: f.kernel.seq })).rejects.toThrow();
    } finally { await f.close(); }
  });
});
