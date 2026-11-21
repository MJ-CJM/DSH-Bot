import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { consolidationViewSchema, ConsolidationDecision, ConsolidationInput } from '../../shared/memory-consolidation.js';
import type { ManagedMemoryPage } from '../../shared/memory-management.js';
import type { SharedMemoryBinding } from './SharedMemoryPanel.js';
import type { MemoryPanelProps } from './MemoryPanel.js';
import styles from '../styles/bots.module.css';

export function MemoryConsolidation({ binding, botId, defaultRoute, t }: { binding: SharedMemoryBinding; botId: string; defaultRoute?: { provider: string; model: string }; t: MemoryPanelProps['t'] }) {
  const [view, setView] = useState<z.output<typeof consolidationViewSchema>>(), [sources, setSources] = useState<ManagedMemoryPage>();
  const [selected, setSelected] = useState<string[]>([]), [provider, setProvider] = useState(defaultRoute?.provider ?? ''), [model, setModel] = useState(defaultRoute?.model ?? '');
  const [routeEdited, setRouteEdited] = useState(false);
  useEffect(() => { if (!routeEdited) { setProvider(defaultRoute?.provider ?? ''); setModel(defaultRoute?.model ?? ''); } }, [defaultRoute?.provider, defaultRoute?.model, routeEdited]);
  const [edits, setEdits] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState<'changed' | 'limit' | 'unknown' | 'load'>();
  const pending = useRef<ConsolidationInput | ConsolidationDecision>(), alive = useRef(true), locked = useRef(false);
  const routeFields = <><label>{t('memory.consolidation.provider')}<input value={provider} onChange={e => { setRouteEdited(true); setProvider(e.target.value); }} /></label>
    <label>{t('memory.consolidation.model')}<input value={model} onChange={e => { setRouteEdited(true); setModel(e.target.value); }} /></label></>;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async () => {
    const [status, rows] = await Promise.all([binding.remote().consolidationStatus(botId),
      binding.remote().query({ botId, scope: 'private', view: 'facts', limit: 50 })]);
    if (!status.ok || !rows.ok) throw new Error('Unavailable');
    if (alive.current) {
      setView(status.value); setSources(rows.value);
      const available = new Set(rows.value.rows.map(row => row.version.versionId));
      setSelected(previous => previous.filter(id => available.has(id)));
    }
  };
  const run = async (input?: ConsolidationInput | ConsolidationDecision) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(undefined);
    try {
      if (input) {
        pending.current = input;
        const reply = 'runId' in input ? await binding.remote().decideConsolidation(input) : await binding.remote().consolidate(input);
        if (!reply.ok) {
          const code = reply.error.code;
          if (code !== 'bot/conflict' && code !== 'memory/consolidation-limit') throw reply.error;
          // The Host rejected the old revision before dispatch or commit.
          pending.current = undefined;
          if (alive.current) setView(undefined);
          await load();
          if (alive.current) setError(code === 'bot/conflict' ? 'changed' : 'limit');
          return;
        }
        pending.current = undefined; await binding.refresh();
      }
      await load();
    } catch { if (alive.current) setError(pending.current ? 'unknown' : 'load'); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  return <details data-memory-consolidation="" onToggle={e => { if (e.currentTarget.open && !view && !busy) void run(); }}>
    <summary>{t('memory.consolidation.title')}</summary>
    <p className={styles.hint}>{t('memory.consolidation.notice')}</p>
    {view && !view.enabled && <p>{t('memory.consolidation.disabled')}</p>}
    <button type="button" className={styles.button} disabled={busy} onClick={() => void run()}>{t('memory.changes.refresh')}</button>
    {view?.enabled && <fieldset disabled={busy || !!pending.current}>
      <legend>{t('memory.consolidation.sources')}</legend>
      {sources?.rows.map(row => <label key={row.version.versionId}><input type="checkbox" checked={selected.includes(row.version.versionId)}
        disabled={!selected.includes(row.version.versionId) && selected.length >= 8}
        onChange={e => setSelected(e.target.checked ? [...selected, row.version.versionId] : selected.filter(id => id !== row.version.versionId))} />{row.payload.content}</label>)}
      {defaultRoute ? <><p>{t('memory.consolidation.botModel')}: {provider} / {model}</p><details><summary>{t('chat.advanced')}</summary>{routeFields}</details></> : routeFields}
      <button type="button" className={styles.button} disabled={!selected.length || !provider.trim() || !model.trim()} onClick={() => void run({ operationId: crypto.randomUUID(), botId,
        expectedRevision: view.revision, sourceIds: selected, provider: provider.trim(), model: model.trim() })}>{t('memory.consolidation.generate')}</button>
    </fieldset>}
    {view?.runs.map(row => <section key={row.id} data-consolidation-state={row.state}>
      <p>{row.closedUnknown ? t('memory.consolidation.closedUnknown') : t(`memory.consolidation.state.${row.state}`)}</p>
      {row.unresolved && <><p>{t('memory.consolidation.unknownNotice')}</p>
        <code>{row.id}</code><p>{t('memory.consolidation.provider')}: {row.provider} / {row.model} · {row.modelRequests}</p>
        <button type="button" className={styles.button} disabled={busy || !!pending.current} onClick={() => void run({ operationId: crypto.randomUUID(), runId: row.id,
          botId, expectedRevision: view.revision, action: 'close' })}>{t('memory.consolidation.closeUnknown')}</button></>}
      {row.content && <><p>{t('memory.consolidation.candidateNotice')}</p>
        <textarea aria-label={t('memory.consolidation.candidate')} value={edits[row.id] ?? row.content} maxLength={2048}
          disabled={busy || !!pending.current} onChange={e => setEdits({ ...edits, [row.id]: e.target.value })} />
        <p>{t('memory.consolidation.expires')}: {new Date(row.expiresAt).toLocaleString()}</p>
        <details><summary>{t('memory.consolidation.sources')}</summary>{row.sourceIds.map(id => <p key={id}>
          {sources?.rows.find(s => s.version.versionId === id)?.payload.content ?? t('memory.consolidation.sourceChanged')}</p>)}</details>
        {(['accept', 'reject'] as const).map(action => <button type="button" key={action} className={styles.button} disabled={busy || !!pending.current}
          onClick={() => void run({ operationId: crypto.randomUUID(), runId: row.id, botId, expectedRevision: view.revision, action,
            ...(action === 'accept' && edits[row.id] !== undefined ? { editedContent: edits[row.id] } : {}) })}>{t(`memory.consolidation.${action}`)}</button>)}</>}
    </section>)}
    {error && <p role="alert">{t(error === 'changed' ? 'memory.consolidation.changed' : error === 'limit' ? 'memory.consolidation.limit' : error === 'load' ? 'memory.loadError' : 'memory.consolidation.error')}</p>}
    {pending.current && <button type="button" className={styles.button} disabled={busy} onClick={() => void run(pending.current)}>{t('memory.consolidation.reconcile')}</button>}
  </details>;
}
