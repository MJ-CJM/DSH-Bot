import { z } from 'zod';
import { botIdSchema } from './ids.js';
export const onboardingSourceSchema = z.strictObject({
  kind: z.literal('dsh-bot-onboarding'), botId: botIdSchema, botCreatedAt: z.number().int().nonnegative(),
  operationId: z.uuid(), sessionId: z.string().min(1), inputId: z.string().min(1),
  context: z.strictObject({ form: z.literal('notice'), summary: z.string().min(1).max(120) }),
});
export type OnboardingSource = z.output<typeof onboardingSourceSchema>;
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'dsh-bot-onboarding': OnboardingSource } }
