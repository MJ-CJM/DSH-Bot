import { SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives';
import { ManagementHeader } from './ManagementHeader.js';
import { RetainedPanel } from './RetainedPanel.js';
import { useEffect, useId, useState, useContext } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotRecord } from '../../shared/schema.js';
import type { WorkspaceActions } from '../workspace-state.js';
import type { BotsPageInjected } from '../pages/BotsPage.js';
import { MemoryPanel } from './MemoryPanel.js';
import { TransferPanel } from './BotTransferPanel.js';
import { GraphPanel } from './ReferenceMemoryPanel.js';
import { SettingsBotContext, useSettingsBot } from './SettingsBotContext.js';
import styles from '../styles/integrations.module.css';
import css from '../styles/integrations.module.css?inline';
type Locale = PropsLocale<'dsh-bot'>;
export function ManagementPanel({
  bots,
  actions,
  createMemoryPanel,
  active = true,
  t,
}: {
  bots: BotRecord[];
  actions: WorkspaceActions;
  createMemoryPanel: BotsPageInjected['createMemoryPanel'];
  active?: boolean;
} & Locale) {
  const uid = useId();
  const embedded = Boolean(useContext(SettingsBotContext));
  const [tab, setTab] = useState<'records' | 'graph' | 'transfer'>('records');
  const { bot, select: setId } = useSettingsBot(bots);
  return (
    <section className={styles.panel} aria-label={t('manage.memoryTools')}>
      <style>{css}</style>
      <p>{t('shared.personalContextHint')}</p>
      <p>{t('shared.contextTiming')}</p>
      {!embedded && <ManagementHeader title={t('manage.memoryTools')} selector={{ bots, value: bot?.id ?? '', onChange: setId }} t={t} />}
      <SegmentedTabs label={t('manage.memoryTools')} value={tab} onChange={setTab} items={[{ value: 'records', id: `${uid}-records`, panelId: `${uid}-records-panel`, label: t('manage.records') }, { value: 'graph', id: `${uid}-graph`, panelId: `${uid}-graph-panel`, label: t('manage.graph') }, { value: 'transfer', id: `${uid}-transfer`, panelId: `${uid}-transfer-panel`, label: t('manage.transfer') }]} />
      <RetainedPanel id={`${uid}-transfer-panel`} labelledBy={`${uid}-transfer`} active={tab === 'transfer'}>
        <TransferPanel key={bot ? `${bot.id}:${bot.createdAt}` : 'none'} bot={bot} actions={actions} t={t} />
      </RetainedPanel>
      {bot && (
        <>
          <RetainedPanel id={`${uid}-graph-panel`} labelledBy={`${uid}-graph`} active={tab === 'graph'}>
            <GraphPanel key={`${bot.id}:${bot.createdAt}`} active={tab === 'graph'} bot={bot} actions={actions} t={t} />
          </RetainedPanel>
          <RetainedPanel id={`${uid}-records-panel`} labelledBy={`${uid}-records`} active={tab === 'records'}>
            <RecordsPanel key={`${bot.id}:${bot.createdAt}`} bot={bot} create={createMemoryPanel} active={active && tab === 'records'} t={t} />
          </RetainedPanel>
        </>
      )}
    </section>
  );
}
function RecordsPanel({ bot, create, active, t }: { bot: BotRecord; create: BotsPageInjected['createMemoryPanel']; active: boolean } & Locale) {
  const [panel, setPanel] = useState<ReturnType<typeof create>>();
  useEffect(() => {
    const value = create(bot.id);
    setPanel(value);
    return value.dispose;
  }, [bot.id, create]);
  return panel ? <MemoryPanel {...panel} bot={bot} t={t} active={active} /> : <p role="status">{t('memory.loading')}</p>;
}
