import { useEffect, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotRecord } from '../../shared/schema.js';
import type { WorkspaceActions } from '../workspace-state.js';
import type { BotsPageInjected } from '../pages/BotsPage.js';
import { MemoryPanel } from './MemoryPanel.js';
import { TransferPanel } from './BotTransferPanel.js';
import { GraphPanel } from './ReferenceMemoryPanel.js';
import { Statistics } from './WorkspaceStatistics.js';
import styles from '../styles/p34.module.css';
import css from '../styles/p34.module.css?inline';
type Locale = PropsLocale<'dsh-bot'>;
export function ManagementPanel({
  bots,
  actions,
  createMemoryPanel,
  t,
}: {
  bots: BotRecord[];
  actions: WorkspaceActions;
  createMemoryPanel: BotsPageInjected['createMemoryPanel'];
} & Locale) {
  const [id, setId] = useState(bots[0]?.id),
    [tab, setTab] = useState<'records' | 'graph' | 'transfer'>('records');
  const bot = bots.find((b) => b.id === id) ?? bots[0];
  return (
    <section className={styles.panel} aria-label={t('manage.title')}>
      <style>{css}</style>
      <h2>{t('manage.title')}</h2>
      <label>
        {t('p34.bot')}
        <select value={bot?.id ?? ''} onChange={(e) => setId(e.target.value)}>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.id})
            </option>
          ))}
        </select>
      </label>
      <div role="tablist" aria-label={t('manage.title')}>
        {(['records', 'graph', 'transfer'] as const).map((key) => (
          <button type="button" key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {t(`manage.${key}`)}
          </button>
        ))}
      </div>
      <Statistics actions={actions} t={t} />
      {tab === 'transfer' ? (
        <TransferPanel key={bot ? `${bot.id}:${bot.createdAt}` : 'none'} bot={bot} actions={actions} t={t} />
      ) : (
        bot &&
        (tab === 'graph' ? (
          <GraphPanel key={`${bot.id}:${bot.createdAt}`} bot={bot} actions={actions} t={t} />
        ) : (
          <RecordsPanel key={`${bot.id}:${bot.createdAt}`} bot={bot} create={createMemoryPanel} t={t} />
        ))
      )}
    </section>
  );
}
function RecordsPanel({ bot, create, t }: { bot: BotRecord; create: BotsPageInjected['createMemoryPanel'] } & Locale) {
  const [panel, setPanel] = useState<ReturnType<typeof create>>();
  useEffect(() => {
    const value = create(bot.id);
    setPanel(value);
    return value.dispose;
  }, [bot.id, create]);
  return panel ? <MemoryPanel {...panel} bot={bot} t={t} /> : <p role="status">{t('memory.loading')}</p>;
}
