import { previewText, relativeTime } from '../activity-view.js';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { GroupAvatar } from '../components/GroupAvatar.js';
import { BotIdentity } from '../components/BotIdentity.js';
import { SearchField } from '../components/SearchField.js';
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { recentPreferences, setRecentPreference, updateRecentPreference } from './recent-conversations.js';
import { directoryWindow, filterNativeDirectory, migrateLegacyDirectory, nativeDirectoryRows, readDirectoryWindow, writeDirectoryWindow, type NativeDirectoryRow } from './native-directory.js';
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
  const latest = useRef(model); latest.current = model;
  const [windowState] = useState(directoryWindow);
  const [selection, setSelection] = useState(() => readDirectoryWindow(windowState.storage, windowState.path, 'selection').selected);
  const [menu, setMenu] = useState<string>();
  const update = (key: string, field: 'hidden' | 'pinned') => {
    setRecentPreference(key, field); setRevision(value => value + 1);
  };
  const allRows = nativeDirectoryRows(model.entries, snapshot.groups, model.activity.sessions ?? []);
  const liveIdentities = JSON.stringify(allRows.map(({ kind, id, createdAt }) => ({ kind, id, createdAt })));
  useEffect(() => {
    if (model.snapshot?.loaded === false || groups && snapshot.loaded === false) return;
    const migrated = migrateLegacyDirectory(windowState.storage, windowState.path, JSON.parse(liveIdentities));
    if (migrated) setSelection(current => current ?? migrated);
    setRevision(value => value + 1);
  }, [liveIdentities, model.snapshot?.loaded, groups, snapshot.loaded, windowState]);
  const candidates = mode === 'bots' ? allRows.filter(row => row.kind === 'bot') : allRows;
  const rows = filterNativeDirectory(candidates, query, mode === 'bots' ? undefined : hidden);
  const profile = (row: NativeDirectoryRow) => {
    model.cancelNavigation?.();
    if (row.entry) model.showBot(row.entry.bot);
    else { groups?.select(row.id, row.createdAt); model.setTab('groups'); }
  };
  const open = (row: NativeDirectoryRow) => model.navigate(async signal => {
    if (row.entry) {
      if (!latest.current.entries.some(entry => entry.bot.id === row.id && entry.bot.createdAt === row.createdAt)) throw new Error(t('errors.detailMissing'));
      if (page.onStartExact) await page.onStartExact({ id: row.id, createdAt: row.createdAt }, signal);
      else await page.onStart(row.id, signal);
    } else {
      if (!groups || !groups.catalog.getSnapshot().groups.some(candidate => candidate.group.id === row.id && candidate.group.createdAt === row.createdAt && !candidate.group.archived)) throw new Error(t('navigation.targetMissing'));
      await groups.open({ groupId: row.id, groupCreatedAt: row.createdAt }, signal);
    }
    if (signal.aborted) return;
    updateRecentPreference(row.key, { openedAt: Date.now() });
    writeDirectoryWindow(windowState.storage, windowState.path, 'selection', { selected: row.key });
    setSelection(row.key); setRevision(value => value + 1);
  }, row.entry ? 'errors.start' : 'activity.openError');
  return <section aria-label={text(mode === 'bots' ? 'navigation.myBots' : 'chat.recent')} data-bots-list={mode}>
    <div className={styles.listTools}>
      {mode === 'bots' && model.entries.length > 0 && <button type="button" className={styles.button} disabled={model.busy || !model.snapshot.loaded} onClick={() => model.open({ kind: 'create' })}>{t('bots.create')}</button>}
      {mode === 'bots' && page.onOpenAutomaticCollaboration && <Button variant="ghost" onClick={page.onOpenAutomaticCollaboration}>{t('supergroup.settingsTitle')}</Button>}
      <SearchField className={styles.recentSearch} label={text(mode === 'bots' ? 'navigation.searchBots' : 'chat.search')} clearLabel={t('detail.clearSearch')} value={query} onChange={setQuery} />
      {mode === 'recent' && <button type="button" className={styles.button} aria-pressed={hidden} onClick={() => setHidden(!hidden)}>{text(hidden ? 'chat.recent' : 'chat.hidden')}</button>}
    </div>
    <ul className={styles.recentList}>
      {rows.map(row => <li key={row.key} className={styles.recentRow} data-directory-kind={row.kind} data-directory-id={row.id} data-directory-created-at={row.createdAt} data-directory-selected={selection === row.key ? '' : undefined}>
        <button type="button" data-directory-open="" data-bot-id={row.entry?.bot.id} aria-label={row.name} className={styles.recentOpen} disabled={model.busy || model.navigating} onClick={() => { void open(row); }}>
          {row.entry ? <BotIdentity bot={row.entry.bot} size={36} preview={previewText(row.preview, t) || (row.entry.bot.description === row.name || /^bot-[a-z0-9-]+$/i.test(row.entry.bot.description) ? '' : row.entry.bot.description) || t('bots.noSessions')} disambiguate={allRows.filter(candidate => candidate.name === row.name).length > 1} /> : <><GroupAvatar size={36} members={row.group?.members} bots={model.entries.map(entry => entry.bot)} label={row.name} /><span className={styles.recentBody}>{row.name}<span className={styles.activityPreview}>{allRows.filter(candidate => candidate.name === row.name).length > 1 ? row.id : row.group?.running ? t('groups.running') : t('groups.title')}</span></span></>}
          {mode === 'bots' && row.entry?.status?.preset.state !== 'ok' && <span className={styles.hint}>{text(row.entry?.status?.preset.state === 'broken' ? 'card.statusBroken' : row.entry?.status?.preset.state === 'missing' ? 'card.statusMissing' : 'card.statusUnknown')}</span>}
          {!!row.unread && <span data-unread="" role="img" aria-label={t('activity.unreadCount', { count: row.unread })}>●</span>}
          {!!row.at && <time className={styles.relativeTime} dateTime={new Date(row.at).toISOString()}>{relativeTime(row.at, t('activity.locale'))}</time>}
        </button>
        <Button variant="ghost" className={styles.quietAction} data-directory-pin="" aria-pressed={Boolean(recentPreferences.get(row.key)?.pinned)} aria-label={`${text(recentPreferences.get(row.key)?.pinned ? 'chat.unpin' : 'chat.pin')} · ${row.name}`} title={text(recentPreferences.get(row.key)?.pinned ? 'chat.unpin' : 'chat.pin')} onClick={() => update(row.key, 'pinned')}><span aria-hidden="true">⌖</span></Button>
        <Button variant="ghost" className={styles.quietAction} aria-label={`${text('chat.profile')} · ${row.name}`} onClick={() => profile(row)}>{text('chat.profile')}</Button>
        <Menu open={menu === row.key} onClose={() => setMenu(undefined)} align="end"
          anchor={<Button variant="ghost" className={styles.quietAction} aria-label={`${t('card.more')} ${row.name}`} aria-haspopup="menu" aria-expanded={menu === row.key} onClick={() => setMenu(menu === row.key ? undefined : row.key)}>···</Button>}
          items={[
            { id: 'pinned', label: text(recentPreferences.get(row.key)?.pinned ? 'chat.unpin' : 'chat.pin') },
            ...(mode === 'recent' ? [{ id: 'hidden', label: text(hidden ? 'chat.restore' : 'chat.hide') }] : []),
            { id: 'profile', label: text('chat.profile') },
            ...(row.entry ? [{ id: 'delete', label: t('actions.delete') }] : []),
          ]}
          onSelect={id => { setMenu(undefined);
            if (id === 'pinned' || id === 'hidden') update(row.key, id);
            else if (id === 'delete' && row.entry) model.open({ kind: 'delete', bot: row.entry.bot });
            else profile(row);
          }} />

      </li>)}
    </ul>
    {rows.length === 0 && (mode !== 'bots' || Boolean(query)) && !model.snapshot?.error && <p className={styles.hint}>{text(query ? mode === 'bots' ? 'navigation.noBotsMatch' : 'chat.noMatches' : mode === 'bots' ? 'bots.empty' : hidden ? 'navigation.noHidden' : 'navigation.noRecent')}</p>}
  </section>;
}
