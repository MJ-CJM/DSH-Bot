import { useEffect, useRef, useState } from 'react';
import type { ForgetChoice, ForgetPreview as Preview, ForgetSelection, CleanupStatus } from '../../shared/memory-forget.js';
import type { MemoryPanelProps } from './MemoryPanel.js';
import styles from '../styles/bots.module.css';

export interface ForgetActions {
  preview(selection: ForgetSelection): Promise<Preview>;
  choose(choice: ForgetChoice): Promise<CleanupStatus>;
  retry(id: string): Promise<unknown>;
}
export function ForgetPreview({ memoryId, actions, close, t }: {
  memoryId: string; actions: ForgetActions; close(): void; t: MemoryPanelProps['t'];
}) {
  const [mode, setMode] = useState<ForgetSelection['mode']>('version');
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const life = useRef(0), active = useRef(false);
  useEffect(() => { life.current++; return () => { life.current++; }; }, []);
  async function load() {
    if (active.current) return;
    active.current = true; setBusy(true); setFailed(false);
    const current = life.current;
    try {
      const result = await actions.preview({ memoryId, mode });
      if (current === life.current) setPreview(result);
    } catch { if (current === life.current) setFailed(true); }
    finally { if (current === life.current) { active.current = false; setBusy(false); } }
  }
  async function choose(choice: ForgetChoice['choice']) {
    if (!preview || active.current) return;
    active.current = true; setBusy(true); setFailed(false);
    const current = life.current;
    try {
      await actions.choose({ previewRevision: preview.previewRevision, choice });
      if (current === life.current) close();
    } catch { if (current === life.current) { setFailed(true); setPreview(undefined); } }
    finally { if (current === life.current) { active.current = false; setBusy(false); } }
  }
  return <fieldset className={styles.notice} aria-label={t('forget.title')}>
    <legend>{t('forget.title')}</legend>
    <label><input type="radio" checked={mode === 'version'} disabled={busy}
      onChange={() => { setMode('version'); setPreview(undefined); }} />{t('forget.version')}</label>
    <label><input type="radio" checked={mode === 'related'} disabled={busy}
      onChange={() => { setMode('related'); setPreview(undefined); }} />{t('forget.related')}</label>
    <p>{t('forget.previewNotice')}</p>
    {preview && <div>
      <p>{t('forget.counts', { versions: preview.versions, sessions: preview.sessionIds.length,
        history: preview.historyNodes, summaries: preview.summaries, copies: preview.copies, pending: preview.pendingMessages })}</p>
      {preview.conservative && <p>{t('forget.conservative')}</p>}
      {preview.rootInstructions && <p>{t('forget.rootBlocked')}</p>}
    </div>}
    {failed && <p className={styles.error} role="alert">{t('forget.changed')}</p>}
    <div className={styles.actions}>
      <button type="button" className={styles.button} disabled={busy} onClick={close}>{t('actions.cancel')}</button>
      <button type="button" className={styles.button} disabled={busy} onClick={() => { void load(); }}>{t('forget.preview')}</button>
      <button type="button" className={styles.button} disabled={busy || !preview}
        onClick={() => { void choose('stop'); }}>{t('forget.stop')}</button>
      <button type="button" className={styles.dangerButton} disabled={busy || !preview}
        onClick={() => { void choose('clean'); }}>{t('forget.clean')}</button>
    </div>
  </fieldset>;
}
