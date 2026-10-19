import { Context } from '@deepseek-ai/cordis';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SlotCore, type StoredEntry, resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import { type ComponentType, act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { vi } from 'vitest';
import * as client from '../../src/client/index.js';
import * as primitives from './platform-primitives.js';
import type { BotStatus, DshBotRemoteMethods } from '../../src/shared/remote-contract.js';
import { type ActivitySession, isActivityUnread } from '../../src/shared/activity.js';
import {
  type BotCreateInput, type BotRecord, type MemoryRecord, botCreateSchema, botSchema, normalizeBotPatch,
} from '../../src/shared/schema.js';

export function bot(input: BotCreateInput = { id: 'alpha-bot', name: 'Alpha Bot' }): BotRecord {
  return botSchema.parse({ ...botCreateSchema.parse(input), schemaVersion: 1, createdAt: 1, updatedAt: 1 });
}

export function remoteDouble(initial: BotRecord[] = []) {
  const data = { records: initial, presetIdPrefix: 'custom-', memories: [] as MemoryRecord[], activities: [] as ActivitySession[], statuses: undefined as BotStatus[] | undefined };
  const activity = {
    list: vi.fn<DshBotRemoteMethods['activity']['list']>(async () => ({ ok: true, value: {
      sessions: [...data.activities], bots: data.records.map((bot) => {
        const sessions = data.activities.filter((row) => row.botId === bot.id).sort((a, b) => b.updatedAt - a.updatedAt);
        const latest = sessions[0];
        return { botId: bot.id, lastActivityAt: latest?.updatedAt ?? 0, unreadCount: sessions.filter((row) => row.unread).length,
          ...(latest ? { latest: { ...latest.lastMessage, sessionId: latest.sessionId } } : {}) };
      }),
    } })),
    markRead: vi.fn<DshBotRemoteMethods['activity']['markRead']>(async (sessionId) => {
      const row = data.activities.find((item) => item.sessionId === sessionId);
      if (!row) return { ok: false, error: new RemoteError('activity/not-found', '', {}) };
      const read = { ...row, lastReadAt: Math.max(Date.now(), row.lastMessage.at, row.lastReadAt ?? 0) };
      const next = { ...read, unread: isActivityUnread(read) };
      data.activities = data.activities.map((item) => item.sessionId === sessionId ? next : item);
      return { ok: true, value: next };
    }),
  };
  const memory = {
    list: vi.fn<DshBotRemoteMethods['memory']['list']>(async (id) => ({ ok: true, value: data.memories.filter((row) => row.botId === id) })),
    search: vi.fn<DshBotRemoteMethods['memory']['search']>(async (id, input) => ({ ok: true, value: data.memories.filter((row) => row.botId === id && row.content.includes(input.query)) })),
    count: vi.fn<DshBotRemoteMethods['memory']['count']>(async (id) => ({ ok: true, value: data.memories.filter((row) => row.botId === id).length })),
    save: vi.fn<DshBotRemoteMethods['memory']['save']>(async () => ({ ok: true, value: { id: 'memory-test', deduplicated: false } })),
    update: vi.fn<DshBotRemoteMethods['memory']['update']>(async (botId, id, patch) => {
      const row = data.memories.find((item) => item.botId === botId && item.id === id);
      if (!row) throw new Error('Missing memory');
      const next = { ...row, ...patch, updatedAt: row.updatedAt + 1 };
      data.memories = data.memories.map((item) => item === row ? next : item);
      return { ok: true, value: next };
    }),
    delete: vi.fn<DshBotRemoteMethods['memory']['delete']>(async (botId, id) => {
      data.memories = data.memories.filter((row) => row.botId !== botId || row.id !== id);
      return { ok: true, value: undefined };
    }),
  };
  const methods = {
    activity,
    memory,
    catalogInfo: vi.fn<DshBotRemoteMethods['catalogInfo']>(async () => ({ ok: true, value: { presetIdPrefix: data.presetIdPrefix } })),
    list: vi.fn<DshBotRemoteMethods['list']>(async () => ({ ok: true, value: [...data.records] })),
    status: vi.fn<DshBotRemoteMethods['status']>(async () => ({
      ok: true,
      value: data.statuses ?? data.records.map((record) => ({
        id: record.id, presetId: `host-selected/${record.id}`, preset: { state: 'ok' as const },
      })),
    })),
    get: vi.fn<DshBotRemoteMethods['get']>(async (id) => {
      const record = data.records.find((item) => item.id === id);
      if (!record) throw new Error(`Missing test Bot ${id}`);
      return { ok: true, value: record };
    }),
    create: vi.fn<DshBotRemoteMethods['create']>(async (input) => {
      const record = bot(input);
      data.records = [...data.records, record];
      return { ok: true, value: record };
    }),
    update: vi.fn<DshBotRemoteMethods['update']>(async (id, patch) => {
      const record = data.records.find((item) => item.id === id);
      if (!record) throw new Error(`Missing test Bot ${id}`);
      const updated = botSchema.parse({ ...record, ...normalizeBotPatch(patch), updatedAt: record.updatedAt + 1 });
      data.records = data.records.map((item) => item.id === id ? updated : item);
      return { ok: true, value: updated };
    }),
    duplicate: vi.fn<DshBotRemoteMethods['duplicate']>(async (id, newId) => {
      const record = data.records.find((item) => item.id === id);
      if (!record) throw new Error(`Missing test Bot ${id}`);
      const duplicate = { ...record, id: newId, name: `${record.name} copy` };
      data.records = [...data.records, duplicate];
      return { ok: true, value: duplicate };
    }),
    delete: vi.fn<DshBotRemoteMethods['delete']>(async (id) => {
      data.records = data.records.filter((item) => item.id !== id);
      return { ok: true, value: undefined };
    }),
  };
  return { methods, data };
}

type WorkspaceSnapshot = ReturnType<Context['workspaces']['list']['getSnapshot']>;
export function workspace(id = 'workspace-one', title = 'Test workspace'): WorkspaceSnapshot['items'][number] {
  return { workspaceId: id as WorkspaceSnapshot['items'][number]['workspaceId'], title, path: `/test/${id}`,
    sessionIds: [], createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z' };
}

/** Execute the actual closure artifact with its shared platform modules. No browser emulation of Host services. */
export function loadBuiltClient(): typeof client {
  const require = createRequire(import.meta.url);
  let plugin: typeof client | undefined;
  const source = readFileSync(require.resolve('dsh-bot/client'), 'utf8');
  const platformRequire = ((id: string) => id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(id)) as NodeJS.Require;
  const previousLoader = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
  Object.defineProperty(window, '__ModuleLoader__', { configurable: true, value: {
    load(entry: { factory: (require: NodeJS.Require) => typeof client }) { plugin = entry.factory(platformRequire); },
  } });
  try { new Function('window', source)(window); }
  finally {
    if (previousLoader) Object.defineProperty(window, '__ModuleLoader__', previousLoader);
    else Reflect.deleteProperty(window, '__ModuleLoader__');
  }
  if (!plugin) throw new Error('Built Client factory did not load');
  return plugin;
}

/** Public Cordis and SlotCore are real; transport, locale and Workspace are service doubles. */
export async function mountClient(
  initial: BotRecord[] = [],
  language: 'en' | 'zh' = 'en',
  configure?: (remote: ReturnType<typeof remoteDouble>) => void,
  config: Partial<client.Config> = {},
  plugin: typeof client = client,
) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context();
  const core = new SlotCore();
  const unmountFrame = core.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
  }, (() => null) as never);
  const remote = remoteDouble(initial);
  configure?.(remote);
  const dictionaries = new Map<string, Record<string, Record<string, string>>>();
  const translate = (namespace: string) => (key: string, params?: Record<string, unknown>) => {
    const template = dictionaries.get(namespace)?.[language]?.[key];
    if (template === undefined) throw new Error(`Missing ${language} locale ${namespace}:${key}`);
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? `{${name}}`));
  };
  const mountRemote = vi.fn(async () => {
    remoteMounted = true;
    const release = ctx.provide('remote.dshBot', remote.methods);
    const releaseActivity = ctx.provide('remote.dshBot.activity', remote.methods.activity);
    const releaseMemory = ctx.provide('remote.dshBot.memory', remote.methods.memory);
    return async () => { remoteMounted = false; await releaseActivity(); await releaseMemory(); await release(); };
  });
  let remoteMounted = true;
  let navigation = new AbortController();
  const beginNavigation = () => { navigation.abort(); navigation = new AbortController(); return navigation.signal; };
  const openSession = vi.fn<Context['uiWorkspace']['openSession']>(() => { beginNavigation(); });
  const selectPanel = vi.fn<Context['layout']['selectPanel']>(() => { beginNavigation(); });
  ctx.provide('layout', { selectPanel, beginNavigation } as unknown as Context['layout']);
  const openWorkspace = vi.fn<Context['uiWorkspace']['openWorkspace']>(async (_id, beforeOpen) => {
    beginNavigation();
    beforeOpen?.('test-opened-session' as never);
  });
  let workspaceSnapshot: WorkspaceSnapshot = {
    items: [workspace()], state: 'idle', phase: 'ready', error: null, archivedSessionIds: [], pinnedSessionIds: [],
  };
  const workspaceListeners = new Set<() => void>();
  let sessionSnapshot: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} };
  const sessionListeners = new Set<() => void>();
  const sessionSource = {
    getSnapshot: () => sessionSnapshot,
    subscribe(listener: () => void) { sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
  };
  const workspaceSource: Context['workspaces']['list'] = {
    getSnapshot: () => workspaceSnapshot,
    subscribe(listener) { workspaceListeners.add(listener); return () => { workspaceListeners.delete(listener); }; },
  };
  ctx.provide('locale', {
    register(namespace: string, values: Record<string, Record<string, string>>) {
      dictionaries.set(namespace, values);
      return () => { dictionaries.delete(namespace); };
    },
    bind: translate,
  } as unknown as Context['locale']);
  ctx.provide('slots', {
    inject: (_key: string, callback: () => () => void) => callback(),
    register: core.register.bind(core),
  } as unknown as Context['slots']);
  ctx.provide('remote', { $mount: mountRemote, dshBot: remote.methods } as unknown as Context['remote']);
  ctx.provide('uiWorkspace', { openWorkspace, openSession } as unknown as Context['uiWorkspace']);
  ctx.provide('workspaces', { list: workspaceSource } as unknown as Context['workspaces']);
  ctx.provide('sessions', { list: sessionSource } as unknown as Context['sessions']);
  let fork = ctx.plugin(plugin, config);
  await fork.await();
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  const main = core.entries('main')[0];
  if (!main) throw new Error('Client did not register its main page');
  const renderEntry = (entry: StoredEntry | undefined, target = root, runtime: Record<string, unknown> = {}) => {
    if (!entry) { target.render(null); return; }
    const Component = entry.component as ComponentType<Record<string, unknown>>;
    const { hooks, ...injected } = entry.inject?.() ?? {};
    const boundHooks: Record<string, unknown> = {};
    for (const [name, source] of Object.entries(hooks as Record<string, {
      subscribe(listener: () => void): () => void;
      getSnapshot(): unknown;
    }> ?? {})) {
      boundHooks[`use${name[0]?.toUpperCase()}${name.slice(1)}`] = (selector?: (value: unknown) => unknown) => {
        const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
        return selector ? selector(snapshot) : snapshot;
      };
    }
    target.render(<Component {...runtime} {...injected} {...boundHooks} t={translate(entry.locale ?? 'dsh-bot')} />);
  };
  await act(async () => { renderEntry(main); });
  let disposed = false;
  let viewMounted = true;
  let sidebarRoot: ReturnType<typeof createRoot> | undefined;
  let sidebarContainer: HTMLDivElement | undefined;
  let sidebarWide = true;
  const renderSidebar = () => {
    if (!sidebarRoot) return;
    renderEntry(core.entries('sidebar.footer.action')[0], sidebarRoot, {
      wide: sidebarWide,
      useSessions: (selector: (value: SessionListState) => unknown) => {
        const value = useSyncExternalStore(sessionSource.subscribe, sessionSource.getSnapshot, sessionSource.getSnapshot);
        return selector(value);
      },
    });
  };
  const unsubscribeSidebar = core.subscribe('sidebar.footer.action', renderSidebar);
  // Model the renderer's public slot subscription, including unmount when its entry disappears.
  const unsubscribeMain = core.subscribe('main', () => {
    if (viewMounted) renderEntry(core.entries('main')[0]);
  });
  const unmountPage = async () => {
    if (!viewMounted) return;
    viewMounted = false;
    await act(async () => { root.unmount(); });
  };
  return {
    ctx, core, remote, openWorkspace, openSession, selectPanel, mountRemote, container, main, dictionaries,
    sessionListeners,
    async mountSidebar(wide = true) {
      sidebarWide = wide;
      if (!sidebarContainer) {
        sidebarContainer = document.createElement('div');
        document.body.append(sidebarContainer);
        sidebarRoot = createRoot(sidebarContainer);
      }
      await act(async () => { renderSidebar(); });
      return sidebarContainer;
    },
    async setSessions(patch: Partial<SessionListState>) {
      await act(async () => {
        sessionSnapshot = { ...sessionSnapshot, ...patch };
        for (const listener of sessionListeners) listener();
      });
    },
    async setWorkspaces(patch: Partial<WorkspaceSnapshot>) {
      await act(async () => {
        workspaceSnapshot = { ...workspaceSnapshot, ...patch };
        for (const listener of workspaceListeners) listener();
      });
    },
    remoteMounted: () => remoteMounted,
    sidebarLabel: () => resolveSlotLabel(core.entries('sidebar.panellist')[0]?.options.label),
    unmountPage,
    async remountPage() {
      if (disposed) throw new Error('Cannot remount a disposed test application');
      if (viewMounted) return;
      root = createRoot(container);
      viewMounted = true;
      await act(async () => { renderEntry(core.entries('main')[0]); });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await unmountPage();
      await act(async () => { sidebarRoot?.unmount(); });
      sidebarRoot = undefined;
      sidebarContainer?.remove();
      unsubscribeMain();
      unsubscribeSidebar();
      container.remove();
      await fork.dispose();
      unmountFrame();
      await ctx.fiber.dispose();
    },
    async unloadPlugin() { await act(async () => { await fork.dispose(); }); },
    async reloadPlugin(next: typeof client = plugin) {
      await act(async () => { await fork.dispose(); });
      await act(async () => { fork = ctx.plugin(next, config); await fork.await(); });
    },
  };
}

export function button(container: ParentNode, text: string): HTMLButtonElement {
  const element = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text);
  if (!element) throw new Error(`Button ${JSON.stringify(text)} not found in ${container.textContent}`);
  return element;
}

export async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

export function field(container: ParentNode, label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const labelElement = [...container.querySelectorAll('label')].find((item) => item.textContent?.trim().startsWith(label));
  const control = labelElement?.control;
  if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) {
    throw new Error(`Field ${JSON.stringify(label)} not found in ${container.textContent}`);
  }
  return control;
}

export async function fill(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    // Use the native setter so React's value tracker sees a browser input change.
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

export async function submit(container: ParentNode) {
  const form = container.querySelector('form');
  if (!form) throw new Error('No form is mounted');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
