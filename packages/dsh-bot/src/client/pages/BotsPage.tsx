import { GroupsPanel } from '../components/GroupsPanel.js';
import type { GroupActions } from '../groups-state.js';
import { CollaborationPanel, ImPanel } from '../components/CollaborationPanel.js';
import type { CollaborationActions } from '../collaboration-state.js';
import { WhaleGlyph } from '../components/WhaleGlyph.js';
import { P34Panel } from '../components/P34Panel.js';
import type { P34Actions } from '../p34-state.js';
import type { RoutineActions } from '../automation-state.js';
import { RoutinePanel } from '../components/RoutinePanel.js';
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { Context } from '@deepseek-ai/cordis';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import { Button, IconEllipsisOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { botIdSchema } from '../../shared/ids.js';
import type { BotCreateInput, BotPatch, BotRecord } from '../../shared/schema.js';
import { BotAvatar } from '../components/BotAvatar.js';
import { BotList } from '../components/BotList.js';
import type { ActivityCatalog } from '../activity-state.js';
import { botSessionRows, previewText, relativeTime, sortBotEntries } from '../activity-view.js';
import { BotEditor } from '../components/BotEditor.js';
import { MemoryPanel, type MemoryPanelProps } from '../components/MemoryPanel.js';
import type { BotDetailSource } from '../detail-state.js';
import { Modal } from '../components/Modal.js';
import type { BotCatalog } from '../state.js';
import type { ChatLauncherActions } from '../chat-launcher.js';
import styles from '../styles/bots.module.css';
import css from '../styles/bots.module.css?inline';

export interface BotsPageInjected extends ChatLauncherActions {
  groups?: GroupActions;
  routines?: RoutineActions;
  p34?: P34Actions;
  collaboration?: CollaborationActions;
  hooks: {
    catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'>;
    activity: Pick<ActivityCatalog, 'getSnapshot' | 'subscribe'>;
    workspaceCatalog: Context['workspaces']['list'];
    sessionCatalog: ObservableSnapshot<SessionListState>;
    botDetail: Pick<BotDetailSource, 'getSnapshot' | 'subscribe'>;
  };
  onOpenSession(id: string, signal?: AbortSignal): Promise<void>;
  onDetailConsumed(requestId: number): void;
  onCountMemories(id: string): Promise<number>;
  createMemoryPanel(id: string): Omit<MemoryPanelProps, 'bot' | 't'> & { dispose(): void };
  onRefresh(): Promise<void>;
  onPollInterval(value: number): void;
  onCreate(input: BotCreateInput): Promise<void>;
  onUpdate(id: string, input: BotPatch): Promise<void>;
  onDuplicate(id: string, newId: string): Promise<void>;
  onDelete(id: string, deleteMemories: boolean, deleteHome: boolean): Promise<void>;
  onEnsureHome(id: string): Promise<string>;
  onEnsureBotsWorkspace(): Promise<string>;
  onPickDirectory?: () => Promise<string | null>;
}
export type BotsPageProps = InjectFace<BotsPageInjected> & PropsLocale<'dsh-bot'>;
type Dialog = { kind: 'create' } | { kind: 'edit' | 'delete' | 'duplicate' | 'memory'; bot: BotRecord };

function NotificationTab({ actions, selected, onSelect, t }: { actions: P34Actions; selected: boolean; onSelect(): void } & PropsLocale<'dsh-bot'>) {
  const snapshot = useSyncExternalStore(actions.catalog.subscribe, actions.catalog.getSnapshot, actions.catalog.getSnapshot);
  return <button type="button" role="tab" aria-selected={selected} className={styles.button} onClick={onSelect}>{t('p34.notifications')}{snapshot.unread > 0 && <span role="status" aria-label={t('p34.unread')}><WhaleGlyph size={14} />{snapshot.unread}</span>}</button>;
}

function detail(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  return typeof error === 'string' ? error : '';
}

export function BotsPage({ groups, routines, p34, collaboration, useCatalog, useActivity, useSessionCatalog, useWorkspaceCatalog, useBotDetail, onOpenSession, onDetailConsumed, onCountMemories, createMemoryPanel, onRefresh, onCreate, onUpdate, onDuplicate, onDelete, onStart, onEnsureHome, onEnsureBotsWorkspace, onPickDirectory, t }: BotsPageProps) {
  const snapshot = useCatalog((value) => value);
  const activity = useActivity((value) => value);
  const sessions = useSessionCatalog((value) => value);
  const requestedDetail = useBotDetail((value) => value);
  const workspaces = useWorkspaceCatalog((value) => value);
  const pageElement = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.innerWidth < 760);
  const [tab, setTab] = useState<'bots' | 'routines' | 'connectors' | 'notifications' | 'collaboration' | 'im' | 'groups'>('bots');
  useEffect(() => {
    if (!groups) return;
    const update = () => { if (groups.selection.getSnapshot().selectedId) setTab('groups'); };
    update(); return groups.selection.observe(update);
  }, [groups]);
  const [selectedId, setSelectedId] = useState<string>();
  const [showDetail, setShowDetail] = useState(false);
  const [more, setMore] = useState(false);
  const listElement = useRef<HTMLDivElement>(null);
  const backElement = useRef<HTMLButtonElement>(null);
  const focusListOnReturn = useRef(false);
  const listId = useId();
  const locale = t('activity.locale');
  const entries = sortBotEntries(snapshot.entries, activity.bots, locale);
  const selected = entries.find(({ bot }) => bot.id === selectedId) ?? entries[0];
  const rows = selected ? botSessionRows(selected.bot.id, snapshot.entries, sessions, activity.sessions, workspaces.archivedSessionIds, workspaces.items) : [];
  const ready = !snapshot.error && !snapshot.loading && selected?.status?.preset.state === 'ok';
  const [memoryCount, setMemoryCount] = useState<{ count?: number; failed?: boolean }>({});
  const [countAttempt, setCountAttempt] = useState(0);
  const [deleteMemories, setDeleteMemories] = useState(true);
  const [deleteHome, setDeleteHome] = useState(false);
  const [dialog, setDialog] = useState<Dialog>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const navigation = useRef<AbortController>();
  const [navigating, setNavigating] = useState(false);
  const cancelNavigation = useCallback(() => {
    navigation.current?.abort();
    navigation.current = undefined;
    setNavigating(false);
  }, []);
  const [toast, setToast] = useState<{ text: string; error: boolean; inline?: boolean }>();
  const [copyId, setCopyId] = useState('');
  const [copyInvalid, setCopyInvalid] = useState(false);
  const copyInput = useId();
  const lifetime = useRef<AbortController>();
  useEffect(() => {
    // Lock the first complete ordering, then retain that Bot across activity polls.
    if (!snapshot.loaded || (!activity.loaded && !activity.error)) return;
    if (!entries.some(({ bot }) => bot.id === selectedId)) setSelectedId(entries[0]?.bot.id);
  }, [snapshot.loaded, activity.loaded, activity.error, entries, selectedId]);
  useEffect(() => {
    if (!compact || dialog) return;
    if (showDetail) backElement.current?.focus();
    else if (focusListOnReturn.current) { listElement.current?.focus(); focusListOnReturn.current = false; }
  }, [compact, showDetail, dialog]);
  useEffect(() => {
    const page = pageElement.current;
    if (!page) return;
    const update = (width: number) => { if (width > 0) setCompact(width < 760); };
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
    return () => { controller.abort(); navigation.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!requestedDetail || !snapshot.loaded || snapshot.loading || snapshot.error) return;
    const found = snapshot.entries.find(({ bot }) => bot.id === requestedDetail.botId);
    if (found) { setTab('bots'); setSelectedId(found.bot.id); setShowDetail(true); cancelNavigation(); setDialog({ kind: 'edit', bot: found.bot }); setToast(undefined); }
    else setToast({ text: t('errors.detailMissing'), error: true });
    onDetailConsumed(requestedDetail.requestId);
  }, [requestedDetail, snapshot, onDetailConsumed, t, cancelNavigation]);
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

  async function navigate(action: (signal: AbortSignal) => Promise<void>, errorKey: 'errors.start' | 'activity.openError') {
    if (busyRef.current || navigation.current) return;
    const controller = new AbortController();
    navigation.current = controller;
    setNavigating(true);
    setToast(undefined);
    try {
      await action(controller.signal);
    } catch (error: unknown) {
      if (alive() && !controller.signal.aborted) setToast({
        text: errorKey === 'activity.openError' ? t(errorKey) : `${t(errorKey)} ${detail(error)}`.trim(),
        error: true, inline: errorKey === 'errors.start',
      });
    } finally {
      if (navigation.current === controller) {
        navigation.current = undefined;
        if (alive()) setNavigating(false);
      }
    }
  }

  async function perform(action: () => Promise<void>, errorKey: 'errors.save' | 'errors.delete' | 'errors.duplicate', successKey?: 'bots.saveSuccess' | 'delete.success' | 'delete.keptSuccess' | 'duplicate.success') {
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
      if (alive() && errorKey === 'errors.delete' && typeof error === 'object' && error !== null
        && 'code' in error && error.code === 'bot/home-cleanup-failed') setDialog(undefined);
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
    // Editing supersedes pending navigation, not the Host operation itself.
    cancelNavigation();
    setDialog(next);
    setToast(undefined);
    if (next.kind === 'delete') { setDeleteMemories(true); setDeleteHome(false); }
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
          {(routines || p34 || collaboration || groups) && <div role="tablist" aria-label={t('bots.title')} className={styles.actions}>
            <button type="button" role="tab" aria-selected={tab === 'bots'} className={styles.button} onClick={() => setTab('bots')}>{t('bots.title')}</button>
            {groups && <button type="button" role="tab" aria-selected={tab === 'groups'} className={styles.button} onClick={() => setTab('groups')}>{t('groups.title')}</button>}
            {p34 && <><button type="button" role="tab" aria-selected={tab === 'connectors'} className={styles.button} onClick={() => setTab('connectors')}>{t('p34.connectors')}</button><NotificationTab actions={p34} selected={tab === 'notifications'} onSelect={() => setTab('notifications')} t={t} /></>}
            {collaboration && <><button type="button" role="tab" aria-selected={tab === 'collaboration'} className={styles.button} onClick={() => setTab('collaboration')}>{t('team.title')}</button><button type="button" role="tab" aria-selected={tab === 'im'} className={styles.button} onClick={() => setTab('im')}>{t('im.title')}</button></>}
            <button type="button" role="tab" aria-selected={tab === 'routines'} className={styles.button} onClick={() => setTab('routines')}>{t('routine.title')}</button>
          </div>}
          {groups && tab === 'groups' && <GroupsPanel actions={groups} bots={entries.map(entry => entry.bot)} t={t} onOpenSession={onOpenSession} />}
          {collaboration && tab === 'collaboration' && <CollaborationPanel actions={collaboration} bots={entries.map(entry => entry.bot)} onOpenSession={onOpenSession} t={t} />}
          {collaboration && tab === 'im' && <ImPanel actions={collaboration} t={t} />}
          {p34 && (tab === 'connectors' || tab === 'notifications') && <P34Panel actions={p34} bots={entries.map(entry => entry.bot)} mode={tab} onOpenSession={onOpenSession} t={t} />}
          {tab === 'routines' && routines && <RoutinePanel key="overview" actions={routines} bots={entries.map(entry => entry.bot)} onOpenSession={onOpenSession} t={t} />}
          {snapshot.error && <div role="alert" className={styles.error}>
            <p>{t(unavailable ? 'errors.unavailable' : 'errors.load')}</p>
            {snapshot.error.code && <p>{snapshot.error.code}</p>}
            {snapshot.error.message && <p>{snapshot.error.message}</p>}
            <button type="button" className={styles.button} onClick={() => { void onRefresh(); }}>{t('actions.retry')}</button>
          </div>}
          {!snapshot.loaded && snapshot.loading && <p className={styles.loading} role="status">{t('bots.loading')}</p>}
          {snapshot.loaded && !snapshot.error && snapshot.entries.length === 0 && <div className={styles.empty}>
            <h2>{t('bots.empty')}</h2><p>{t('bots.emptyHint')}</p>
            <Button variant="primary" size="sm" className={styles.emptyAction} disabled={busy} onClick={() => open({ kind: 'create' })}>{t('bots.create')}</Button>
          </div>}
          {tab === 'bots' && entries.length > 0 && <div className={styles.twoPane}>
            {(!compact || !showDetail) && <BotList disabled={busy || navigating} entries={entries} activities={activity.bots} t={t}
              selectedId={selected?.bot.id} listRef={listElement} idPrefix={listId}
              onSelect={(id) => { setSelectedId(id); setMore(false); setToast(undefined); }} onActivate={(id) => { setShowDetail(true); void navigate(signal => onStart(id, signal), 'errors.start'); }} />}
            {selected && (!compact || showDetail) && <article className={styles.botDetail} data-bot-detail={selected.bot.id}>
              {compact && <Button ref={backElement} variant="ghost" size="sm" className={styles.backButton} onClick={() => { focusListOnReturn.current = true; setShowDetail(false); setMore(false); }}>{t('bots.back')}</Button>}
              <header className={styles.detailHeader}>
                <div className={styles.cardHeading}>
                  <BotAvatar bot={selected.bot} size={64} />
                  <div className={styles.cardIdentity}><h2 className={styles.detailTitle}>{selected.bot.name}</h2><span className={styles.botId}>{selected.bot.id}</span></div>
                  <Menu open={more} onClose={() => setMore(false)} align="end" className={styles.moreContainer}
                    anchor={<Button variant="ghost" size="sm" className={styles.iconButton} disabled={busy}
                      aria-label={t('card.more')} title={t('card.more')} aria-haspopup="menu" aria-expanded={more}
                      onClick={() => setMore(!more)}><IconEllipsisOutlineRegular size={18} /></Button>}
                    items={[

                      { id: 'duplicate', label: t('card.duplicate'), disabled: busy },
                      { id: 'delete', label: t('actions.delete'), disabled: busy, danger: true },
                    ]} onSelect={(action) => {
                      setMore(false);
                      if (action === 'duplicate' || action === 'delete') open({ kind: action, bot: selected.bot });
                    }} />
                </div>
                <p className={styles.description}>{selected.bot.description || t('card.noDescription')}</p>
                <p className={styles.hint}>{t('editor.cwdPermissions')}</p>
                {selected.status?.warnings?.includes('avatar/invalid') && <p className={styles.statusNotice}>{t('avatar.invalidStored')}</p>}
                {!ready && <p className={styles.statusNotice} role="status" id={`${listId}-status`}>
                  {t(!selected.status || snapshot.error || snapshot.loading ? 'card.statusUnknown'
                    : selected.status.preset.state === 'broken' ? 'card.statusBroken' : 'card.statusMissing')}
                  {selected.status?.preset.reason ? ` ${selected.status.preset.reason}` : ''}
                </p>}
                <div className={styles.detailActions}>
                  <Button variant="primary" size="sm" disabled={busy || navigating || !ready} aria-describedby={!ready ? `${listId}-status` : undefined}
                    onClick={() => { void navigate(signal => onStart(selected.bot.id, signal), 'errors.start'); }}>{t('bots.newSession')}</Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => open({ kind: 'edit', bot: selected.bot })}>{t('card.edit')}</Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => open({ kind: 'memory', bot: selected.bot })}>{t('memory.title')}</Button>
                </div>
                {toast?.inline && <p className={styles.error} role="alert" data-chat-error="">{toast.text}</p>}
              </header>
              {routines && <RoutinePanel key={selected.bot.id} actions={routines} bots={entries.map(entry => entry.bot)} botId={selected.bot.id} onOpenSession={onOpenSession} t={t} />}
              <section className={styles.sessionHistory} aria-label={t('bots.history')}>
                <h3 className={styles.historyTitle}>{t('bots.history')}</h3>
                {activity.error && <p role="alert" className={styles.error}>{t('activity.loadError')}</p>}
                {sessions.phase !== 'ready' || (!activity.loaded && activity.loading)
                  ? <p className={styles.loading} role="status">{t('activity.loading')}</p>
                  : rows.length === 0 ? <div className={styles.empty}><h2>{t('bots.noSessions')}</h2><p>{t('bots.emptySessionsHint')}</p></div>
                    : <div className={styles.historyList}>{rows.map((session) => {
                      const title = previewText(session.title, t) || t('sidebar.untitled');
                      const preview = previewText(session.preview, t);
                      return <button type="button" key={session.id} className={styles.historyRow} data-session-id={session.id}
                        disabled={busy || navigating} onClick={() => { void navigate(signal => onOpenSession(session.id, signal), 'activity.openError'); }}>
                        <span className={styles.rowHeading}><span className={styles.rowName} title={title}>{title}</span>
                          {session.unread && <span className={styles.unreadDot} data-unread="" role="img" aria-label={t('activity.unread')} />}
                          {session.running && <span className={styles.running}>{t('activity.running')}</span>}
                          <time className={styles.relativeTime} dateTime={new Date(session.updatedAt).toISOString()}>{relativeTime(session.updatedAt, locale)}</time>
                        </span>
                        {session.workspaceTitle && <span className={styles.relativeTime} data-workspace-meta="">{session.workspaceTitle}</span>}
                        {preview && <span className={styles.activityPreview} data-activity-preview="" title={preview}>{preview}</span>}
                      </button>;
                    })}</div>}
              </section>
            </article>}
          </div>}
        </div>
      </div>
      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && <BotEditor
        avatarWarning={dialog.kind === 'edit' && snapshot.entries.find(({ bot }) => bot.id === dialog.bot.id)?.status?.warnings?.includes('avatar/invalid')}
        key={dialog.kind === 'edit' ? dialog.bot.id : 'new'}
        memoryPanel={dialog.kind === 'edit' ? <MemoryTab
          bot={snapshot.entries.find(({ bot }) => bot.id === dialog.bot.id)?.bot ?? dialog.bot} create={createMemoryPanel} t={t} /> : undefined}
        bot={dialog.kind === 'edit' ? dialog.bot : undefined} onEnsureHome={onEnsureHome} onEnsureBotsWorkspace={onEnsureBotsWorkspace} onPickDirectory={onPickDirectory} busy={busy} onSave={save} onCancel={() => setDialog(undefined)} t={t} />}
      {dialog?.kind === 'memory' && <Modal title={t('memory.title')} busy={busy} onClose={() => setDialog(undefined)} t={t}>
        <MemoryTab bot={snapshot.entries.find(({ bot }) => bot.id === dialog.bot.id)?.bot ?? dialog.bot} create={createMemoryPanel} t={t} />
      </Modal>}
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
          <label className={styles.checkboxField}>
            <input type="checkbox" checked={deleteHome} disabled={busy} onChange={(event) => setDeleteHome(event.target.checked)} />
            {t('delete.home')}
          </label>
          <p className={styles.warning}>{t(deleteHome ? 'delete.homeWarning' : 'delete.keepHome')}</p>
          <p className={styles.warning}>{t('delete.history')}</p>
        </div>
        <footer className={styles.dialogFooter}>
          <button type="button" className={styles.button} disabled={busy} onClick={() => setDialog(undefined)}>{t('actions.cancel')}</button>
          <button type="button" className={styles.dangerButton} disabled={busy || memoryCount.count === undefined} onClick={() => {
            void perform(() => onDelete(dialog.bot.id, deleteMemories, deleteHome), 'errors.delete', deleteMemories ? 'delete.success' : 'delete.keptSuccess').catch(() => {});
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
      {toast && !toast.inline && <div className={styles.toast} role={toast.error ? 'alert' : 'status'}>
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
