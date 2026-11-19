import { scoreAnswer } from '../../../../evals/continuous-agent/scorer.js';
import { describe, it, expect } from 'vitest';
import { workerInput, assertEvidence, report, slots, digest, notificationReport, type CaseManifest, type Receipt } from '../../../../evals/continuous-agent/protocol.js';
import { retrievalRank } from '../../src/host/memory/retrieval-rank.js';
import { v2Fixture } from '../deepening/v2-fixtures.js';
import { management } from '../deepening/shared-fixtures.js';

const manifest: CaseManifest[] = Array.from({ length: 24 }, (_, i) => ({ id: `mechanism-${i}`, family: `family-${i}`,
  split: i < 8 ? 'development' : i < 16 ? 'validation' : 'final', hash: digest(i) }));
const receipts = (): Receipt[] => slots(manifest).map((s, i) => ({ ...s, operationId: `op-${i}`, modelHash: digest('fixture'),
  sessionId: `session-${i}`, storeId: `store-${s.caseId}-${s.arm}`, status: 'complete', baseContextHash: digest('base'),
  corpusHash: digest('corpus'), memoryHash: digest([]), requestHash: digest(i), sourceIds: [], pass: true, billing: s.arm === 'C' ? .6 : 1,
  preparationBilling: s.arm === 'C' ? .1 : 0, humanSeconds: 0, preparation: 'accepted' }));

describe('continuous memory evaluation protocol (mechanisms, not model quality)', () => {
  it('keeps 120 slots and unknown/missing trials in the denominator', () => {
    expect(slots(manifest)).toHaveLength(120);
    const r = receipts(); r[0]!.status = 'unknown'; r.pop();
    expect(report(manifest, r)).toMatchObject({ denominator: 120, gate: false, allComplete: false });
    expect(report(manifest, [])).toMatchObject({ denominator: 120, gate: false });
  });
  it('charges full preparation at N=1, preserves unknown costs, rejects catastrophic regressions', () => {
    expect(report(manifest, receipts())).toMatchObject({ gate: true, final: { A: 24, B: 24, C: 24 } });
    const r = receipts(); for (const x of r) if (x.arm === 'C') x.preparationBilling = 2;
    expect(report(manifest, r).gate).toBe(false);
    r[0]!.billing = undefined; expect(report(manifest, r).knownCost).toBe(false);
    for (const x of r) if (x.arm === 'C' && x.caseId === 'mechanism-16') x.pass = false;
    expect(report(manifest, r).gate).toBe(false);
  });
  it('detects duplicate samples, mixed models, cross-arm sessions/stores and unfair search', () => {
    for (const mutate of [(r: Receipt[]) => r.push(r[0]!), (r: Receipt[]) => { r[1]!.sessionId = r[0]!.sessionId; },
      (r: Receipt[]) => { r[1]!.storeId = r[0]!.storeId; }, (r: Receipt[]) => { r[1]!.modelHash = digest('other'); },
      (r: Receipt[]) => { r[1]!.corpusHash = digest('other'); }, (r: Receipt[]) => { r[1]!.baseContextHash = digest('other'); }]) {
      const r = receipts(); mutate(r); expect(() => report(manifest, r)).toThrow();
    }
  });
  it('removes Gold, future and foreign/revoked sources and rejects forged citations twice', () => {
    const input = { id: 'mechanism-0', cutoff: 2, owner: 'alpha', question: 'location', gold: 'CANARY', sources: [
      { id: 'ok', at: 1, text: 'location North', readers: ['alpha'] },
      { id: 'future', at: 3, text: 'CANARY', readers: ['alpha'] },
      { id: 'foreign', at: 1, text: 'SECRET', readers: ['beta'] },
      { id: 'revoked', at: 1, text: 'ERASED', readers: ['alpha'], revoked: true }] };
    const visible = workerInput(input); expect(JSON.stringify(visible)).not.toMatch(/CANARY|SECRET|ERASED|gold/);
    for (const source of ['future', 'foreign', 'revoked', 'gold']) expect(() => assertEvidence(input,
      { ...receipts()[0]!, sourceIds: [source], corpusHash: digest(visible.sources) })).toThrow();
    for (const canary of ['North', 'location']) expect(() => assertEvidence(input,
      { ...receipts()[0]!, sourceIds: ['ok'], corpusHash: digest(visible.sources) }, [canary])).toThrow();
  });
  it('uses actual kernel writes and production retrieval for 24 independent three-arm mechanism cases', async () => {
    const f = await v2Fixture();
    try {
      for (let i = 0; i < 24; i++) {
        const text = `fixture${i} project port ${8000 + i}`, raw = [{ payload: { content: text }, version: { memoryId: `event-${i}`, commitSeq: i } }];
        expect(retrievalRank(raw, `fixture${i}`, 1)[0]?.payload.content).toBe(text);
        await management(f).create({ botId: 'alpha', scope: 'private', kind: 'user_fact', content: text,
          valid: { from: 0, to: null, basis: 'explicit' }, expectedRevision: f.kernel.seq });
        for (const arm of ['B', 'C-fixture-before-P2']) {
          const rows = management(f).query({ botId: 'alpha', scope: 'private', view: 'facts', query: `fixture${i}`, limit: 1 });
          expect(rows.rows[0]?.payload.content, arm).toBe(text);
          expect(management(f).query({ botId: 'beta', scope: 'private', view: 'facts', query: `fixture${i}` }).rows).toEqual([]);
        }
      }
      await f.reopen(); expect(management(f).query({ botId: 'alpha', scope: 'private', view: 'facts' }).total).toBe(24);
    } finally { await f.close(); }
  });
  it('scores 12 positive and 12 negative notification opportunities without losing unknowns', () => {
    const rows = Array.from({ length: 24 }, (_, i) => ({ expected: i < 12, delivered: i < 12, duplicate: false, revoked: false, unknown: false }));
    expect(notificationReport(rows).pass).toBe(true); rows[23]!.unknown = true; expect(notificationReport(rows).pass).toBe(false);
  });
});

it('verifies the frozen quality manifest and final hashes without scoring or printing held-out content', async () => {
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const base = new URL('../../../../evals/continuous-agent/data/', import.meta.url);
  const index = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8')) as { cases: (CaseManifest & { goldHash: string })[] };
  expect(slots(index.cases)).toHaveLength(120);
  for (const row of index.cases) for (const gold of [false, true]) {
    const bytes = await readFile(new URL(`${row.split}/${row.id}${gold ? '.gold' : ''}.json`, base));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(gold ? row.goldHash : row.hash);
  }
});

it('blind scorer rejects missing facts, canaries, wrong action and unauthorized effects', () => {
  const gold = { required: ['North'], forbidden: ['South'], action: 'answer' as const, canary: 'SECRET' };
  const answer = { text: 'North', action: 'answer', status: 'ok', sideEffects: 0 };
  expect(scoreAnswer(gold, answer).pass).toBe(true);
  for (const patch of [{ text: 'South' }, { text: 'North SECRET' }, { action: 'notify' }, { sideEffects: 1 }, { status: 'unknown' }])
    expect(scoreAnswer(gold, { ...answer, ...patch }).pass).toBe(false);
});
