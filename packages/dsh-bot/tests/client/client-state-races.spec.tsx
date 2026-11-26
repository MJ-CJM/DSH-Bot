// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPollingCatalog } from '../../src/client/state.js';
import { createGroupActions, type GroupActions } from '../../src/client/groups-state.js';
import { GroupConversation, GroupsPanel } from '../../src/client/components/GroupsPanel.js';
import { GroupModelControl } from '../../src/client/components/GroupModelControl.js';
import { SharedMemoryPanel, type SharedMemoryBinding } from '../../src/client/components/SharedMemoryPanel.js';
import { RosterManagement } from '../../src/client/components/RosterManagement.js';
import { MemoryConsolidation } from '../../src/client/components/MemoryConsolidation.js';
import { ManagementWorkspace } from '../../src/client/components/ManagementWorkspace.js';
import { SettingsDrafts, useSettingsDraft, useSettingsNavigation } from '../../src/client/components/SettingsNavigation.js';
import { TeamRecipes } from '../../src/client/components/TeamRecipes.js';
import { registerGroupDetails } from '../../src/client/group-details.js';
import { useBotsPage } from '../../src/client/pages/use-bots-page.js';
import { BotsTab } from '../../src/client/pages/BotsTab.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import type { ModelActions } from '../../src/client/model-catalog-state.js';
import type { IntegrationActions } from '../../src/client/integrations-state.js';
import type { TeamRecipe } from '../../src/shared/team-recipes.js';
import type { SharedMemoryCatalog } from '../../src/client/shared-memory-state.js';
import { bots, configure, summary, view } from './group-fixture.js';
import { bot, button, click, field, fill, mountClient } from './helpers.js';
import { requireValue } from './test-required.js';
import en from '../../locale/en.json';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) =>
  en.ui[key].replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? `{${name}}`))) as PropsLocale<'dsh-bot'>['t'];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function mountNode() {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    element.remove();
  });
  return { element, root };
}

describe('Area 1: createPollingCatalog superseded refresh races & live group verification', () => {
  it('awaits superseding refresh and connection/reset reads instead of resolving early with stale data', async () => {
    const ctx = new Context();
    cleanups.push(() => ctx.fiber.dispose());
    const d1 = deferred<{ version: number }>();
    const d2 = deferred<{ version: number }>();
    const d3 = deferred<{ version: number }>();
    const load = vi.fn<() => Promise<{ version: number }>>()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise)
      .mockReturnValueOnce(d3.promise);
    const catalog = createPollingCatalog(ctx, { version: 0 }, load);
    const unsub = catalog.subscribe(() => {});
    // Initial subscribe started d1.
    expect(load).toHaveBeenCalledTimes(1);
    d1.resolve({ version: 1 });
    await settle();
    expect(catalog.getSnapshot().version).toBe(1);

    // Caller A starts refresh (d2), then Caller B supersedes it (d3).
    let firstDone = false;
    const first = catalog.refresh().then(() => { firstDone = true; });
    const second = catalog.refresh();
    await settle();
    expect(firstDone).toBe(false);
    expect(catalog.getSnapshot().version).toBe(1);

    // Superseding read resolves with fresh post-mutation data.
    d3.resolve({ version: 3 });
    await first;
    expect(firstDone).toBe(true);
    expect(catalog.getSnapshot().version).toBe(3);
    await second;

    // Late resolution from aborted d2 must never clobber version 3.
    d2.resolve({ version: 2 });
    await settle();
    expect(catalog.getSnapshot().version).toBe(3);

    // Now supersede an in-flight refresh() with a scheduler connection/reset read.
    const d4 = deferred<{ version: number }>();
    const d5 = deferred<{ version: number }>();
    load.mockReturnValueOnce(d4.promise).mockReturnValueOnce(d5.promise);
    let resetWaitDone = false;
    const waitReset = catalog.refresh().then(() => { resetWaitDone = true; });
    ctx.emit('connection/reset');
    await settle();
    expect(resetWaitDone).toBe(false);
    d5.resolve({ version: 5 });
    await waitReset;
    expect(catalog.getSnapshot().version).toBe(5);
    d4.resolve({ version: 4 });
    await settle();
    expect(catalog.getSnapshot().version).toBe(5);

    // Unsubscribing last listener (stop) and dispose still settle pending refresh immediately without hanging.
    const d6 = deferred<{ version: number }>();
    load.mockReturnValueOnce(d6.promise);
    const stoppedRefresh = catalog.refresh();
    unsub();
    await stoppedRefresh;
    expect(catalog.getSnapshot().version).toBe(5);

    const d7 = deferred<{ version: number }>();
    load.mockReturnValueOnce(d7.promise);
    const disposedRefresh = catalog.refresh();
    catalog.dispose();
    await disposedRefresh;
  });

  it('prevents false modelLoadFailed, refreshRoster failure, and stale SharedMemoryPanel rebase when refresh is superseded', async () => {
    const ctx = new Context();
    cleanups.push(() => ctx.fiber.dispose());

    // 1. GroupModelControl: superseded models.catalog.refresh() does not report modelLoadFailed.
    const m1 = deferred<{ providers: Array<{ id: string; name: string; available: boolean; models: Array<{ provider: string; id: string; name: string }> }> }>();
    const m2 = deferred<{ providers: Array<{ id: string; name: string; available: boolean; models: Array<{ provider: string; id: string; name: string }> }> }>();
    const modelLoad = vi.fn().mockReturnValueOnce(m1.promise).mockReturnValueOnce(m2.promise);
    const modelCatalog = createPollingCatalog(ctx, { providers: [] as Array<{ id: string; name: string; available: boolean; models: Array<{ provider: string; id: string; name: string }> }> }, modelLoad);
    const models = { catalog: modelCatalog, modelInfo: vi.fn(async () => ({ provider: 'p', id: 'm', name: 'M' })) } as unknown as ModelActions;
    const actions = { remote: () => ({ setModel: vi.fn() }), catalog: { refresh: vi.fn(async () => {}) }, modelMetadata: new Map() } as unknown as GroupActions;
    const { element, root } = mountNode();
    await act(async () => root.render(<GroupModelControl group={view().group} members={view().members} bots={bots} actions={actions} models={models} t={t} />));
    const trigger = requireValue(element.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]'));
    await act(async () => { trigger.click(); });
    // Supersede the menu's initial catalog.refresh() before m1 resolves.
    const superseding = modelCatalog.refresh();
    await settle();
    expect(element.textContent).not.toContain(en.ui['groups.modelLoadFailed']);
    m2.resolve({ providers: [{ id: 'p', name: 'P', available: true, models: [{ provider: 'p', id: 'm', name: 'Fresh model' }] }] });
    await act(async () => { await superseding; await settle(); });
    expect(element.textContent).not.toContain(en.ui['groups.modelLoadFailed']);
    m1.resolve({ providers: [] });

    // 2. groups-state.ts refreshRoster: superseded catalog refresh completes with updated state without error.
    const data = view();
    const list1 = deferred<RemoteResult<ReturnType<typeof summary>[]>>();
    const list2 = deferred<RemoteResult<ReturnType<typeof summary>[]>>();
    const listFn = vi.fn().mockReturnValueOnce(list1.promise).mockReturnValueOnce(list2.promise);
    ctx.provide('remote.dshBot.groups', {
      list: listFn,
      view: vi.fn(async () => ({ ok: true, value: data })),
    } as unknown as GroupMethods);
    const groupActions = createGroupActions(ctx, {});
    const rosterRefresh = groupActions.refreshRoster({ groupId: data.group.id, groupCreatedAt: data.group.createdAt });
    const concurrentList = groupActions.catalog.refresh();
    list2.resolve({ ok: true, value: [summary()] });
    await expect(rosterRefresh).resolves.toBeUndefined();
    await concurrentList;
    list1.resolve({ ok: false, error: new RemoteError('store/unavailable', 'stale', {}) });
    await settle();
    expect(groupActions.catalog.getSnapshot().error).toBeUndefined();

    // 3. SharedMemoryPanel rebase awaits superseding catalog read and shows fresh comparison.
    const owner = { botId: 'alpha', botCreatedAt: 1 };
    const makeRow = (versionId: string, revision: number, content: string) => ({
      state: 'active' as const,
      version: {
        memoryId: 'mem-1',
        versionId,
        scope: 'shared' as const,
        revision,
        kind: 'user_fact' as const,
        status: 'active' as const,
        provenance: { bot: owner },
        recordedAt: 1,
        trust: 'candidate' as const,
        labels: { readers: 'shared' as const },
        sourceRefs: [],
      },
      payload: { content, qualifiers: {}, valid: { from: null, to: null, basis: 'unknown' as const } },
    });
    const initialRow = makeRow('ver-1', 1, 'Old content');
    const freshRow = makeRow('ver-2', 2, 'Fresh rebased content');
    type SharedPage = { input: { scope: 'shared'; view: 'facts'; query: string }; rows: ReturnType<typeof makeRow>[]; total: number; revision: number };
    const s1 = deferred<SharedPage>();
    const s2 = deferred<SharedPage>();
    const sharedLoad = vi.fn<() => Promise<SharedPage>>()
      .mockResolvedValueOnce({ input: { scope: 'shared', view: 'facts', query: '' }, rows: [initialRow], total: 1, revision: 1 })
      .mockReturnValueOnce(s1.promise)
      .mockReturnValueOnce(s2.promise);
    const baseShared = createPollingCatalog<SharedPage>(ctx, { input: { scope: 'shared', view: 'facts', query: '' }, rows: [initialRow], total: 1, revision: 1 }, sharedLoad);
    const sharedCatalog: SharedMemoryCatalog = {
      ...baseShared,
      select: vi.fn(),
      nextPage: vi.fn(),
    } as unknown as SharedMemoryCatalog;
    const binding: SharedMemoryBinding = {
      catalog: sharedCatalog,
      remote: () => ({
        autoShareStatus: async () => ({ ok: true, value: { enabled: false, revision: 1 } }),
        cleanupStatuses: async () => ({ ok: true, value: [] }),
      }) as unknown as ReturnType<SharedMemoryBinding['remote']>,
      refresh: async () => { await sharedCatalog.refresh(); },
    };
    const panelMount = mountNode();
    await act(async () => panelMount.root.render(<SharedMemoryPanel binding={binding} scope="shared" botId="alpha" t={t} />));
    await click(button(panelMount.element, en.ui['memory.edit']));
    const rebaseBtn = button(panelMount.element, en.ui['shared.compare']);
    await act(async () => { rebaseBtn.click(); });
    const supersedeShared = sharedCatalog.refresh();
    s2.resolve({ input: { scope: 'shared', view: 'facts', query: '' }, rows: [freshRow], total: 1, revision: 2 });
    await act(async () => { await supersedeShared; await settle(); });
    expect(panelMount.element.textContent).toContain('Fresh rebased content');
    s1.resolve({ input: { scope: 'shared', view: 'facts', query: '' }, rows: [initialRow], total: 1, revision: 1 });
  });

  it('useBotsPage reads fresh getCatalogSnapshot() synchronously after onRefresh() during create recovery', async () => {
    const created = bot({ id: 'fresh-bot', name: 'Fresh Bot' });
    let snapshot = { entries: [] as Array<{ bot: typeof created }>, loaded: true, loading: false, pollIntervalMs: 5_000 };
    const onStart = vi.fn(async () => {});
    const onRefresh = vi.fn(async () => {
      // Simulate store update synchronously before React re-renders.
      snapshot = { ...snapshot, entries: [{ bot: created }] };
    });
    const onCreate = vi.fn(async () => { throw new Error('transport lost'); });
    const activitySnap = { bots: [], sessions: [], loaded: true, loading: false, pollIntervalMs: 5_000 };
    const sessionsSnap = { byId: {}, projectionsBySession: {} } as never;
    const workspacesSnap = { items: [], archivedSessionIds: new Set() } as never;
    const noopAsync = async () => {};
    const noop = () => {};
    const onCountMemories = async () => 0;
    const onEnsureHome = async () => '/home';
    const onEnsureBotsWorkspace = async () => '/ws';
    const getPreferredWorkspace = () => '';
    const createMemoryPanel = () => { throw new Error('unused'); };
    const getCatalogSnapshot = () => snapshot;
    let model!: ReturnType<typeof useBotsPage>;
    function Harness() {
      model = useBotsPage({
        useCatalog: (sel) => sel(snapshot),
        useActivity: (sel) => sel(activitySnap),
        useSessionCatalog: (sel) => sel(sessionsSnap),
        useWorkspaceCatalog: (sel) => sel(workspacesSnap),
        useBotDetail: (sel) => sel(undefined),
        onDetailConsumed: noop,
        onCountMemories,
        createMemoryPanel,
        onCreate,
        onUpdate: noopAsync,
        onDuplicate: noopAsync,
        onDelete: noopAsync,
        onStart,
        onStartInWorkspace: noopAsync,
        onOpenSession: noopAsync,
        onEnsureHome,
        onEnsureBotsWorkspace,
        onRefresh,
        getCatalogSnapshot,
        onPollInterval: noop,
        getPreferredWorkspace,
        t,
      });
      return null;
    }
    const { root } = mountNode();
    await act(async () => root.render(<Harness />));
    await act(async () => { model.open({ kind: 'create' }); });
    await act(async () => {
      await model.save({ id: 'fresh-bot', name: 'Fresh Bot' });
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith('fresh-bot', expect.any(AbortSignal));
  });

  it('GroupsPanel membership-changed uses live remote.view() bound to mount lifetime and keeps operationId on unmount', async () => {
    const ctx = new Context();
    cleanups.push(() => ctx.fiber.dispose());
    const data = view();
    data.group.mode = 'natural';
    const updatedView = structuredClone(data);
    updatedView.group.membershipRevision = 2;

    let holdConflictView = false;
    let releaseConflictView: ((result: RemoteResult<ReturnType<typeof view>>) => void) | undefined;
    const conflictViewEntered = deferred<void>();
    const remoteView = vi.fn<GroupMethods['view']>(async () => {
      if (holdConflictView) {
        holdConflictView = false;
        conflictViewEntered.resolve();
        return new Promise(resolve => { releaseConflictView = resolve; });
      }
      return { ok: true, value: structuredClone(data) };
    });
    const remoteSend = vi.fn<GroupMethods['send']>(async () => {
      holdConflictView = true;
      throw { code: 'dsh-bot/conflict' };
    });
    ctx.provide('remote.dshBot.groups', {
      view: remoteView,
      list: async () => ({ ok: true, value: [summary()] }),
      send: remoteSend,
      cancel: vi.fn(),
    } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const element = document.createElement('div');
    document.body.append(element);
    let root: Root = createRoot(element);
    cleanups.push(async () => {
      await act(async () => root.unmount());
      element.remove();
    });
    const render = async () => {
      await act(async () => root.render(<GroupConversation workspace summary={summary()} actions={actions} bots={bots}
        expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={async () => {}} t={t} />));
      await vi.waitFor(() => expect(element.querySelector('textarea')).toBeTruthy());
    };
    const rootId = data.group.rootSessionId;
    await render();
    await fill(field(element, t('groups.message')), 'Conflict during navigation');
    await act(async () => { button(element, t('groups.send')).click(); });
    await conflictViewEntered.promise;
    const originalOpId = actions.draft(rootId).operation?.request.operationId;
    expect(originalOpId).toBeTruthy();

    // Unmount while conflict live remote.view() is still pending.
    await act(async () => root.unmount());
    await vi.waitFor(() => expect(actions.draft(rootId).sending).toBe(false));

    // Late resolution after unmount must NOT release operationId or flip errorCode to membership-changed.
    releaseConflictView?.({ ok: true, value: updatedView });
    await settle();
    expect(actions.draft(rootId).operation?.request.operationId).toBe(originalOpId);
    expect(actions.draft(rootId).errorCode).toBe('conflict');

    // Remount and retry while mounted: live remote.view() resolves with membershipRevision 2 -> releases operationId cleanly.
    root = createRoot(element);
    await render();
    holdConflictView = false;
    remoteSend.mockImplementationOnce(async () => {
      data.group.membershipRevision = 2;
      throw { code: 'dsh-bot/conflict' };
    });
    await click(button(element, t('groups.send')));
    expect(actions.draft(rootId).operation).toBeUndefined();
    expect(actions.draft(rootId).errorCode).toBe('membership-changed');
  });
});

describe('Area 2: RosterManagement and MemoryConsolidation lockout fixes', () => {
  it('RosterManagement unlocks cleanly when getMemberEditResult returns not-found in both save() and check()', async () => {
    const data = view();
    const gamma = bot({ id: 'gamma', name: 'Gamma' });
    const records = [...bots, gamma];
    data.members.push({ ...requireValue(data.members[0]), id: 'member:gamma', bot: { botId: gamma.id, botCreatedAt: gamma.createdAt }, order: 2 });
    const onClose = vi.fn();
    const editMembers = vi.fn<GroupMethods['editMembers']>();
    const getMemberEditResult = vi.fn<GroupMethods['getMemberEditResult']>();
    const actions = {
      remote: () => ({ editMembers, getMemberEditResult, view: vi.fn(async () => ({ ok: true, value: data })) }),
      refreshRoster: vi.fn(async () => {}),
      memberEdits: new Map(),
      canAddBot: () => true,
    } as unknown as GroupActions;
    const { element, root } = mountNode();
    let reopen!: () => void;
    function Harness() {
      const [open, setOpen] = useState(true);
      reopen = () => setOpen(true);
      return open ? <RosterManagement initial={data} actions={actions} bots={records} onClose={() => { onClose(); setOpen(false); }} t={t} /> : null;
    }
    await act(async () => root.render(<Harness />));

    // Case 1: save() transport fails, immediate getMemberEditResult returns 'not-found' -> unlocked immediately.
    editMembers.mockRejectedValueOnce(new Error('transport dropped before Host'));
    getMemberEditResult.mockImplementationOnce(async (_k, operationId) => ({ ok: true, value: { operationId, status: 'not-found' } }));
    await click(requireValue(element.querySelector<HTMLButtonElement>('[data-roster-member="gamma"] button:last-child')));
    await click(button(element, en.ui['integrations.save']));
    expect(actions.memberEdits?.size).toBe(0);
    expect(element.textContent).toContain(en.ui['groups.roster.failed']);
    expect(button(element, en.ui['integrations.save']).disabled).toBe(false);
    const firstOpId = requireValue(editMembers.mock.calls[0])[1].operationId;

    // Case 2: retry hits transport failure -> 'unknown' -> close & reopen -> check() returns 'not-found' -> unlocked & retryable!
    editMembers.mockRejectedValueOnce(new Error('transport lost'));
    getMemberEditResult.mockImplementationOnce(async (_k, operationId) => ({ ok: true, value: { operationId, status: 'unknown' } }));
    await click(button(element, en.ui['integrations.save']));
    expect(actions.memberEdits?.size).toBe(1);
    expect(button(element, en.ui['integrations.save']).disabled).toBe(true);
    await click(button(element, en.ui['actions.cancel']));
    await act(async () => { reopen(); });
    expect(button(element, en.ui['integrations.save']).disabled).toBe(true);

    getMemberEditResult.mockImplementationOnce(async (_k, operationId) => ({ ok: true, value: { operationId, status: 'not-found' } }));
    await click(button(element, en.ui['groups.roster.checkReceipt']));
    expect(actions.memberEdits?.size).toBe(0);
    expect(element.textContent).toContain(en.ui['groups.roster.failed']);
    expect(button(element, en.ui['integrations.save']).disabled).toBe(false);

    // Final retry succeeds with a brand-new operationId.
    editMembers.mockImplementationOnce(async (_k, input) => ({ ok: true, value: { operationId: input.operationId, status: 'saved', group: data.group } }));
    await click(button(element, en.ui['integrations.save']));
    expect(editMembers).toHaveBeenCalledTimes(3);
    expect(requireValue(editMembers.mock.calls[2])[1].operationId).not.toBe(firstOpId);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('MemoryConsolidation unlocks on definitive Host rejections while preserving pending on uncertain failures', async () => {
    const sourceId = '22222222-2222-4222-8222-222222222222';
    const runId = '33333333-3333-4333-8333-333333333333';
    let runs: Array<Record<string, unknown>> = [];
    const consolidate = vi.fn();
    const decideConsolidation = vi.fn();
    const binding = {
      refresh: vi.fn(async () => {}),
      remote: () => ({
        consolidate,
        decideConsolidation,
        consolidationStatus: async () => ({ ok: true, value: { enabled: true, revision: 4, runs } }),
        query: async () => ({ ok: true, value: { revision: 4, rows: [{ version: { versionId: sourceId }, payload: { content: 'Fact' } }], total: 1 } }),
      }),
    } as unknown as SharedMemoryBinding;
    const { element, root } = mountNode();
    await act(async () => root.render(<MemoryConsolidation binding={binding} botId="alpha" defaultRoute={{ provider: 'p', model: 'm' }} t={t} />));
    await act(async () => {
      const details = requireValue(element.querySelector('details'));
      details.open = true;
      details.dispatchEvent(new Event('toggle', { bubbles: true }));
    });
    await click(requireValue(element.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')));

    // Definitive rejections clear pending.current and keep the form enabled.
    for (const code of ['bot/invalid', 'memory/disabled', 'memory/invalid'] as const) {
      consolidate.mockResolvedValueOnce({ ok: false, error: { code } });
      await click(button(element, en.ui['memory.consolidation.generate']));
      expect(requireValue(element.querySelector('fieldset')).disabled).toBe(false);
      expect([...element.querySelectorAll('button')].some(b => b.textContent === en.ui['memory.consolidation.reconcile'])).toBe(false);
      expect(element.querySelector('[role="alert"]')?.textContent).toBe(en.ui['memory.saveError']);
    }

    // Secret rejection during decideConsolidation unlocks textarea so user can edit secret out.
    runs = [{ id: runId, state: 'proposed', content: 'Candidate text', sourceIds: [sourceId], expiresAt: Date.now() + 60_000, provider: 'p', model: 'm', modelRequests: 1 }];
    await click(button(element, en.ui['memory.changes.refresh']));
    decideConsolidation.mockResolvedValueOnce({ ok: false, error: { code: 'memory/rejected' } });
    await click(button(element, en.ui['memory.consolidation.accept']));
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(en.ui['memory.secretRejected']);
    expect(requireValue(element.querySelector('textarea')).disabled).toBe(false);
    expect([...element.querySelectorAll('button')].some(b => b.textContent === en.ui['memory.consolidation.reconcile'])).toBe(false);

    // Uncertain error (gateway/internal) STILL preserves pending.current and offers Reconcile.
    consolidate.mockResolvedValueOnce({ ok: false, error: { code: 'gateway/internal' } });
    await click(button(element, en.ui['memory.consolidation.generate']));
    expect(requireValue(element.querySelector('fieldset')).disabled).toBe(true);
    expect(button(element, en.ui['memory.consolidation.reconcile'])).toBeTruthy();

    // Refresh reconciles and unlocks once Host reports the operation in runs.
    const pendingOpId = requireValue(consolidate.mock.calls.at(-1))[0].operationId;
    runs = [{ id: pendingOpId, state: 'unknown', unresolved: true, sourceIds: [sourceId], expiresAt: Date.now() + 60_000, provider: 'p', model: 'm', modelRequests: 1 }];
    await click(button(element, en.ui['memory.changes.refresh']));
    expect(requireValue(element.querySelector('fieldset')).disabled).toBe(false);
    expect([...element.querySelectorAll('button')].some(b => b.textContent === en.ui['memory.consolidation.reconcile'])).toBe(false);
  });
});

describe('Area 3: All 7 SettingsNavigation draft guards', () => {
  it('BotsPage guards My Bots, Recent, and Settings navigation when Groups has an unsaved draft', async () => {
    const app = await mountClient(bots, 'en', configure);
    cleanups.push(() => app.dispose());
    await click(button(app.container, en.ui['groups.title']));
    await click(button(app.container, en.ui['groups.create']));
    await fill(field(app.container, en.ui['groups.name']), 'Unsaved team');

    // Switching to My Bots opens unsaved confirmation.
    await click(button(app.container, en.ui['navigation.myBots']));
    expect(app.container.querySelector('dialog')?.textContent).toContain(en.ui['navigation.unsaved']);
    await click(button(requireValue(app.container.querySelector('dialog')), en.ui['navigation.keepEditing']));
    expect(field(app.container, en.ui['groups.name']).value).toBe('Unsaved team');

    // Switching to Settings opens unsaved confirmation; Discard enters Settings and clears the hidden draft.
    await click(requireValue(app.container.querySelector<HTMLButtonElement>('[data-settings-navigation]')));
    expect(app.container.querySelector('dialog')?.textContent).toContain(en.ui['navigation.unsaved']);
    await click(button(requireValue(app.container.querySelector('dialog')), en.ui['navigation.discardLeave']));
    expect(app.container.querySelector('h1')?.textContent).toBe(en.ui['chat.settings']);

    // Returning from Settings has no spurious unsaved dialog.
    await click(requireValue(app.container.querySelector<HTMLButtonElement>('[data-settings-navigation]')));
    expect(app.container.querySelector('dialog')).toBeNull();
  });

  it('GroupsPanel guards onCreate with leave() and clears dirty state after creationSaved', async () => {
    const ctx = new Context();
    cleanups.push(() => ctx.fiber.dispose());
    const saved = view().group;
    const create = vi.fn<GroupMethods['create']>(async () => ({ ok: true, value: saved }));
    const open = vi.fn<GroupMethods['open']>().mockRejectedValueOnce(new Error('open failed'));
    ctx.provide('remote.dshBot.groups', {
      create,
      open,
      list: async () => ({ ok: true, value: [summary()] }),
      view: async () => ({ ok: true, value: view() }),
    } as unknown as GroupMethods);
    ctx.provide('uiWorkspace', { openSession: vi.fn() } as never);
    const actions = createGroupActions(ctx, {});
    const onCreateFinished = vi.fn();
    const { element, root } = mountNode();
    await act(async () => root.render(<GroupsPanel actions={actions} bots={bots} onOpenSession={async () => {}} onCreateFinished={onCreateFinished} t={t} />));

    // Start creating, type a name, then click Create again -> must prompt instead of silently resetting.
    await click(button(element, en.ui['groups.create']));
    await fill(field(element, en.ui['groups.name']), 'Draft A');
    await click(button(element, en.ui['groups.create']));
    expect(element.querySelector('dialog')?.textContent).toContain(en.ui['navigation.unsaved']);
    await click(button(requireValue(element.querySelector('dialog')), en.ui['navigation.keepEditing']));
    expect(field(element, en.ui['groups.name']).value).toBe('Draft A');

    // Save succeeds on Host, open fails -> creationSaved=true -> clicking Close must NOT show unsaved prompt.
    const form = requireValue(element.querySelector('form'));
    for (const box of form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      if (!box.checked) await click(box);
    }
    await click(button(form, en.ui['integrations.save']));
    await vi.waitFor(() => expect(element.textContent).toContain(en.ui['groups.createdOpenFailed']));
    await click(button(form, en.ui['groups.close']));
    expect(element.querySelector('dialog')).toBeNull();
    expect(onCreateFinished).toHaveBeenCalledOnce();
  });

  it('ManagementWorkspace guards Bot context switch standalone without an outer SettingsDrafts provider', async () => {
    const records = [bot({ id: 'alpha', name: 'Alpha' }), { ...bot({ id: 'beta', name: 'Beta' }), createdAt: 2 }];
    const emptyInt = { definitions: [], assignments: [], runtime: [], notifications: [], policies: [], unread: 0, imSupported: false, defaults: { dailyLimit: 20, cooldownSec: 60 }, loaded: true, loading: false, pollIntervalMs: 5_000 };
    const integrations = {
      catalog: { subscribe: () => () => {}, getSnapshot: () => emptyInt, refresh: async () => {} },
      credentials: () => undefined,
      connectors: () => ({}),
      notifications: () => ({}),
      write: async (fn: () => Promise<unknown>) => fn(),
    } as unknown as IntegrationActions;
    const { element, root } = mountNode();
    await act(async () => root.render(<ManagementWorkspace integrations={integrations} bots={records} createMemoryPanel={() => { throw new Error('unused'); }} onOpenSession={async () => {}} t={t} />));
    await click(button(element, en.ui['connectors.newConnector']));
    await fill(field(element, en.ui['integrations.label']), 'Standalone draft');
    const select = field(element, en.ui['integrations.bot']) as HTMLSelectElement;
    await act(async () => { select.value = 'beta'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(element.querySelector('dialog')?.textContent).toContain(en.ui['navigation.unsaved']);
    await click(button(requireValue(element.querySelector('dialog')), en.ui['navigation.keepEditing']));
    expect(select.value).toBe('alpha');
    expect(field(element, en.ui['integrations.label']).value).toBe('Standalone draft');
    await act(async () => { select.value = 'beta'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(button(requireValue(element.querySelector('dialog')), en.ui['navigation.discardLeave']));
    expect(select.value).toBe('beta');
    expect(element.querySelector('form')).toBeNull();
  });

  it('GroupDetails provides SettingsDrafts so dirty GroupRosterEditor guards closing and switching tabs', async () => {
    const ctx = new Context();
    cleanups.push(() => ctx.fiber.dispose());
    const data = view();
    const gamma = bot({ id: 'gamma', name: 'Gamma' });
    const records = [...bots, gamma];
    data.members.push({ ...requireValue(data.members[0]), id: 'member:gamma', bot: { botId: gamma.id, botCreatedAt: gamma.createdAt }, order: 2 });
    const groupSum = { ...summary(), members: data.members };
    let registeredTab: ((props: Record<string, unknown>) => React.ReactNode) | undefined;
    const toggleExpanded = vi.fn();
    ctx.provide('locale', { bind: () => t } as never);
    ctx.provide('sidebarRight', { isExpanded: () => true, toggleExpanded, mounted: { getSnapshot: () => data.group.rootSessionId }, openTab: vi.fn() } as never);
    ctx.provide('sidebarRightTabs', { register: () => () => {} } as never);
    ctx.provide('slots', {
      inject: (_name: string, factory: () => () => void) => factory(),
      register: (_meta: unknown, component: (props: Record<string, unknown>) => React.ReactNode) => {
        registeredTab = component;
        return () => {};
      },
    } as never);
    ctx.provide('remote.dshBot.groups', { view: async () => ({ ok: true, value: data }), list: async () => ({ ok: true, value: [groupSum] }) } as unknown as GroupMethods);
    const groupActions = createGroupActions(ctx, {});
    await groupActions.catalog.refresh();
    const botSnapshot = { entries: records.map(b => ({ bot: b })), loaded: true, loading: false, pollIntervalMs: 5_000 };
    const botCatalog = {
      subscribe: () => () => {},
      getSnapshot: () => botSnapshot,
    };
    registerGroupDetails(ctx, {
      actions: groupActions,
      bots: botCatalog as never,
      work: { list: async () => [], tasks: {} as never, integrations: {} as never, openSession: async () => {} },
      openOrigin: async () => {},
      stopWork: async () => {},
      openBot: async () => {},
    });
    await vi.waitFor(() => expect(registeredTab).toBeTruthy());
    const TabComponent = requireValue(registeredTab);
    const { element, root } = mountNode();
    await act(async () => root.render(<TabComponent sessionId={data.group.rootSessionId} useTabInfo={() => ({ tab: { visible: true, navigation: { revision: 1, params: { id: data.group.id, createdAt: data.group.createdAt } } } })} t={t} />));
    await click(button(element, en.ui['groups.members']));
    await vi.waitFor(() => expect(element.querySelector('[data-group-edit-members]')).toBeTruthy());
    await click(requireValue(element.querySelector<HTMLButtonElement>('[data-group-edit-members]')));
    await click(requireValue(element.querySelector<HTMLButtonElement>('[data-roster-member="gamma"] button:last-child')));

    // Clicking Close on GroupDetails header must prompt instead of closing immediately!
    const headerClose = requireValue(element.querySelector<HTMLButtonElement>('header button'));
    await click(headerClose);
    expect(toggleExpanded).not.toHaveBeenCalled();
    expect(element.textContent).toContain(en.ui['navigation.unsaved']);
  });

  it('BotsTab guards switching away from Work tab when an unmounting Work form has an unsaved draft', async () => {
    const record = bot({ id: 'alpha', name: 'Alpha' });
    const feedbackActions = {
      view: vi.fn(async () => ({ candidates: [], datasets: [] })),
      contexts: vi.fn(async () => [{ label: 'Task 1', origin: { bot: { botId: record.id, botCreatedAt: record.createdAt }, taskId: 'task-1', sourceKind: 'manual' } }]),
      act: vi.fn(),
      readSkill: vi.fn(),
    };
    const workSnapshot = {
      status: {
        state: 'ready', configEpoch: 1, policyVersion: 1,
        capabilities: { externalNotification: false, automaticGroup: false },
      },
      suggestions: [],
      work: [],
      responsibilities: [],
      loaded: true,
      loading: false,
      pollIntervalMs: 5_000,
    };
    const ownerCatalog = {
      subscribe: () => () => {},
      getSnapshot: () => workSnapshot,
      refresh: async () => {},
      dispose: () => {},
    };
    const proactiveWork = () => ownerCatalog;
    const page = {
      proactive: {},
      proactiveWork,
      proactiveFeedback: feedbackActions,
      onOpenSession: async () => {},
      onUpdate: async () => {},
      onStart: async () => {},
      t,
    } as unknown as Parameters<typeof BotsTab>[0]['page'];
    const model = {
      selected: { bot: record, status: { id: record.id, presetId: 'p', preset: { state: 'ok' as const } } },
      showDetail: true,
      tab: 'bots' as const,
      section: 'bots' as const,
      busy: false,
      navigating: false,
      ready: true,
      backElement: { current: null },
      detailDestination: { requestId: 1, botId: record.id, section: 'work' as const },
      onDetailTargetReached: () => {},
      returnFromDetail: vi.fn(),
      navigate: vi.fn(),
      cancelNavigation: vi.fn(),
      open: vi.fn(),
      setToast: vi.fn(),
      rows: [],
      locale: 'en',
    } as unknown as Parameters<typeof BotsTab>[0]['model'];
    const { element, root } = mountNode();
    await act(async () => root.render(<BotsTab page={page} model={model} />));
    await vi.waitFor(() => expect(element.querySelector('[data-feedback-workflow]')).toBeTruthy());
    await fill(field(element, en.ui['proactive.feedbackReason']), 'Unsaved feedback draft');

    // Switching away from Work must prompt because FeedbackWorkspace unmounts!
    await click(button(element, en.ui['detail.overview']));
    expect(element.querySelector('dialog')?.textContent).toContain(en.ui['navigation.unsaved']);
    await click(button(requireValue(element.querySelector('dialog')), en.ui['navigation.keepEditing']));
    expect(field(element, en.ui['proactive.feedbackReason']).value).toBe('Unsaved feedback draft');

    // Discarding allows switching to Overview.
    await click(button(element, en.ui['detail.overview']));
    await click(button(requireValue(element.querySelector('dialog')), en.ui['navigation.discardLeave']));
    expect(element.querySelector('[data-feedback-workflow]')).toBeNull();
  });

  it('RosterManagement and TeamRecipes clear parent dirty state after Cancel -> Keep editing -> undo', async () => {
    const data = view();
    const gamma = bot({ id: 'gamma', name: 'Gamma' });
    const records = [...bots, gamma];
    data.members.push({ ...requireValue(data.members[0]), id: 'member:gamma', bot: { botId: gamma.id, botCreatedAt: gamma.createdAt }, order: 2 });
    const actions = {
      remote: () => ({ view: async () => ({ ok: true, value: data }) }),
      memberEdits: new Map(),
      canAddBot: () => true,
    } as unknown as GroupActions;
    const parentLeft = vi.fn();
    function RosterParent() {
      const parentNav = useSettingsNavigation(t);
      return <SettingsDrafts.Provider value={parentNav.registry}>
        <button type="button" data-parent-leave="" onClick={() => parentNav.leave(parentLeft)}>Parent leave</button>
        <RosterManagement initial={data} actions={actions} bots={records} onClose={() => {}} t={t} />
        {parentNav.confirmation}
      </SettingsDrafts.Provider>;
    }
    const rMount = mountNode();
    await act(async () => rMount.root.render(<RosterParent />));
    const gammaToggle = () => requireValue(rMount.element.querySelector<HTMLButtonElement>('[data-roster-member="gamma"] button:last-child'));
    await click(gammaToggle());
    await click(button(rMount.element, en.ui['actions.cancel']));
    await click(button(requireValue(rMount.element.querySelectorAll('dialog')[1]), en.ui['navigation.keepEditing']));
    // Undo the change: parent dirty flag must clear immediately!
    await click(gammaToggle());
    await click(requireValue(rMount.element.querySelector<HTMLButtonElement>('[data-parent-leave]')));
    expect(parentLeft).toHaveBeenCalledOnce();

    // Same regression check for TeamRecipes: Close -> Keep editing -> restore matching preview -> parent leave succeeds!
    const recipe: TeamRecipe = {
      format: 'dsh-bot-team', version: 1, name: 'Swap', mode: 'natural', onDemand: false,
      roles: [
        { id: 'role-0', role: 'Lead', preferredBotId: 'alpha', template: 'standard' },
        { id: 'role-1', role: 'Peer', preferredBotId: 'beta', template: 'standard' },
      ],
    };
    const twoMembers = data.members.slice(0, 2);
    const twoView = { ...data, members: twoMembers };
    const swappedPreview = {
      recipe,
      roles: [
        { roleId: 'role-0', bot: twoMembers[0]!.bot, match: 'preferred', capabilityMatch: true, candidates: records.map(r => ({ bot: { botId: r.id, botCreatedAt: r.createdAt }, name: r.name, template: 'standard' })) },
        { roleId: 'role-1', bot: { botId: gamma.id, botCreatedAt: gamma.createdAt }, match: 'preferred', capabilityMatch: true, candidates: records.map(r => ({ bot: { botId: r.id, botCreatedAt: r.createdAt }, name: r.name, template: 'standard' })) },
      ],
    };
    const restoredPreview = {
      recipe,
      roles: [
        swappedPreview.roles[0]!,
        { ...swappedPreview.roles[1]!, bot: twoMembers[1]!.bot },
      ],
    };
    const teamPreview = vi.fn().mockResolvedValueOnce({ ok: true, value: swappedPreview }).mockResolvedValueOnce({ ok: true, value: restoredPreview });
    const teamActions = {
      remote: () => ({
        teamList: async () => ({ ok: true, value: [] }),
        teamCapture: async () => ({ ok: true, value: recipe }),
        teamPreview,
      }),
      memberEdits: new Map(),
    } as unknown as GroupActions;
    const teamParentLeft = vi.fn();
    function TeamParent() {
      const parentNav = useSettingsNavigation(t);
      return <SettingsDrafts.Provider value={parentNav.registry}>
        <button type="button" data-team-parent-leave="" onClick={() => parentNav.leave(teamParentLeft)}>Leave</button>
        <TeamRecipes view={twoView} bots={records} actions={teamActions} onSaved={async () => {}} onClose={() => {}} t={t} />
        {parentNav.confirmation}
      </SettingsDrafts.Provider>;
    }
    const tMount = mountNode();
    await act(async () => tMount.root.render(<TeamParent />));
    await vi.waitFor(() => expect(tMount.element.querySelector('[data-team-preview]')).toBeTruthy());
    await click(button(tMount.element, en.ui['groups.close']));
    await click(button(requireValue(tMount.element.querySelector('dialog')), en.ui['navigation.keepEditing']));
    // Restore role-1 back to beta so memberDraft becomes false.
    const roleSelect = requireValue(tMount.element.querySelector<HTMLSelectElement>('select[aria-label="Peer"]'));
    await act(async () => {
      roleSelect.value = JSON.stringify(twoMembers[1]!.bot);
      roleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(requireValue(tMount.element.querySelector<HTMLButtonElement>('[data-team-parent-leave]')));
    expect(teamParentLeft).toHaveBeenCalledOnce();
  });

  it('useSettingsDraft stays isolated to dirty flag and clears cleanly on unmount', async () => {
    const left = vi.fn();
    let setShow!: (v: boolean) => void;
    function Child() { useSettingsDraft(true); return <span>child</span>; }
    function Parent() {
      const [show, update] = useState(true);
      setShow = update;
      const nav = useSettingsNavigation(t);
      return <SettingsDrafts.Provider value={nav.registry}>
        {show && <Child />}
        <button type="button" onClick={() => nav.leave(left)}>Go</button>
        {nav.confirmation}
      </SettingsDrafts.Provider>;
    }
    const { element, root } = mountNode();
    await act(async () => root.render(<Parent />));
    await act(async () => setShow(false));
    await click(button(element, 'Go'));
    expect(left).toHaveBeenCalledOnce();
  });
});
