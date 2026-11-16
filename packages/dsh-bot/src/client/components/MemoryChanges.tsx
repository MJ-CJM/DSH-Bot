import { useEffect, useRef, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { MemoryChangesPage, MemoryRestore } from '../../shared/memory-management.js';
import styles from '../styles/bots.module.css';
import panel from '../styles/memory.module.css';

export interface MemoryChangesBinding {
  load(): Promise<MemoryChangesPage>;
  restore(input: Omit<MemoryRestore, 'botId'>): Promise<void>;
  openSession?(id: string): unknown | Promise<unknown>;
}

/** Loaded on demand. A failed restore is never automatically submitted again. */
export function MemoryChanges({ binding, t }: { binding: MemoryChangesBinding; t: PropsLocale<'dsh-bot'>['t'] }) {
  const [page, setPage] = useState<MemoryChangesPage>();
  const [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const alive = useRef(true), locked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async () => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(false);
    try { const next = await binding.load(); if (alive.current) setPage(next); }
    catch { if (alive.current) { setError(true); setPage(undefined); } }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  const restore = async (row: MemoryChangesPage['rows'][number]) => {
    if (!page || locked.current) return;
    locked.current = true; setBusy(true); setError(false);
    const expectedRevision = page.revision;
    // Clear stale controls before crossing the network, including an unknown result.
    setPage(undefined);
    try {
      await binding.restore({ id: row.version.memoryId, versionId: row.version.versionId, expectedRevision });
      const next = await binding.load(); if (alive.current) setPage(next);
    } catch { if (alive.current) setError(true); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  return <details data-memory-changes="" onToggle={event => {
    if (event.currentTarget.open && !page && !busy) void load();
  }}>
    <summary>{t('memory.changes.title')}</summary>
    <p className={styles.hint}>{t('memory.changes.notice')}</p>
    <button type="button" className={styles.button} disabled={busy} onClick={() => void load()}>{t('memory.changes.refresh')}</button>
    {error && <p role="alert" className={styles.error}>{t('memory.changes.error')}</p>}
    {page && !page.rows.length && <p>{t('memory.changes.empty')}</p>}
    {page && <ul>{page.rows.map(row => <li key={row.version.versionId} data-memory-change={row.version.versionId}>
      <p>{t(`memory.changes.source.${row.version.provenance.channel}`)} · <time dateTime={new Date(row.version.recordedAt).toISOString()}>
        {new Date(row.version.recordedAt).toLocaleString()}</time> · {t('memory.changes.revision', { revision: row.version.revision })}</p>
      <p>{t('memory.changes.bot', { id: row.version.provenance.bot.botId })}</p>
      {binding.openSession && [...new Set(row.version.sourceRefs.flatMap(ref => ref.sessionId ? [ref.sessionId] : []))].map(id =>
        <button key={id} type="button" className={styles.button} onClick={() => { void Promise.resolve(binding.openSession?.(id)).catch(() => setError(true)); }}>
          {t('memory.changes.openSource')}</button>)}
      <p>{t('memory.changes.fields', { fields: row.changed.map(field => t(`memory.changes.field.${field}`)).join(', ') })}</p>
      {row.previous && <section aria-label={t('memory.changes.before')}><h4>{t('memory.changes.before')}</h4>
        <pre className={panel.changePayload}>{JSON.stringify(row.previous, null, 2)}</pre></section>}
      <section aria-label={t('memory.changes.after')}><h4>{t('memory.changes.after')}</h4>
        <pre className={panel.changePayload}>{JSON.stringify(row.payload, null, 2)}</pre></section>
      {row.restorable && <button type="button" className={styles.button} disabled={busy} onClick={() => void restore(row)}>
        {t('memory.changes.restore')}</button>}
    </li>)}</ul>}
  </details>;
}
