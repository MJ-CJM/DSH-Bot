import extra from './retrieval-extra.json';
import { v2Fixture } from './v2-fixtures.js';
import { management, shared, annotatedFact, uid, type AnnotatedFact } from './shared-fixtures.js';
import { topics, clock, timelines, type RetrievalCategory } from './retrieval-corpus.js';
import type { TimeQuery } from '../../src/host/memory/temporal.js';
export interface RetrievalQuestion {
  id: string; category: RetrievalCategory; query: string; relevant: string[]; time: TimeQuery;
}
export async function retrievalFixture() {
  const f = await v2Fixture();
  try {
      const m = management(f), questions: RetrievalQuestion[] = [];
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

      for (const [id, category, query, topic] of extra) {
        const original = questions.find(q => category === 'temporal'
          ? q.id === `${topic}-temporal-${topic === 'city' ? 51 : 55}` : q.id === `${topic}-exact`);
        if (!original || !id || !query) throw new Error('Invalid supplemental gold');
        questions.push({ ...original, id, query, category: category as RetrievalCategory });
      }
      return { ...f, questions, forbidden };
  } catch (error) { await f.close(); throw error; }
}
