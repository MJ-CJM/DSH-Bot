import type { Context } from '@deepseek-ai/cordis';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { Button, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useRef, useState } from 'react';
import type { ActivityCatalog } from '../activity-state.js';
import { botSessionRows, sortBotEntries } from '../activity-view.js';
import { useChatLauncher, type ChatLauncherActions } from '../chat-launcher.js';
import type { BotCatalog } from '../state.js';
import { BotList } from './BotList.js';
import styles from '../styles/right-tab.module.css';
import css from '../styles/right-tab.module.css?inline';
import listCss from '../styles/bots.module.css?inline';

export interface BotsRightTabInjected extends ChatLauncherActions {
  hooks: {
    catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'>;
    activity: Pick<ActivityCatalog, 'getSnapshot' | 'subscribe'>;
    sessionCatalog: ObservableSnapshot<SessionListState>;
    workspaceCatalog: Context['workspaces']['list'];
  };
  onOpenSession(id: string, signal?: AbortSignal): Promise<void>;
  onRefresh(): Promise<void>;
  onManage(): void;
}

export function BotsRightTab({ useCatalog, useActivity, useSessionCatalog, useWorkspaceCatalog,
  onOpenSession, onRefresh, onManage, onStart, getPreferredWorkspace, t,
}: InjectFace<BotsRightTabInjected> & PropsLocale<'dsh-bot'>) {
  const catalog = useCatalog((value) => value);
  const activity = useActivity((value) => value);
  const sessions = useSessionCatalog((value) => value);
  const workspaces = useWorkspaceCatalog((value) => value);
  const chat = useChatLauncher({ workspaces, onStart, getPreferredWorkspace, t });
  const entries = sortBotEntries(catalog.entries, activity.bots, t('activity.locale'));
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const lifetime = useRef<AbortController>();
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const selected = entries.some(({ bot }) => bot.id === selectedId) ? selectedId : entries[0]?.bot.id;
  const activate = async (id: string) => {
    // An incomplete Host catalog must never be interpreted as "no sessions".
    if (pending.current || sessions.phase !== 'ready' || !catalog.loaded || catalog.loading || catalog.error) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const latest = botSessionRows(id, catalog.entries, sessions, activity.sessions, workspaces.archivedSessionIds)[0];
      if (latest) await onOpenSession(latest.id, lifetime.current?.signal);
      else {
        const entry = catalog.entries.find(({ bot }) => bot.id === id);
        if (entry?.status?.preset.state !== 'ok') throw new Error(t('card.statusUnknown'));
        await chat.start(id);
      }
    } catch {
      if (!lifetime.current?.signal.aborted) setError(t('activity.openError'));
    } finally {
      pending.current = false;
      if (!lifetime.current?.signal.aborted) setBusy(false);
    }
  };
  return <section className={styles.tab} data-bots-right-tab="" aria-label={t('rightTab.title')}>
    <style data-dsh-bot-right-styles="">{css}{listCss}</style>
    <header className={styles.header}>
      <strong>{t('rightTab.title')}</strong>
      <Button variant="ghost" size="sm" aria-label={t('bots.refresh')} title={t('bots.refresh')}
        disabled={busy || catalog.loading} onClick={() => { void onRefresh(); }}><IconRefreshOutlineRegular size={16} /></Button>
    </header>
    {(catalog.loading || sessions.phase !== 'ready') && <p role="status" className={styles.notice}>{t('bots.loading')}</p>}
    {(catalog.error || activity.error) && <div role="alert" className={styles.notice}>
      <p>{t(catalog.error ? 'errors.load' : 'activity.loadError')}</p>
      <Button variant="ghost" size="sm" onClick={() => { void onRefresh(); }}>{t('actions.retry')}</Button>
    </div>}
    {error && <p role="alert" className={styles.notice}>{error}</p>}
    {catalog.loaded && !catalog.error && !entries.length && <p className={styles.notice}>{t('bots.empty')}</p>}
    <div className={styles.list}>
      <BotList entries={entries} activities={activity.bots} selectedId={selected} onSelect={setSelectedId}
        onActivate={(id) => { void activate(id); }} compact t={t}
        disabled={busy || !catalog.loaded || catalog.loading || Boolean(catalog.error) || sessions.phase !== 'ready'} />
    </div>
    <footer className={styles.footer}><Button variant="ghost" size="sm" disabled={busy} onClick={onManage}>{t('sidebar.manage')}</Button></footer>
    {chat.dialog}
  </section>;
}
