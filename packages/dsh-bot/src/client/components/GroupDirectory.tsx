import { useState } from 'react';
import { Button, IconChevronDownOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupSummary } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';
import { filterGroupDirectory, type GroupDirectoryFilter } from '../group-management.js';
import { relativeTime } from '../activity-view.js';
import { GroupAvatar } from './GroupAvatar.js';
import { SearchField } from './SearchField.js';
import styles from '../styles/groups.module.css';

export function GroupDirectory({ rows, bots, selectedId, onSelect, onCreate, onRefresh, t }: {
  rows: readonly GroupSummary[];
  bots: readonly BotRecord[];
  selectedId?: string;
  onSelect(group: GroupSummary['group']): void;
  onCreate(): void;
  onRefresh(): void;
} & PropsLocale<'dsh-bot'>) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<GroupDirectoryFilter>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const visible = filterGroupDirectory(rows, query, filter);
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
    {visible.length > 0 ? <ul className={styles.directoryList}>
      {visible.map(row => {
        const active = row.members.filter(member => member.enabled && member.removedAt === undefined);
        const latest = row.latest;
        return <li key={`${row.group.id}:${row.group.createdAt}`}>
          <button type="button" className={styles.directoryRow} data-group-directory-row={row.group.id}
            aria-current={selectedId === row.group.id ? 'page' : undefined} onClick={() => onSelect(row.group)}>
            <GroupAvatar size={40} members={active} bots={bots} label={row.group.name} />
            <span className={styles.directoryRowBody}>
              <span className={styles.directoryRowTitle}>
                <strong>{row.group.name}</strong>
                {row.unread && <span className={styles.unreadMark} role="status" aria-label={t('groups.unread')}>●</span>}
              </span>
              <span className={styles.directoryRowMeta}>
                <span>{t('navigation.memberCount', { count: active.length })}</span>
                {row.running && !row.group.archived && <span>{t('groups.running')}</span>}
                {row.group.archived && <span>{t('groups.archived')}</span>}
                {latest?.speaker?.name && <span className={styles.directorySpeaker}>{latest.speaker.name}</span>}
                {latest?.at && <time dateTime={new Date(latest.at).toISOString()}>{relativeTime(latest.at, t('activity.locale'))}</time>}
              </span>
            </span>
          </button>
        </li>;
      })}
    </ul> : <div className={styles.directoryEmpty}>
      <p>{t(rows.length ? 'groups.noMatches' : 'groups.empty')}</p>
      {rows.length > 0 && <Button variant="ghost" onClick={() => { setQuery(''); setFilter('all'); }}>{t('groups.clearFilters')}</Button>}
    </div>}
    <div className={styles.directoryFooter}>
      <Button variant={rows.length ? 'ghost' : 'primary'} className={styles.directoryCreate} onClick={onCreate}>
        <IconPlusOutlineRegular size={14} />{t('groups.create')}
      </Button>
    </div>
  </section>;
}
