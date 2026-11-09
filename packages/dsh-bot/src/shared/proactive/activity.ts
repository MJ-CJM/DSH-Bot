import { z } from 'zod';
import { botKeySchema } from '../identity.js';
import { workSchema, workId } from './work.js';

/** A list is a projection; evidence and execution grants are fetched on demand. */
export const workSummarySchema = workSchema.pick({
  admission: true, taskKind: true,
  ticketId: true, assignmentId: true, decisionId: true, triggerId: true,
  sourceId: true, title: true, target: true, expiresAt: true, policyVersion: true,
  revision: true, generation: true, state: true, evidenceDigest: true,
  sessionId: true, groupReview: true, notice: true, usage: true, reviewedAt: true,
});
export const activityRequestSchema = z.strictObject({
  owner: botKeySchema,
  collection: z.enum(['work', 'suggestions']),
  sourceId: workId.optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
export const workDetailRequestSchema = z.strictObject({
  owner: botKeySchema, ticketId: workId,
  expectedRevision: z.number().int().nonnegative(),
});
export type ActivityRequest = z.output<typeof activityRequestSchema>;
export type WorkDetailRequest = z.output<typeof workDetailRequestSchema>;
