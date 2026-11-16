import { z } from 'zod';
import { taskMaterialSchema, taskBlockerSchema, taskResumeSchema } from './task-materials.js';
import { botKeySchema } from './identity.js';
import { groupKeySchema, groupViewSchema } from './groups.js';

export const supergroupExpertSchema = z.strictObject({
  id: z.string().min(1), digest: z.string(), botId: z.string().min(1),
  memberId: z.string(), turnId: z.string(), childSessionId: z.string(),
  state: z.enum(['pending', 'invited', 'failed']), reason: z.string().optional(),
});
export const supergroupDeliverySchema = z.strictObject({
  id: z.string(), messageId: z.string(), digest: z.string(), targetSessionId: z.string(), resultVersion: z.string(),
  state: z.enum(['prepared', 'dispatching', 'queued', 'delivered', 'unknown', 'undeliverable', 'cancelled']),
  inputSeq: z.number().int().optional(), answerMessageId: z.string().optional(), reason: z.string().optional(),
});
export const supergroupGroupInputReceiptSchema = z.strictObject({
  operationId: z.string(), digest: z.string(), messageId: z.string(), seq: z.number().int().optional(),
  expectedRevision: z.number().int().positive(), acceptedRevision: z.number().int().positive().optional(),
  state: z.enum(['stored', 'queued', 'running', 'completed', 'conflict', 'cancelled', 'unknown']),
  memberIds: z.array(z.string()).optional(), replyTo: z.string().optional(),
  reason: z.string().optional(), delivery: supergroupDeliverySchema.optional(),
});
/** Association and admission receipts; Group/Session remain the execution authority. */
export const supergroupWorkSchema = z.strictObject({
  id: z.string().min(1), revision: z.number().int().positive(), owner: botKeySchema,
  originSessionId: z.string().min(1), inputMessageId: z.string().min(1), inputMessageIds: z.array(z.string()),
  configDigest: z.string(), readers: z.array(botKeySchema).min(1).max(65),
  createdAt: z.number(), updatedAt: z.number(), expiresAt: z.number(),
  group: groupKeySchema.optional(), turnIds: z.array(z.string()),
  state: z.enum(['creating', 'running', 'completed', 'partial', 'cancelled', 'unknown']),
  collaboration: z.strictObject({ requests: z.number().int().nonnegative(), operations: z.array(z.strictObject({
    id: z.string(), digest: z.string(), target: botKeySchema,
    state: z.enum(['prepared', 'completed', 'failed', 'cancelled', 'unknown']),
    childId: z.string().optional(), status: z.string().optional(), resultDigest: z.string().optional(),
    errorCode: z.string().optional(), diagnostic: z.string().optional(),
  })) }).optional(),
  initialPending: z.boolean().optional(),
  materials: z.array(taskMaterialSchema).max(8).optional(),
  blockers: z.array(taskBlockerSchema).max(128).optional(),
  resumes: z.array(taskResumeSchema).max(32).optional(),
  groupInputs: z.array(supergroupGroupInputReceiptSchema).default([]),
  experts: z.array(supergroupExpertSchema), reason: z.string().optional(),
});
export const supergroupViewSchema = z.strictObject({ work: supergroupWorkSchema, group: groupViewSchema.optional() });
export const supergroupSessionInputSchema = z.strictObject({ sessionId: z.string().min(1), messageId: z.string().min(1) });
export const supergroupCancelInputSchema = z.strictObject({ workId: z.string().min(1), expectedRevision: z.number().int().positive() });
export const supergroupSettingsSchema = z.strictObject({ enabled: z.boolean() });
export const supergroupConfigureSchema = z.strictObject({ enabled: z.boolean(), expectedEnabled: z.boolean() });
export type SupergroupWork = z.output<typeof supergroupWorkSchema>;
export type SupergroupExpert = z.output<typeof supergroupExpertSchema>;
export type SupergroupWorkView = z.output<typeof supergroupViewSchema>;

export const supergroupCatalogInputSchema = z.strictObject({ bot: botKeySchema.optional(), group: groupKeySchema.optional() });
export const supergroupGroupInputSchema = z.strictObject({ group: groupKeySchema });
export const supergroupSendGroupInputSchema = z.strictObject({
  group: groupKeySchema, workId: z.string().min(1), expectedRevision: z.number().int().positive(),
  operationId: z.string().min(1).max(256), memberIds: z.array(z.string().min(1)).max(16).optional(), replyTo: z.string().min(1).optional(), text: z.string().min(1).max(65536).refine(value => value.trim().length > 0),
});
export const supergroupSendGroupResultSchema = z.strictObject({ view: supergroupViewSchema, receipt: supergroupGroupInputReceiptSchema });
export type SupergroupGroupInputReceipt = z.output<typeof supergroupGroupInputReceiptSchema>;
export type SupergroupSendGroupInput = z.output<typeof supergroupSendGroupInputSchema>;
