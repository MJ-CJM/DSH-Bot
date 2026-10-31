import { GroupsPanel } from '../components/GroupsPanel.js';
import { ManagementWorkspace } from '../components/ManagementWorkspace.js';
import { useState } from 'react';
import { RecentConversations } from './RecentConversations.js';
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import styles from '../styles/bots.module.css';
import css from '../styles/bots.module.css?inline';

import type { BotsPageProps } from './bots-page-types.js';
import { useBotsPage } from './use-bots-page.js';
import { BotsTab } from './BotsTab.js';
import { BotDialogs } from './BotDialogs.js';
export type { BotsPageInjected, BotsPageProps } from './bots-page-types.js';

export function BotsPage(page: BotsPageProps) {
  const { management, groups, routines, integrations, collaboration, createMemoryPanel, onOpenSession, onRefresh, t } =
    page;
  const model = useBotsPage(page);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const text = (key: string) => t(key as Parameters<typeof t>[0]);
  const { snapshot, pageElement, compact, tab, setTab, busy, open, entries, unavailable, toast, setToast } = model;
  return (
    <section
      ref={pageElement}
      className={`${styles.page} ${compact ? styles.compact : styles.wide}`}
      data-bots-page=""
      aria-label={t('bots.title')}
    >
      <style data-dsh-bot-styles="">{css}</style>
      <div className={styles.pageScroll}>
        <div className={styles.pageContent}>
          <header className={styles.header}>
            <div className={styles.heading}>
              <h1 className={styles.title}>{t('bots.title')}</h1>
              <p className={styles.subtitle}>{t('bots.subtitle')}</p>
            </div>
            <div className={styles.actions}>
              <details><summary className={styles.button} aria-label={text('chat.new')}><IconPlusOutlineRegular size={16} /></summary>
                <button type="button" className={styles.button} disabled={busy || !snapshot.loaded} onClick={() => open({ kind: 'create' })}>{t('bots.create')}</button>
                {groups && <button type="button" className={styles.button} onClick={() => { setCreatingGroup(true); setTab('groups'); }}>{t('groups.create')}</button>}
              </details>
              <button type="button" className={styles.button} onClick={() => setTab(tab === 'management' ? 'bots' : 'management')}>{text(tab === 'management' ? 'chat.recent' : 'chat.settings')}</button>
            </div>
          </header>
          {tab === 'bots' && <RecentConversations page={page} model={model} />}
          {tab === 'groups' && <button type="button" className={styles.button} onClick={() => { setTab('bots'); setCreatingGroup(false); }}>{text('chat.recent')}</button>}
          {tab === 'management' && (
            <ManagementWorkspace
              management={management}
              integrations={integrations}
              routines={routines}
              collaboration={collaboration}
              bots={entries.map((entry) => entry.bot)}
              createMemoryPanel={createMemoryPanel}
              onOpenSession={onOpenSession}
              t={t}
            />
          )}
          {groups && tab === 'groups' && (
            <GroupsPanel
              key={creatingGroup ? 'create' : 'manage'}
              initialCreate={creatingGroup}
              actions={groups}
              bots={entries.map((entry) => entry.bot)}
              t={t}
              onOpenSession={onOpenSession}
            />
          )}
          {snapshot.error && (
            <div role="alert" className={styles.error}>
              <p>{t(unavailable ? 'errors.unavailable' : 'errors.load')}</p>
              {snapshot.error.code && <p>{snapshot.error.code}</p>}
              {snapshot.error.message && <p>{snapshot.error.message}</p>}
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  void onRefresh();
                }}
              >
                {t('actions.retry')}
              </button>
            </div>
          )}
          {!snapshot.loaded && snapshot.loading && (
            <p className={styles.loading} role="status">
              {t('bots.loading')}
            </p>
          )}
          {tab === 'bots' && snapshot.loaded && !snapshot.error && snapshot.entries.length === 0 && (
            <div className={styles.empty}>
              <h2>{t('bots.empty')}</h2>
              <p>{t('bots.emptyHint')}</p>
              <Button
                variant="primary"
                size="sm"
                className={styles.emptyAction}
                disabled={busy}
                onClick={() => open({ kind: 'create' })}
              >
                {t('bots.create')}
              </Button>
            </div>
          )}
          <BotsTab page={page} model={model} />
        </div>
      </div>
      <BotDialogs page={page} model={model} />
      {toast && (
        <div className={styles.toast} role={toast.error ? 'alert' : 'status'}>
          <span>{toast.text}</span>
          <button type="button" className={styles.button} onClick={() => setToast(undefined)}>
            {t('actions.dismiss')}
          </button>
        </div>
      )}
    </section>
  );
}
