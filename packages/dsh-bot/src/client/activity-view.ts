import type {} from '@deepseek-ai/dsh-agent-preset-registry/types';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { type ActivitySession, type BotActivity, isHiddenActivityPreview } from '../shared/activity.js';
import type { BotCatalogEntry } from './state.js';

export function previewText(preview: string | undefined, t: PropsLocale<'dsh-bot'>['t']): string {
  return isHiddenActivityPreview(preview) ? t('activity.hidden') : preview ?? '';
}

export function relativeTime(at: number, locale: string, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const seconds = Math.min(0, Math.round((at - now) / 1_000));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (seconds > -60) return format.format(0, 'second');
  for (const [unit, size] of [['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3_600], ['minute', 60]] as const) {
    if (Math.abs(seconds) >= size) return format.format(Math.ceil(seconds / size), unit);
  }
  return format.format(0, 'second');
}

export function sortBotEntries(entries: readonly BotCatalogEntry[], activities: readonly BotActivity[], locale: string): BotCatalogEntry[] {
  const times = new Map(activities.map((item) => [item.botId, item.lastActivityAt]));
  return [...entries].sort((a, b) => (times.get(b.bot.id) ?? 0) - (times.get(a.bot.id) ?? 0)
    || a.bot.name.localeCompare(b.bot.name, locale) || a.bot.createdAt - b.bot.createdAt || a.bot.id.localeCompare(b.bot.id));
}

export interface SessionRow {
  id: SessionId;
  title: string;
  preview: string;
  updatedAt: number;
  unread: boolean;
  running: boolean;
}

/** The public Host catalog owns membership/preset identity and live running
 * state. Activity only enriches those rows; a retained projection is not a row. */
export function botSessionRows(botId: string, entries: readonly BotCatalogEntry[], sessions: SessionListState,
  activities: readonly ActivitySession[], archived: readonly SessionId[] = []): SessionRow[] {
  const presetId = entries.find((entry) => entry.bot.id === botId)?.status?.presetId;
  if (!presetId) return [];
  const hidden = new Set(archived);
  const summaries = new Map(activities.filter((item) => item.botId === botId).map((item) => [item.sessionId, item]));
  return sessions.ids.flatMap((id): SessionRow[] => {
    const session = sessions.byId[id];
    if (!session || session.origin === 'subagent' || hidden.has(id) || session.projectionValues?.agentPreset !== presetId) return [];
    const activity = summaries.get(id);
    return [{ id, title: activity?.title ?? session.displayTitle ?? '', preview: activity?.lastMessage.preview ?? '',
      updatedAt: Math.max(session.updatedAt, activity?.updatedAt ?? 0), unread: activity?.unread ?? false, running: session.running }];
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
