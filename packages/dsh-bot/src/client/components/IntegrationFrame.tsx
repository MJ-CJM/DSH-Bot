import { ManagementHeader } from './ManagementHeader.js';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotRecord } from '../../shared/schema.js';
import type { IntegrationActions } from '../integrations-state.js';
import css from '../styles/integrations.module.css?inline';
import styles from '../styles/integrations.module.css';
export interface IntegrationPanelProps extends PropsLocale<'dsh-bot'> {
  actions: IntegrationActions;
  bots: BotRecord[];
  onOpenSession(id: string): Promise<void>;
}
export function useIntegrationPanel(actions: IntegrationActions, bots: BotRecord[]) {
  const data = useSyncExternalStore(
    actions.catalog.subscribe,
    actions.catalog.getSnapshot,
    actions.catalog.getSnapshot,
  );
  const [ownerId, setOwnerId] = useState('');
  const bot = bots.find((b) => b.id === ownerId) ?? bots[0];
  const owner = bot && { botId: bot.id, botCreatedAt: bot.createdAt };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    void actions.catalog.refresh();
  }, [actions]);
  const perform = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await fn();
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return { data, bot, owner, setOwnerId, busy, error, setError, perform };
}
export function IntegrationFrame({
  state,
  actions,
  bots,
  title,
  children,
  onOwnerChange,
  t,
}: IntegrationPanelProps & {
  state: ReturnType<typeof useIntegrationPanel>;
  title: 'connectors' | 'notifications';
  children: import('react').ReactNode;
  onOwnerChange?(): void;
}) {
  return (
    <section
      className={styles.panel}
      aria-label={t(title === 'connectors' ? 'connectors.connectors' : 'notifications.notifications')}
    >
      <style>{css}</style>
      <ManagementHeader
        title={t(title === 'connectors' ? 'connectors.connectors' : 'notifications.notifications')}
        selector={{ bots, value: state.bot?.id ?? '', onChange: (id) => {
          state.setOwnerId(id);
          onOwnerChange?.();
        } }}
        actions={<button type="button" disabled={state.busy} onClick={() => { void actions.catalog.refresh(); }}>{t('bots.refresh')}</button>}
        t={t}
      />
      {state.data.error && <p role="alert">{t('integrations.loadFailed')}</p>}
      {state.error && <p role="alert">{t('integrations.operationFailed')}</p>}
      {children}
    </section>
  );
}
