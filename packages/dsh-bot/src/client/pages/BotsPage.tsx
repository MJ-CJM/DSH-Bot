import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { Context } from '@deepseek-ai/cordis';
import { useEffect, useId, useRef, useState } from 'react';
import { botIdSchema } from '../../shared/ids.js';
import type { BotCreateInput, BotPatch, BotRecord } from '../../shared/schema.js';
import { BotCard } from '../components/BotCard.js';
import { BotEditor } from '../components/BotEditor.js';
import { Modal } from '../components/Modal.js';
import type { BotCatalog } from '../state.js';
import styles from '../styles/bots.module.css';
import css from '../styles/bots.module.css?inline';

export interface BotsPageInjected {
  hooks: { catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'>; workspaceCatalog: Context['workspaces']['list'] };
  onRefresh(): Promise<void>;
  onPollInterval(value: number): void;
  onCreate(input: BotCreateInput): Promise<void>;
  onUpdate(id: string, input: BotPatch): Promise<void>;
  onDuplicate(id: string, newId: string): Promise<void>;
  onDelete(id: string, deleteMemories: boolean): Promise<void>;
  onStart(id: string, workspaceId: string, signal?: AbortSignal): Promise<void>;
}
export type BotsPageProps = InjectFace<BotsPageInjected> & PropsLocale<'dsh-bot'>;
type Dialog = { kind: 'create' } | { kind: 'edit' | 'delete' | 'duplicate'; bot: BotRecord };

function detail(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  return typeof error === 'string' ? error : '';
}

export function BotsPage({ useCatalog, useWorkspaceCatalog, onRefresh, onPollInterval, onCreate, onUpdate, onDuplicate, onDelete, onStart, t }: BotsPageProps) {
  const snapshot = useCatalog((value) => value);
  const workspaces = useWorkspaceCatalog((value) => value);
  const [chosenWorkspace, setChosenWorkspace] = useState('');
  const workspaceId = chosenWorkspace || (workspaces.items.length === 1 ? workspaces.items[0]?.workspaceId ?? '' : '');
  const [deleteMemories, setDeleteMemories] = useState(true);
  const [dialog, setDialog] = useState<Dialog>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [toast, setToast] = useState<{ text: string; error: boolean }>();
  const [copyId, setCopyId] = useState('');
  const [copyInvalid, setCopyInvalid] = useState(false);
  const copyInput = useId();
  const lifetime = useRef<AbortController>();
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const alive = () => lifetime.current?.signal.aborted === false;

  async function perform(action: () => Promise<void>, errorKey: 'errors.save' | 'errors.delete' | 'errors.duplicate' | 'errors.start', successKey?: 'bots.saveSuccess' | 'delete.success' | 'delete.keptSuccess' | 'duplicate.success') {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setToast(undefined);
    try {
      await action();
      if (alive()) {
        if (successKey) setToast({ text: t(successKey), error: false });
        setDialog(undefined);
      }
    } catch (error: unknown) {
      if (alive()) setToast({ text: `${t(errorKey)} ${detail(error)}`.trim(), error: true });
      throw error;
    } finally {
      busyRef.current = false;
      if (alive()) setBusy(false);
    }
  }
  function save(input: BotCreateInput | BotPatch) {
    return perform(() => dialog?.kind === 'edit'
      ? onUpdate(dialog.bot.id, input as BotPatch)
      : onCreate(input as BotCreateInput), 'errors.save', 'bots.saveSuccess');
  }
  function open(next: Dialog) {
    setDialog(next);
    setToast(undefined);
    if (next.kind === 'delete') setDeleteMemories(true);
    if (next.kind === 'duplicate') {
      setCopyId(`${next.bot.id.slice(0, 27)}-copy`);
      setCopyInvalid(false);
    }
  }
  const unavailable = snapshot.error?.code === 'bot/unavailable'
    || snapshot.error?.code === 'gateway/service-unavailable';
  return (
    <section className={styles.page} aria-label={t('bots.title')}>
      <style data-dsh-bot-styles="">{css}</style>
      <header className={styles.header}>
        <div><h1 className={styles.title}>{t('bots.title')}</h1><p className={styles.subtitle}>{t('bots.subtitle')}</p></div>
        <div className={styles.actions}>
          <label className={styles.field}>{t('chat.workspace')}
            <select value={workspaceId} disabled={busy || workspaces.phase !== 'ready'} onChange={(event) => setChosenWorkspace(event.target.value)}>
              <option value="">{t('chat.workspaceChoose')}</option>
              {workspaces.items.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.title || item.path}</option>)}
            </select>
          </label>
          <label className={styles.field}>{t('bots.pollInterval')}
            <select value={snapshot.pollIntervalMs} onChange={(event) => onPollInterval(Number(event.target.value))}>
              {[...new Set([1000, 5000, 15000, 30000, 60000, snapshot.pollIntervalMs])].sort((a, b) => a - b)
                .map((ms) => <option key={ms} value={ms}>{t('bots.pollSeconds', { seconds: ms / 1000 })}</option>)}
            </select>
          </label>
          <button type="button" className={styles.button} disabled={busy} onClick={() => { void onRefresh(); }}>{t('bots.refresh')}</button>
          <button type="button" className={styles.primaryButton} disabled={busy || !snapshot.loaded || Boolean(snapshot.error)} onClick={() => open({ kind: 'create' })}>{t('bots.create')}</button>
        </div>
      </header>
      {snapshot.error && <div role="alert" className={styles.error}>
        <p>{t(unavailable ? 'errors.unavailable' : 'errors.load')}</p>
        {snapshot.error.code && <p>{snapshot.error.code}</p>}
        {snapshot.error.message && <p>{snapshot.error.message}</p>}
        <button type="button" className={styles.button} onClick={() => { void onRefresh(); }}>{t('actions.retry')}</button>
      </div>}
      {snapshot.loading && <p className={styles.loading} role="status">{t('bots.loading')}</p>}
      {snapshot.loaded && !snapshot.error && snapshot.entries.length === 0 && <div className={styles.empty}>
        <h2>{t('bots.empty')}</h2><p>{t('bots.emptyHint')}</p>
        <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => open({ kind: 'create' })}>{t('bots.create')}</button>
      </div>}
      <div className={styles.grid}>
        {snapshot.entries.map(({ bot, status }) => <BotCard key={bot.id} bot={bot} status={snapshot.error || snapshot.loading ? undefined : status}
          busy={busy}
          onStart={() => { void perform(() => onStart(bot.id, workspaceId, lifetime.current?.signal), 'errors.start').catch(() => {}); }}
          onEdit={() => open({ kind: 'edit', bot })} onDuplicate={() => open({ kind: 'duplicate', bot })}
          onDelete={() => open({ kind: 'delete', bot })} t={t} />)}
      </div>
      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && <BotEditor
        bot={dialog.kind === 'edit' ? dialog.bot : undefined} busy={busy} onSave={save} onCancel={() => setDialog(undefined)} t={t} />}
      {dialog?.kind === 'delete' && <Modal title={t('delete.title')} busy={busy} onClose={() => setDialog(undefined)} t={t}>
        <div className={styles.editorBody}>
          <p>{t('delete.description', { name: dialog.bot.name })}</p>
          <label className={styles.checkboxField}>
            <input type="checkbox" checked={deleteMemories} disabled={busy} onChange={(event) => setDeleteMemories(event.target.checked)} />
            {t('delete.memories')}
          </label>
          <p className={styles.warning}>{t(deleteMemories ? 'delete.memoriesWarning' : 'delete.keepMemories')}</p>
          <p className={styles.warning}>{t('delete.history')}</p>
        </div>
        <footer className={styles.dialogFooter}>
          <button type="button" className={styles.button} disabled={busy} onClick={() => setDialog(undefined)}>{t('actions.cancel')}</button>
          <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => {
            void perform(() => onDelete(dialog.bot.id, deleteMemories), 'errors.delete', deleteMemories ? 'delete.success' : 'delete.keptSuccess').catch(() => {});
          }}>{t('actions.delete')}</button>
        </footer>
      </Modal>}
      {dialog?.kind === 'duplicate' && <Modal title={t('duplicate.title')} busy={busy} onClose={() => setDialog(undefined)} t={t}>
        <form noValidate onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          const result = botIdSchema.safeParse(copyId);
          setCopyInvalid(!result.success);
          if (result.success) void perform(() => onDuplicate(dialog.bot.id, result.data), 'errors.duplicate', 'duplicate.success').catch(() => {});
        }}>
          <div className={styles.editorBody}>
            <p>{t('duplicate.description', { name: dialog.bot.name })}</p>
            <label className={styles.field} htmlFor={copyInput}>{t('duplicate.id')}
              <input id={copyInput} value={copyId} disabled={busy} aria-invalid={copyInvalid} aria-describedby={copyInvalid ? `${copyInput}-error` : undefined} onChange={(event) => setCopyId(event.target.value)} />
            </label>
            {copyInvalid && <p id={`${copyInput}-error`} role="alert" className={styles.error}>{t('validation.id')}</p>}
          </div>
          <footer className={styles.dialogFooter}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => setDialog(undefined)}>{t('actions.cancel')}</button>
            <button type="submit" className={styles.primaryButton} disabled={busy}>{t('duplicate.action')}</button>
          </footer>
        </form>
      </Modal>}
      {toast && <div className={styles.toast} role={toast.error ? 'alert' : 'status'}>
        <span>{toast.text}</span><button type="button" className={styles.button} onClick={() => setToast(undefined)}>{t('actions.dismiss')}</button>
      </div>}
    </section>
  );
}
