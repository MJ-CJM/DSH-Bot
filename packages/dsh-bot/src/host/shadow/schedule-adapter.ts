import { z } from 'zod';
import type { ScheduleDeliveryRecord } from '@deepseek-ai/dsh-schedule';
import { botKeySchema } from '../../shared/identity.js';
// Native delivery identity, only supplied synthetic fixtures. No create/runNow/Agent access.
export const dueSchema = z.strictObject({
  source: z.literal('synthetic'), occurrenceId: z.string().min(1), owner: botKeySchema,
  at: z.number().int().nonnegative(), relevant: z.boolean(),
});
export type SyntheticDue = z.output<typeof dueSchema>;
export function syntheticDue(scheduleId: string, delivery: Pick<ScheduleDeliveryRecord, 'scheduledAt'>,
  fixture: Omit<SyntheticDue, 'occurrenceId'>) {
  const at = Date.parse(delivery.scheduledAt);
  if (!scheduleId || !Number.isFinite(at) || at !== fixture.at) throw Error('Invalid synthetic occurrence');
  return dueSchema.parse({ ...fixture, occurrenceId: `${scheduleId}:${new Date(at).toISOString()}` });
}
