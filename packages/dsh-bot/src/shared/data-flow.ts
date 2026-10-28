import { z } from 'zod';
import { botIdSchema } from './ids.js';
import { botKeySchema } from './identity.js';

export const dataLabelSchema = z.strictObject({
  readers: z.union([z.literal('shared'), z.array(botKeySchema)]),
  originTrust: z.enum(['candidate', 'user_stated', 'user_confirmed']),
  sourceVersions: z.array(z.uuid()),
  restrictions: z.array(z.enum(['secret', 'no-egress', 'pending-cleanup', 'revoked'])),
  grants: z.array(z.uuid()),
});
export type DataLabel = z.output<typeof dataLabelSchema>;
export const egressTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bot'), bot: botKeySchema }),
  z.strictObject({ kind: z.literal('shared') }),
  z.strictObject({ kind: z.literal('group'), groupId: z.string().min(1), groupCreatedAt: z.number().int().nonnegative(),
    members: z.array(botKeySchema).min(1) }),
  z.strictObject({ kind: z.literal('external'), destination: z.string().min(1).max(512) }),
]);
export type EgressTarget = z.output<typeof egressTargetSchema>;
export const flowBindingSchema = z.strictObject({
  userScope: z.uuid(), bot: botKeySchema, invocation: z.string().min(1),
  payloadVersion: z.uuid(), sourceVersions: z.array(z.uuid()),
  sourceRefs: z.array(z.strictObject({ sessionId: z.string().optional(), eventSeq: z.number().int().nonnegative().optional(),
    callId: z.string().optional(), parentVersionId: z.uuid().optional(), entryReceiptId: z.uuid().optional(),
    managementOpId: z.uuid().optional() })), target: egressTargetSchema,
  epoch: z.number().int().nonnegative(), policyRevision: z.number().int().positive(),
});
export type FlowBinding = z.output<typeof flowBindingSchema>;
export const autoShareSettingsSchema = z.strictObject({
  enabled: z.boolean(), botDaily: z.number().int().min(0).max(10000), domainDaily: z.number().int().min(0).max(100000),
  timeZone: z.string().refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }),
});
export const autoSharePolicySchema = autoShareSettingsSchema.extend({
  revision: z.number().int().positive(), hostConfig: autoShareSettingsSchema.optional(),
});
export const quotaChargeSchema = z.strictObject({
  botId: botIdSchema, bucket: z.number().int().nonnegative(), end: z.number().int().positive(),
  timeZone: z.string(), at: z.number().int().nonnegative(),
}).refine(v => v.bucket <= v.at && v.at < v.end);
export type AutoSharePolicy = z.output<typeof autoSharePolicySchema>;
export type QuotaCharge = z.output<typeof quotaChargeSchema>;
export const autoShareStatusSchema = z.strictObject({
  domainUsed: z.number().int().nonnegative().optional(),
  configured: z.boolean(), effectiveAutoShare: z.literal(false), reason: z.literal('unverifiable-user-input'),
  botDaily: z.number().int().min(0).max(10000), domainDaily: z.number().int().min(0).max(100000),
  timeZone: autoShareSettingsSchema.shape.timeZone, revision: z.number().int().positive(),
});
export const autoShareToggleSchema = z.strictObject({ enabled: z.boolean(), expectedRevision: z.number().int().positive() });
