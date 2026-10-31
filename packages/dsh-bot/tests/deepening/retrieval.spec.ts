import { createHash } from 'node:crypto';
import aliases from '../../src/host/memory/retrieval-aliases.json';
import { normalizeRetrieval } from '../../src/host/memory/retrieval-text.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rankFacts, readableFacts } from '../../src/host/memory/query.js';
import { v2Fixture } from './v2-fixtures.js';
import { botKey, management, shared } from './shared-fixtures.js';
import { memoryContext } from '../../src/host/memory/context.js';
import { retrievalFixture } from './retrieval-fixture.js';
import { baselineRank } from './retrieval-baseline.js';
import split from './retrieval-split.json';
const policy = { maxInjectChars: 4000, privateShare: 0.6, journalShare: 0.25, journalDays: 30 };
describe('B5s retrieval evaluation (held-out only with explicit final flag)', () => {
  it('evaluates the frozen stratified split without tuning on held-out', async () => {
    const final = process.env.DSH_BOT_RETRIEVAL_FINAL === '1';
    const dir = resolve('../../.dsh-dev/deepening/b5s'); await mkdir(dir, { recursive: true });
    const files = ['src/host/memory/retrieval-config.ts', 'src/host/memory/retrieval-rank.ts', 'src/host/memory/retrieval-text.ts',
      'src/host/memory/retrieval-aliases.json', 'tests/deepening/retrieval-split.json', 'tests/deepening/retrieval-extra.json'];
    const hashes = Object.fromEntries(await Promise.all(files.map(async path =>
      [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
    // Reserve the sole held-out run BEFORE reading results. A second invocation cannot evaluate it again.
    if (final) await writeFile(resolve(dir, 'final-run.json'), JSON.stringify({ hashes, startedAt: new Date().toISOString() }), { flag: 'wx' });
    const f = await retrievalFixture();
    try {
      const groups = Object.values(split.categories);
      const tune = new Set(groups.flatMap(g => g.tune)), held = new Set(groups.flatMap(g => g['held-out']));
      expect(tune.size).toBe(42); expect(held.size).toBe(30);
      expect(f.questions).toHaveLength(72);
      expect(f.questions.every(q => tune.has(q.id) !== held.has(q.id))).toBe(true);
      const outcomes = f.questions.filter(q => final || tune.has(q.id)).map(q => {
        const rows = readableFacts(f.kernel, botKey('beta'), q.time);
        expect(q.relevant.every(id => rows.some(r => r.version.versionId === id))).toBe(true);
        expect(rows.every(r => r.version.scope === 'shared')).toBe(true);
        const measure = (ranked: typeof rows) => {
          const ids = ranked.map(r => r.version.versionId), ranks = q.relevant.map(id => ids.indexOf(id) + 1);
          const hits = ranks.filter(r => r > 0);
          if (q.category !== 'temporal') expect(ranked.every(r => !f.forbidden.has(r.version.memoryId))).toBe(true);
          return { top5: ids.slice(0, 5), ranks, recallAt5: hits.filter(r => r <= 5).length / q.relevant.length,
            mrr: hits.length ? 1 / Math.min(...hits) : 0 };
        };
        return { ...q, split: tune.has(q.id) ? 'tune' : 'held-out',
          before: measure(baselineRank(rows, q.query)), after: measure(rankFacts(rows, q.query, 10000)) };
      });
      const review = final ? f.questions.filter(q => held.has(q.id)).map(q => {
        const text = normalizeRetrieval(q.query), words = text.split(' ');
        const ngrams = new Set<string>();
        for (let i = 0; i < words.length - 1; i++) ngrams.add(words.slice(i, i + 2).join(' '));
        for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
          const chars = [...run]; for (let i = 0; i < chars.length - 3; i++) ngrams.add(chars.slice(i, i + 4).join(''));
        }
        const longOverlap = aliases.groups.flat().filter(t => [...ngrams].some(g => t.includes(g)));
        expect(longOverlap).toEqual([]);
        // Report short concept overlaps, including broad one-word queries; these are reviewed, not hidden.
        return { id: q.id, longOverlap, shortOverlap: aliases.groups.flat().filter(t => text.includes(t)) };
      }) : undefined;
      await writeFile(resolve(dir, final ? 'final.json' : 'tune.json'), JSON.stringify({ seed: split.seed, hashes, review, outcomes }, null, 2),
        final ? { flag: 'wx' } : {});
    } finally { await f.close(); }
  });
  it('borrows unused budget without truncating facts and keeps old journal searchable after the 30-day context window', async () => {
    const f = await v2Fixture();
    try {
      const now = Date.now(), day = 86400000, m = management(f);
      await shared(f, `STABLE_SHARED_${'😀'.repeat(300)}`);
      await shared(f, 'OLD_JOURNAL', { kind: 'user_event', valid: { from: now - 31 * day, to: null, basis: 'explicit' } });
      await shared(f, 'RECENT_JOURNAL', { kind: 'user_event', valid: { from: now - day, to: null, basis: 'explicit' } });
      for (let i = 0; i < 14; i++) await f.alpha.save({ content: `PRIVATE_${i}_${'界'.repeat(300)}` });
      const text = memoryContext(f.kernel, botKey(), policy, 20, () => now)();
      expect([...text].length).toBeLessThanOrEqual(4000); expect(text).toContain('RECENT_JOURNAL'); expect(text).not.toContain('OLD_JOURNAL');
      expect(m.query({ botId: 'beta', scope: 'shared', view: 'journal', query: 'OLD_JOURNAL' }).rows).toHaveLength(1);
      expect(text).toContain('STABLE_SHARED_'); expect(text).toContain('More memories');
    } finally { await f.close(); }
  });
});
