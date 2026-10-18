import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { type FormEvent, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { type BotRecord, type MemoryPatch, type MemoryRecord, memoryAddSchema } from '../../shared/schema.js';
import type { MemoryCatalog } from '../memory-state.js';
import styles from '../styles/bots.module.css';
import panel from '../styles/memory.module.css';
import css from '../styles/memory.module.css?inline';

export type MemoryPanelInput = Pick<MemoryRecord, 'content' | 'kind' | 'tags' | 'pinned'>;
export interface MemoryPanelProps {
  bot: BotRecord;
  catalog: MemoryCatalog;
  onSave(input: MemoryPanelInput): unknown | Promise<unknown>;
  onUpdate(id: string, patch: Pick<MemoryPatch, 'content' | 'kind' | 'tags' | 'pinned'>): unknown | Promise<unknown>;
  onRemove(id: string): unknown | Promise<unknown>;
  onOpenSession(id: string): unknown | Promise<unknown>;
  t: PropsLocale<'dsh-bot'>['t'];
}

interface Draft { record?: MemoryRecord; content: string; kind: MemoryRecord['kind']; tags: string; pinned: boolean }
const kindKeys = {
  profile: 'memory.kindProfile', preference: 'memory.kindPreference', fact: 'memory.kindFact', note: 'memory.kindNote',
} as const;

/** The owning page binds each action to this Bot and refreshes the catalog after
 * mutations. No Context, Host service, portal or additional modal is needed here.
 */
export function MemoryPanel({ bot, catalog, onSave, onUpdate, onRemove, onOpenSession, t }: MemoryPanelProps) {
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot);
  const [search, setSearch] = useState(snapshot.query);
  const [draft, setDraft] = useState<Draft>();
  const [pendingDelete, setPendingDelete] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const busyRef = useRef(false);
  const lifetime = useRef(0);
  const uid = useId();

  useEffect(() => {
    lifetime.current++;
    busyRef.current = false;
    setBusy(false);
    setDraft(undefined);
    setPendingDelete(undefined);
    setNotice(undefined);
    setInvalid(false);
    setSearch(catalog.getSnapshot().query);
    return () => { lifetime.current++; };
  }, [catalog]);

  async function perform(action: () => unknown | Promise<unknown>, errorKey: 'memory.saveError' | 'memory.removeError' | 'memory.openError', successKey?: 'memory.saved' | 'memory.removed', done?: () => void) {
    if (busyRef.current) return;
    busyRef.current = true;
    const current = lifetime.current;
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      if (current !== lifetime.current) return;
      done?.();
      if (successKey) setNotice({ text: t(successKey), error: false });
    } catch (error: unknown) {
      if (current !== lifetime.current) return;
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      // Never echo a failed payload or Host diagnostic that may contain a secret.
      setNotice({ text: t(code === 'memory/rejected' ? 'memory.secretRejected' : errorKey), error: true });
    } finally {
      if (current === lifetime.current) { busyRef.current = false; setBusy(false); }
    }
  }

  function edit(record?: MemoryRecord) {
    setNotice(undefined);
    setInvalid(false);
    setPendingDelete(undefined);
    setDraft({ record, content: record?.content ?? '', kind: record?.kind ?? 'note', tags: record?.tags.join('\n') ?? '', pinned: record?.pinned ?? false });
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busyRef.current) return;
    // Preserve unchanged tags exactly, including existing tags containing commas.
    const tags = draft.record && draft.tags === draft.record.tags.join('\n') ? draft.record.tags
      : [...new Set(draft.tags.split(/[,，\n]/u).map((tag) => tag.trim()).filter(Boolean))];
    const parsed = memoryAddSchema.safeParse({ botId: bot.id, content: draft.content, kind: draft.kind, tags, pinned: draft.pinned });
    if (!parsed.success) { setInvalid(true); return; }
    setInvalid(false);
    const { content, kind, pinned } = parsed.data;
    const input: MemoryPanelInput = { content, kind, pinned, tags: parsed.data.tags };
    void perform(() => draft.record ? onUpdate(draft.record.id, input) : onSave(input), 'memory.saveError', 'memory.saved', () => setDraft(undefined));
  }
  function timestamp(value: number, label: 'memory.created' | 'memory.updated') {
    const date = new Date(value);
    const valid = Number.isFinite(date.getTime());
    return <time dateTime={valid ? date.toISOString() : undefined}>
      {t(label, { time: valid ? date.toLocaleString() : t('memory.timeUnavailable') })}
    </time>;
  }

  return <section className={panel.panel} aria-label={t('memory.title')}>
    <style data-dsh-bot-memory-styles="">{css}</style>
    {!bot.memory.enabled && <p className={styles.notice}>{t('memory.disabled')}</p>}
    {bot.memory.enabled && bot.persona.complete && <p className={styles.notice}>{t('memory.complete')}</p>}
    <p className={styles.hint}>{t('memory.sessionNotice')}</p>
    <form className={panel.search} onSubmit={(event) => {
      event.preventDefault();
      if (busyRef.current) return;
      setPendingDelete(undefined);
      catalog.setQuery(search);
    }}>
      <label className={styles.field}>{t('memory.search')}
        <input type="search" value={search} disabled={busy} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <button className={styles.button} type="submit" disabled={busy}>{t('memory.searchAction')}</button>
      <button className={styles.button} type="button" disabled={busy} onClick={() => { void catalog.refresh(); }}>{t('bots.refresh')}</button>
    </form>
    <div className={styles.actions}>
      {snapshot.total !== undefined && <span className={styles.hint}>{t('memory.total', { count: snapshot.total })}</span>}
      <button className={styles.primaryButton} type="button" disabled={busy || Boolean(draft)} onClick={() => edit()}>{t('memory.add')}</button>
    </div>
    {notice && <p className={notice.error ? styles.error : styles.notice} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    {draft && <form className={panel.form} aria-label={t(draft.record ? 'memory.edit' : 'memory.add')} onSubmit={save} noValidate>
      <h3>{t(draft.record ? 'memory.edit' : 'memory.add')}</h3>
      <label className={styles.field}>{t('memory.content')}
        <textarea rows={4} value={draft.content} disabled={busy} required aria-invalid={invalid}
          aria-describedby={invalid ? `${uid}-content-error` : undefined}
          onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
      </label>
      {invalid && <p id={`${uid}-content-error`} className={styles.error} role="alert">{t('memory.contentInvalid')}</p>}
      <div className={styles.formRow}>
        <label className={styles.field}>{t('memory.kind')}
          <select value={draft.kind} disabled={busy} onChange={(event) => setDraft({ ...draft, kind: event.target.value as MemoryRecord['kind'] })}>
            {Object.entries(kindKeys).map(([kind, key]) => <option key={kind} value={kind}>{t(key)}</option>)}
          </select>
        </label>
        <label className={styles.checkboxField}>
          <input type="checkbox" checked={draft.pinned} disabled={busy} onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })} />
          {t('memory.pinned')}
        </label>
      </div>
      <label className={styles.field}>{t('memory.tags')}
        <textarea rows={2} value={draft.tags} disabled={busy} aria-describedby={`${uid}-tags-hint`}
          onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
        <span className={styles.hint} id={`${uid}-tags-hint`}>{t('memory.tagsHint')}</span>
      </label>
      <div className={styles.actions}>
        <button type="button" className={styles.button} disabled={busy} onClick={() => { setDraft(undefined); setInvalid(false); }}>{t('actions.cancel')}</button>
        <button type="submit" className={styles.primaryButton} disabled={busy}>{t('memory.save')}</button>
      </div>
    </form>}
    {snapshot.error && <div className={styles.error} role="alert">
      <p>{t('memory.loadError')}</p>
      <button type="button" className={styles.button} disabled={busy} onClick={() => { void catalog.refresh(); }}>{t('actions.retry')}</button>
    </div>}
    {snapshot.loading && <p className={styles.loading} role="status">{t('memory.loading')}</p>}
    {snapshot.loaded && !snapshot.loading && !snapshot.error && snapshot.records.length === 0
      && <p className={styles.notice}>{t(snapshot.query ? 'memory.noMatches' : 'memory.empty')}</p>}
    <ul className={panel.list}>
      {snapshot.records.map((record) => <li key={record.id} className={panel.record}>
        <div className={panel.metadata}>
          <span>{t(kindKeys[record.kind])}</span>
          {record.pinned && <span>{t('memory.pinned')}</span>}
          <span>{t(record.source?.by === 'user' ? 'memory.sourceUser' : record.source?.by === 'model' ? 'memory.sourceModel' : 'memory.sourceUnknown')}</span>
        </div>
        <p className={panel.content}>{record.content}</p>
        {record.tags.length > 0 && <ul className={panel.tags} aria-label={t('memory.tags')}>
          {[...new Set(record.tags)].map((tag) => <li key={tag}>{tag}</li>)}
        </ul>}
        <div className={panel.metadata}>
          {timestamp(record.createdAt, 'memory.created')}
          {timestamp(record.updatedAt, 'memory.updated')}
        </div>
        <div className={styles.actions}>
          {record.source?.sessionId && <button type="button" className={styles.button} disabled={busy}
            title={record.source.sessionId} onClick={() => {
              const sessionId = record.source?.sessionId;
              if (sessionId) void perform(() => onOpenSession(sessionId), 'memory.openError');
            }}>{t('memory.sourceSession')}</button>}
          <button type="button" className={styles.button} disabled={busy || Boolean(draft)}
            onClick={() => { void perform(() => onUpdate(record.id, { pinned: !record.pinned }), 'memory.saveError', 'memory.saved'); }}>{t(record.pinned ? 'memory.unpin' : 'memory.pin')}</button>
          <button type="button" className={styles.button} disabled={busy || Boolean(draft)} onClick={() => edit(record)}>{t('card.edit')}</button>
          <button type="button" className={styles.dangerButton} disabled={busy || Boolean(draft)} onClick={() => { setPendingDelete(record.id); setNotice(undefined); }}>{t('actions.delete')}</button>
        </div>
        {pendingDelete === record.id && <fieldset className={panel.confirm}>
          <legend className={styles.warning}>{t('memory.deleteConfirm')}</legend>
          <div className={styles.actions}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => setPendingDelete(undefined)}>{t('actions.cancel')}</button>
            <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => {
              void perform(() => onRemove(record.id), 'memory.removeError', 'memory.removed', () => setPendingDelete(undefined));
            }}>{t('memory.deleteAction')}</button>
          </div>
        </fieldset>}
      </li>)}
    </ul>
    {(snapshot.before || snapshot.hasNext) && <div className={styles.actions}>
      <button type="button" className={styles.button} disabled={busy || snapshot.loading || !snapshot.before}
        onClick={() => { setPendingDelete(undefined); catalog.firstPage(); }}>{t('memory.firstPage')}</button>
      <button type="button" className={styles.button} disabled={busy || snapshot.loading || !snapshot.hasNext || Boolean(snapshot.error)}
        onClick={() => { setPendingDelete(undefined); catalog.nextPage(); }}>{t('memory.nextPage')}</button>
      <span className={styles.hint}>{t('memory.pageNotice')}</span>
    </div>}
  </section>;
}
