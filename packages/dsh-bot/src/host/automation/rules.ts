import {
  createAtScheduleRecord, createEveryScheduleRecord, createDailyScheduleRecord,
  createWeeklyScheduleRecord, createCronScheduleRecord,
  resolveRecurringOccurrence,
} from '@deepseek-ai/dsh-schedule';
import type { RoutineRule, RoutineRecord } from '../../shared/automation.js';
import { AutomationError } from './errors.js';

/** Only public schedule factories decide calendar validity and normalization. */
export function prepareRule(id: string, rule: RoutineRule, timeZone: string, now: number): {
  rule: RoutineRule; nextRunAt: number;
} {
  const key = id as Parameters<typeof createAtScheduleRecord>[0];
  try {
    switch (rule.kind) {
      case 'at': {
        const r = createAtScheduleRecord(key, 'routine', new Date(rule.at).toISOString(), now, 'Routine');
        return { rule: { kind: 'at', at: Date.parse(r.scheduledAt) }, nextRunAt: Date.parse(r.scheduledAt) };
      }
      case 'every': {
        const r = createEveryScheduleRecord(key, 'routine', rule.everySeconds, now, 'Routine');
        return { rule, nextRunAt: Date.parse(r.scheduledAt) };
      }
      case 'daily': {
        const r = createDailyScheduleRecord(key, 'routine', { time: rule.time, time_zone: timeZone }, now, 'Routine');
        return { rule: { kind: 'daily', time: r.time }, nextRunAt: Date.parse(r.scheduledAt) };
      }
      case 'weekly': {
        const r = createWeeklyScheduleRecord(key, 'routine', { time: rule.time, weekdays: rule.weekdays, time_zone: timeZone }, now, 'Routine');
        return { rule: { kind: 'weekly', time: r.time, weekdays: r.weekdays }, nextRunAt: Date.parse(r.scheduledAt) };
      }
      case 'cron': {
        const r = createCronScheduleRecord(key, 'routine', { expression: rule.expression, time_zone: timeZone }, now, 'Routine');
        return { rule: { kind: 'cron', expression: r.expression }, nextRunAt: Date.parse(r.scheduledAt) };
      }
    }
  } catch (cause) { throw new AutomationError('automation/invalid', 'Invalid routine schedule', { cause }); }
}

/** The persisted UTC cursor is authoritative, including across tzdata changes. */
export function dueOccurrence(routine: RoutineRecord, now: number): {
  scheduledAt: number; nextRunAt: number | null;
} | undefined {
  if (!routine.enabled || routine.deletedAt !== undefined || routine.nextRunAt === undefined || routine.nextRunAt > now) return;
  if (routine.rule.kind === 'at') return { scheduledAt: routine.nextRunAt, nextRunAt: null };
  const common = {
    id: routine.id as Parameters<typeof createAtScheduleRecord>[0],
    title: routine.title, prompt: routine.prompt,
    scheduledAt: new Date(routine.nextRunAt).toISOString(),
  };
  const record = routine.rule.kind === 'every' ? { ...common, ...routine.rule }
    : { ...common, ...routine.rule, timeZone: routine.timeZone };
  const occurrence = resolveRecurringOccurrence(record, now);
  return { scheduledAt: Date.parse(occurrence.occurrenceAt),
    nextRunAt: occurrence.nextScheduledAt === undefined ? null : Date.parse(occurrence.nextScheduledAt) };
}
