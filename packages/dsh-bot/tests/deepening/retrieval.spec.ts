import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rankFacts, readableFacts } from '../../src/host/memory/query.js';
import { v2Fixture } from './v2-fixtures.js';
import { botKey, management, shared, annotatedFact, uid, type AnnotatedFact } from './shared-fixtures.js';
import { memoryContext } from '../../src/host/memory/context.js';
import { topics, categories, clock, timelines, type RetrievalCategory } from './retrieval-corpus.js';
import type { TimeQuery } from '../../src/host/memory/temporal.js';
const policy = { maxInjectChars: 4000, privateShare: 0.6, journalShare: 0.25, journalDays: 30 };
describe('I28 lexical retrieval baseline and fixed Unicode context budget', () => {
  it('reports 60 curated questions, including lexical misses, temporal cutoffs and distractors', async () => {
    const f = await v2Fixture();
    try {
      const m = management(f), questions: {
        id: string; category: RetrievalCategory; query: string; relevant: string[]; time: TimeQuery;
      }[] = [];
      const forbidden = new Set<string>(), seeded: ReturnType<typeof annotatedFact>[] = [];
      // Retrieval fixture, not a commit-throughput benchmark: persist the static corpus as one batch.
      const add = (content: string, patch: Partial<AnnotatedFact> = {}) => {
        const fact = annotatedFact({ id: `retrieval-${seeded.length}`, content, scope: 'shared', trust: 'user_confirmed',
          from: 10, to: null, basis: 'explicit', seq: f.kernel.seq + 1, kind: 'user_fact', subject: 'user',
          factKey: `corpus-${seeded.length}`, qualifiers: {}, ...patch });
        fact.version.userScope = f.kernel.scope.scope.id; seeded.push(fact); return fact.version;
      };
      for (const topic of topics) {
        const version = add(topic.content, { factKey: topic.id });
        for (const category of ['exact', 'synonym', 'colloquial', 'cross', 'distractor'] as const) questions.push({
          id: `${topic.id}-${category}`, category, query: category === 'distractor' ? topic.broad : topic[category],
          relevant: [version.versionId], time: { at: clock.current },
        });
        // Six similar, shorter documents compete with the relevant preference. These are real retrieval negatives.
        for (let i = 0; i < 6; i++) add(`${topic.distractor} ${i}`, { factKey: `${topic.id}-decoy-${i}` });
        forbidden.add(add(`PRIVATE_ONLY ${topic.content}`, { scope: 'private' }).memoryId);
        for (const [label, from, to] of [
          ['expired', clock.past, clock.current], ['future', clock.future, null],
        ] as const) forbidden.add(add(topic.content, { factKey: `${topic.id}-${label}`, from, to }).memoryId);
      }
      await f.kernel.commit({ opId: uid('retrieval-corpus-v2'), kind: 'accept', expectedRevision: f.kernel.seq,
        forgetEpoch: f.kernel.epoch, subjectIds: seeded.map(r => r.version.memoryId), versions: seeded.map(r => r.version),
        payloads: Object.fromEntries(seeded.map(r => [r.version.contentRef, r.payload])) });
      for (const timeline of timelines) {
        const versions: string[] = [], seqs: number[] = [], recorded: number[] = [];
        const id = await shared(f, timeline.contents[0], { factKey: `timeline-${timeline.id}`,
          valid: { from: clock.past, to: null, basis: 'explicit' } });
        const capture = () => {
          const v = f.kernel.snapshot.versions.get(id); if (!v) throw new Error('Missing timeline version');
          versions.push(v.versionId); seqs.push(f.kernel.seq); recorded.push(v.recordedAt);
        };
        capture();
        for (const index of [1, 2] as const) {
          await m.revise({ id, expectedRevision: f.kernel.seq, patch: { content: timeline.contents[index],
            valid: { from: index === 1 ? clock.current : clock.future, to: null, basis: 'explicit' } } }); capture();
        }
        for (const [index, time] of [
          [0, { at: clock.past }], [1, { at: clock.current }], [2, { at: clock.future }],
          [0, { at: clock.current, commitBefore: seqs[0] }], [1, { at: clock.future, recordedBefore: recorded[1] }],
        ] as const) {
          const relevant = versions[index]; if (!relevant) throw new Error('Missing temporal gold');
          questions.push({ id: `${timeline.id}-temporal-${questions.length}`, category: 'temporal', query: timeline.query,
            relevant: [relevant], time });
        }
      }
      const outcomes = questions.map(q => {
        const readable = readableFacts(f.kernel, botKey('beta'), q.time);
        expect(q.relevant.every(id => readable.some(r => r.version.versionId === id))).toBe(true);
        expect(readable.every(r => r.version.scope === 'shared')).toBe(true);
        const allRanked = rankFacts(readable, q.query, Number.MAX_SAFE_INTEGER), ranked = allRanked.slice(0, 5);
        if (q.category !== 'temporal') expect(ranked.every(r => !forbidden.has(r.version.memoryId))).toBe(true);
        const ids = allRanked.map(r => r.version.versionId), ranks = q.relevant.map(id => ids.indexOf(id) + 1);
        const hits = ranks.filter(rank => rank > 0);
        const resultChars = [...ranked.map(r => r.payload.content).join('\n')].length;
        expect(resultChars).toBeLessThanOrEqual(policy.maxInjectChars);
        return { ...q, ranks, returned: ids.slice(0, 5), resultChars,
          recallAt5: hits.filter(rank => rank <= 5).length / q.relevant.length,
          reciprocalRank: hits.length ? 1 / Math.min(...hits) : 0,
          reciprocalRankAt5: hits.some(rank => rank <= 5) ? 1 / Math.min(...hits) : 0 };
      });
      const metrics = (rows: typeof outcomes) => ({ queries: rows.length,
        recallAt5: rows.reduce((n, r) => n + r.recallAt5, 0) / rows.length,
        mrr: rows.reduce((n, r) => n + r.reciprocalRank, 0) / rows.length,
        mrrAt5: rows.reduce((n, r) => n + r.reciprocalRankAt5, 0) / rows.length });
      const dir = resolve('../../.dsh-dev/deepening/b5-rework'); await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'retrieval.json'), JSON.stringify({ mode: 'synthetic lexical baseline', seed: 'B5-rework-v2',
        ...metrics(outcomes), byCategory: Object.fromEntries(categories.map(c => [c, metrics(outcomes.filter(r => r.category === c))])),
        k: 5, budgetChars: policy.maxInjectChars, corpusOps: f.kernel.seq, corpusMemories: f.kernel.snapshot.versions.size,
        permissionFilter: 'beta reads shared only', realModelRequests: 0, answerQuality: 'NOT_RUN', outcomes }, null, 2));
      expect(outcomes).toHaveLength(60);
      expect(new Set(outcomes.map(r => r.id)).size).toBe(60);
      for (const category of categories) expect(outcomes.filter(r => r.category === category)).toHaveLength(10);
      // No quality threshold: misses and low ranks are the baseline, not a reason to change the gold labels.
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
