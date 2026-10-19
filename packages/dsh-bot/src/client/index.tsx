import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import TYPERT_REMOTE from '../typert.remote-client.js';
import type { DshBotRemoteMethods } from '../shared/remote-contract.js';
import { Config } from './config.js';
import { registerBotsRightTab } from './right-tab.js';
import { BotsPage, type BotsPageInjected } from './pages/BotsPage.js';
import { SessionBotBadge } from './components/SessionBotBadge.js';
import { SessionBotLeading, SessionBotHover, type SessionBotRowInjected } from './components/SessionBotLeading.js';
import { BotSessionsSidebar, type BotSessionsSidebarInjected } from './components/BotSessionsSidebar.js';
import { createMemoryCatalog, type MemoryCatalog } from './memory-state.js';
import { createBotDetailSource } from './detail-state.js';
import { createBotCatalog } from './state.js';
import { createActivityCatalog } from './activity-state.js';

export { Config };

const namespace = 'dsh-bot';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-bot': keyof typeof en.ui;
  }
}

// Standard Web/Desktop composition includes locale (dsh-v0.2.1-rc.2:
// packages/bundle/web-app/cordis.patch.yml:257-258). Cordis waits for both services.
// This assembly mounts dshBot, so it must not depend on remote.dshBot itself.
export const inject = ['slots', 'locale', 'remote', 'uiWorkspace', 'workspaces', 'sessions', 'layout'];

function BotsIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 8 12 4l4 4M6 11h12v9H6zM10 15h.01M14 15h.01" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export async function apply(ctx: Context, options: Partial<Config> = {}): Promise<void> {
  const config = Config(options);
  await ctx.effect(async () => await ctx.remote.$mount(TYPERT_REMOTE), 'dsh-bot: Remote contribution');
  ctx.effect(() => ctx.locale.register(namespace, {
    en: en.ui,
    zh: zh.ui,
  }), 'dsh-bot: dictionaries');
  const t = ctx.locale.bind(namespace);
  const catalog = createBotCatalog(ctx, config);
  const activity = createActivityCatalog(ctx, config);
  // Host and Client ambient Context declarations share a TS program here;
  // this entry runs only on the Client and uses its public service contract.
  const sessions = ctx.sessions as unknown as ISessions;
  const detail = createBotDetailSource(ctx);
  const memories = new Set<MemoryCatalog>();
  // Client memory only: shared by page/sidebar, cleared on plugin unload.
  let preferredWorkspace = '';
  let active = true;
  ctx.effect(() => () => { active = false; }, 'dsh-bot: action lifetime');
  const remote = (): DshBotRemoteMethods => {
    const service = ctx.get('remote.dshBot');
    if (!active || !service) throw new Error(t('errors.unavailable'));
    return service;
  };
  const memoryRemote = (): DshBotRemoteMethods['memory'] => {
    const service = ctx.get('remote.dshBot.memory') as DshBotRemoteMethods['memory'] | undefined;
    if (!active || !service) throw new Error(t('errors.unavailable'));
    return service;
  };
  const mutate = async (operation: () => Promise<RemoteResult<unknown>>) => {
    const result = await operation();
    if (!result.ok && result.error.code === 'bot/home-cleanup-failed') {
      // The Host deletion has committed even though cleanup failed. Reflect
      // the authoritative catalog, then report the incomplete cleanup clearly.
      await Promise.all([catalog.refresh(), activity.refresh()]);
      throw Object.assign(new Error(t('delete.homeCleanupFailed')), { code: result.error.code });
    }
    unwrap(result);
    // A successful commit must not reuse a read begun before that commit.
    await Promise.all([catalog.refresh(), activity.refresh()]);
  };
  const refresh = async () => { await Promise.all([catalog.refresh(), activity.refresh()]); };
  const openSession = async (id: string, beforeOpen?: (id: SessionId) => void, signal?: AbortSignal) => {
    if (!active || signal?.aborted) return;
    const navigation = ctx.layout.beginNavigation();
    try { await activity.markRead(id); }
    catch {
      // Read receipts are best effort. Do not leak transport/payload details
      // and do not block the primary action when the receipt cannot be saved.
      if (active) console.warn(t('activity.readFailed'));
    }
    if (active && !navigation.aborted && !signal?.aborted) {
      beforeOpen?.(id as SessionId);
      ctx.uiWorkspace.openSession(id as SessionId);
    }
  };
  const startBotInWorkspace = async (id: string, workspaceId: string, signal?: AbortSignal, beforeOpen?: (id: SessionId) => void) => {
    if (!active || signal?.aborted) return;
    const navigation = ctx.layout.beginNavigation();
    const target = () => {
      const snapshot = ctx.workspaces.list.getSnapshot();
      if (snapshot.state === 'error') throw new Error(`${t('chat.workspaceUnavailable')} ${snapshot.error?.message ?? ''}`.trim());
      if (snapshot.phase !== 'ready') throw new Error(t('chat.workspaceLoading'));
      if (!snapshot.items.length) throw new Error(t('chat.workspaceRequired'));
      const selected = snapshot.items.find((item) => item.workspaceId === workspaceId);
      if (!selected) throw new Error(t('chat.workspaceChoose'));
      return selected;
    };
    target();
    // Recheck the snapshot at action time; Host still owns the final validity check.
    const statuses = unwrap(await remote().status());
    if (!active || signal?.aborted || navigation.aborted) return;
    const status = statuses.find((entry) => entry.id === id);
    if (status?.preset.state !== 'ok') {
      void catalog.refresh();
      throw new Error(status?.preset.reason ?? t(status?.preset.state === 'broken'
        ? 'card.statusBroken' : status?.preset.state === 'missing' ? 'card.statusMissing' : 'card.statusUnknown'));
    }
    // Unlike startSession (void, silently clears main when no workspace),
    // this public API lets this page await and display Host refusals.
    // Revalidate after the status query in case the workspace was removed.
    await ctx.uiWorkspace.openWorkspace(target().workspaceId, (sessionId) => {
      if (!active || signal?.aborted) throw new Error(t('chat.cancelled'));
      // This callback is skipped for superseded navigation and runs before
      // selectPanel unmounts the Bots page (and aborts its local lifetime).
      preferredWorkspace = workspaceId;
      beforeOpen?.(sessionId);
    }, { agentPreset: status.presetId });
    if (active) await refresh();
  };
  const startBot = async (id: string, signal?: AbortSignal, beforeOpen?: (id: SessionId) => void) => {
    if (!active || signal?.aborted) return;
    const navigation = ctx.layout.beginNavigation();
    const current = () => active && !signal?.aborted && !navigation.aborted;
    // Read the authoritative Bot at click time so another Client's cwd edit is respected.
    const [record, statuses] = await Promise.all([remote().get(id), remote().status()]);
    if (!current()) return;
    const bot = unwrap(record);
    const status = unwrap(statuses).find((entry) => entry.id === id);
    if (status?.preset.state !== 'ok') {
      void catalog.refresh();
      throw new Error(status?.preset.reason ?? t(status?.preset.state === 'broken'
        ? 'card.statusBroken' : status?.preset.state === 'missing' ? 'card.statusMissing' : 'card.statusUnknown'));
    }
    const cwd = bot.defaultCwd || unwrap(await remote().ensureHome(id)).path;
    if (!current()) return;
    const sessionId = await sessions.create({ cwd, agentPreset: status.presetId });
    if (!current()) return;
    // Keep the right-tab continuation before native navigation can unmount its origin.
    beforeOpen?.(sessionId);
    ctx.uiWorkspace.openSession(sessionId);
    if (active) await refresh();
  };
  const page: BotsPageInjected = {
    hooks: { catalog, activity, sessionCatalog: sessions.list, workspaceCatalog: ctx.workspaces.list, botDetail: detail },
    onOpenSession: openSession,
    onDetailConsumed: detail.consume,
    onCountMemories: async (id) => unwrap(await memoryRemote().count(id)),
    createMemoryPanel: (id) => {
      const memory = createMemoryCatalog(ctx, id, { pollIntervalMs: catalog.getSnapshot().pollIntervalMs, pageSize: config.memoryPageSize });
      memories.add(memory);
      const write = async (operation: () => Promise<RemoteResult<unknown>>) => {
        unwrap(await operation());
        await memory.refresh();
      };
      return {
        catalog: memory,
        dispose: () => { memories.delete(memory); memory.dispose(); },
        onSave: (input) => write(() => memoryRemote().save(id, input)),
        onUpdate: (memoryId, patch) => write(() => memoryRemote().update(id, memoryId, patch)),
        onRemove: (memoryId) => write(() => memoryRemote().delete(id, memoryId)),
        onOpenSession: openSession,
      };
    },
    onRefresh: refresh,
    getPreferredWorkspace: () => preferredWorkspace,
    onPollInterval: (value) => {
      const interval = Config({ pollIntervalMs: value }).pollIntervalMs;
      catalog.setPollIntervalMs(interval);
      activity.setPollIntervalMs(interval);
      for (const memory of memories) memory.setPollIntervalMs(interval);
    },
    onCreate: (input) => mutate(() => remote().create(input)),
    onUpdate: (id, patch) => mutate(() => remote().update(id, patch)),
    onDuplicate: (id, newId) => mutate(() => remote().duplicate(id, newId)),
    onDelete: (id, deleteMemories, deleteHome) => mutate(() => remote().delete(id, { deleteMemories, deleteHome })),
    onEnsureHome: async (id) => unwrap(await remote().ensureHome(id)).path,
    onPickDirectory: typeof ctx.uiWorkspace.pickDirectory === 'function' ? () => ctx.uiWorkspace.pickDirectory() : undefined,
    onStart: startBot, onStartInWorkspace: startBotInWorkspace,
  };
  registerBotsRightTab(ctx, {
    hooks: { catalog, activity, sessionCatalog: sessions.list, workspaceCatalog: ctx.workspaces.list },
    onOpenSession: (id, signal) => openSession(id, undefined, signal),
    onStart: startBot, onStartInWorkspace: startBotInWorkspace, getPreferredWorkspace: page.getPreferredWorkspace,
    onRefresh: refresh,
    onManage: () => { if (active) ctx.layout.selectPanel('dsh-bot' as MainPanelId); },
  }, { open: openSession, start: startBot, startInWorkspace: startBotInWorkspace });
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'dsh-bot', locale: namespace,
    inject: () => ({ hooks: { catalog: { getSnapshot: catalog.getSnapshot, subscribe: catalog.observe }, activity }, onMarkRead: activity.markRead, onOpenBot: (id: string) => {
      if (!active) return;
      detail.open(id);
      ctx.layout.selectPanel('dsh-bot' as MainPanelId);
    } }),
  }, SessionBotBadge)), 'dsh-bot: session badge');
  const row = (): SessionBotRowInjected => ({
    hooks: { catalog, activity },
  });
  // All visible rows share these catalogs and at most one timer per catalog.
  // Active leases keep externally edited/deleted Bot identities up to date.
  ctx.effect(() => ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading', id: 'dsh-bot-avatar', order: 0, locale: namespace, inject: row,
  }, SessionBotLeading)), 'dsh-bot: session row avatar');
  ctx.effect(() => ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
    name: 'sidebar.session.row.hover', id: 'dsh-bot-identity', order: 0, locale: namespace, inject: row,
  }, SessionBotHover)), 'dsh-bot: session row identity');
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'dsh-bot', locale: namespace, inject: () => page,
  }, BotsPage)), 'dsh-bot: main page');
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'dsh-bot', order: 20, locale: namespace,
    label: () => t('bots.title'),
  }, BotsIcon)), 'dsh-bot: sidebar entry');
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'dsh-bot-sessions', order: 20, locale: namespace,
    inject: (): BotSessionsSidebarInjected => ({
      hooks: { catalog: { getSnapshot: catalog.getSnapshot, subscribe: catalog.observe }, activity, workspaceCatalog: ctx.workspaces.list },
      sessionLimit: config.sidebarSessionLimit,
      onStart: page.onStart,
      onStartInWorkspace: page.onStartInWorkspace,
      getPreferredWorkspace: page.getPreferredWorkspace,
      onRefresh: refresh,
      onOpenSession: openSession,
      onManage: () => { if (active) ctx.layout.selectPanel('dsh-bot' as MainPanelId); },
    }),
  }, BotSessionsSidebar)), 'dsh-bot: sidebar conversations');
}
