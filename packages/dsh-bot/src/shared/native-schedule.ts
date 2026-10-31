import { z } from 'zod';
import { botIdSchema } from './ids.js';
import { automationTimeSchema } from './automation.js';
export const scheduleBindingSchema = z.strictObject({
  botId: botIdSchema,
  botCreatedAt: automationTimeSchema,
  sessionId: z.string().min(1),
  nativeScheduleId: z.string().min(1),
});
export type ScheduleBinding = z.output<typeof scheduleBindingSchema>;
export const legacyEntrySchema = z.strictObject({
  id: z.string(),
  botId: z.string(),
  botCreatedAt: automationTimeSchema,
  title: z.string(),
  prompt: z.string(),
});
export type LegacyEntry = z.output<typeof legacyEntrySchema>;
export const aggregateSchema = z.strictObject({
  bindings: z.array(scheduleBindingSchema),
  legacy: z.array(legacyEntrySchema),
  nativeAvailable: z.boolean(),
  legacyUnavailable: z.boolean(),
  legacySkipped: z.number().int().nonnegative(),
});
export type NativeAggregate = z.output<typeof aggregateSchema>;
