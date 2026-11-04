import { GroupsPanel } from '../components/GroupsPanel.js';
import { ManagementWorkspace } from '../components/ManagementWorkspace.js';
import { SettingsDrafts, useSettingsNavigation } from '../components/SettingsNavigation.js';
import { useState } from 'react';
import { RecentConversations } from './RecentConversations.js';
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import styles from '../styles/bots.module.css';
import identityCss from '../styles/identity.module.css?inline';
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
  const settings = useSettingsNavigation(t);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const text = (key: string) => t(key as Parameters<typeof t>[0]);
  const { snapshot, pageElement, compact, tab, setTab, section, busy, open, entries, unavailable, toast, setToast } = model;
  const selectedGroup = groups?.catalog.getSnapshot().groups.find(row => row.group.id === model.selectedGroup?.id && row.group.createdAt === model.selectedGroup.createdAt);
  const sectionLabel = section === 'bots' ? t('navigation.myBots') : section === 'groups' ? (selectedGroup?.group.name ?? t('groups.title')) : t('chat.recent');
  return (
    <section
      ref={pageElement}
      className={`${styles.page} ${compact ? styles.compact : styles.wide}`}
      data-bots-page=""
      aria-label={t('bots.title')}
    >
      <style data-dsh-bot-styles="">{css + identityCss}</style>
      <div className={styles.pageScroll} ref={model.scrollElement} onScroll={event => model.rememberScroll(event.currentTarget.scrollTop)}>
        <div className={styles.pageContent}>
          <header hidden={model.showDetail && tab !== 'management'} className={styles.header}>
            <div className={styles.heading}>
              <h1 className={styles.title}>{t(tab === 'management' ? 'chat.settings' : 'bots.title')}</h1>
              <p className={styles.subtitle}>{tab === 'management' ? t('navigation.settingsFrom', { name: sectionLabel }) : t('bots.subtitle')}</p>
            </div>
            <div className={styles.actions}>
              <button type="button" ref={model.settingsButton} className={styles.button} data-settings-navigation="" onClick={() => tab === 'management' ? settings.leave(model.returnFromSettings) : setTab('management')}>{tab === 'management' ? t('navigation.returnTo', { name: sectionLabel }) : text('chat.settings')}</button>
            </div>
          </header>
          <nav hidden={tab === 'management' || model.showDetail} className={styles.sectionNavigation} aria-label={t('navigation.sections')}>
            {(['bots', 'groups', 'recent'] as const).filter(key => key !== 'groups' || groups).map(key => <button
              type="button" key={key} className={styles.button} aria-current={tab !== 'management' && section === key ? 'page' : undefined}
              onClick={() => {
                const go = () => { setTab(key); setCreatingGroup(false); model.setShowDetail(false); };
                if (tab === 'management') settings.leave(go); else go();
              }}>
              {t(key === 'bots' ? 'navigation.myBots' : key === 'groups' ? 'groups.title' : 'chat.recent')}
            </button>)}
          </nav>
          {tab === 'management' && (
            <SettingsDrafts.Provider value={settings.registry}>
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
            </SettingsDrafts.Provider>
          )}
          <div hidden={tab === 'management' || model.showDetail}>
          {(section === 'bots' || section === 'recent') && <RecentConversations key={section} page={page} model={model} mode={section} />}
          {groups && section === 'groups' && (
            <GroupsPanel
              key={creatingGroup ? 'create' : 'manage'}
              initialCreate={creatingGroup}
              selectedGroup={model.selectedGroup}
              onSelectGroup={model.setSelectedGroup}
              onOpenBot={model.showBot}
              onCreateFinished={() => setCreatingGroup(false)}
              actions={groups}
              bots={entries.map((entry) => entry.bot)}
              workspaces={model.workspaces.items}
              onPickDirectory={page.onPickDirectory}
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
          {section === 'bots' && snapshot.loaded && !snapshot.error && snapshot.entries.length === 0 && (
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
          </div>
          {model.showDetail && <BotsTab key={`${model.selected?.bot.id}:${model.selected?.bot.createdAt}`} page={page} model={model} />}
        </div>
      </div>
      <BotDialogs page={page} model={model} />
      {settings.confirmation}
      {toast && !toast.error && <Toast key={toast.text} text={toast.text} tone="success" onDone={() => setToast(undefined)} />}
      {toast?.error && (
        <div className={styles.error} role={toast.error ? 'alert' : 'status'}>
          <span>{toast.text}</span>
          <button type="button" className={styles.button} onClick={() => setToast(undefined)}>
            {t('actions.dismiss')}
          </button>
        </div>
      )}
    </section>
  );
}
