import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/);
export const methodCase = z.strictObject({
  id, split: z.enum(['development', 'validation', 'final']),
  scenario: z.enum(['personal', 'background', 'handoff']),
  input: z.string().min(1).max(2000),
  expected: z.record(z.string().min(1).max(100), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])),
});
export const methodPlan = z.strictObject({
  version: z.literal(1), judge: z.literal('exact-json-v1'),
  provider: id, model: z.string().min(1).max(128),
  maxCalls: z.number().int().min(12).max(36),
  maxTokensPerCall: z.number().int().min(4096).max(32768),
  cases: z.array(methodCase).min(3).max(9),
}).superRefine((plan, ctx) => {
  if (new Set(plan.cases.map(row => row.id)).size !== plan.cases.length || new Set(plan.cases.map(row => row.input)).size !== plan.cases.length) ctx.addIssue({ code: 'custom', message: 'Cases and inputs must be disjoint' });
  if (new Set(plan.cases.map(row => row.split)).size !== 3 || plan.maxCalls < plan.cases.length * 4) ctx.addIssue({ code: 'custom', message: 'Three independent splits and four arms per case are required' });
});
export const methodTrial = z.strictObject({
  planDigest: hash, caseId: id, arm: z.enum(['parent', 'candidate', 'noop', 'negative']),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), content: z.string().max(16384),
  methodHash: hash, inputHash: hash,
});
export const methodLoadEvidence = methodTrial.omit({ content: true }).extend({
  loadedBodyHash: hash, requestHash: hash, contextHash: hash,
  tools: z.literal('none'), permission: z.literal('read-only-no-egress'),
});
export const methodRunReceipt = z.strictObject({
  caseId: id, arm: methodTrial.shape.arm, ticketId: z.string(), assignmentId: z.string(),
  state: z.enum(['completed', 'inconclusive']),
  passed: z.boolean().optional(), evidenceDigest: hash.optional(),
  method: methodLoadEvidence.optional(),
});
export const methodEvaluation = z.strictObject({
  plan: methodPlan, digest: hash, candidateHash: hash, parentHash: hash.nullable(),
  registeredAt: z.number().int().nonnegative(),
  state: z.enum(['registered', 'running', 'completed', 'unknown']),
  operationId: z.uuid().optional(),
  outcome: z.enum(['improved', 'no-benefit', 'inconclusive']).optional(),
  receipts: z.array(methodRunReceipt).max(36),
});
export type MethodPlan = z.output<typeof methodPlan>;
export type MethodTrial = z.output<typeof methodTrial>;
export type MethodLoadEvidence = z.output<typeof methodLoadEvidence>;
export type MethodEvaluation = z.output<typeof methodEvaluation>;
export type MethodRunReceipt = z.output<typeof methodRunReceipt>;
