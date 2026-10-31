import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { rankFacts, readableFacts } from '../../src/host/memory/query.js';
import { retrievalRank as beforeRank } from './retrieval-b7-baseline.js';
import { v2Fixture } from './v2-fixtures.js';
import { annotatedFact, botKey, uid } from './shared-fixtures.js';
import corpus from './retrieval-b7-unseen.json';

const base = resolve('../../.dsh-dev/deepening/b7-unseen');
const paths = ['src/host/memory/retrieval-rank.ts', 'src/host/memory/retrieval-config.ts',
  'src/host/memory/retrieval-text.ts', 'src/host/memory/retrieval-aliases.json',
  'tests/deepening/retrieval-b7-baseline.ts', 'tests/deepening/retrieval-b7-unseen.json', 'tests/deepening/retrieval-unseen.spec.ts'];
const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async path =>
  [path, createHash('sha256').update(await readFile(path)).digest('hex')])));

it('validates the frozen unseen corpus; scoring runs once only on explicit final invocation', async () => {
  expect(corpus.length).toBeGreaterThanOrEqual(10);
  expect(new Set(corpus.map(row => row.id)).size).toBe(corpus.length);
  expect(corpus.every(row => row.decoys.length >= 6 && !row.decoys.includes(row.content))).toBe(true);
  const freeze = JSON.parse(await readFile('tests/deepening/retrieval-b7-unseen-freeze.json', 'utf8'));
  expect(await hashes()).toEqual(freeze.hashes);
  if (process.env.DSH_BOT_B7_UNSEEN_FINAL !== '1') return; // Normal check validates freeze, never rescores this set.
  await mkdir(base, { recursive: true });
  await writeFile(resolve(base, 'final-run.json'), JSON.stringify({ hashes: freeze.hashes, started: Date.now() }), { flag: 'wx' });
  const f = await v2Fixture();
  try {
    const facts = [], gold = new Map<string, string>();
    for (const topic of corpus) for (const [index, content] of [topic.content, ...topic.decoys].entries()) {
      const fact = annotatedFact({ id: `unseen-${topic.id}-${index}`, content, scope: 'shared', trust: 'user_confirmed',
        from: 10, to: null, basis: 'explicit', seq: f.kernel.seq + 1, kind: 'user_fact', subject: 'user', factKey: null, qualifiers: {} });
      fact.version.userScope = f.kernel.scope.scope.id;
      facts.push(fact); if (!index) gold.set(topic.id, fact.version.versionId);
    }
    await f.kernel.commit({ opId: uid('b7-unseen'), kind: 'accept', expectedRevision: f.kernel.seq, forgetEpoch: f.kernel.epoch,
      subjectIds: facts.map(r => r.version.memoryId), versions: facts.map(r => r.version),
      payloads: Object.fromEntries(facts.map(r => [r.version.contentRef, r.payload])) });
    const rows = readableFacts(f.kernel, botKey('beta'), { at: 100 });
    expect(rows).toHaveLength(corpus.length * 7);
    const outcomes = corpus.map(topic => {
      const measure = (ranked: typeof rows) => {
        const rank = ranked.findIndex(row => row.version.versionId === gold.get(topic.id)) + 1;
        return { rank, top5: ranked.slice(0, 5).map(r => r.version.memoryId), recallAt5: rank > 0 && rank <= 5 ? 1 : 0,
          mrr: rank ? 1 / rank : 0 };
      };
      return { id: topic.id, query: topic.query, category: 'distractor', relevant: gold.get(topic.id),
        before: measure(beforeRank(rows, topic.query, 10000)), after: measure(rankFacts(rows, topic.query, 10000)) };
    });
    const avg = (phase: 'before' | 'after', metric: 'recallAt5' | 'mrr') =>
      outcomes.reduce((sum, row) => sum + row[phase][metric], 0) / outcomes.length;
    const summary = { n: corpus.length, beforeRecallAt5: avg('before', 'recallAt5'), afterRecallAt5: avg('after', 'recallAt5'),
      beforeMRR: avg('before', 'mrr'), afterMRR: avg('after', 'mrr') };
    await writeFile(resolve(base, 'final.json'), JSON.stringify({ summary, hashes: freeze.hashes, outcomes,
      unseenAtFreeze: true, synthetic: true, modelRequests: 0 }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(summary));
  } finally { await f.close(); }
}, 30000);
