import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { type FormEvent, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { type BotRecord, type MemoryPatch, type MemoryRecord, memoryAddSchema } from '../../shared/schema.js';
import type { MemoryCatalog } from '../memory-state.js';
import styles from '../styles/bots.module.css';
import panel from '../styles/memory.module.css';
import css from '../styles/memory.module.css?inline';
import { MemoryList } from './MemoryList.js';
import { MemorySearchControls } from './MemorySearchControls.js';
import { BotAvatar } from './BotAvatar.js';
import { MemoryEditor, type Draft } from './MemoryEditor.js';

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
    return () => {
      lifetime.current++;
    };
  }, [catalog]);

  async function perform(
    action: () => unknown | Promise<unknown>,
    errorKey: 'memory.saveError' | 'memory.removeError' | 'memory.openError',
    successKey?: 'memory.saved' | 'memory.removed',
    done?: () => void,
  ) {
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
      if (current === lifetime.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  function edit(record?: MemoryRecord) {
    setNotice(undefined);
    setInvalid(false);
    setPendingDelete(undefined);
    setDraft({
      record,
      content: record?.content ?? '',
      kind: record?.kind ?? 'note',
      tags: record?.tags.join('\n') ?? '',
      pinned: record?.pinned ?? false,
    });
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busyRef.current) return;
    // Preserve unchanged tags exactly, including existing tags containing commas.
    const tags =
      draft.record && draft.tags === draft.record.tags.join('\n')
        ? draft.record.tags
        : [
            ...new Set(
              draft.tags
                .split(/[,，\n]/u)
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          ];
    const parsed = memoryAddSchema.safeParse({
      botId: bot.id,
      content: draft.content,
      kind: draft.kind,
      tags,
      pinned: draft.pinned,
    });
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const { content, kind, pinned } = parsed.data;
    const input: MemoryPanelInput = { content, kind, pinned, tags: parsed.data.tags };
    void perform(
      () => (draft.record ? onUpdate(draft.record.id, input) : onSave(input)),
      'memory.saveError',
      'memory.saved',
      () => setDraft(undefined),
    );
  }


  return (
    <section className={panel.panel} aria-label={t('memory.title')}>
      <style data-dsh-bot-memory-styles="">{css}</style>
      <div className={styles.actions}>
        <BotAvatar bot={bot} size={32} />
        <strong>{bot.name}</strong>
      </div>
      {!bot.memory.enabled && <p className={styles.notice}>{t('memory.disabled')}</p>}
      {bot.memory.enabled && bot.persona.complete && <p className={styles.notice}>{t('memory.complete')}</p>}
      <p className={styles.hint}>{t('memory.sessionNotice')}</p>
      {snapshot.quarantined !== undefined && snapshot.quarantined > 0 && (
        <p className={styles.notice} role="status">{t('memory.quarantined', { count: snapshot.quarantined })}</p>
      )}
      <MemorySearchControls search={search} busy={busy} t={t} onChange={setSearch}
        onSearch={() => {
          if (busyRef.current) return;
          setPendingDelete(undefined);
          catalog.setQuery(search);
        }} onRefresh={() => { void catalog.refresh(); }} />
      <div className={styles.actions}>
        {snapshot.total !== undefined && (
          <span className={styles.hint}>{t('memory.total', { count: snapshot.total })}</span>
        )}
        <button className={styles.primaryButton} type="button" disabled={busy || Boolean(draft)} onClick={() => edit()}>
          {t('memory.add')}
        </button>
      </div>
      {notice && (
        <p className={notice.error ? styles.error : styles.notice} role={notice.error ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}
      {draft && (
        <MemoryEditor draft={draft} busy={busy} invalid={invalid} uid={uid} t={t} setDraft={setDraft}
          onSubmit={save} onCancel={() => { setDraft(undefined); setInvalid(false); }} />
      )}
      {snapshot.error && (
        <div className={styles.error} role="alert">
          <p>{t('memory.loadError')}</p>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() => {
              void catalog.refresh();
            }}
          >
            {t('actions.retry')}
          </button>
        </div>
      )}
      {snapshot.loading && (
        <p className={styles.loading} role="status">
          {t('memory.loading')}
        </p>
      )}
      {snapshot.loaded && !snapshot.loading && !snapshot.error && snapshot.records.length === 0 && (
        <p className={styles.notice}>{t(snapshot.query ? 'memory.noMatches' : 'memory.empty')}</p>
      )}
      <MemoryList records={snapshot.records} busy={busy} draft={Boolean(draft)} pendingDelete={pendingDelete} t={t}
        onOpenSession={onOpenSession} onUpdate={onUpdate} onRemove={onRemove} edit={edit}
        setPendingDelete={setPendingDelete} setNotice={setNotice} perform={perform} />
      {(snapshot.before || snapshot.hasNext) && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            disabled={busy || snapshot.loading || !snapshot.before}
            onClick={() => {
              setPendingDelete(undefined);
              catalog.firstPage();
            }}
          >
            {t('memory.firstPage')}
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={busy || snapshot.loading || !snapshot.hasNext || Boolean(snapshot.error)}
            onClick={() => {
              setPendingDelete(undefined);
              catalog.nextPage();
            }}
          >
            {t('memory.nextPage')}
          </button>
          <span className={styles.hint}>{t('memory.pageNotice')}</span>
        </div>
      )}
    </section>
  );
}
