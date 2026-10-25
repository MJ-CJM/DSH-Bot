import { GroupsPanel } from '../components/GroupsPanel.js';
import { ManagementWorkspace } from '../components/ManagementWorkspace.js';
import { Button, IconPlusOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
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
              <Button
                variant="ghost"
                size="sm"
                className={styles.iconButton}
                aria-label={t('bots.refresh')}
                title={t('bots.refresh')}
                disabled={busy || snapshot.loading}
                onClick={() => {
                  void onRefresh();
                }}
              >
                <IconRefreshOutlineRegular size={16} />
              </Button>
              <Button
                variant="primary"
                size="sm"
                className={styles.createButton}
                icon={<IconPlusOutlineRegular size={13} />}
                disabled={busy || !snapshot.loaded || Boolean(snapshot.error)}
                onClick={() => open({ kind: 'create' })}
              >
                {t('bots.create')}
              </Button>
            </div>
          </header>
          <div role="tablist" aria-label={t('bots.title')} className={styles.managementTabs}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'bots'}
              className={styles.button}
              onClick={() => setTab('bots')}
            >
              {t('bots.title')}
            </button>
            {groups && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'groups'}
                className={styles.button}
                onClick={() => setTab('groups')}
              >
                {t('groups.title')}
              </button>
            )}
            {(management || integrations || routines || collaboration) && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'management'}
                className={styles.button}
                onClick={() => setTab('management')}
              >
                {t('manage.title')}
              </button>
            )}
          </div>
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
          {snapshot.loaded && !snapshot.error && snapshot.entries.length === 0 && (
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
      {toast && !toast.inline && (
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
