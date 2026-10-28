import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { rankFacts, readableFacts } from '../../src/host/memory/query.js';
import { retrievalRank as beforeRank } from './retrieval-b7-baseline.js';
import { retrievalFixture } from './retrieval-fixture.js';
import { botKey } from './shared-fixtures.js';
import split from './retrieval-split.json';

it('B7 evaluates tune only until a single explicitly reserved final held-out comparison', async () => {
  const final = process.env.DSH_BOT_B7_RETRIEVAL_FINAL === '1', base = resolve('../../.dsh-dev/deepening/b7-retrieval');
  await mkdir(base, { recursive: true });
  const paths = ['src/host/memory/retrieval-rank.ts', 'src/host/memory/retrieval-config.ts',
    'src/host/memory/retrieval-text.ts', 'src/host/memory/retrieval-aliases.json', 'tests/deepening/retrieval-b7-baseline.ts',
    'tests/deepening/retrieval-split.json', 'tests/deepening/retrieval-extra.json'];
  const hashes = Object.fromEntries(await Promise.all(paths.map(async path =>
    [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  const name = final ? 'final' : `tune-${Date.now()}-${process.pid}`;
  if (final) await writeFile(resolve(base, 'final-run.json'), JSON.stringify({ hashes, started: new Date().toISOString() }), { flag: 'wx' });
  const f = await retrievalFixture();
  try {
    const tune = new Set(Object.values(split.categories).flatMap(g => g.tune)), outcomes = [];
    for (const q of f.questions.filter(q => final || tune.has(q.id))) {
      const rows = readableFacts(f.kernel, botKey('beta'), q.time);
      expect(q.relevant.every(id => rows.some(r => r.version.versionId === id))).toBe(true);
      expect(rows.every(r => r.version.scope === 'shared')).toBe(true);
      const measure = (ranked: typeof rows) => {
        if (q.category !== 'temporal') expect(ranked.every(row => !f.forbidden.has(row.version.memoryId))).toBe(true);
        const ranks = q.relevant.map(id => ranked.findIndex(r => r.version.versionId === id) + 1), hits = ranks.filter(r => r > 0);
        return { ranks, top5: ranked.slice(0, 5).map(r => r.version.versionId),
          recallAt5: hits.filter(r => r <= 5).length / q.relevant.length, mrr: hits.length ? 1 / Math.min(...hits) : 0 };
      };
      outcomes.push({ ...q, split: tune.has(q.id) ? 'tune' : 'held-out',
        before: measure(beforeRank(rows, q.query, 10000)), after: measure(rankFacts(rows, q.query, 10000)) });
    }
    const groups = [];
    for (const part of ['tune', ...(final ? ['held-out'] : [])]) for (const category of [...Object.keys(split.categories), 'all']) {
      const rows = outcomes.filter(r => r.split === part && (category === 'all' || r.category === category));
      const avg = (phase: 'before' | 'after', field: 'recallAt5' | 'mrr') => rows.reduce((n, r) => n + r[phase][field], 0) / rows.length;
      groups.push({ split: part, category, n: rows.length, beforeRecallAt5: avg('before', 'recallAt5'), beforeMRR: avg('before', 'mrr'),
        afterRecallAt5: avg('after', 'recallAt5'), afterMRR: avg('after', 'mrr') });
    }
    await writeFile(resolve(base, `${name}.json`), JSON.stringify({ hashes, seed: split.seed, final, outcomes, groups }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ name, groups }));
  } finally { await f.close(); }
}, 30000);
