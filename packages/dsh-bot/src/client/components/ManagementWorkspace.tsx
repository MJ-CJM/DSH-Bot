import { RetainedPanel } from './RetainedPanel.js';
import { useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotRecord } from '../../shared/schema.js';
import type { BotsPageInjected } from '../pages/BotsPage.js';
import type { IntegrationActions } from '../integrations-state.js';
import { ManagementPanel } from './ManagementPanel.js';
import { ConnectorsPanel } from './ConnectorsPanel.js';
import { NotificationsPanel } from './NotificationsPanel.js';
import { CollaborationPanel, ImPanel } from './CollaborationPanel.js';
import { RoutinePanel } from './RoutinePanel.js';
import { WhaleGlyph } from './WhaleGlyph.js';
import styles from '../styles/bots.module.css';
function NotificationTab({
  actions,
  selected,
  onSelect,
  t,
}: { actions: IntegrationActions; selected: boolean; onSelect(): void } & PropsLocale<'dsh-bot'>) {
  const snapshot = useSyncExternalStore(
    actions.catalog.subscribe,
    actions.catalog.getSnapshot,
    actions.catalog.getSnapshot,
  );
  return (
    <button type="button" role="tab" aria-selected={selected} className={styles.button} onClick={onSelect}>
      {t('notifications.notifications')}
      {snapshot.unread > 0 && (
        <span role="status" aria-label={t('notifications.unread')}>
          <WhaleGlyph size={14} />
          {snapshot.unread}
        </span>
      )}
    </button>
  );
}

type Tab = 'records' | 'connectors' | 'notifications' | 'routines' | 'collaboration' | 'im';
export function ManagementWorkspace({
  management,
  integrations,
  routines,
  collaboration,
  bots,
  createMemoryPanel,
  onOpenSession,
  t,
}: Pick<
  BotsPageInjected,
  'management' | 'integrations' | 'routines' | 'collaboration' | 'createMemoryPanel' | 'onOpenSession'
> & { bots: BotRecord[] } & PropsLocale<'dsh-bot'>) {
  const [tab, setTab] = useState<Tab>(
    management ? 'records' : integrations ? 'connectors' : routines ? 'routines' : 'collaboration',
  );
  const labels = {
    records: 'manage.memoryTools',
    connectors: 'connectors.connectors',
    notifications: 'notifications.notifications',
    routines: 'routine.title',
    collaboration: 'team.title',
    im: 'im.title',
  } as const;
  const tabs: Tab[] = [
    ...(management ? (['records'] as const) : []),
    ...(integrations ? (['connectors', 'notifications'] as const) : []),
    ...(routines ? (['routines'] as const) : []),
    ...(collaboration ? (['collaboration', 'im'] as const) : []),
  ];
  return (
    <section aria-label={t('manage.navigation')}>
      <div role="tablist" aria-label={t('manage.navigation')} className={styles.managementTabs}>
        {tabs.map((key) =>
          key === 'notifications' && integrations ? (
            <NotificationTab
              key={key}
              actions={integrations}
              selected={tab === key}
              onSelect={() => setTab(key)}
              t={t}
            />
          ) : (
            <button type="button" role="tab" key={key} aria-selected={tab === key} onClick={() => setTab(key)}>
              {t(labels[key])}
            </button>
          ),
        )}
      </div>
      {management && (
        <RetainedPanel active={tab === 'records'}>
          <ManagementPanel bots={bots} actions={management} createMemoryPanel={createMemoryPanel} t={t} />
        </RetainedPanel>
      )}
      {integrations && (
        <>
          <RetainedPanel active={tab === 'connectors'}>
            <ConnectorsPanel
              actions={integrations}
              active={tab === 'connectors'}
              bots={bots}
              onOpenSession={onOpenSession}
              t={t}
            />
          </RetainedPanel>
          <RetainedPanel active={tab === 'notifications'}>
            <NotificationsPanel actions={integrations} bots={bots} onOpenSession={onOpenSession} t={t} />
          </RetainedPanel>
        </>
      )}
      {routines && (
        <RetainedPanel active={tab === 'routines'}>
          <RoutinePanel actions={routines} bots={bots} onOpenSession={onOpenSession} t={t} />
        </RetainedPanel>
      )}
      {collaboration && (
        <>
          <RetainedPanel active={tab === 'collaboration'}>
            <CollaborationPanel actions={collaboration} bots={bots} onOpenSession={onOpenSession} t={t} />
          </RetainedPanel>
          <RetainedPanel active={tab === 'im'}>
            <ImPanel actions={collaboration} t={t} />
          </RetainedPanel>
        </>
      )}
    </section>
  );
}
