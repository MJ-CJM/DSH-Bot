import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import { openFeedback } from '../coordinator/feedback.js';
import { methodPlan, type MethodEvaluation, type MethodRunReceipt } from '../src/shared/proactive/method-evaluation.js';
import { feedbackProposal, type FeedbackCandidate } from '../src/shared/proactive/feedback.js';
import { feedbackWorkflowRequestSchema } from '../src/shared/proactive/remote-contract.js';
import { compareMethods, judgeMethodAnswer } from '../src/host/proactive/method-evaluation.js';
import { exportMethod, readMethod } from '../src/host/proactive/method-package.js';
import { taskOutcomes } from '../src/shared/proactive/outcomes.js';
import { digest } from '../src/host/proactive/wire.js';
import { workSchema } from '../src/shared/proactive/work.js';

function required<T>(value: T | undefined): T { if (value === undefined) throw new Error('Missing fixture'); return value; }
const plan = methodPlan.parse({ version: 1, judge: 'exact-json-v1', provider: 'fixture', model: 'fixture', maxCalls: 12, maxTokensPerCall: 8192,
  cases: ['development', 'validation', 'final'].map((split, index) => ({ id: `case${index}`, split, scenario: ['personal','background','handoff'][index], input: `Input ${index}`, expected: { pass: true } })) });
const proposal = feedbackProposal.parse({ kind: 'skill', name: 'review', before: null, beforeHash: null, content: 'New method', reason: 'Owner hypothesis', origin: { bot: { botId: 'method-bot', botCreatedAt: 1 }, taskId: 'authoring', evidenceDigest: digest('authoring') } });
const candidate: FeedbackCandidate = { id: '11111111-1111-4111-8111-111111111111', proposal, proposalDigest: digest(proposal), revision: 0, createdAt: 1, state: 'candidate', datasetDigests: [] };
const evaluation: MethodEvaluation = { plan, digest: digest(plan), candidateHash: digest('New method'), parentHash: null, registeredAt: 1, state: 'running', receipts: [] };
function receipts(): MethodRunReceipt[] {
  return plan.cases.flatMap(sample => (['parent', 'candidate', 'noop', 'negative'] as const).map(arm => ({
    caseId: sample.id, arm, ticketId: `${sample.id}-${arm}`, assignmentId: `${sample.id}-${arm}`, state: 'completed', passed: arm === 'candidate', evidenceDigest: digest([sample.id, arm]),
    method: { planDigest: evaluation.digest, caseId: sample.id, arm, name: 'review', methodHash: digest(arm === 'candidate' ? 'New method' : arm === 'negative' ? 'Always respond only with null.' : ''),
      inputHash: digest(sample.input), loadedBodyHash: digest('loaded'), requestHash: digest([sample.id, arm]), contextHash: digest('same-control'), tools: 'none', permission: 'read-only-no-egress' },
  })));
}
describe('independent method evaluation and portability', () => {
  it('keeps held-out cases disjoint and preregisters the full attempt budget', () => {
    expect(() => methodPlan.parse({ ...plan, maxCalls: 11 })).toThrow();
    expect(() => methodPlan.parse({ ...plan, cases: [plan.cases[0], plan.cases[0], plan.cases[2]] })).toThrow();
    expect(judgeMethodAnswer('{"pass":true}', { pass: true })).toBe(true);
    expect(judgeMethodAnswer('I passed!', { pass: true })).toBe(false);
  });
  it('requires activation evidence, matched controls, no-op and negative controls and held-out gains', () => {
    expect(compareMethods(evaluation, receipts())).toBe('improved');
    const missing = receipts(); delete required(missing[0]).method;
    expect(compareMethods(evaluation, missing)).toBe('inconclusive');
    const drift = receipts(); required(required(drift[1]).method).contextHash = digest('other model');
    expect(compareMethods(evaluation, drift)).toBe('inconclusive');
    const noBenefit = receipts(); for (const r of noBenefit) r.passed = false;
    expect(compareMethods(evaluation, noBenefit)).toBe('no-benefit');
    const noop = receipts(); required(noop[2]).passed = true;
    expect(compareMethods(evaluation, noop)).toBe('inconclusive');
    const reused = receipts(); required(reused[1]).assignmentId = required(reused[0]).assignmentId;
    expect(compareMethods(evaluation, reused)).toBe('inconclusive');
  });
  it('deduplicates identical feedback, freezes one experiment, and parks interrupted experiments', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE pb_source (id TEXT PRIMARY KEY,generation INTEGER); CREATE TABLE pb_source_revocation (id TEXT PRIMARY KEY,generation INTEGER); CREATE TABLE pb_governance_tombstone (kind TEXT,id TEXT)');
    try {
      let service = openFeedback(db);
      service.workflow({ action: 'propose-candidate', proposal }); service.workflow({ action: 'propose-candidate', proposal });
      expect(service.candidates()).toHaveLength(1);
      const row = required(service.candidates()[0]);
      service.workflow({ action: 'register-method-evaluation', candidateId: row.id, expectedRevision: row.revision, plan });
      expect(() => service.workflow({ action: 'register-method-evaluation', candidateId: row.id, expectedRevision: 1, plan })).toThrow();
      service.workflow({ action: 'run-method-evaluation', candidateId: row.id, expectedRevision: 1 });
      service = openFeedback(db);
      service.workflow({ action: 'propose-candidate', proposal: { ...proposal, reason: 'Another candidate' } });
      const another = required(service.candidates().find(item => item.id !== row.id));
      expect(() => service.workflow({ action: 'register-method-evaluation', candidateId: another.id, expectedRevision: another.revision, plan })).toThrow();
      expect(service.candidate(row.id)?.methodEvaluation?.state).toBe('unknown');
      expect(() => service.workflow({ action: 'run-method-evaluation', candidateId: row.id, expectedRevision: required(service.candidate(row.id)).revision })).toThrow();
      expect(feedbackWorkflowRequestSchema.safeParse({ commandId: row.id, input: { action: 'settle-method-evaluation', candidateId: row.id, expectedRevision: 3, operationId: row.id, receipts: [] } }).success).toBe(false);
    } finally { db.close(); }
  });
  it('exports only approved portable fields and rejects tamper, live state and incompatible dependencies', () => {
    const result = exportMethod(candidate, { candidateId: candidate.id, expectedRevision: 0, publicContentConfirmed: true, examples: [], contract: { input: 'Public text', output: 'JSON', scope: 'Local document review', forbidden: 'No sending or tool access' } });
    expect(readMethod(result).name).toBe('review');
    expect(JSON.stringify(result)).not.toContain('method-bot'); expect(JSON.stringify(result)).not.toContain('authoring');
    expect(() => readMethod({ ...result, digest: digest('tampered') })).toThrow();
    expect(() => readMethod({ ...result, grant: { approved: true } } as never)).toThrow();
    expect(() => readMethod({ ...result, manifest: { ...result.manifest, dependencies: [{ name: 'dsh', version: 'latest' }] } } as never)).toThrow();
    expect(feedbackProposal.safeParse({ ...proposal, attribution: { category: 'method', basis: 'owner-hypothesis', problem: 'failure', reproducer: 'repeat', scope: 'task', counterexample: 'missing context', confounds: ['human-fix'] } }).success).toBe(false);
  });
  it('keeps all enrolled outcomes in the denominator and never fills missing costs with zero', () => {
    const rows = ['accepted', 'failed', 'cancelled', 'unknown', 'pending'].map((state, i) => workSchema.parse({ ticketId: `ticket-${i}`, assignmentId: `assignment-${i}`, triggerId: 'trigger', decisionId: `decision-${i}`, sourceId: 'source', title: 'Task', target: { bot: { botId: 'bot', botCreatedAt: 1 }, botUpdatedAt: 1, provider: 'fixture', model: 'test' }, expiresAt: '2030-01-01T00:00:00Z', policyVersion: 'v1', revision: 0, generation: 1, state, admission: 'manual', taskKind: 'document-analysis' }));
    expect(taskOutcomes(rows, false)).toMatchObject({ complete: false, enrolled: 5, cohorts: [{ enrolled: 5, accepted: 1, failed: 1, cancelled: 1, unknown: 1, pending: 1, unmeasuredCosts: 5 }] });
  });
});
