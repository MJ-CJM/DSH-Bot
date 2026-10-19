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
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import TYPERT_REMOTE from '../typert.remote-client.js';
import type { DshBotRemoteMethods } from '../shared/remote-contract.js';
import { Config } from './config.js';
import { BotsPage, type BotsPageInjected } from './pages/BotsPage.js';
import { SessionBotBadge } from './components/SessionBotBadge.js';
import { BotSessionsSidebar, type BotSessionsSidebarInjected } from './components/BotSessionsSidebar.js';
import { createMemoryCatalog, type MemoryCatalog } from './memory-state.js';
import { createBotDetailSource } from './detail-state.js';
import { createBotCatalog } from './state.js';

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
export const inject = ['slots', 'locale', 'remote', 'uiWorkspace', 'workspaces', 'layout'];

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
  const mutate = async (operation: () => Promise<RemoteResult<unknown>>) => {
    unwrap(await operation());
    // A successful commit must not reuse a read begun before that commit.
    await catalog.refresh();
  };
  const page: BotsPageInjected = {
    hooks: { catalog, workspaceCatalog: ctx.workspaces.list, botDetail: detail },
    onDetailConsumed: detail.consume,
    onCountMemories: async (id) => unwrap(await remote().memory.count(id)),
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
        onSave: (input) => write(() => remote().memory.save(id, input)),
        onUpdate: (memoryId, patch) => write(() => remote().memory.update(id, memoryId, patch)),
        onRemove: (memoryId) => write(() => remote().memory.delete(id, memoryId)),
        onOpenSession: (sessionId) => { if (active) ctx.uiWorkspace.openSession(sessionId as SessionId); },
      };
    },
    onRefresh: catalog.refresh,
    getPreferredWorkspace: () => preferredWorkspace,
    onPollInterval: (value) => {
      const interval = Config({ pollIntervalMs: value }).pollIntervalMs;
      catalog.setPollIntervalMs(interval);
      for (const memory of memories) memory.setPollIntervalMs(interval);
    },
    onCreate: (input) => mutate(() => remote().create(input)),
    onUpdate: (id, patch) => mutate(() => remote().update(id, patch)),
    onDuplicate: (id, newId) => mutate(() => remote().duplicate(id, newId)),
    onDelete: (id, deleteMemories) => mutate(() => remote().delete(id, { deleteMemories })),
    onStart: async (id, workspaceId, signal) => {
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
      if (!active || signal?.aborted) return;
      const status = statuses.find((entry) => entry.id === id);
      if (status?.preset.state !== 'ok') {
        void catalog.refresh();
        throw new Error(status?.preset.reason ?? t(status?.preset.state === 'broken'
          ? 'card.statusBroken' : status?.preset.state === 'missing' ? 'card.statusMissing' : 'card.statusUnknown'));
      }
      // Unlike startSession (void, silently clears main when no workspace),
      // this public API lets this page await and display Host refusals.
      // Revalidate after the status query in case the workspace was removed.
      await ctx.uiWorkspace.openWorkspace(target().workspaceId, () => {
        if (!active || signal?.aborted) throw new Error(t('chat.cancelled'));
        // This callback is skipped for superseded navigation and runs before
        // selectPanel unmounts the Bots page (and aborts its local lifetime).
        preferredWorkspace = workspaceId;
      }, { agentPreset: status.presetId });
    },
  };
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'dsh-bot', locale: namespace,
    inject: () => ({ hooks: { catalog: { getSnapshot: catalog.getSnapshot, subscribe: catalog.observe } }, onOpenBot: (id: string) => {
      if (!active) return;
      detail.open(id);
      ctx.layout.selectPanel('dsh-bot' as MainPanelId);
    } }),
  }, SessionBotBadge)), 'dsh-bot: session badge');
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
      hooks: { catalog: { getSnapshot: catalog.getSnapshot, subscribe: catalog.observe }, workspaceCatalog: ctx.workspaces.list },
      sessionLimit: config.sidebarSessionLimit,
      onStart: page.onStart,
      getPreferredWorkspace: page.getPreferredWorkspace,
      onRefresh: catalog.refresh,
      onOpenSession: (id) => { if (active) ctx.uiWorkspace.openSession(id); },
      onManage: () => { if (active) ctx.layout.selectPanel('dsh-bot' as MainPanelId); },
    }),
  }, BotSessionsSidebar)), 'dsh-bot: sidebar conversations');
}
