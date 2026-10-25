import css from '../styles/messages.module.css?inline';
import { useEffect, useRef, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { MessageRequest, MessageOverview } from '../../shared/messaging-contract.js';
import { BotAvatar } from './BotAvatar.js';
import styles from '../styles/messages.module.css';
export interface MessageActions {
  request(input: MessageRequest): Promise<MessageOverview>;
  subscribe(refresh: () => Promise<void>): () => void;
}
export function MessageOverviewPanel({ botId, actions, onOpen, t }: {
  botId: string; actions: MessageActions; onOpen(id: string): Promise<void>;
} & PropsLocale<'dsh-bot'>) {
  const [snapshot, setSnapshot] = useState<MessageOverview>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0), mutating = useRef(false);
  useEffect(() => {
    let active = true, running = false;
    epoch.current++; mutating.current = false; setBusy(false); setSnapshot(undefined);
    const refresh = async () => {
      if (running || mutating.current || document.visibilityState === 'hidden') return;
      running = true; const token = epoch.current;
      try { const value = await actions.request({ action: 'list', botId }); if (active && token === epoch.current) { setSnapshot(value); setError(false); } }
      catch { if (active && token === epoch.current) setError(true); }
      finally { running = false; }
    };
    void refresh();
    const off = actions.subscribe(refresh);
    return () => { active = false; epoch.current++; off(); };
  }, [botId, actions]);
  const mutate = async (input: MessageRequest) => {
    const token = ++epoch.current; mutating.current = true; setBusy(true);
    try { const value = await actions.request(input); if (token === epoch.current) { setSnapshot(value); setError(false); } }
    catch { if (token === epoch.current) setError(true); }
    finally { if (token === epoch.current) { mutating.current = false; setBusy(false); } }
  };
  return <section className={styles.card} aria-label={t('messages.title')}><style>{css}</style><h3>{t('messages.title')}</h3>
    <p>{t('messages.limited')}</p>
    {(error || snapshot?.enabled === false) && <p role="status">{t('messages.disabled')}</p>}
    <p>{t('messages.pending')}: {snapshot?.pending ?? 0}</p>
    {snapshot?.items.map((r) => {
      const sent = r.envelope.from.botId === botId, peer = sent ? r.envelope.to : r.envelope.from;
      const display = sent ? r.envelope.toDisplay : r.envelope.fromDisplay;
      return <div key={r.envelope.id} className={styles.body}>
        <BotAvatar bot={{ id: peer.botId, ...display }} size={24} /> {t(sent ? 'messages.to' : 'messages.from')} {display.name} ({peer.botId})
        <p>{t(`messages.${r.envelope.mode}`)} · {t(`messages.delivery.${r.delivery}`)} · {t(`messages.processing.${r.processing}`)} · {t(`messages.response.${r.response}`)}</p>
        <button type="button" onClick={() => void onOpen(sent ? r.envelope.toSessionId : r.envelope.fromSessionId)}>{t('messages.open')}</button>
        {(r.delivery === 'queued' || (r.delivery === 'delivered' && r.processing === 'pending')) &&
          <button type="button" disabled={busy} onClick={() => void mutate({ action: 'cancel', id: r.envelope.id, revision: r.revision })}>{t('messages.cancel')}</button>}
        {r.delivery === 'failed' && <button type="button" disabled={busy} onClick={() => void mutate({ action: 'retry', id: r.envelope.id, revision: r.revision })}>{t('messages.retry')}</button>}
      </div>;
    })}
  </section>;
}
