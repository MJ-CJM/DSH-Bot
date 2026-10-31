import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { adjudicate, temporalSlices } from '../../src/host/memory/conflicts.js';
import { annotatedFact, botKey, uid, type AnnotatedFact } from './shared-fixtures.js';
const manifest = JSON.parse(await readFile(resolve('../../evals/manifests/memory-conflicts.json'), 'utf8')) as { files: string[] };
const cases = (await Promise.all(manifest.files.map(path => readFile(resolve('../..', path), 'utf8').then(JSON.parse)))).flat() as {
  id: string; annotation: string; at: number; bot: string; rows: AnnotatedFact[];
  expectedActive: string[]; expectedStates: Record<string, string>;
}[];
describe('I25 frozen annotated conflict/valid-time corpus', () => {
  it('adjudicates every labeled scenario and records the fixed denominator', async () => {
    let corrections = 0, correctCorrections = 0, candidateOverrides = 0, disputedInjected = 0;
    for (const c of cases) {
      const judged = adjudicate(c.rows.map(annotatedFact), c.at, botKey(c.bot));
      const active = judged.filter(r => r.state === 'active').map(r => r.version.memoryId).sort();
      expect(active, c.id).toEqual(c.expectedActive.map(uid).sort());
      for (const [id, state] of Object.entries(c.expectedStates))
        expect(judged.find(r => r.version.memoryId === uid(id))?.state, c.id).toBe(state);
      if (['explicit-correction', 'old-private-suppressed', 'commit-breaks-tie'].includes(c.annotation)) {
        corrections++; if (active.includes(uid('new')) && !active.includes(uid('old'))) correctCorrections++;
      }
      if (c.annotation === 'candidate-never-overwrites' && active.includes(uid('new'))) candidateOverrides++;
      disputedInjected += judged.filter(r => r.state === 'active' && r.version.status === 'disputed').length;
    }
    const dir = resolve('../../.dsh-dev/deepening/b5'); await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'conflicts.json'), JSON.stringify({ level: 'UNIT rc.2', cases: cases.length,
      categories: new Set(cases.map(c => c.annotation)).size, corrections, correctCorrections,
      correctionRate: correctCorrections / corrections, candidateOverrides, disputedInjected,
      sourceComplete: cases.every(c => c.rows.map(annotatedFact).every(r => r.version.sourceRefs.length > 0)) }, null, 2));
    expect(cases.length).toBeGreaterThanOrEqual(100); expect(correctCorrections / corrections).toBeGreaterThanOrEqual(0.95);
    expect(candidateOverrides).toBe(0); expect(disputedInjected).toBe(0);
  });
  it('honors private role/work/explicit local exceptions without letting a candidate override a user fact', () => {
    const source = cases[0]?.rows[0]; if (!source) throw new Error('Missing corpus source');
    const global = annotatedFact({ ...source, id: 'global', content: 'Global preference', trust: 'user_confirmed' });
    for (const kind of ['bot_role', 'how_to_work', 'user_fact']) {
      const own = annotatedFact({ ...source, id: 'local', content: 'Explicit local exception', kind,
        scope: 'private', owner: 'alpha', trust: 'user_confirmed', from: null, basis: 'unknown', localException: kind === 'user_fact' });
      expect(adjudicate([global, own], 2000, botKey()).filter(r => r.state === 'active').map(r => r.version.memoryId))
        .toEqual([uid('local')]);
      expect(adjudicate([global, own], 2000, botKey('beta')).filter(r => r.state === 'active').map(r => r.version.memoryId))
        .toEqual([uid('global')]);
      own.version.trust = 'candidate';
      expect(adjudicate([global, own], 2000, botKey()).filter(r => r.state === 'active').map(r => r.version.memoryId))
        .toEqual([uid('global')]);
    }
  });
  it('partitions overlaps and honors left-closed/right-open boundaries', () => {
    const c = cases.find(c => c.annotation === 'half-open-expiry'); if (!c) throw new Error('Missing case');
    const slices = temporalSlices(c.rows.map(annotatedFact), botKey());
    expect(slices.find(s => s.from === c.at)?.rows.find(r => r.version.memoryId === uid('old'))?.state).toBe('expired');
  });
});
