import styles from '../styles/background-work.module.css';
import css from '../styles/background-work.module.css?inline';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { BotRecord } from '../../shared/schema.js';
import type { BackgroundActions, BackgroundTask } from '../background-work-state.js';
export type BackgroundKey = `background.${'title' | 'hint' | 'empty' | 'refresh' | 'open' | 'stop' | 'stopAll' | 'stopConfirm' | 'supplement' | 'queue' | 'steer' | 'input' | 'running' | 'inactive' | 'unknown' | 'error' | 'recovery' | 'runningOnly'}`;
export function BackgroundTasksPanel({ bot, actions, t }: {
  bot: BotRecord; actions: BackgroundActions; t: (key: BackgroundKey) => string;
}) {
  const source = useMemo(() => actions.forBot({ id: bot.id, createdAt: bot.createdAt }), [actions, bot.id, bot.createdAt]);
  const state = useSyncExternalStore(source.catalog.subscribe, source.catalog.getSnapshot);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<BackgroundTask>();
  const [text, setText] = useState('');
  const [delivery, setDelivery] = useState<'queue' | 'steer'>('queue');
  useEffect(() => { void source.catalog.refresh(); return () => source.dispose(); }, [source]);
  const perform = async (action: () => Promise<void>) => {
    setError(false); setBusy(true);
    try { await action(); } catch { setError(true); } finally { setBusy(false); }
  };
  return <section className={styles.panel} aria-label={t('background.title')}>
    <style>{css}</style>
    <h3>{t('background.title')}</h3>
    <p>{t('background.hint')}</p>
    {(state.error || state.tasks.some(task => task.running === undefined)) && <p>{t('background.recovery')}</p>}
    <button type="button" disabled={busy} onClick={() => { void perform(() => source.catalog.refresh()); }}>{t('background.refresh')}</button>
    <button type="button" disabled={busy || !state.tasks.some(task => task.running !== false && task.address.mode === 'continuable')}
      onClick={() => { if (window.confirm(t('background.stopConfirm'))) void perform(() => source.stopAll()); }}>{t('background.stopAll')}</button>
    {(error || state.error) && <p role="alert">{t('background.error')}</p>}
    {state.loaded && !state.tasks.length && <p>{t('background.empty')}</p>}
    <ul>{state.tasks.map(task => <li key={task.address.childSessionId}>
      <span>{task.label} · {t(task.running === true ? 'background.running' : task.running === false ? 'background.inactive' : 'background.unknown')}</span>{' '}
      <button type="button" disabled={busy} onClick={() => { void perform(() => source.open(task)); }}>{t('background.open')}</button>{' '}
      {task.address.mode === 'continuable' && <>
        <button type="button" disabled={busy || task.running !== true} onClick={() => { setSelected(task); setText(''); }}>{t('background.supplement')}</button>{' '}
        <button type="button" disabled={busy} onClick={() => { void perform(() => source.stop(task)); }}>{t('background.stop')}</button>
      </>}
      {task.running !== true && <small>{t('background.runningOnly')}</small>}
    </li>)}</ul>
    {selected && <form onSubmit={event => { event.preventDefault(); void perform(async () => {
      await source.supplement(selected, text, delivery); setSelected(undefined); setText('');
    }); }}>
      <label>{t('background.input')} · {selected.label}<textarea required value={text} onChange={event => setText(event.target.value)} /></label>
      <label><input type="radio" checked={delivery === 'queue'} onChange={() => setDelivery('queue')} />{t('background.queue')}</label>
      <label><input type="radio" checked={delivery === 'steer'} onChange={() => setDelivery('steer')} />{t('background.steer')}</label>
      <button type="submit" disabled={busy || !text.trim() || !state.tasks.some(task => task.address.childSessionId === selected.address.childSessionId && task.running === true)}>{t('background.supplement')}</button>
    </form>}
  </section>;
}
