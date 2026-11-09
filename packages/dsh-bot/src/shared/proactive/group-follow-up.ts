import { z } from 'zod';
import { groupKeySchema, ownerFollowUpChoiceSchema } from '../groups.js';
import { resourceId } from '../identity.js';

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scope = { subject: z.strictObject({ kind: z.literal('group'), group: groupKeySchema }),
  cardId: resourceId, expectedRevision: revision };
export const followUpGroupChoiceRequestSchema = z.strictObject({ ...scope, memberId: resourceId });
export const followUpGroupInputSchema = z.strictObject({ ...scope, expectedPolicyRevision: revision,
  choice: ownerFollowUpChoiceSchema, text: z.string().trim().min(1).max(8192), approved: z.literal(true) });
export const followUpGroupAcceptRequestSchema = followUpGroupInputSchema.extend({ commandId: z.uuid() });
export const followUpGroupAbandonInputSchema = z.strictObject({ ...scope, operationId: z.uuid(), approved: z.literal(true) });
export const followUpGroupAbandonRequestSchema = followUpGroupAbandonInputSchema.extend({ commandId: z.uuid() });
export const followUpGroupPlanRequestSchema = z.strictObject(scope);
export const followUpGroupPlanSchema = z.strictObject({ commandId: z.uuid(), input: followUpGroupInputSchema,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/), activationEpoch: z.uuid().nullable().default(null), turnId: resourceId.optional() });
export const followUpGroupChoiceReplySchema = z.strictObject({ choice: ownerFollowUpChoiceSchema,
  existing: followUpGroupAcceptRequestSchema.optional(), canAbandon: z.literal(true).optional() });
export const followUpGroupReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('started'), commandId: z.uuid(), turnId: resourceId }),
  z.strictObject({ kind: z.literal('unknown'), commandId: z.uuid() }),
  z.strictObject({ kind: z.literal('rejected'), code: z.enum(['stale', 'forbidden', 'conflict', 'unavailable']) }),
]);
export type FollowUpGroupChoiceRequest = z.output<typeof followUpGroupChoiceRequestSchema>;
export type FollowUpGroupChoiceReply = z.output<typeof followUpGroupChoiceReplySchema>;
export type FollowUpGroupInput = z.output<typeof followUpGroupInputSchema>;
export type FollowUpGroupAcceptRequest = z.output<typeof followUpGroupAcceptRequestSchema>;
export type FollowUpGroupAbandonInput = z.output<typeof followUpGroupAbandonInputSchema>;
export type FollowUpGroupAbandonRequest = z.output<typeof followUpGroupAbandonRequestSchema>;
export type FollowUpGroupPlanRequest = z.output<typeof followUpGroupPlanRequestSchema>;
export type FollowUpGroupPlan = z.output<typeof followUpGroupPlanSchema>;
export type FollowUpGroupReply = z.output<typeof followUpGroupReplySchema>;
