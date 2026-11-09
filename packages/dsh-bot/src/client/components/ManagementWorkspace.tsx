import { RetainedPanel } from './RetainedPanel.js';
import { useId, useState, useSyncExternalStore } from 'react';
import { SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives';
import { SettingsBotContext, useBotSelection } from './SettingsBotContext.js';
import { ManagementHeader } from './ManagementHeader.js';
import { Statistics } from './WorkspaceStatistics.js';
import css from '../styles/settings.module.css?inline';
import settingsStyles from '../styles/settings.module.css';
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
function NotificationLabel({ actions, t }: { actions: IntegrationActions } & PropsLocale<'dsh-bot'>) {
  const snapshot = useSyncExternalStore(actions.catalog.subscribe, actions.catalog.getSnapshot, actions.catalog.getSnapshot);
  return <>{t('notifications.notifications')}{snapshot.unread > 0 && <span role="status" aria-label={t('notifications.unread')}><WhaleGlyph size={14} />{snapshot.unread}</span>}</>;
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
  const selection = useBotSelection(bots);
  const uid = useId();
  const identity = selection.bot ? `${selection.bot.id}:${selection.bot.createdAt}` : 'none';
  const [tab, setTab] = useState<Tab>(
    integrations ? 'connectors' : management ? 'records' : routines ? 'routines' : 'collaboration',
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
    ...(routines || management ? (['routines'] as const) : []),
    ...(collaboration ? (['collaboration', 'im'] as const) : []),
  ];
  if (!tabs.length) return <p>{t('native.unavailable')}</p>;
  return (
    <SettingsBotContext.Provider value={selection}>
    <section aria-label={t('manage.navigation')} className={settingsStyles.workspace}>
      <style>{css}</style>
      <ManagementHeader title={t('settings.botContext')} contextSelector
        selector={{ bots, value: selection.bot?.id ?? '', onChange: selection.select }} t={t} />
      {!selection.bot && <p role="status">{t(bots.length ? 'settings.botUnavailable' : 'settings.noBots')}</p>}
      <div className={settingsStyles.tabStrip}>
        <SegmentedTabs label={t('manage.navigation')} value={tab} onChange={setTab}
          items={tabs.map(key => ({ value: key, id: `${uid}-${key}`, panelId: `${uid}-${key}-panel`,
            label: key === 'notifications' && integrations ? <NotificationLabel actions={integrations} t={t} /> : t(labels[key]),
          })) as [import('@deepseek-ai/dsh-client-ui-primitives').SegmentedTab<Tab>, ...import('@deepseek-ai/dsh-client-ui-primitives').SegmentedTab<Tab>[]]} />
      </div>
      <div key={identity} data-settings-bot={identity}>
      {management && (
        <RetainedPanel active={tab === 'records'} id={`${uid}-records-panel`} labelledBy={`${uid}-records`}>
          <ManagementPanel bots={bots} actions={management} createMemoryPanel={createMemoryPanel} active={tab === 'records'} t={t} />
        </RetainedPanel>
      )}
      {integrations && (
        <>
          <RetainedPanel active={tab === 'connectors'} id={`${uid}-connectors-panel`} labelledBy={`${uid}-connectors`}>
            <ConnectorsPanel
              actions={integrations}
              active={tab === 'connectors'}
              bots={bots}
              onOpenSession={onOpenSession}
              t={t}
            />
          </RetainedPanel>
          <RetainedPanel active={tab === 'notifications'} id={`${uid}-notifications-panel`} labelledBy={`${uid}-notifications`}>
            <NotificationsPanel actions={integrations} bots={bots} onOpenSession={onOpenSession} t={t} />
          </RetainedPanel>
        </>
      )}
      {(routines || management) && (
        <RetainedPanel active={tab === 'routines'} id={`${uid}-routines-panel`} labelledBy={`${uid}-routines`}>
          <p>{t('settings.allBots')}</p>
          {routines && <RoutinePanel actions={routines} bots={bots} onOpenSession={onOpenSession} t={t} />}
          {management && <Statistics actions={management} t={t} />}
        </RetainedPanel>
      )}
      {collaboration && (
        <>
          <RetainedPanel active={tab === 'collaboration'} id={`${uid}-collaboration-panel`} labelledBy={`${uid}-collaboration`}>
            <CollaborationPanel actions={collaboration} bots={bots} onOpenSession={onOpenSession} t={t} />
          </RetainedPanel>
          <RetainedPanel active={tab === 'im'} id={`${uid}-im-panel`} labelledBy={`${uid}-im`}>
            <p>{t('settings.globalScope')}</p>
            <ImPanel actions={collaboration} t={t} />
          </RetainedPanel>
        </>
      )}
      </div>
    </section>
    </SettingsBotContext.Provider>
  );
}
