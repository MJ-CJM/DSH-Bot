import { z } from 'zod';
import { groupDeliverySchema, groupKeySchema } from './groups.js';
import { resourceId } from './integrations.js';

export const GROUP_RECALL_QUERY_MAX = 240;
export const GROUP_RECALL_LIMIT_MAX = 20;
export const GROUP_RECALL_SOURCE_MAX = 8000;
export const GROUP_RECALL_CONTEXT_MAX = 8;
export const groupRecallInputSchema = z.strictObject({
  query: z.string().trim().max(GROUP_RECALL_QUERY_MAX).optional(),
  group: groupKeySchema.optional(),
  turnId: resourceId.optional(),
  limit: z.number().int().min(1).max(GROUP_RECALL_LIMIT_MAX).optional(),
  cursor: z.string().min(1).max(640).optional(),
});
export type GroupRecallInput = z.output<typeof groupRecallInputSchema>;

const sourceIdentity = z.strictObject({
  sessionId: z.string().min(1).max(160),
  messageId: z.string().min(1).max(160),
  seq: z.number().int().nonnegative(),
  role: z.enum(['question', 'answer', 'context']),
  /** Offset in the source event's trimmed plain text, measured in UTF-16 code units. */
  offset: z.number().int().nonnegative().optional(),
});
export const groupRecallSourceSchema = sourceIdentity.extend({ text: z.string().min(1).max(GROUP_RECALL_SOURCE_MAX) });
const participation = z.strictObject({
  group: groupKeySchema,
  memberId: resourceId,
  turnId: resourceId,
  deliveryId: resourceId,
  childSessionId: z.string().min(1).max(160),
  at: z.number().int().nonnegative(),
  deliveryRevision: groupDeliverySchema.shape.revision,
});
export const groupRecallItemSchema = participation.extend({
  groupName: z.string().min(1),
  state: groupDeliverySchema.shape.state,
  sources: z.array(groupRecallSourceSchema).min(1).max(GROUP_RECALL_CONTEXT_MAX + 2),
});
export const groupRecallPageSchema = z.strictObject({
  items: z.array(groupRecallItemSchema).max(GROUP_RECALL_LIMIT_MAX),
  nextCursor: groupRecallInputSchema.shape.cursor,
  /** A permitted source could not be verified or the work budget was exhausted. */
  incomplete: z.boolean(),
  unavailable: z.boolean().optional(),
});
export const groupRecallReferenceSchema = participation.extend({
  sources: z.array(sourceIdentity.extend({
    chars: z.number().int().min(1).max(GROUP_RECALL_SOURCE_MAX),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).min(1).max(GROUP_RECALL_CONTEXT_MAX + 2),
});
export type GroupRecallSource = z.output<typeof groupRecallSourceSchema>;
export type GroupRecallItem = z.output<typeof groupRecallItemSchema>;
export type GroupRecallPage = z.output<typeof groupRecallPageSchema>;
export type GroupRecallReference = z.output<typeof groupRecallReferenceSchema>;
