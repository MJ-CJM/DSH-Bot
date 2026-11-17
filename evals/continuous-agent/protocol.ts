import { createHash } from 'node:crypto';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type Arm = 'A' | 'B' | 'C';
export type Split = 'development' | 'validation' | 'final';
export interface CaseManifest { id: string; family: string; split: Split; hash: string }
export interface Source { id: string; at: number; text: string; readers: string[]; revoked?: boolean }
export interface WorkerCase { id: string; cutoff: number; owner: string; question: string; sources: Source[] }
export interface Receipt {
  caseId: string; arm: Arm; repeat: number; operationId: string; modelHash: string;
  status: 'complete' | 'failed' | 'timeout' | 'unknown' | 'budget-denied' | 'not-started';
  sessionId: string; storeId: string; baseContextHash: string; corpusHash: string;
  memoryHash: string; requestHash: string; sourceIds: string[];
  answer?: string; billing?: number; preparationBilling?: number; humanSeconds?: number;
  pass?: boolean; unsafe?: boolean; preparation?: 'accepted' | 'rejected' | 'failed' | 'unknown';
}
export const arms: Arm[] = ['A', 'B', 'C'];
export function slots(manifest: CaseManifest[]) {
  if (manifest.length !== 24 || new Set(manifest.map(x => x.id)).size !== 24 || new Set(manifest.map(x => x.family)).size !== 24)
    throw new Error('Require 24 disjoint cases and families');
  for (const split of ['development', 'validation', 'final']) if (manifest.filter(x => x.split === split).length !== 8)
    throw new Error('Require 8 cases per split');
  return manifest.flatMap(c => arms.flatMap(arm => Array.from({ length: c.split === 'final' ? 3 : 1 }, (_, repeat) => ({ caseId: c.id, arm, repeat }))));
}
const key = (r: Pick<Receipt, 'caseId' | 'arm' | 'repeat'>) => `${r.caseId}:${r.arm}:${r.repeat}`;
/** Worker receives a fresh allowlisted value, never the evaluator's object/Gold. */
export function workerInput(input: WorkerCase): WorkerCase {
  const sources = input.sources.filter(s => s.at <= input.cutoff && !s.revoked && s.readers.includes(input.owner))
    .map(({ id, at, text, readers }) => ({ id, at, text, readers: [...readers] }));
  return { id: input.id, cutoff: input.cutoff, owner: input.owner, question: input.question, sources };
}
export function assertEvidence(input: WorkerCase, receipt: Receipt, forbidden: string[] = []) {
  const visible = workerInput(input), ids = new Set(visible.sources.map(s => s.id));
  if (receipt.caseId !== input.id || receipt.corpusHash !== digest(visible.sources) || receipt.sourceIds.some(id => !ids.has(id)))
    throw new Error('Source/cutoff/permission mismatch');
  if (forbidden.some(value => value && JSON.stringify(visible).includes(value))) throw new Error('Gold or future information leaked');
  if (receipt.arm === 'A' && receipt.memoryHash !== digest([])) throw new Error('A inherited memory');
  if ([receipt.modelHash, receipt.baseContextHash, receipt.memoryHash, receipt.requestHash].some(h => !/^[a-f0-9]{64}$/.test(h)))
    throw new Error('Missing request evidence');
}
/** Failed and absent slots remain in the fixed denominator. Repeated op IDs never add samples. */
export function report(manifest: CaseManifest[], receipts: Receipt[]) {
  const expected = slots(manifest), allowed = new Set(expected.map(key));
  const rows = new Map<string, Receipt>(), operations = new Set<string>(), sessions = new Set<string>(), stores = new Map<string, string>();
  for (const r of receipts) {
    if (!allowed.has(key(r)) || rows.has(key(r)) || operations.has(r.operationId) || sessions.has(r.sessionId))
      throw new Error('Duplicate or unregistered trial');
    const trial = `${r.caseId}:${r.arm}`, previous = stores.get(r.storeId);
    if (previous && previous !== trial) throw new Error('Cross-arm store contamination');
    stores.set(r.storeId, trial); rows.set(key(r), r); operations.add(r.operationId); sessions.add(r.sessionId);
  }
  const models = new Set(receipts.map(r => r.modelHash));
  if (models.size > 1) throw new Error('Models must be reported separately');
  for (const c of manifest) {
    const sample = receipts.filter(r => r.caseId === c.id);
    if (new Set(sample.map(r => r.baseContextHash)).size > 1 || new Set(sample.map(r => r.corpusHash)).size > 1)
      throw new Error('Unpaired base context or corpus');
  }
  const complete = (r?: Receipt) => r?.status === 'complete' && typeof r.pass === 'boolean' && !r.unsafe &&
    (r.arm !== 'C' || r.preparation === 'accepted' || r.preparation === 'rejected');
  const passed = (r?: Receipt) => complete(r) && r?.pass === true;
  const allComplete = expected.every(s => complete(rows.get(key(s))));
  const summary = Object.fromEntries(arms.map(arm => [arm, { denominator: expected.filter(s => s.arm === arm).length,
    passed: expected.filter(s => s.arm === arm && passed(rows.get(key(s)))).length,
    missing: expected.filter(s => s.arm === arm && !rows.has(key(s))).length }]));
  const final = manifest.filter(c => c.split === 'final');
  const successes = (id: string, arm: Arm) => [0, 1, 2].filter(repeat => passed(rows.get(key({ caseId: id, arm, repeat })))).length;
  const totals = Object.fromEntries(arms.map(arm => [arm, final.reduce((n, c) => n + successes(c.id, arm), 0)])) as Record<Arm, number>;
  const noRegression = final.every(c => successes(c.id, 'C') >= successes(c.id, 'B'));
  const noCatastrophe = (arm: Arm) => final.every(c => successes(c.id, arm) !== 3 || successes(c.id, 'C') !== 0);
  // N=1 production economics: charge preparation fully to each single-answer opportunity.
  const knownCost = receipts.length === expected.length && receipts.every(r => [r.billing, r.humanSeconds,
    ...(r.arm === 'C' ? [r.preparationBilling] : [])].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0));
  const meanCost = (arm: Arm) => final.reduce((sum, c) => sum + [0, 1, 2].reduce((n, repeat) => {
    const r = rows.get(key({ caseId: c.id, arm, repeat })); return n + (r?.billing ?? 0) + (arm === 'C' ? r?.preparationBilling ?? 0 : 0);
  }, 0) / 3, 0);
  const human = (arm: Arm) => receipts.filter(r => r.arm === arm).reduce((n, r) => n + (r.humanSeconds ?? 0), 0);
  const savings = knownCost && meanCost('B') > 0 ? 1 - meanCost('C') / meanCost('B') : null;
  const gate = allComplete && knownCost && totals.C >= 18 && totals.C >= totals.A && noCatastrophe('A') &&
    (totals.C >= totals.B + 3 && noCatastrophe('B') || noRegression && savings !== null && savings >= .15 && human('C') <= human('B'));
  return { mechanismOnly: true, qualityClaim: 'NOT_RUN until authorized real-model receipts and blind review',
    denominator: expected.length, allComplete, summary, final: totals, knownCost, n1Savings: savings, gate };
}
export function notificationReport(rows: { expected: boolean; delivered: boolean; duplicate: boolean; revoked: boolean; unknown: boolean }[]) {
  const tp = rows.filter(r => r.expected && r.delivered).length, fp = rows.filter(r => !r.expected && r.delivered).length;
  return { denominator: 24, tp, fp, pass: rows.length === 24 && rows.filter(r => r.expected).length === 12 && tp >= 10 && fp <= 1 &&
    rows.every(r => !r.duplicate && !r.revoked && !r.unknown) };
}
