import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ForgetPreviews, type ForgetInventory } from '../../src/host/memory/forget-preview.js';
import { ForgetRunner } from '../../src/host/memory/forget-runner.js';
import { forgetChoiceSchema } from '../../src/shared/memory-forget.js';
import { command, v2Fixture } from './v2-fixtures.js';

export const inventory = (): ForgetInventory => ({ sessionIds: ['alpha-session', 'beta-session', 'gamma-session'],
  historyNodes: 10, summaries: 1, copies: 3, pendingMessages: 1, conservative: true, rootInstructions: false, stamp: 1 });
describe('I15 preview closure and atomic CAS', () => {
  it('finds exact duplicates and transitive derived versions but keeps private Bot boundaries', async () => {
    const f = await v2Fixture();
    try {
      const first = await f.alpha.save({ content: 'SYNTHETIC_FACT' });
      const duplicate = await f.store.add({ botId: 'alpha', content: 'SYNTHETIC_FACT', kind: 'note', tags: [], pinned: false });
      const other = await f.beta.save({ content: 'SYNTHETIC_FACT' });
      const seed = f.kernel.snapshot.versions.get(first.id);
      if (!seed) throw new Error('Missing seed');
      const op = command(f, 'DERIVED');
      const derived = op.versions[0];
      if (!derived) throw new Error('Missing derived version');
      derived.labels.sourceVersions = [seed.versionId];
      await f.kernel.commit(op);
      const previews = new ForgetPreviews(f.kernel, async () => inventory());
      const one = await previews.create({ memoryId: first.id, mode: 'version' });
      expect(one.targets).toEqual([first.id]);
      const all = await previews.create({ memoryId: first.id, mode: 'related' });
      expect(all.targets).toEqual([first.id, duplicate.id, op.subjectIds[0]].sort());
      expect(all.targets).not.toContain(other.id);
      expect(JSON.stringify(all)).not.toContain('SYNTHETIC_FACT');
    } finally { await f.close(); }
  });
  it.each(['log', 'inbox', 'copy', 'history', 'root'] as const)('invalidates a preview on %s changes without committing', async change => {
    const f = await v2Fixture();
    try {
      const saved = await f.alpha.save({ content: 'KEEP_ME' }), data = inventory();
      const previews = new ForgetPreviews(f.kernel, async () => data);
      const preview = await previews.create({ memoryId: saved.id, mode: 'related' });
      if (change === 'log') await f.beta.save({ content: 'NEW_DEPENDENCY' });
      else data.stamp = { changed: change };
      const runner = new ForgetRunner(f.kernel, previews, { drain: async () => {}, history: async () => [],
        copies: async () => {}, verifyInventory: async () => [] });
      await expect(runner.choose({ previewRevision: preview.previewRevision, choice: 'clean' })).rejects.toThrow(/preview|revision/i);
      expect(f.kernel.epoch).toBe(0);
      expect(f.kernel.snapshot.versions.has(saved.id)).toBe(true);
      expect(f.kernel.domain.table('forget_jobs').size).toBe(0);
    } finally { await f.close(); }
  });
  it('does not accept caller-supplied targets or verification flags', () => {
    expect(() => forgetChoiceSchema.parse({ previewRevision: randomUUID(), choice: 'clean', targets: [randomUUID()] })).toThrow();
    expect(() => forgetChoiceSchema.parse({ previewRevision: randomUUID(), choice: 'clean', verified: true })).toThrow();
  });
});
