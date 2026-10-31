import { matchesCreation } from './recent-conversations.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { BotCreateInput, BotPatch } from '../../shared/schema.js';
import { botSessionRows, sortBotEntries } from '../activity-view.js';

import type { Dialog, BotsPageProps } from './bots-page-types.js';
function detail(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  return typeof error === 'string' ? error : '';
}

export function useBotsPage({
  groups,
  useCatalog,
  useActivity,
  useSessionCatalog,
  useWorkspaceCatalog,
  useBotDetail,
  onDetailConsumed,
  onCountMemories,
  onCreate,
  onCreateForChat,
  onStartCreated,
  onUpdate,
  onStart,
  onRefresh,
  t,
}: BotsPageProps) {
  const snapshot = useCatalog((value) => value);
  const catalogRef = useRef(snapshot);
  catalogRef.current = snapshot;
  const activity = useActivity((value) => value);
  const sessions = useSessionCatalog((value) => value);
  const requestedDetail = useBotDetail((value) => value);
  const workspaces = useWorkspaceCatalog((value) => value);
  const pageElement = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.innerWidth < 760);
  const [tab, setTab] = useState<'bots' | 'groups' | 'management'>('bots');
  useEffect(() => {
    if (!groups) return;
    const update = () => {
      if (groups.selection.getSnapshot().selectedId) setTab('groups');
    };
    update();
    return groups.selection.observe(update);
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
  const selected = entries.find(({ bot }) => bot.id === (requestedDetail?.botId ?? selectedId)) ??
    (selectedId === undefined && requestedDetail === undefined ? entries[0] : undefined);
  const rows = selected
    ? botSessionRows(
        selected.bot.id,
        snapshot.entries,
        sessions,
        activity.sessions,
        workspaces.archivedSessionIds,
        workspaces.items,
      )
    : [];
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
    if (!snapshot.loaded || (!activity.loaded && !activity.error) || requestedDetail) return;
    // A synchronous detail-request consumption can schedule another render
    // before its explicit selection commits. Preserve the latest queued target.
    setSelectedId(current => entries.some(({ bot }) => bot.id === current) ? current : entries[0]?.bot.id);
  }, [snapshot.loaded, activity.loaded, activity.error, entries, requestedDetail]);
  useEffect(() => {
    if (!compact || dialog) return;
    if (showDetail) backElement.current?.focus();
    else if (focusListOnReturn.current) {
      listElement.current?.focus();
      focusListOnReturn.current = false;
    }
  }, [compact, showDetail, dialog]);
  useEffect(() => {
    const page = pageElement.current;
    if (!page) return;
    const update = (width: number) => {
      if (width > 0) setCompact(width < 760);
    };
    update(page.clientWidth || window.innerWidth);
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(([entry]) => {
        if (entry) update(entry.contentRect.width);
      });
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
    return () => {
      controller.abort();
      navigation.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!requestedDetail || !snapshot.loaded || snapshot.loading || snapshot.error) return;
    const found = snapshot.entries.find(({ bot }) => bot.id === requestedDetail.botId);
    if (found) {
      setTab('bots');
      setSelectedId(found.bot.id);
      setShowDetail(true);
      cancelNavigation();
      setDialog(undefined);
      setToast(undefined);
    } else setToast({ text: t('errors.detailMissing'), error: true });
    onDetailConsumed(requestedDetail.requestId);
  }, [requestedDetail, snapshot, onDetailConsumed, t, cancelNavigation]);
  const deleteId = dialog?.kind === 'delete' ? dialog.bot.id : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly refreshes the same Bot.
  useEffect(() => {
    let current = true;
    setMemoryCount({});
    if (deleteId)
      void onCountMemories(deleteId).then(
        (count) => {
          if (current) setMemoryCount({ count });
        },
        () => {
          if (current) setMemoryCount({ failed: true });
        },
      );
    return () => {
      current = false;
    };
  }, [deleteId, onCountMemories, countAttempt]);
  const alive = () => lifetime.current?.signal.aborted === false;

  async function navigate(
    action: (signal: AbortSignal) => Promise<void>,
    errorKey: 'errors.start' | 'activity.openError',
  ) {
    if (busyRef.current || navigation.current) return;
    const controller = new AbortController();
    navigation.current = controller;
    setNavigating(true);
    setToast(undefined);
    try {
      await action(controller.signal);
    } catch (error: unknown) {
      if (alive() && !controller.signal.aborted)
        setToast({
          text: errorKey === 'activity.openError' ? t(errorKey) : `${t(errorKey)} ${detail(error)}`.trim(),
          error: true,
          inline: errorKey === 'errors.start',
        });
    } finally {
      if (navigation.current === controller) {
        navigation.current = undefined;
        if (alive()) setNavigating(false);
      }
    }
  }

  async function perform(
    action: () => Promise<void>,
    errorKey: 'errors.save' | 'errors.delete' | 'errors.duplicate',
    successKey?: 'bots.saveSuccess' | 'delete.success' | 'delete.keptSuccess' | 'duplicate.success',
  ) {
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
      if (
        alive() &&
        errorKey === 'errors.delete' &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'bot/home-cleanup-failed'
      )
        setDialog(undefined);
      if (alive()) setToast({ text: `${t(errorKey)} ${detail(error)}`.trim(), error: true });
      throw error;
    } finally {
      busyRef.current = false;
      if (alive()) setBusy(false);
    }
  }
  const [createdId, setCreatedId] = useState<string>();
  const acceptedCreation = useRef<string>();
  const creationOperation = useRef<string>();
  async function save(input: BotCreateInput | BotPatch) {
    if (dialog?.kind !== 'create') return perform(
      () => dialog?.kind === 'edit' ? onUpdate(dialog.bot.id, input as BotPatch) : Promise.resolve(),
      'errors.save', 'bots.saveSuccess',
    );
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setToast(undefined);
    const id = (input as BotCreateInput).id;
    try {
      if (acceptedCreation.current !== id) {
        try {
          if (onCreateForChat) {
            creationOperation.current ??= crypto.randomUUID();
            await onCreateForChat(input as BotCreateInput, creationOperation.current, locale.startsWith('zh') ? 'zh' : 'en');
          } else await onCreate(input as BotCreateInput);
        }
        catch (error) {
          // An onboarding create response is recovered only by the Host's
          // stable operation, never by treating a matching name as ownership.
          if (onCreateForChat) throw error;
          // Reconcile an unknown response before offering another create attempt.
          await onRefresh();
          if (!catalogRef.current.entries.some(entry => entry.bot.id === id && matchesCreation(input as BotCreateInput, entry.bot))) throw error;
        }
        acceptedCreation.current = id; setCreatedId(id);
      }
      if (onStartCreated && creationOperation.current) await onStartCreated(id, creationOperation.current, lifetime.current?.signal);
      else await onStart(id, lifetime.current?.signal);
      if (alive()) setDialog(undefined);
    } catch (error) {
      if (alive()) setToast({ text: `${acceptedCreation.current === id ? t('chat.savedOpenFailed' as Parameters<typeof t>[0]) : t('errors.save')} ${detail(error)}`.trim(), error: true });
      throw error;
    } finally { busyRef.current = false; if (alive()) setBusy(false); }
  }
  function open(next: Dialog) {
    // Editing supersedes pending navigation, not the Host operation itself.
    cancelNavigation();
    acceptedCreation.current = undefined; creationOperation.current = undefined; setCreatedId(undefined);
    setDialog(next);
    setToast(undefined);
    if (next.kind === 'delete') {
      setDeleteMemories(true);
      setDeleteHome(false);
    }
    if (next.kind === 'duplicate') {
      setCopyId(`${next.bot.id.slice(0, 27)}-copy`);
      setCopyInvalid(false);
    }
  }
  const unavailable =
    snapshot.error?.code === 'bot/unavailable' || snapshot.error?.code === 'gateway/service-unavailable';
  return {
    snapshot,
    activity,
    sessions,
    requestedDetail,
    workspaces,
    pageElement,
    compact,
    tab,
    setTab,
    selectedId,
    setSelectedId,
    showDetail,
    setShowDetail,
    more,
    setMore,
    listElement,
    backElement,
    focusListOnReturn,
    listId,
    locale,
    entries,
    selected,
    rows,
    ready,
    memoryCount,
    setCountAttempt,
    deleteMemories,
    setDeleteMemories,
    deleteHome,
    setDeleteHome,
    dialog,
    setDialog,
    busy,
    navigating,
    toast,
    setToast,
    copyId,
    setCopyId,
    copyInvalid,
    setCopyInvalid,
    copyInput,
    navigate,
    perform,
    save,
    createdId,
    open,
    unavailable,
  };
}
export type BotsPageModel = ReturnType<typeof useBotsPage>;
