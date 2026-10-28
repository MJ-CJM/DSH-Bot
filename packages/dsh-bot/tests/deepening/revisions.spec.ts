import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { v2Fixture, command } from './v2-fixtures.js';
import { management, shared, botKey } from './shared-fixtures.js';
import { temporalFacts } from '../../src/host/memory/temporal.js';
import { readableFacts } from '../../src/host/memory/query.js';
import { retireShard } from '../../src/host/memory/shards.js';
import { ForgetPreviews } from '../../src/host/memory/forget-preview.js';
import { memoryContext } from '../../src/host/memory/context.js';
const policy = { maxInjectChars: 4000, privateShare: 0.6, journalShare: 0.25, journalDays: 30 };
describe('I26 durable revisions, manual sharing and shard lifecycle', () => {
  it('keeps recorded-time history, filters future/expired facts and rejects competing CAS after reopen', async () => {
    const f = await v2Fixture();
    try {
      const m = management(f), id = await shared(f, 'Beijing');
      const old = f.kernel.snapshot.versions.get(id); if (!old) throw new Error('Missing old version');
      const revision = f.kernel.seq;
      const results = await Promise.allSettled([
        m.revise({ id, expectedRevision: revision, patch: { content: 'Shanghai', valid: { from: 20, to: null, basis: 'explicit' } } }),
        m.revise({ id, expectedRevision: revision, patch: { content: 'DROPPED_UPDATE' } }),
      ]);
      expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
      expect(temporalFacts(f.kernel, { at: 30, recordedBefore: old.recordedAt }).map(r => r.payload.content)).toEqual(['Beijing']);
      expect(temporalFacts(f.kernel, { at: 30, commitBefore: old.commitSeq }).map(r => r.payload.content)).toEqual(['Beijing']);
      expect(readableFacts(f.kernel, botKey('beta'), { at: 15 }).map(r => r.payload.content)).toEqual(['Beijing']);
      await m.revise({ id, expectedRevision: f.kernel.seq,
        patch: { content: 'FUTURE_CITY', valid: { from: 100, to: null, basis: 'explicit' } } });
      expect(m.query({ botId: 'beta', scope: 'shared', view: 'facts', at: 30 }).rows[0]?.payload.content).toBe('Shanghai');
      expect(m.query({ botId: 'beta', scope: 'shared', view: 'all', at: 30 }).rows[0]?.payload.content).toBe('FUTURE_CITY');
      const before = f.kernel.snapshot; await f.reopen(); expect(isDeepStrictEqual(f.kernel.snapshot, before)).toBe(true);
      expect(readableFacts(f.kernel, botKey('beta'), { at: 30 }).map(r => r.payload.content)).toEqual(['Shanghai']);
    } finally { await f.close(); }
  });
  it('publishes only explicitly confirmed exact content; new Bots read shared but never another Bot private', async () => {
    const f = await v2Fixture();
    try {
      const m = management(f), { id } = await f.alpha.save({ content: 'EXACT_PRIVATE_FACT', tags: ['PRIVATE_TAG_CANARY'], pinned: true });
      expect(memoryContext(f.kernel, botKey('beta'), policy, 20)()).not.toContain('EXACT_PRIVATE_FACT');
      await f.bots.update('alpha', { avatar: '🐳', avatarColor: 'teal', avatarVariant: 'hat' });
      const published = await m.confirm({ id, expectedRevision: f.kernel.seq, botId: 'alpha', scope: 'shared' });
      expect(published).not.toBe(id);
      await m.confirm({ id: published, botId: 'beta', scope: 'shared', expectedRevision: f.kernel.seq });
      expect(f.kernel.snapshot.versions.get(published)?.provenance.bot).toEqual(botKey());
      expect(f.kernel.snapshot.versions.get(published)?.sourceRefs.some(r => r.parentVersionId)).toBe(true);
      expect(memoryContext(f.kernel, botKey('new-bot'), policy, 20)()).toContain('EXACT_PRIVATE_FACT');
      const otherRead = await f.beta.search({ query: 'EXACT_PRIVATE_FACT' });
      expect(otherRead).toMatchObject([{ id: published, scope: 'shared', tags: [], pinned: false }]);
      expect(JSON.stringify(otherRead)).not.toContain('PRIVATE_TAG_CANARY');
      await expect(f.beta.forget({ id: published })).rejects.toThrow();
      const previews = new ForgetPreviews(f.kernel, async () => ({ sessionIds: [], historyNodes: 0, summaries: 0,
        copies: 0, pendingMessages: 0, conservative: false, rootInstructions: false, stamp: null }));
      expect((await previews.create({ memoryId: id, mode: 'related' })).targets.sort()).toEqual([id, published].sort());
      await retireShard(f.kernel, botKey());
      await f.bots.remove('alpha', { deleteMemories: false }); await f.bots.create({ id: 'alpha', name: 'New Alpha' }, 300);
      const rows = management(f).query({ botId: 'beta', scope: 'shared', view: 'all' });
      expect(rows.rows[0]?.deletedBot).toBe(true);
      expect(rows.rows[0]?.payload.botSnapshot).toMatchObject({ name: 'Alpha', avatar: '🐳', avatarColor: 'teal', avatarVariant: 'hat' });
      expect(JSON.stringify([...f.kernel.domain.table('ops').entries()])).not.toContain('🐳');
      expect(memoryContext(f.kernel, { botId: 'alpha', botCreatedAt: 300 }, policy, 20)()).toContain('EXACT_PRIVATE_FACT');
      expect((await previews.contribution(published)).targets).toEqual([published]);
      expect(readableFacts(f.kernel, botKey(), { at: Date.now() }).every(r => r.version.scope === 'shared')).toBe(true);
      const ref = f.kernel.snapshot.versions.get(published)?.contentRef;
      await f.kernel.commit({ opId: randomUUID(), kind: 'forget', subjectIds: [published],
        expectedRevision: f.kernel.seq, forgetEpoch: f.kernel.epoch + 1 });
      if (!ref) throw new Error('Missing published payload');
      expect(f.kernel.domain.table('payloads').get(ref)).toBeUndefined();
      expect(memoryContext(f.kernel, { botId: 'alpha', botCreatedAt: 300 }, policy, 20)()).toBe('');
    } finally { await f.close(); }
  });
  it('atomically resolves ambiguous values, qualified coexistence and reject-all; wrong-domain resolution fails', async () => {
    const f = await v2Fixture();
    try {
      const m = management(f), ids = [await shared(f, 'City A', { valid: { from: null, to: null, basis: 'unknown' } }),
        await shared(f, 'City B', { valid: { from: null, to: null, basis: 'unknown' } })];
      expect(m.query({ botId: 'beta', scope: 'shared', view: 'conflicts' }).rows).toHaveLength(2);
      await m.resolve({ ids, expectedRevision: f.kernel.seq, choice: 'coexist',
        qualifiers: ids.map((id, i) => ({ id, values: { day: i ? 'weekend' : 'weekday' } })) });
      expect(m.query({ botId: 'beta', scope: 'shared', view: 'facts' }).rows).toHaveLength(2);
      await expect(m.resolve({ ids, expectedRevision: f.kernel.seq, choice: 'reject' })).rejects.toThrow('one fact');
      const other = await shared(f, 'City C');
      await m.resolve({ ids: [other], expectedRevision: f.kernel.seq, choice: 'reject' });
      expect(f.kernel.snapshot.versions.get(other)?.status).toBe('rejected');
    } finally { await f.close(); }
  });
  it('assigns quarantined legacy content explicitly without granting sharing or inheriting a dead Bot birth', async () => {
    const f = await v2Fixture();
    try {
      const c = command(f, 'QUARANTINED_ITEM'), v = c.versions[0]; if (!v) throw new Error('Missing fixture');
      v.status = 'proposed'; await f.kernel.commit(c);
      await f.kernel.domain.table('migration_items').put('orphan', { legacyId: 'orphan', memoryId: v.memoryId,
        versionId: v.versionId, opId: c.opId, contentRef: v.contentRef, quarantine: true });
      const m = management(f);
      expect(m.query({ botId: 'beta', scope: 'quarantine', view: 'all' }).rows).toHaveLength(1);
      await expect(m.confirm({ id: v.memoryId, botId: 'beta', scope: 'shared', expectedRevision: f.kernel.seq }))
        .rejects.toThrow('privately first');
      await m.confirm({ id: v.memoryId, botId: 'beta', scope: 'private', expectedRevision: f.kernel.seq });
      expect(m.query({ botId: 'beta', scope: 'quarantine', view: 'all' }).rows).toHaveLength(0);
      expect(memoryContext(f.kernel, botKey('beta'), policy, 20)()).toContain('QUARANTINED_ITEM');
      expect(memoryContext(f.kernel, botKey(), policy, 20)()).not.toContain('QUARANTINED_ITEM');
      expect(f.kernel.snapshot.versions.get(v.memoryId)?.scope).toBe('private');
      const epoch = f.kernel.epoch;
      await f.kernel.commit({ opId: randomUUID(), kind: 'forget', subjectIds: [v.memoryId],
        expectedRevision: f.kernel.seq, forgetEpoch: epoch + 1 });
      expect(temporalFacts(f.kernel, { at: 30, commitBefore: 1 })).toEqual([]);
    } finally { await f.close(); }
  });
});
