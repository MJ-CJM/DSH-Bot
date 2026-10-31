import { z } from 'zod';
import { botIdSchema } from './ids.js';
import { botCreateSchema } from './schema.js';
export const createForChatSchema = z.strictObject({
  operationId: z.uuid(), bot: botCreateSchema, language: z.enum(['zh', 'en']),
});
export type CreateForChatInput = z.input<typeof createForChatSchema>;
export const startOnboardingSchema = z.strictObject({ botId: botIdSchema, operationId: z.uuid(), sessionId: z.string().min(1) });
export type StartOnboardingInput = z.input<typeof startOnboardingSchema>;
export const onboardingStatusSchema = z.strictObject({
  botId: botIdSchema, operationId: z.uuid().optional(), sessionId: z.string().optional(),
  state: z.enum(['unavailable', 'pending', 'dispatching', 'submitted', 'completed', 'skipped', 'failed', 'uncertain']),
  retryable: z.boolean(), reason: z.string().optional(),
});
export type OnboardingStatus = z.output<typeof onboardingStatusSchema>;
