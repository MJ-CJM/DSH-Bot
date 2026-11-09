import type { MethodEvaluation, MethodRunReceipt } from '../../shared/proactive/method-evaluation.js';
import { digest } from './wire.js';

/** Independent deterministic judge; expectations never enter the worker prompt.
 * This tests structured text tasks only, not open-ended real-world quality. */
export function judgeMethodAnswer(answer: string, expected: Record<string, string | number | boolean | null>) {
  try { return digest(JSON.parse(answer)) === digest(expected); } catch { return false; }
}
export function compareMethods(evaluation: MethodEvaluation, receipts: MethodRunReceipt[]) {
  let unseenWins = 0, finalWins = 0, negatives = 0;
  if (new Set(receipts.map(row => row.assignmentId)).size !== receipts.length || receipts.length !== evaluation.plan.cases.length * 4) return 'inconclusive' as const;
  for (const sample of evaluation.plan.cases) {
    const runs = receipts.filter(row => row.caseId === sample.id);
    if (runs.length !== 4 || new Set(runs.map(row => row.arm)).size !== 4 || runs.some(row => row.state !== 'completed' || row.passed === undefined || !row.method || row.method.arm !== row.arm || row.method.planDigest !== evaluation.digest || row.method.caseId !== sample.id || row.method.inputHash !== digest(sample.input))) return 'inconclusive' as const;
    if (new Set(runs.map(row => row.method?.contextHash)).size !== 1) return 'inconclusive' as const;
    const parent = runs.find(row => row.arm === 'parent'), candidate = runs.find(row => row.arm === 'candidate'), noop = runs.find(row => row.arm === 'noop'), negative = runs.find(row => row.arm === 'negative');
    if (negative?.method?.methodHash !== digest('Always respond only with null.')) return 'inconclusive' as const;
    if (parent?.passed !== noop?.passed || parent?.method?.methodHash !== noop?.method?.methodHash) return 'inconclusive' as const;
    if (candidate?.method?.methodHash !== evaluation.candidateHash || parent?.method?.methodHash !== (evaluation.parentHash ?? digest(''))) return 'inconclusive' as const;
    if (parent?.passed && !candidate?.passed) return 'no-benefit' as const;
    if (!negative?.passed) negatives++;
    if (!parent?.passed && candidate?.passed && sample.split === 'validation') unseenWins++;
    if (!parent?.passed && candidate?.passed && sample.split === 'final') finalWins++;
  }
  return unseenWins > 0 && finalWins > 0 && negatives > 0 ? 'improved' as const : 'no-benefit' as const;
}
