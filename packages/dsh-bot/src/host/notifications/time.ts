import type { NotificationPolicy } from '../../shared/integrations.js';
export function localTime(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (key: string) => parts.find((p) => p.type === key)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}
export function quietAt(at: number, p: Pick<NotificationPolicy, 'quietHours' | 'timezone'>) {
  if (!p.quietHours) return false;
  const t = localTime(at, p.timezone).time,
    { start, end } = p.quietHours;
  return start === end || (start < end ? t >= start && t < end : t >= start || t < end);
}
