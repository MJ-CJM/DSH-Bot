import { describe, expect, it } from 'vitest';
import { DshBotMemoryRemote } from '../../lib/host/memory/remote.js';
import type { DshBotRegistry } from '../../src/host/registry.js';
import { dshBotRemoteSpec } from '../../src/shared/remote-contract.js';
import { memoryQuerySchema, memoryCreateSchema, memoryReviseSchema, memoryConfirmSchema,
  memoryResolveSchema, memoryPageSchema } from '../../src/shared/memory-management.js';
import { v2Fixture } from './v2-fixtures.js';
import { management, uid } from './shared-fixtures.js';
describe('I27 management-only Remote with strict shared codecs', () => {
  it('runs decorated management entry points over the real kernel; data survives a JSON-domain reopen', async () => {
    const f = await v2Fixture();
    try {
      f.ctx.provide('dshBots', { manageMemory: (op: (m: ReturnType<typeof management>) => unknown) => op(management(f)),
        invalidate() {} } as unknown as DshBotRegistry);
      await f.ctx.plugin({ inject: ['dshBots'], apply(ctx) { new DshBotMemoryRemote(ctx); } }).await();
      const remote = f.ctx.dshBotMemory;
      const id = await remote.createManaged({ scope: 'shared', botId: 'alpha', kind: 'user_fact', content: 'MANUAL_SHARED',
        valid: { from: null, to: null, basis: 'unknown' }, expectedRevision: f.kernel.seq });
      const result = await remote.query({ scope: 'shared', botId: 'beta', view: 'facts' });
      expect(result.rows.map(r => r.payload.content)).toEqual(['MANUAL_SHARED']);
      const sourceOp = result.rows[0]?.version.sourceRefs[0]?.managementOpId;
      expect(sourceOp && f.kernel.domain.table('ops').get(sourceOp)?.subjectIds).toEqual([id]);
      const spec = dshBotRemoteSpec.methods['dshBot.memory/query'];
      expect(spec.result.encode(result)).toEqual(spec.result.decode(result));
      expect(() => spec.result.decode({ ...result, forged: true })).toThrow();
      await remote.revise({ id, expectedRevision: f.kernel.seq, patch: { content: 'MANUAL_REVISED' } });
      await f.reopen(); expect((await remote.query({ scope: 'shared', botId: 'beta', view: 'facts' })).rows[0]?.payload.content)
        .toBe('MANUAL_REVISED');
      await expect(remote.createManaged({ scope: 'shared', botId: 'beta', kind: 'bot_role', content: 'ROLE',
        valid: { from: null, to: null, basis: 'unknown' }, expectedRevision: f.kernel.seq })).rejects.toThrow();
    } finally { await f.close(); }
  });
  it('rejects every Host-owned field and forged identity, on inputs and wire results', () => {
    const query = { scope: 'shared', botId: 'alpha', view: 'facts' };
    const create = { scope: 'shared', botId: 'alpha', kind: 'user_fact', content: 'EXACT', expectedRevision: 0,
      valid: { from: null, to: null, basis: 'unknown' } };
    const revise = { id: uid('id'), expectedRevision: 0, patch: { content: 'EXACT' } };
    const confirm = { id: uid('id'), expectedRevision: 0, scope: 'shared', botId: 'alpha' };
    const resolve = { ids: [uid('id')], choice: 'reject', expectedRevision: 0 };
    for (const key of ['trust', 'sourceRefs', 'sourceExcerpt', 'provenance', 'ownerBotKey', 'shard', 'commitSeq', 'epoch', 'verified']) {
      for (const [schema, value] of [[memoryQuerySchema, query], [memoryCreateSchema, create],
        [memoryReviseSchema, revise], [memoryConfirmSchema, confirm], [memoryResolveSchema, resolve]] as const)
        expect(schema.safeParse({ ...value, [key]: 'forged' }).success, key).toBe(false);
      expect(memoryReviseSchema.safeParse({ ...revise, patch: { content: 'EXACT', [key]: 'forged' } }).success).toBe(false);
    }
    expect(memoryPageSchema.safeParse({ revision: 0, rows: [], total: 0, privateConflictCount: 1 }).success).toBe(false);
  });
});
