import { pageNavigation, type BotsSection, type PageIdentity } from './page-navigation.js';
import { matchesCreation } from './recent-conversations.js';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BotCreateInput, BotPatch } from '../../shared/schema.js';
import { botSessionRows, sortBotEntries } from '../activity-view.js';
import type { BotDetailRequest } from '../detail-state.js';

import type { Dialog, BotsPageProps } from './bots-page-types.js';
import type { GroupActions } from '../groups-state.js';
const emptyGroups: ReturnType<GroupActions['catalog']['getSnapshot']> = { groups: [], loaded: false, loading: false, pollIntervalMs: 0 };
const emptyRequest: ReturnType<GroupActions['selection']['getSnapshot']> = { loaded: true, loading: false, pollIntervalMs: 0 };
const noSubscribe = () => () => {};
const noGroups = () => emptyGroups;
const noRequest = () => emptyRequest;
function detail(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  return typeof error === 'string' ? error : '';
}

export function useBotsPage({
  groups,
  pageNavigation: providedNavigation,
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
  const [pageState] = useState(() => providedNavigation ?? pageNavigation());
  const [tab, updateTab] = useState<BotsSection | 'management'>(pageState.section);
  const scrollElement = useRef<HTMLDivElement>(null);
  const currentTab = useRef(tab);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const [selectedGroup, updateGroup] = useState<PageIdentity | undefined>(pageState.group);
  const setSelectedGroup = useCallback((value: PageIdentity | undefined) => {
    pageState.group = value; updateGroup(value);
  }, [pageState]);
  const setTab = useCallback((next: BotsSection | 'management') => {
    if (currentTab.current !== 'management' && scrollElement.current) pageState.scroll[currentTab.current] = scrollElement.current.scrollTop;
    currentTab.current = next;
    if (next !== 'management') pageState.section = next;
    updateTab(next);
  }, [pageState]);
  const section = tab === 'management' ? pageState.section : tab;
  const groupList = useSyncExternalStore(groups?.catalog.subscribe ?? noSubscribe, groups?.catalog.getSnapshot ?? noGroups);
  const groupRequest = useSyncExternalStore(groups?.selection.subscribe ?? noSubscribe, groups?.selection.getSnapshot ?? noRequest);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedCreatedAt, setSelectedCreatedAt] = useState<number>();
  const [showDetail, setShowDetail] = useState(false);
  const [detailDestination, setDetailDestination] = useState<BotDetailRequest>();
  const onDetailTargetReached = useCallback((requestId: number) => setDetailDestination(current =>
    current?.requestId === requestId ? { ...current, target: undefined } : current), []);
  const [more, setMore] = useState(false);
  const listElement = useRef<HTMLDivElement>(null);
  const backElement = useRef<HTMLButtonElement>(null);
  const focusListOnReturn = useRef(false);
  const listId = useId();
  const locale = t('activity.locale');
  const entries = sortBotEntries(snapshot.entries, activity.bots, locale);
  const selected = entries.find(({ bot }) => bot.id === (requestedDetail?.botId ?? selectedId) &&
    (requestedDetail ? requestedDetail.botCreatedAt === undefined || bot.createdAt === requestedDetail.botCreatedAt
      : selectedCreatedAt === undefined || bot.createdAt === selectedCreatedAt)) ??
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
  const detailOrigin = useRef<HTMLElement>();
  const detailScroll = useRef(0);
  const openedWithTarget = useRef(false);
  const returnFromDetail = () => { setShowDetail(false); };
  useLayoutEffect(() => {
    if (showDetail) { if (scrollElement.current) scrollElement.current.scrollTop = 0; backElement.current?.focus({ preventScroll: true }); }
    else if (detailOrigin.current) {
      if (scrollElement.current) scrollElement.current.scrollTop = detailScroll.current;
      detailOrigin.current.focus({ preventScroll: true }); detailOrigin.current = undefined;
    }
  }, [showDetail]);
  const showBot = (bot: { id: string; createdAt: number }) => {
    detailOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    detailScroll.current = scrollElement.current?.scrollTop ?? 0;
    openedWithTarget.current = false;
    setDetailDestination(undefined);
    setSelectedId(bot.id); setSelectedCreatedAt(bot.createdAt); setShowDetail(true);
  };
  useEffect(() => {
    if (!groups || !('selectedId' in groupRequest) || !groupRequest.selectedId || !groupRequest.requestId || !groupList.loaded || groupList.error) return;
    const found = groupList.groups.find(row => row.group.id === groupRequest.selectedId &&
      (groupRequest.createdAt === undefined || row.group.createdAt === groupRequest.createdAt));
    setSelectedGroup(found && !found.group.archived ? { id: found.group.id, createdAt: found.group.createdAt } : undefined);
    setTab('groups'); setShowDetail(false); setDialog(undefined);
    if (!found || found.group.archived) setToast({ text: t('navigation.targetMissing'), error: true });
    groups.consumeSelection(groupRequest.requestId);
  }, [groups, groupRequest, groupList, setSelectedGroup, setTab, t]);
  useEffect(() => {
    if (!selectedGroup || !groupList.loaded || groupList.error) return;
    const found = groupList.groups.find(row => row.group.id === selectedGroup.id && row.group.createdAt === selectedGroup.createdAt && !row.group.archived);
    if (!found) { setSelectedGroup(undefined); setToast({ text: t('navigation.targetMissing'), error: true }); }
  }, [selectedGroup, groupList, setSelectedGroup, t]);
  useEffect(() => {
    if (showDetail && !busy && !dialog && !requestedDetail && snapshot.loaded && !snapshot.loading && !snapshot.error && !selected) {
      setShowDetail(false); setToast({ text: t('errors.detailMissing'), error: true });
    }
  }, [showDetail, busy, dialog, requestedDetail, snapshot, selected, t]);
  useLayoutEffect(() => {
    if (tab !== 'management' && (!snapshot.loaded || (tab === 'groups' && !groupList.loaded))) return;
    if (scrollElement.current) scrollElement.current.scrollTop = tab === 'management' ? 0 : pageState.scroll[tab];
  }, [tab, pageState, snapshot.loaded, groupList.loaded]);
  const returnFromSettings = () => { setTab(pageState.section); settingsButton.current?.focus({ preventScroll: true }); };

  useEffect(() => {
    // Lock the first complete ordering, then retain that Bot across activity polls.
    if (!snapshot.loaded || (!activity.loaded && !activity.error) || requestedDetail) return;
    // A synchronous detail-request consumption can schedule another render
    // before its explicit selection commits. Preserve the latest queued target.
    if (!showDetail) setSelectedId(current => entries.some(({ bot }) => bot.id === current) ? current : entries[0]?.bot.id);
  }, [snapshot.loaded, activity.loaded, activity.error, entries, requestedDetail, showDetail]);
  useEffect(() => {
    if (!compact || dialog) return;
    if (showDetail) {
      // The selected work row or section manages focus for a deep link.
      if (!openedWithTarget.current) backElement.current?.focus();
    } else if (focusListOnReturn.current) {
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
    const found = snapshot.entries.find(({ bot }) => bot.id === requestedDetail.botId &&
      (requestedDetail.botCreatedAt === undefined || bot.createdAt === requestedDetail.botCreatedAt));
    if (found) {
      openedWithTarget.current = !!requestedDetail.target;
      setTab('bots');
      setSelectedId(found.bot.id);
      setSelectedCreatedAt(found.bot.createdAt);
      setDetailDestination(requestedDetail);
      setShowDetail(true);
      cancelNavigation();
      setDialog(undefined);
      setToast(undefined);
    } else setToast({ text: t('errors.detailMissing'), error: true });
    onDetailConsumed(requestedDetail.requestId);
  }, [requestedDetail, snapshot, onDetailConsumed, t, cancelNavigation, setTab]);
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
        if (errorKey === 'errors.delete') setShowDetail(false);
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
    detailDestination,
    onDetailTargetReached,
    workspaces,
    pageElement,
    pageState,
    scrollElement,
    settingsButton,
    rememberScroll: (top: number) => { if (currentTab.current !== 'management' && !showDetail) pageState.scroll[currentTab.current] = top; },
    section,
    selectedGroup,
    setSelectedGroup,
    showBot,
    returnFromDetail,
    returnFromSettings,
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
    cancelNavigation,
    perform,
    save,
    createdId,
    open,
    unavailable,
  };
}
export type BotsPageModel = ReturnType<typeof useBotsPage>;
