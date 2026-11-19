import { z } from 'zod';
import { botIdSchema } from './ids.js';
import { automationTimeSchema } from './automation.js';
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule';
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

/** Public rc.3 target-based record. Legacy rc.2 records carry sessionId directly. */
export interface TargetScheduleEntry {
  id: ScheduleCatalogEntry['id']; kind: 'rrule'; title: string; prompt: string; rrule: string; scheduledAt: string;
  target: { kind: 'session'; sessionId: string } | { kind: 'new' | 'new_once'; sessionId?: string };
  status: 'active' | 'ended'; updatedAt?: string; createdAt?: string;
}
export function nativeScheduleSession(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  if ('target' in value) {
    const target = value.target;
    if (!target || typeof target !== 'object' || !('kind' in target) || target.kind !== 'session' ||
        !('sessionId' in target) || typeof target.sessionId !== 'string' || !target.sessionId) return;
    if ('sessionId' in value && value.sessionId !== undefined && value.sessionId !== target.sessionId) return;
    return target.sessionId;
  }
  return 'sessionId' in value && typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : undefined;
}
