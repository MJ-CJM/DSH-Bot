import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dataLabelSchema, type DataLabel } from '../../src/shared/data-flow.js';
import { mergeLabels, unknownLabel } from '../../src/host/data-flow/labels.js';
import { MemoryLineage } from '../../src/host/data-flow/lineage.js';
import { v2Fixture, command } from './v2-fixtures.js';
const alpha = { botId: 'alpha', botCreatedAt: 1 }, beta = { botId: 'beta', botCreatedAt: 2 };
const label = (readers: DataLabel['readers'], trust: DataLabel['originTrust'] = 'user_confirmed'): DataLabel => ({
  readers, originTrust: trust, sourceVersions: [randomUUID()], restrictions: ['no-egress'], grants: [randomUUID()],
});
describe('I35 monotone labels and durable memory dependencies', () => {
  it('takes reader intersections and lower trust across 100 hops, never laundering restrictions or grants', () => {
    const privateLabel = label([alpha]), shared = label('shared'), untrusted = label('shared', 'candidate');
    privateLabel.restrictions.push('secret');
    let result = privateLabel;
    for (let i = 0; i < 100; i++) result = mergeLabels(result, shared, untrusted);
    expect(result.readers).toEqual([alpha]); expect(result.originTrust).toBe('candidate');
    expect(result.restrictions).toEqual(expect.arrayContaining(['no-egress', 'secret'])); expect(result.grants).toEqual([]);
    expect(mergeLabels(result, label([beta])).readers).toEqual([]);
    expect(mergeLabels(result, label([{ ...alpha, botCreatedAt: 3 }])).readers).toEqual([]);
    expect(mergeLabels(result, unknownLabel()).readers).toEqual([]);
    expect(dataLabelSchema.safeParse({ ...result, trusted: true }).success).toBe(false);
  });
  it('retains reads across requests/reload, and marks forgotten sources revoked without narrowing taint', async () => {
    const f = await v2Fixture();
    try {
      const a = command(f), b = command(f, 'SECOND'); await f.kernel.commit(a);
      b.expectedRevision = f.kernel.seq;
      if (b.versions[0]) b.versions[0].commitSeq = f.kernel.seq + 1;
      await f.kernel.commit(b);
      const av = a.versions[0], bv = b.versions[0]; if (!av || !bv) throw new Error('Missing fixture version');
      let lineage = new MemoryLineage(f.kernel);
      await lineage.record('session', [av.versionId]); await lineage.record('session', [bv.versionId]);
      await f.reopen(); lineage = new MemoryLineage(f.kernel);
      expect(lineage.seen('session')).toEqual([av.versionId, bv.versionId]);
      expect(lineage.label(lineage.seen('session')).readers).toEqual([alpha]);
      await f.kernel.commit({ opId: randomUUID(), kind: 'forget', subjectIds: [av.memoryId],
        expectedRevision: f.kernel.seq, forgetEpoch: f.kernel.epoch + 1 });
      expect(lineage.label(lineage.seen('session')).restrictions).toContain('revoked');
      expect(lineage.seen('session')).toHaveLength(2);
      expect(lineage.label([randomUUID()]).readers).toEqual([]);
    } finally { await f.close(); }
  });
  it('keeps observed source restrictions on model saves and subsequent private revisions', async () => {
    const f = await v2Fixture();
    try {
      const secret = command(f), version = secret.versions[0]; if (!version) throw new Error('Missing fixture source');
      version.labels.restrictions.push('secret'); await f.kernel.commit(secret);
      await new MemoryLineage(f.kernel).record('model-session', [version.versionId]);
      const { id } = await f.alpha.save({ content: 'MODEL_DERIVED' }, { by: 'model', at: 100, sessionId: 'model-session' });
      let row = f.kernel.snapshot.versions.get(id);
      expect(row?.labels.restrictions).toContain('secret'); expect(row?.labels.sourceVersions).toContain(version.versionId);
      await f.alpha.update(id, { content: 'APPARENTLY_HARMLESS_REWRITE' }); row = f.kernel.snapshot.versions.get(id);
      expect(row?.labels.restrictions).toContain('secret'); expect(row?.labels.sourceVersions).toContain(version.versionId);
      await f.reopen(); expect(f.kernel.snapshot.versions.get(id)?.labels.restrictions).toContain('secret');
    } finally { await f.close(); }
  });

});
