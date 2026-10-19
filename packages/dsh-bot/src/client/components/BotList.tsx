import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { type RefObject, useEffect, useId, useRef } from 'react';
import type { BotActivity } from '../../shared/activity.js';
import { previewText, relativeTime } from '../activity-view.js';
import type { BotCatalogEntry } from '../state.js';
import styles from '../styles/bots.module.css';
import { BotAvatar } from './BotAvatar.js';

export interface BotListProps {
  /** Callers own ordering and selection so activity refreshes retain identity. */
  entries: readonly BotCatalogEntry[];
  activities: readonly BotActivity[];
  t: PropsLocale<'dsh-bot'>['t'];
  selectedId?: string;
  onSelect(id: string): void;
  onActivate(id: string): void;
  compact?: boolean;
  disabled?: boolean;
  listRef?: RefObject<HTMLDivElement>;
  idPrefix?: string;
}

/** The Bots page and right sidebar share row content and listbox navigation. */
export function BotList({ entries, activities, t, selectedId, onSelect, onActivate,
  compact = false, disabled = false, listRef, idPrefix }: BotListProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const element = listRef ?? ownRef;
  const generatedId = useId();
  const listId = idPrefix ?? generatedId;
  const selected = entries.find(({ bot }) => bot.id === selectedId) ?? entries[0];
  const activeId = selected?.bot.id;
  const locale = t('activity.locale');
  const activityByBot = new Map(activities.map((row) => [row.botId, row]));
  useEffect(() => {
    if (activeId && element.current) document.getElementById(`${listId}-${activeId}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId, element, listId]);
  return <div className={`${styles.botList}${compact ? ` ${styles.botListCompact}` : ''}`} ref={element}
    role="listbox" tabIndex={0} aria-label={t('bots.list')} aria-disabled={disabled || undefined}
    aria-activedescendant={activeId ? `${listId}-${activeId}` : undefined}
    onKeyDown={(event) => {
      if (disabled || !entries.length) return;
      const current = entries.findIndex(({ bot }) => bot.id === activeId);
      let next = current;
      if (event.key === 'ArrowDown') next = Math.min(entries.length - 1, current + 1);
      else if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = entries.length - 1;
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (activeId) onActivate(activeId);
        return;
      } else return;
      event.preventDefault();
      const id = entries[next]?.bot.id;
      if (id) onSelect(id);
    }}>
    {entries.map(({ bot }) => {
      const latest = activityByBot.get(bot.id);
      const preview = latest?.latest ? previewText(latest.latest.preview, t) || t('activity.noPreview') : bot.description || t('bots.noSessions');
      return <button type="button" role="option" tabIndex={-1} key={bot.id} id={`${listId}-${bot.id}`} data-bot-id={bot.id}
        aria-selected={bot.id === activeId} className={styles.botOption} disabled={disabled}
        onClick={() => { onSelect(bot.id); onActivate(bot.id); element.current?.focus(); }}>
        <BotAvatar bot={bot} size={compact ? 32 : 40} />
        <span className={styles.botOptionBody}>
          <span className={styles.rowHeading}><span className={styles.rowName}>{bot.name}</span>
            {!!latest?.lastActivityAt && <time className={styles.relativeTime} dateTime={new Date(latest.lastActivityAt).toISOString()}>{relativeTime(latest.lastActivityAt, locale)}</time>}
          </span>
          <span className={styles.rowHeading}><span className={styles.activityPreview} data-activity-preview="" title={preview}>{preview}</span>
            {!!latest?.unreadCount && <span className={styles.unreadDot} data-unread="" role="img" aria-label={t('activity.unreadCount', { count: latest.unreadCount })} />}
          </span>
        </span>
      </button>;
    })}
  </div>;
}
