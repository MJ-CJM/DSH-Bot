import type { BotsPageInjected } from '../../src/client/pages/BotsPage.js';
import { Context } from '@deepseek-ai/cordis';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SlotCore, type StoredEntry, resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { ISessions, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SidebarRightTabDefinition, SidebarRightTabInjected } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { type ComponentType, Profiler, act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { vi } from 'vitest';
import * as client from '../../src/client/index.js';
import * as primitives from './platform-primitives.js';
import * as inputTriggerPlatform from './platform-input-trigger.js';
import type {
  BotRecord,
} from '../../src/shared/schema.js';

import { remoteDouble } from './remote-double.js';
export { bot, remoteDouble } from './remote-double.js';

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
  const platformRequire = ((id: string) => id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : /^@deepseek-ai\/dsh-client-ui-input-trigger(?:\/client)?$/.test(id) ? inputTriggerPlatform : require(id)) as NodeJS.Require;
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
  rightSidebar = false,
  initialSessions: Partial<SessionListState> = {},
) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context();
  const core = new SlotCore();
  const rightSlotInjection: SidebarRightTabInjected = {
    hooks: { tabInfo: () => () => { throw new Error('This tab test does not supply docking geometry'); } },
  };
  const unmountFrame = core.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'sidebar.session.row.leading': { kind: 'list', scope: 'root' },
      'sidebar.session.row.hover': { kind: 'list', scope: 'root' },
      ...(rightSidebar ? {
        'sidebar.right.pane.tab': { kind: 'keyed' as const, scope: 'session' as const, inject: rightSlotInjection },
        'sidebar.right.pane.tab.title': { kind: 'keyed' as const, scope: 'session' as const, inject: rightSlotInjection },
        'conversation.hero.options': { kind: 'list' as const, scope: 'session' as const },
      } : {}),
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
  const mountRemote = vi.fn(async (contribution?: { package?: string }) => {
    if (contribution?.package === '@deepseek-ai/dsh-permission-presets') return ctx.provide('remote.permissionPresets', {
      catalog: vi.fn(async () => ({ ok: true, value: { options: [] } })),
    } as never);
    if (contribution?.package === 'dsh-bot/capabilities') return ctx.provide('remote.dshBot.capabilities', {
      request: vi.fn(async (input: { action: string }) => ({ ok: true, value: input.action === 'models'
        ? { kind: 'models', providers: [] } : { kind: 'inspect', online: false, skillsAvailable: false, skills: [], tools: [], ownSkills: [], extraDirs: [] } })),
    } as never);
    if (contribution?.package === 'dsh-bot/workspace') {
      const releases = [ctx.provide('remote.dshBot.workspace', remote.workspaceManagement),
        ctx.provide('remote.dshBot.referenceMemory', remote.referenceMemory)];
      return () => { for (const release of releases) release(); };
    }
    if (contribution?.package === 'dsh-bot/messaging') return ctx.provide('remote.dshBot.messaging', {
      request: async () => ({ ok: true as const, value: { enabled: true, nestedMessaging: false as const, pending: 0, items: [] } }),
    });
    if (contribution?.package === 'dsh-bot/groups') return ctx.provide('remote.dshBot.groups', remote.groups);
    if (contribution?.package === 'dsh-bot/collaboration') {
      const releases = [ctx.provide('remote.dshBot.collaboration', remote.collaboration), ctx.provide('remote.dshBot.im', remote.im)];
      return () => { for (const release of releases) release(); };
    }
    if (contribution?.package === 'dsh-bot/integrations') {
      const releases = [ctx.provide('remote.dshBot.connectors', remote.connectors), ctx.provide('remote.dshBot.notifications', remote.notifications)];
      return async () => { for (const release of releases) await release(); };
    }
    if (contribution?.package === '@deepseek-ai/dsh-subagent') return ctx.provide('remote.subagents', {
      prompt: vi.fn(async () => ({ ok: true, value: undefined })),
      interruptByParent: vi.fn(async () => ({ ok: true, value: undefined })),
    } as never);
    if (contribution?.package === '@deepseek-ai/dsh-schedule') return ctx.provide('remote.schedule', remote.schedule);
    if (contribution?.package === 'dsh-bot/automation') {
      const releases = [ctx.provide('remote.dshBot.nativeSchedule', remote.routine), ctx.provide('remote.dshBot.run', remote.run),
        ctx.provide('remote.dshBot.automation', remote.automation)];
      return async () => { for (const release of releases) await release(); };
    }
    remoteMounted = true;
    const release = ctx.provide('remote.dshBot', remote.methods);
    const releaseActivity = ctx.provide('remote.dshBot.activity', remote.methods.activity);
    const releaseMemory = ctx.provide('remote.dshBot.memory', remote.methods.memory);
    return async () => { remoteMounted = false; await releaseActivity(); await releaseMemory(); await release(); };
  });
  let remoteMounted = true;
  let rightSession: SessionId | undefined;
  const rightSessionListeners = new Set<() => void>();
  const rightMounted = {
    getSnapshot: () => rightSession,
    subscribe(listener: () => void) { rightSessionListeners.add(listener); return () => { rightSessionListeners.delete(listener); }; },
  };
  const updateRightSession = (id: SessionId | undefined) => {
    if (!rightSidebar || rightSession === id) return;
    rightSession = id;
    for (const listener of rightSessionListeners) listener();
  };
  const rightDefinitions = new Map<string, SidebarRightTabDefinition>();
  const registerRightTab = vi.fn((definition: SidebarRightTabDefinition) => {
    if (rightDefinitions.has(definition.id)) throw new Error('Duplicate sidebar tab definition');
    rightDefinitions.set(definition.id, definition);
    return () => { rightDefinitions.delete(definition.id); };
  });
  const openRightTab = vi.fn<Context['sidebarRight']['openTab']>();
  if (rightSidebar) {
    ctx.provide('sidebarRight', { mounted: rightMounted, openTab: openRightTab } as unknown as Context['sidebarRight']);
    ctx.provide('sidebarRightTabs', { register: registerRightTab } as unknown as Context['sidebarRightTabs']);
  }
  let navigation = new AbortController();
  const beginNavigation = () => { navigation.abort(); navigation = new AbortController(); return navigation.signal; };
  const openSession = vi.fn<Context['uiWorkspace']['openSession']>((id) => {
    beginNavigation(); updateRightSession(typeof id === 'string' ? id : id.childSessionId);
  });
  const selectPanel = vi.fn<Context['layout']['selectPanel']>(() => { beginNavigation(); updateRightSession(undefined); });
  ctx.provide('layout', { selectPanel, beginNavigation } as unknown as Context['layout']);
  const openWorkspace = vi.fn<Context['uiWorkspace']['openWorkspace']>(async (_id, beforeOpen) => {
    beginNavigation();
    beforeOpen?.('test-opened-session' as never);
    updateRightSession('test-opened-session' as SessionId);
  });
  let workspaceSnapshot: WorkspaceSnapshot = {
    items: [workspace()], state: 'idle', phase: 'ready', error: null, archivedSessionIds: [], pinnedSessionIds: [],
  };
  const workspaceListeners = new Set<() => void>();
  let sessionSnapshot: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {}, ...initialSessions };
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
  ctx.provide('remote', { $mount: mountRemote, $on: (name: string, fn: () => void) => ctx.on(name as 'schedule/changed', fn),
    schedule: remote.schedule, dshBot: remote.methods } as unknown as Context['remote']);
  const createSession = vi.fn<ISessions['create']>(async () => 'test-created-session' as SessionId);
  const createWorkspace = vi.fn<Context['workspaces']['create']>(async ({ path }) => ({ ...workspace('custom-workspace'), path }));
  const pickDirectory = vi.fn<Context['uiWorkspace']['pickDirectory']>(async () => null);
  ctx.provide('uiWorkspace', { openWorkspace, openSession, pickDirectory } as unknown as Context['uiWorkspace']);
  ctx.provide('workspaces', { list: workspaceSource, create: createWorkspace } as unknown as Context['workspaces']);
  ctx.provide('sessions', { list: sessionSource, create: createSession, refreshProjections: vi.fn(async () => {}) } as unknown as Context['sessions']);
  let fork = ctx.plugin(plugin, config);
  await fork.await();
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  const main = core.entries('main')[0];
  if (!main) throw new Error('Client did not register its main page');
  const renderCounts = new Map<StoredEntry, number>();
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
    target.render(<Profiler id="dsh-bot-test" onRender={() => renderCounts.set(entry, (renderCounts.get(entry) ?? 0) + 1)}>
      <Component {...runtime} {...injected} {...boundHooks} t={translate(entry.locale ?? 'dsh-bot')} />
    </Profiler>);
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
  type RightSurface = 'body' | 'title' | 'opener';
  const rightSurfaces = new Map<RightSurface, { container: HTMLDivElement; root: ReturnType<typeof createRoot> }>();
  let openerSessionId = '';
  let openerSeat = 'conversation.session.header.utilities';
  const renderRightSurface = (surface: RightSurface) => {
    const target = rightSurfaces.get(surface);
    if (!target) return;
    const slot = surface === 'body' ? 'sidebar.right.pane.tab' : surface === 'title' ? 'sidebar.right.pane.tab.title' : openerSeat;
    const entry = core.entries(slot).find((item) => surface === 'opener'
      ? item.options.id === 'dsh-bot-right-tab' : item.options.key === 'dsh-bot.right-bots');
    renderEntry(entry, target.root, surface === 'opener' ? { sessionId: openerSessionId } : {});
  };
  const mountRightSurface = async (surface: RightSurface) => {
    if (!rightSidebar) throw new Error('Right sidebar services are not enabled in this test');
    let target = rightSurfaces.get(surface);
    if (!target) {
      const element = document.createElement('div');
      document.body.append(element);
      target = { container: element, root: createRoot(element) };
      rightSurfaces.set(surface, target);
    }
    await act(async () => { renderRightSurface(surface); });
    return target.container;
  };
  const unmountRightSurface = async (surface: RightSurface) => {
    const target = rightSurfaces.get(surface);
    if (!target) return;
    await act(async () => { target.root.unmount(); });
    target.container.remove();
    rightSurfaces.delete(surface);
  };
  const rightSubscriptions = rightSidebar ? [
    core.subscribe('sidebar.right.pane.tab', () => renderRightSurface('body')),
    core.subscribe('sidebar.right.pane.tab.title', () => renderRightSurface('title')),
    core.subscribe('conversation.session.header.utilities', () => renderRightSurface('opener')),
    core.subscribe('conversation.hero.options', () => renderRightSurface('opener')),
  ] : [];
  return {
    ctx, core, remote, openWorkspace, openSession, createSession, createWorkspace, pickDirectory, selectPanel, mountRemote, container, main, dictionaries,
    renderCount: (entry: StoredEntry = main) => renderCounts.get(entry) ?? 0,
    sessionListeners,
    rightDefinitions, registerRightTab, openRightTab, rightSessionListeners,
    rightSession: () => rightSession,
    async setRightSession(id: string | undefined) { await act(async () => { updateRightSession(id as SessionId | undefined); }); },
    mountRightTab: () => mountRightSurface('body'),
    mountRightTitle: () => mountRightSurface('title'),
    async mountRightOpener(id: string, hero = false) {
      openerSessionId = id;
      openerSeat = hero ? 'conversation.hero.options' : 'conversation.session.header.utilities';
      return mountRightSurface('opener');
    },
    unmountRightTab: () => unmountRightSurface('body'),
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
        // Simulated authoritative main mapping for legacy Client fixtures. Host migration has separate real-store tests.
        remote.data.sessionRows = sessionSnapshot.ids.map(id => sessionSnapshot.byId[id]).filter((row): row is SessionSummary => Boolean(row));
        const actions = main.inject?.() as unknown as BotsPageInjected | undefined;
        await actions?.onRefresh();
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
      for (const surface of [...rightSurfaces.keys()]) await unmountRightSurface(surface);
      await act(async () => { sidebarRoot?.unmount(); });
      sidebarRoot = undefined;
      sidebarContainer?.remove();
      unsubscribeMain();
      unsubscribeSidebar();
      for (const unsubscribe of rightSubscriptions) unsubscribe();
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
  const element = [...container.querySelectorAll('button')].find((item) =>
    !item.closest('[hidden]') && (item.textContent?.trim() === text || item.getAttribute('aria-label') === text));
  if (!element) throw new Error(`Button ${JSON.stringify(text)} not found in ${container.textContent}`);
  return element;
}

export async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

export function field(container: ParentNode, label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const labelElement = [...container.querySelectorAll('label')].find((item) => !item.closest('[hidden]') && item.textContent?.trim().startsWith(label));
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
  const form = [...container.querySelectorAll('form')].find(form => !form.closest('[hidden]'));
  if (!form) throw new Error('No form is mounted');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

export async function doubleClick(element: HTMLElement) {
  await click(element);
  await click(element);
  await act(async () => { element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
}
