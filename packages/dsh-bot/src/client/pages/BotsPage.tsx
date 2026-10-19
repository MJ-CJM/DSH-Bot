import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { Context } from '@deepseek-ai/cordis';
import { Button, IconPlusOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useId, useRef, useState } from 'react';
import { botIdSchema } from '../../shared/ids.js';
import type { BotCreateInput, BotPatch, BotRecord } from '../../shared/schema.js';
import { BotCard } from '../components/BotCard.js';
import { BotEditor } from '../components/BotEditor.js';
import { MemoryPanel, type MemoryPanelProps } from '../components/MemoryPanel.js';
import type { BotDetailSource } from '../detail-state.js';
import { Modal } from '../components/Modal.js';
import type { BotCatalog } from '../state.js';
import { useChatLauncher } from '../chat-launcher.js';
import styles from '../styles/bots.module.css';
import css from '../styles/bots.module.css?inline';

export interface BotsPageInjected {
  hooks: { catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'>; workspaceCatalog: Context['workspaces']['list']; botDetail: Pick<BotDetailSource, 'getSnapshot' | 'subscribe'> };
  onDetailConsumed(requestId: number): void;
  onCountMemories(id: string): Promise<number>;
  createMemoryPanel(id: string): Omit<MemoryPanelProps, 'bot' | 't'> & { dispose(): void };
  onRefresh(): Promise<void>;
  onPollInterval(value: number): void;
  onCreate(input: BotCreateInput): Promise<void>;
  onUpdate(id: string, input: BotPatch): Promise<void>;
  onDuplicate(id: string, newId: string): Promise<void>;
  onDelete(id: string, deleteMemories: boolean): Promise<void>;
  onStart(id: string, workspaceId: string, signal?: AbortSignal): Promise<void>;
  getPreferredWorkspace(): string;
}
export type BotsPageProps = InjectFace<BotsPageInjected> & PropsLocale<'dsh-bot'>;
type Dialog = { kind: 'create' } | { kind: 'edit' | 'delete' | 'duplicate'; bot: BotRecord };

function detail(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  return typeof error === 'string' ? error : '';
}

export function BotsPage({ useCatalog, useWorkspaceCatalog, useBotDetail, onDetailConsumed, onCountMemories, createMemoryPanel, onRefresh, onCreate, onUpdate, onDuplicate, onDelete, onStart, getPreferredWorkspace, t }: BotsPageProps) {
  const snapshot = useCatalog((value) => value);
  const requestedDetail = useBotDetail((value) => value);
  const workspaces = useWorkspaceCatalog((value) => value);
  const chat = useChatLauncher({ workspaces, onStart, getPreferredWorkspace, t });
  const pageElement = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 600);
  const [memoryCount, setMemoryCount] = useState<{ count?: number; failed?: boolean }>({});
  const [countAttempt, setCountAttempt] = useState(0);
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
    const page = pageElement.current;
    if (!page) return;
    const update = (width: number) => { if (width > 0) setCompact(width <= 600); };
    update(page.clientWidth || window.innerWidth);
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(([entry]) => { if (entry) update(entry.contentRect.width); });
      observer.observe(page);
      return () => observer.disconnect();
    }
    const onResize = () => update(page.clientWidth || window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!requestedDetail || !snapshot.loaded || snapshot.loading || snapshot.error) return;
    const found = snapshot.entries.find(({ bot }) => bot.id === requestedDetail.botId);
    if (found) { setDialog({ kind: 'edit', bot: found.bot }); setToast(undefined); }
    else setToast({ text: t('errors.detailMissing'), error: true });
    onDetailConsumed(requestedDetail.requestId);
  }, [requestedDetail, snapshot, onDetailConsumed, t]);
  const deleteId = dialog?.kind === 'delete' ? dialog.bot.id : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly starts a fresh count request for the same Bot.
  useEffect(() => {
    let current = true;
    setMemoryCount({});
    if (deleteId) void onCountMemories(deleteId).then(
      (count) => { if (current) setMemoryCount({ count }); },
      () => { if (current) setMemoryCount({ failed: true }); },
    );
    return () => { current = false; };
  }, [deleteId, onCountMemories, countAttempt]);
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
    <section ref={pageElement} className={`${styles.page} ${compact ? styles.compact : styles.wide}`} data-bots-page="" aria-label={t('bots.title')}>
      <style data-dsh-bot-styles="">{css}</style>
      <div className={styles.pageScroll}>
        <div className={styles.pageContent}>
          <header className={styles.header}>
            <div className={styles.heading}><h1 className={styles.title}>{t('bots.title')}</h1><p className={styles.subtitle}>{t('bots.subtitle')}</p></div>
            <div className={styles.actions}>
              <Button variant="ghost" size="sm" className={styles.iconButton} aria-label={t('bots.refresh')} title={t('bots.refresh')}
                disabled={busy || snapshot.loading} onClick={() => { void onRefresh(); }}><IconRefreshOutlineRegular size={16} /></Button>
              <Button variant="primary" size="sm" className={styles.createButton} icon={<IconPlusOutlineRegular size={13} />}
                disabled={busy || !snapshot.loaded || Boolean(snapshot.error)} onClick={() => open({ kind: 'create' })}>{t('bots.create')}</Button>
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
            <Button variant="primary" size="sm" className={styles.emptyAction} disabled={busy} onClick={() => open({ kind: 'create' })}>{t('bots.create')}</Button>
          </div>}
          <div className={styles.grid}>
            {snapshot.entries.map(({ bot, status }) => <BotCard key={bot.id} bot={bot} status={snapshot.error || snapshot.loading ? undefined : status}
              busy={busy}
              onStart={() => { void perform(() => chat.start(bot.id), 'errors.start').catch(() => {}); }}
              onEdit={() => open({ kind: 'edit', bot })} onDuplicate={() => open({ kind: 'duplicate', bot })}
              onDelete={() => open({ kind: 'delete', bot })} t={t} />)}
          </div>
        </div>
      </div>
      {chat.dialog}
      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && <BotEditor
        avatarWarning={dialog.kind === 'edit' && snapshot.entries.find(({ bot }) => bot.id === dialog.bot.id)?.status?.warnings?.includes('avatar/invalid')}
        key={dialog.kind === 'edit' ? dialog.bot.id : 'new'}
        memoryPanel={dialog.kind === 'edit' ? <MemoryTab
          bot={snapshot.entries.find(({ bot }) => bot.id === dialog.bot.id)?.bot ?? dialog.bot} create={createMemoryPanel} t={t} /> : undefined}
        bot={dialog.kind === 'edit' ? dialog.bot : undefined} busy={busy} onSave={save} onCancel={() => setDialog(undefined)} t={t} />}
      {dialog?.kind === 'delete' && <Modal title={t('delete.title')} busy={busy} onClose={() => setDialog(undefined)} t={t}>
        <div className={styles.editorBody}>
          <p>{t('delete.description', { name: dialog.bot.name })}</p>
          {memoryCount.count !== undefined ? <p>{t('delete.memoryCount', { count: memoryCount.count })}</p>
            : memoryCount.failed ? <div role="alert" className={styles.error}>
              <p>{t('delete.countError')}</p><button type="button" className={styles.button} onClick={() => setCountAttempt((value) => value + 1)}>{t('actions.retry')}</button>
            </div> : <p role="status">{t('delete.countLoading')}</p>}
          <label className={styles.checkboxField}>
            <input type="checkbox" checked={deleteMemories} disabled={busy} onChange={(event) => setDeleteMemories(event.target.checked)} />
            {t('delete.memories')}
          </label>
          <p className={styles.warning}>{t(deleteMemories ? 'delete.memoriesWarning' : 'delete.keepMemories')}</p>
          <p className={styles.warning}>{t('delete.history')}</p>
        </div>
        <footer className={styles.dialogFooter}>
          <button type="button" className={styles.button} disabled={busy} onClick={() => setDialog(undefined)}>{t('actions.cancel')}</button>
          <button type="button" className={styles.dangerButton} disabled={busy || memoryCount.count === undefined} onClick={() => {
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

/** Allocate owner-bound stores after mount; release them when switching tabs or Bots. */
function MemoryTab({ bot, create, t }: {
  bot: BotRecord; create: BotsPageInjected['createMemoryPanel']; t: PropsLocale<'dsh-bot'>['t'];
}) {
  const [panel, setPanel] = useState<ReturnType<BotsPageInjected['createMemoryPanel']>>();
  useEffect(() => {
    const value = create(bot.id);
    setPanel(value);
    return value.dispose;
  }, [bot.id, create]);
  return panel ? <MemoryPanel {...panel} bot={bot} t={t} /> : <p role="status">{t('memory.loading')}</p>;
}
