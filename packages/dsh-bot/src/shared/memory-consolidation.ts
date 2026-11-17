import { z } from 'zod';
import { botKeySchema } from './identity.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const consolidationInputSchema = z.strictObject({ operationId: z.uuid(), botId: z.string().min(1).max(256),
  expectedRevision: z.number().int().nonnegative(), sourceIds: z.array(z.uuid()).min(1).max(8),
  provider: z.string().min(1).max(256), model: z.string().min(1).max(256) });
export const consolidationDecisionSchema = z.strictObject({ operationId: z.uuid(), runId: z.uuid(), botId: z.string(),
  expectedRevision: z.number().int().nonnegative(), action: z.enum(['accept', 'reject']),
  editedContent: z.string().trim().min(1).max(2048).optional() });
export const consolidationRunSchema = z.strictObject({ id: z.uuid(), owner: botKeySchema, requestHash: hash,
  sourceIds: z.array(z.uuid()), epoch: z.number().int().nonnegative(), createdAt: z.number(), expiresAt: z.number(),
  provider: z.string(), model: z.string(), sessionId: z.string(), candidateId: z.uuid(),
  state: z.enum(['reserved', 'proposed', 'empty', 'failed', 'unknown', 'accepted', 'rejected', 'expired', 'revoked']),
  decisionId: z.uuid().optional(), decisionHash: hash.optional(), outputHash: hash.optional(),
  inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
  modelRequests: z.number().int().min(0).max(1),
});
export const consolidationEvidenceSchema = z.strictObject({ runId: z.uuid(), sourceIds: z.array(z.uuid()).min(1).max(8),
  expiresAt: z.number(), edited: z.boolean().default(false), decisionHash: hash.optional() });
export type ConsolidationInput = z.output<typeof consolidationInputSchema>;
export type ConsolidationDecision = z.output<typeof consolidationDecisionSchema>;
export type ConsolidationRun = z.output<typeof consolidationRunSchema>;

export const consolidationViewSchema = z.strictObject({ enabled: z.boolean(), revision: z.number().int().nonnegative(),
  runs: z.array(consolidationRunSchema.extend({ content: z.string().optional() })) });
