import { z } from 'zod';
import { resourceId, botKeySchema, metadata } from './identity.js';
export const NOTIFICATION_TEXT_MAX_BYTES = 8192;
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const policyInputSchema = z
  .strictObject({
    id: resourceId,
    owner: botKeySchema,
    channel: z.enum(['in-app', 'im']),
    targetRef: resourceId.optional(),
    enabled: z.boolean(),
    timezone: z
      .string()
      .max(100)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
    quietHours: z.strictObject({ start: time, end: time }).optional(),
    dailyLimit: z.number().int().min(0).max(1000),
    cooldownSec: z.number().int().min(0).max(86400),
    authorization: z.strictObject({ mode: z.enum(['ask', 'preapproved']) }),
  })
  .refine((v) => v.channel !== 'im' || v.targetRef !== undefined);
export const policySchema = policyInputSchema.safeExtend({
  ...metadata,
  scopeDigest: z.string(),
  targetDigest: z.string(),
  approvedAt: z.number().optional(),
});
export type NotificationPolicy = z.output<typeof policySchema>;
export const notifyInputSchema = z.strictObject({
  operationId: resourceId,
  policyId: resourceId,
  text: z
    .string()
    .min(1)
    .refine((v) => new TextEncoder().encode(v).length <= NOTIFICATION_TEXT_MAX_BYTES),
  relatedId: resourceId.optional(),
});
export type NotifyInput = z.output<typeof notifyInputSchema>;
export const notificationState = z.enum([
  'recorded',
  'waiting_approval',
  'suppressed',
  'sending',
  'accepted',
  'failed',
  'unknown',
  'cancelled',
]);
export const notificationSchema = z.strictObject({
  id: resourceId,
  operationId: resourceId,
  flowId: z.uuid().optional(),
  owner: botKeySchema,
  policyId: resourceId,
  policyRevision: z.number().int(),
  targetDigest: z.string(),
  scopeDigest: z.string(),
  text: z.string().refine((v) => new TextEncoder().encode(v).length <= NOTIFICATION_TEXT_MAX_BYTES),
  source: z.strictObject({
    kind: z.enum(['tool', 'manual-run', 'group-turn', 'schedule']),
    id: z.string(),
    sessionId: z.string().optional(),
  }),
  state: notificationState,
  reasonCode: z
    .enum([
      'quiet-hours',
      'daily-limit',
      'cooldown',
      'disabled',
      'approval-denied',
      'changed',
      'unsupported',
      'stopping',
      'transport-failed',
      'recovery-needed',
    ])
    .optional(),
  reservation: z.strictObject({ at: z.number(), day: z.string() }).optional(),
  readAt: z.number().optional(),
  attemptId: resourceId.optional(),
  platformMessageId: z.string().max(200).optional(),
  ...metadata,
});
export type NotificationRecord = z.output<typeof notificationSchema>;
export const receiptSchema = z.strictObject({
  id: resourceId,
  intentId: resourceId,
  attemptId: resourceId,
  channel: z.enum(['in-app', 'im']),
  state: notificationState,
  acceptedAt: z.number().optional(),
  platformMessageId: z.string().max(200).optional(),
  ...metadata,
});
