import { previewText, relativeTime } from '../activity-view.js';
import { useState, useSyncExternalStore } from 'react';
import { GroupAvatar } from '../components/GroupAvatar.js';
import { BotIdentity } from '../components/BotIdentity.js';
import { SearchField } from '../components/SearchField.js';
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { conversationKey, recentPreferences, setRecentPreference } from './recent-conversations.js';
import type { BotsPageProps } from './bots-page-types.js';
import type { BotsPageModel } from './use-bots-page.js';
import styles from '../styles/bots.module.css';
const emptyGroups = { groups: [], loading: false, loaded: true, pollIntervalMs: 0 };
const noSubscribe = () => () => {};
export function RecentConversations({ page, model, mode = 'recent' }: { page: BotsPageProps; model: BotsPageModel; mode?: 'bots' | 'recent' }) {
  const { groups, t } = page;
  const text = (key: string) => t(key as Parameters<typeof t>[0]);
  const snapshot = useSyncExternalStore(groups?.catalog.subscribe ?? noSubscribe, groups?.catalog.getSnapshot ?? (() => emptyGroups));
  const saved = model.pageState?.lists[mode];
  const [query, updateQuery] = useState(saved?.query ?? '');
  const [hidden, updateHidden] = useState(saved?.hidden ?? false);
  const setQuery = (value: string) => { if (saved) saved.query = value; updateQuery(value); };
  const setHidden = (value: boolean) => { if (saved) saved.hidden = value; updateHidden(value); };
  const [, setRevision] = useState(0);
  const [menu, setMenu] = useState<string>();
  const update = (key: string, field: 'hidden' | 'pinned') => {
    setRecentPreference(key, field); setRevision(value => value + 1);
  };
  const rows = [
    ...model.entries.map(entry => ({ key: conversationKey('bot', entry.bot.id, entry.bot.createdAt), name: entry.bot.name,
      at: model.activity.bots.find(row => row.botId === entry.bot.id)?.lastActivityAt ?? entry.bot.updatedAt,
      preview: previewText(model.activity.bots.find(row => row.botId === entry.bot.id)?.latest?.preview, t)
        || (entry.bot.description === entry.bot.name || /^bot-[a-z0-9-]+$/i.test(entry.bot.description) ? '' : entry.bot.description) || t('bots.noSessions'),
      unread: model.activity.bots.find(row => row.botId === entry.bot.id)?.unreadCount ?? 0,
      avatar: undefined, bot: entry.bot, groupId: undefined, groupCreatedAt: undefined, status: entry.status?.preset.state ?? 'unknown',
      open: () => model.navigate(signal => page.onStart(entry.bot.id, signal), 'errors.start') })),
    ...(mode === 'recent' ? snapshot.groups : []).map(group => ({ key: conversationKey('group', group.group.id, group.group.createdAt), name: group.group.name,
      at: group.latest?.at ?? group.group.updatedAt, preview: group.running ? t('groups.running') : '', unread: group.unread ? 1 : 0,
      avatar: <GroupAvatar size={36} members={group.members} bots={model.entries.map(entry => entry.bot)} label={group.group.name} />, bot: undefined, groupId: group.group.id, groupCreatedAt: group.group.createdAt, status: undefined,
      open: () => model.navigate(signal => (groups?.open({ groupId: group.group.id, groupCreatedAt: group.group.createdAt }, signal) ?? Promise.resolve()), 'activity.openError') })),
  ].filter(row => (mode === 'bots' || Boolean(recentPreferences.get(row.key)?.hidden) === hidden) && row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => Number(Boolean(recentPreferences.get(b.key)?.pinned)) - Number(Boolean(recentPreferences.get(a.key)?.pinned)) || b.at - a.at || a.key.localeCompare(b.key));
  return <section aria-label={text(mode === 'bots' ? 'navigation.myBots' : 'chat.recent')} data-bots-list={mode}>
    <div className={styles.listTools}>
      {mode === 'bots' && model.entries.length > 0 && <button type="button" className={styles.button} disabled={model.busy || !model.snapshot.loaded} onClick={() => model.open({ kind: 'create' })}>{t('bots.create')}</button>}
      <SearchField className={styles.recentSearch} label={text(mode === 'bots' ? 'navigation.searchBots' : 'chat.search')} clearLabel={t('detail.clearSearch')} value={query} onChange={setQuery} />
      {mode === 'recent' && <button type="button" className={styles.button} aria-pressed={hidden} onClick={() => setHidden(!hidden)}>{text(hidden ? 'chat.recent' : 'chat.hidden')}</button>}
    </div>
    <ul className={styles.recentList}>
      {rows.map(row => <li key={row.key} className={styles.recentRow}>
        <button type="button" data-bot-id={row.bot?.id} aria-label={row.name} className={styles.recentOpen} disabled={model.busy || model.navigating} onClick={() => { void row.open(); }}>
          {row.bot ? <BotIdentity bot={row.bot} size={36} preview={row.preview} disambiguate={model.entries.filter(entry => entry.bot.name === row.name).length > 1} /> : <>{row.avatar}<span className={styles.recentBody}>{row.name}<span className={styles.activityPreview}>{row.preview}</span></span></>}
          {mode === 'recent' && recentPreferences.get(row.key)?.pinned && <span role="img" aria-label={text('chat.pinned')}>⌖</span>}
          {mode === 'bots' && row.status !== 'ok' && <span className={styles.hint}>{text(row.status === 'broken' ? 'card.statusBroken' : row.status === 'missing' ? 'card.statusMissing' : 'card.statusUnknown')}</span>}
          {!!row.unread && <span data-unread="" role="img" aria-label={t('activity.unreadCount', { count: row.unread })}>●</span>}
          {!!row.at && <time className={styles.relativeTime} dateTime={new Date(row.at).toISOString()}>{relativeTime(row.at, t('activity.locale'))}</time>}
        </button>
        <Button variant="ghost" className={styles.quietAction} aria-label={`${text('chat.profile')} · ${row.name}`} onClick={() => { if (row.bot) model.showBot(row.bot); else if (row.groupId) { groups?.select(row.groupId, row.groupCreatedAt); model.setTab('groups'); } }}>{text('chat.profile')}</Button>
        <Menu open={menu === row.key} onClose={() => setMenu(undefined)} align="end"
          anchor={<Button variant="ghost" className={styles.quietAction} aria-label={`${t('card.more')} ${row.name}`} aria-haspopup="menu" aria-expanded={menu === row.key} onClick={() => setMenu(menu === row.key ? undefined : row.key)}>···</Button>}
          items={[
            ...(mode === 'recent' ? [{ id: 'pinned', label: text(recentPreferences.get(row.key)?.pinned ? 'chat.unpin' : 'chat.pin') }, { id: 'hidden', label: text(hidden ? 'chat.restore' : 'chat.hide') }] : []),
            { id: 'profile', label: text('chat.profile') },
            ...(row.bot ? [{ id: 'delete', label: t('actions.delete') }] : []),
          ]}
          onSelect={id => { setMenu(undefined);
            if (id === 'pinned' || id === 'hidden') update(row.key, id);
            else if (id === 'delete' && row.bot) model.open({ kind: 'delete', bot: row.bot });
            else if (row.bot) model.showBot(row.bot);
            else if (row.groupId) { groups?.select(row.groupId, row.groupCreatedAt); model.setTab('groups'); }
          }} />

      </li>)}
    </ul>
    {rows.length === 0 && (mode !== 'bots' || Boolean(query)) && !model.snapshot?.error && <p className={styles.hint}>{text(query ? mode === 'bots' ? 'navigation.noBotsMatch' : 'chat.noMatches' : mode === 'bots' ? 'bots.empty' : hidden ? 'navigation.noHidden' : 'navigation.noRecent')}</p>}
  </section>;
}
