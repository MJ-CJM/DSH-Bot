import { useEffect, useRef, useState } from 'react';
import { Button, IconChevronDownOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupSummary } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';
import { filterGroupDirectory, type GroupDirectoryFilter } from '../group-management.js';
import { relativeTime } from '../activity-view.js';
import { GroupAvatar } from './GroupAvatar.js';
import { SearchField } from './SearchField.js';
import { directoryWindow, migrateLegacyDirectory, readDirectoryWindow, writeDirectoryWindow } from '../pages/native-directory.js';
import { conversationKey, recentPreferences, setRecentPreference, updateRecentPreference } from '../pages/recent-conversations.js';
import styles from '../styles/groups.module.css';

export function GroupDirectory({ rows, bots, selectedId, onSelect, onOpen, onCreate, onRefresh, t }: {
  rows: readonly GroupSummary[];
  bots: readonly BotRecord[];
  selectedId?: string;
  onSelect(group: GroupSummary['group']): void;
  onOpen?(group: GroupSummary['group'], signal?: AbortSignal): Promise<void>;
  onCreate(): void;
  onRefresh(): void;
} & PropsLocale<'dsh-bot'>) {
  const [windowState] = useState(directoryWindow);
  const [saved] = useState(() => readDirectoryWindow(windowState.storage, windowState.path, 'groups'));
  const [query, updateQuery] = useState(saved.query ?? '');
  const [filter, updateFilter] = useState<GroupDirectoryFilter>(['all', 'running', 'unread', 'archived'].includes(saved.filter ?? '') ? saved.filter as GroupDirectoryFilter : 'all');
  const setQuery = (value: string) => { updateQuery(value); writeDirectoryWindow(windowState.storage, windowState.path, 'groups', { query: value, filter }); };
  const setFilter = (value: GroupDirectoryFilter) => { updateFilter(value); writeDirectoryWindow(windowState.storage, windowState.path, 'groups', { query, filter: value }); };
  const [, setRevision] = useState(0);
  const liveIdentities = JSON.stringify([...bots.map(bot => ({ kind: 'bot', id: bot.id, createdAt: bot.createdAt })),
    ...rows.map(row => ({ kind: 'group', id: row.group.id, createdAt: row.group.createdAt }))]);
  useEffect(() => {
    if (!rows.length) return;
    migrateLegacyDirectory(windowState.storage, windowState.path, JSON.parse(liveIdentities));
    setRevision(value => value + 1);
  }, [liveIdentities, rows.length, windowState]);
  const [opening, setOpening] = useState(false), [failed, setFailed] = useState(false);
  const navigation = useRef<AbortController>();
  useEffect(() => () => navigation.current?.abort(), []);
  const [filterOpen, setFilterOpen] = useState(false);
  const tokens = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const visible = filterGroupDirectory(rows, '', filter).filter(row => {
    const memberBots = row.members.filter(member => member.removedAt === undefined).flatMap(member => {
      const bot = bots.find(bot => bot.id === member.bot.botId && bot.createdAt === member.bot.botCreatedAt);
      return [member.bot.botId, bot?.name ?? ''];
    });
    const search = `${row.group.name} ${row.group.id} ${memberBots.join(' ')}`.normalize('NFKC').toLocaleLowerCase();
    return tokens.every(token => search.includes(token));
  }).sort((a, b) => {
    const ap = recentPreferences.get(conversationKey('group', a.group.id, a.group.createdAt));
    const bp = recentPreferences.get(conversationKey('group', b.group.id, b.group.createdAt));
    return Number(Boolean(bp?.pinned)) - Number(Boolean(ap?.pinned)) || (bp?.openedAt ?? 0) - (ap?.openedAt ?? 0);
  });
  const filtered = Boolean(query.trim()) || filter !== 'all';
  const filters: GroupDirectoryFilter[] = ['all', 'running', 'unread', 'archived'];
  return <section className={styles.directory} aria-label={t('groups.list')}>
    <div className={styles.directoryTools}>
      <SearchField label={t('groups.search')} clearLabel={t('detail.clearSearch')} value={query} onChange={setQuery} />
      <Menu open={filterOpen} onClose={() => setFilterOpen(false)} align="end" selectedId={filter}
        anchor={<Button variant="ghost" className={styles.directoryFilter} aria-label={t('groups.filter')} aria-haspopup="menu" aria-expanded={filterOpen} onClick={() => setFilterOpen(!filterOpen)}>
          {t(`groups.filter.${filter}`)}<IconChevronDownOutlineRegular size={12} />
        </Button>}
        items={filters.map(value => ({ id: value, label: t(`groups.filter.${value}`) }))}
        onSelect={id => { setFilter(id as GroupDirectoryFilter); setFilterOpen(false); }} />
      <Button variant="ghost" className={styles.directoryRefresh} aria-label={t('bots.refresh')} title={t('bots.refresh')} onClick={onRefresh}>
        <IconRefreshOutlineRegular size={14} />
      </Button>
    </div>
    {rows.length > 0 && <p className={styles.directoryCount} role="status">
      {t(filtered ? 'groups.directoryFiltered' : 'groups.directoryTotal', { count: visible.length, total: rows.length })}
    </p>}
    {failed && <p role="alert">{t('activity.openError')}</p>}
    {visible.length > 0 ? <ul className={styles.directoryList}>
      {visible.map(row => {
        const active = row.members.filter(member => member.enabled && member.removedAt === undefined);
        const latest = row.latest;
        const key = conversationKey('group', row.group.id, row.group.createdAt);
        return <li key={key} className={styles.directoryEntry} data-directory-kind="group" data-directory-id={row.group.id} data-directory-created-at={row.group.createdAt}>
          <button type="button" className={styles.directoryRow} data-group-directory-row={row.group.id}
            data-directory-open="" disabled={opening} aria-current={selectedId === row.group.id ? 'page' : undefined} onClick={() => {
              if (!onOpen) { onSelect(row.group); return; }
              if (navigation.current) return;
              const controller = new AbortController(); navigation.current = controller; setOpening(true); setFailed(false);
              void onOpen(row.group, controller.signal).then(() => { if (!controller.signal.aborted) { updateRecentPreference(key, { openedAt: Date.now() }); setRevision(value => value + 1); } }, () => { if (!controller.signal.aborted) setFailed(true); }).finally(() => {
                if (navigation.current === controller) navigation.current = undefined;
                if (!controller.signal.aborted) setOpening(false);
              });
            }}>
            <GroupAvatar size={40} members={active} bots={bots} label={row.group.name} />
            <span className={styles.directoryRowBody}>
              <span className={styles.directoryRowTitle}>
                <strong>{row.group.name}</strong>
                {row.unread && <span className={styles.unreadMark} role="status" aria-label={t('groups.unread')}>●</span>}
              </span>
              {rows.filter(candidate => candidate.group.name === row.group.name).length > 1 && <span className={styles.directoryRowMeta}>{row.group.id}</span>}
              <span className={styles.directoryRowMeta}>
                <span>{t('navigation.memberCount', { count: active.length })}</span>
                {row.running && !row.group.archived && <span>{t('groups.running')}</span>}
                {(row.exportPendingCount ?? 0) > 0 && <span>{t('groups.export.queueCount', { count: row.exportPendingCount ?? 0 })}</span>}
                {row.group.archived && <span>{t('groups.archived')}</span>}
                {latest?.speaker?.name && <span className={styles.directorySpeaker}>{latest.speaker.name}</span>}
                {latest?.at && <time dateTime={new Date(latest.at).toISOString()}>{relativeTime(latest.at, t('activity.locale'))}</time>}
              </span>
            </span>
          </button>
          <Button variant="ghost" data-directory-pin="" aria-pressed={Boolean(recentPreferences.get(key)?.pinned)} aria-label={`${t(recentPreferences.get(key)?.pinned ? 'chat.unpin' : 'chat.pin')} · ${row.group.name}`}
            onClick={() => { setRecentPreference(key, 'pinned'); setRevision(value => value + 1); }}><span aria-hidden="true">⌖</span></Button>
          {onOpen && <Button variant="ghost" aria-label={`${t('chat.profile')} · ${row.group.name}`} onClick={() => { navigation.current?.abort(); navigation.current = undefined; setOpening(false); onSelect(row.group); }}>{t('chat.profile')}</Button>}
        </li>;
      })}
    </ul> : <div className={styles.directoryEmpty}>
      <p>{t(rows.length ? 'groups.noMatches' : 'groups.empty')}</p>
      {rows.length > 0 && <Button variant="ghost" onClick={() => { updateQuery(''); updateFilter('all'); writeDirectoryWindow(windowState.storage, windowState.path, 'groups', {}); }}>{t('groups.clearFilters')}</Button>}
    </div>}
    <div className={styles.directoryFooter}>
      <Button variant={rows.length ? 'ghost' : 'primary'} className={styles.directoryCreate} onClick={onCreate}>
        <IconPlusOutlineRegular size={14} />{t('groups.create')}
      </Button>
    </div>
  </section>;
}
