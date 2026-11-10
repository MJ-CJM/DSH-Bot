import { z } from 'zod';
import { followUpPolicyChangeSchema, followUpSummarySchema } from './follow-up.js';

/** Owner setup only. Execution, models, budgets and credentials are not writable here. */
export const proactiveSetupRequest = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('enable-suggestions') }),
  z.strictObject({
    action: z.literal('connect-github'),
    repository: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
    branch: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9/._-]{0,199}$/),
    credentialRef: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  }),
]);
export const proactiveSetupReply = z.enum(['updated', 'unchanged', 'conflict', 'unavailable', 'credential-missing']);
export type ProactiveSetupRequest = z.input<typeof proactiveSetupRequest>;
export type ProactiveSetupReply = z.output<typeof proactiveSetupReply>;

const configEpoch = z.uuid().nullable();
export const followUpPolicyRequest = followUpPolicyChangeSchema.extend({
  commandId: z.uuid(),
  expectedRevision: followUpPolicyChangeSchema.shape.expectedRevision.nullable(),
  expectedConfigEpoch: configEpoch,
});
export const followUpStatusReply = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('disabled'), configEpoch }),
  z.strictObject({ state: z.literal('unavailable'), configEpoch }),
  z.strictObject({ state: z.literal('ready'), configEpoch, scopeOnly: z.boolean(), summary: followUpSummarySchema }),
]);
export type FollowUpPolicyRequest = z.output<typeof followUpPolicyRequest>;
export type FollowUpStatusReply = z.output<typeof followUpStatusReply>;
