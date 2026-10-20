import assert from 'node:assert/strict';
import * as schedule from '@deepseek-ai/dsh-schedule';

export function probeRules() {
  const id = 't11-rule' as Parameters<typeof schedule.createAtScheduleRecord>[0];
  const now = Date.parse('2026-03-07T12:00:00Z');
  const records = [
    schedule.createAtScheduleRecord(id, 'mock', '2026-03-08T12:00:00Z', now, 'at'),
    schedule.createEveryScheduleRecord(id, 'mock', 60, now, 'every'),
    schedule.createDailyScheduleRecord(id, 'mock', { time: '02:30:00', time_zone: 'America/New_York' }, now, 'daily'),
    schedule.createWeeklyScheduleRecord(id, 'mock', { time: '09:00:00', time_zone: 'UTC', weekdays: [1] }, now, 'weekly'),
    schedule.createCronScheduleRecord(id, 'mock', { expression: '*/5 * * * *', time_zone: 'UTC' }, now, 'cron'),
  ];
  const occurrences = records.filter(record => record.kind !== 'at').map(record => schedule.resolveRecurringOccurrence(record, now + 3 * 86400_000));
  assert.ok(records[2]);
  assert.equal(new Date(records[2].scheduledAt).toISOString(), '2026-03-09T06:30:00.000Z');
  assert.equal(occurrences.length, 4);
  assert.throws(() => schedule.createEveryScheduleRecord(id, 'mock', 59, now, 'bad'));
  assert.throws(() => schedule.createCronScheduleRecord(id, 'mock', { expression: '* * * * * *', time_zone: 'UTC' }, now, 'bad'));
  assert.throws(() => schedule.createAtScheduleRecord(id, 'mock', { date: '2026-03-08', time: '02:30:00', time_zone: 'America/New_York' }, now, 'gap'));
  const overlap = schedule.createAtScheduleRecord(id, 'mock', { date: '2026-11-01', time: '01:30:00', time_zone: 'America/New_York' }, now, 'overlap');
  assert.equal(new Date(overlap.scheduledAt).toISOString(), '2026-11-01T05:30:00.000Z');
  return { records, occurrences, overlap, invalidEvery59Rejected: true, sixFieldCronRejected: true, dstGapRejected: true,
    exports: Object.keys(schedule).filter(key => /^(create|resolve).*?(ScheduleRecord|Occurrence)$/.test(key)) };
}
