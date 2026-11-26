// @vitest-environment jsdom
import { StrictMode, act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialEditor } from '../../src/client/components/CredentialEditor.js';
import { TransferPanel } from '../../src/client/components/BotTransferPanel.js';
import { NotificationsPanel } from '../../src/client/components/NotificationsPanel.js';
import { GroupConversation } from '../../src/client/components/GroupsPanel.js';
import { GroupExportQueue } from '../../src/client/components/GroupExportQueue.js';
import { GroupExportSettings } from '../../src/client/components/GroupExportSettings.js';
import { GroupModelControl } from '../../src/client/components/GroupModelControl.js';
import { GroupDeleteDialog } from '../../src/client/components/GroupDeleteDialog.js';
import { GroupOverview } from '../../src/client/components/GroupOverview.js';
import { RoutinePanel } from '../../src/client/components/RoutinePanel.js';
import { CollaborationPanel } from '../../src/client/components/CollaborationPanel.js';
import { BackgroundTasksPanel } from '../../src/client/components/BackgroundTasksPanel.js';
import { GroupComposerInput } from '../../src/client/components/GroupComposer.js';
import { registerGroupDetails } from '../../src/client/group-details.js';
import { WorkspaceMessage } from '../../src/client/workspace-group.js';
import { createGroupActions, type GroupActions } from '../../src/client/groups-state.js';
import { createPollingCatalog } from '../../src/client/state.js';
import { EMPTY_BOARD, type CollaborationActions } from '../../src/client/collaboration-state.js';
import type { RoutineActions } from '../../src/client/automation-state.js';
import type { BackgroundActions } from '../../src/client/background-work-state.js';
import type { IntegrationActions } from '../../src/client/integrations-state.js';
import type { WorkspaceActions } from '../../src/client/workspace-state.js';
import type { ModelActions } from '../../src/client/model-catalog-state.js';
import type { BotsPageInjected } from '../../src/client/pages/bots-page-types.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import type { GroupDelivery } from '../../src/shared/groups.js';
import { policySchema } from '../../src/shared/integrations.js';
import { botExportSchema, importPreviewSchema } from '../../src/shared/workspace.js';
import { bots, summary, view } from './group-fixture.js';
import { bot, button, click, field, fill, mountClient } from './helpers.js';
import { openProfile } from './bot-ui-helpers.js';
import { requireValue } from './test-required.js';
import en from '../../locale/en.json';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) =>
  en.ui[key].replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? `{${name}}`))) as PropsLocale<'dsh-bot'>['t'];

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

describe('Area 4: Stuck, swallowed, and misdirected client state errors', () => {
  it('CredentialEditor preserves secret on failure and while busy, clearing only after set() succeeds', async () => {
    const set = vi.fn<(_ref: string, _val: string) => Promise<{ ok: boolean; error?: unknown }>>();
    const actions = { credentials: () => ({ describe: vi.fn(), set }) } as unknown as IntegrationActions;
    const perform = vi.fn(async (fn: () => Promise<unknown>) => {
      try { await fn(); } catch { /* handled by parent frame */ }
    });
    const { element, root } = mountNode();

    // First: while busy=true, clicking store does not clear secret or invoke perform.
    const render = (busy: boolean) => act(async () => root.render(
      <CredentialEditor actions={actions} credential="API_KEY" active busy={busy} perform={perform} t={t} />,
    ));
    await render(false);
    const input = field(element, en.ui['connectors.secret']) as HTMLInputElement;
    await fill(input, 'MY_SECRET_1');
    await render(true);
    await act(async () => { button(element, en.ui['connectors.storeCredential']).click(); });
    expect(input.value).toBe('MY_SECRET_1');
    expect(set).not.toHaveBeenCalled();

    // Second: set() fails -> secret is preserved for retry.
    await render(false);
    set.mockResolvedValueOnce({ ok: false, error: new RemoteError('dsh-bot/unavailable', 'down', {}) });
    await click(button(element, en.ui['connectors.storeCredential']));
    expect(set).toHaveBeenCalledWith('API_KEY', 'MY_SECRET_1');
    expect(input.value).toBe('MY_SECRET_1');

    // Third: set() succeeds -> secret is cleared.
    set.mockResolvedValueOnce({ ok: true });
    await click(button(element, en.ui['connectors.storeCredential']));
    expect(set).toHaveBeenCalledTimes(2);
    expect(input.value).toBe('');
  });

  it('BotTransferPanel refreshes Bot catalog after successful import and clears error on edit', async () => {
    const doc = botExportSchema.parse({ format: 'dsh-bot-export', version: 1, bot: { name: 'Imported' } });
    const preview = importPreviewSchema.parse({
      id: 'preview:1', newId: 'imported-bot', digest: 'd', files: [], memories: 0,
      connectorRefs: [], missingConnectorRefs: [], conflict: false, phase: 'preview',
    });
    const workspace = vi.fn(async (input: { action: string }) => {
      if (input.action === 'preview') return { ok: true as const, value: { kind: 'preview' as const, preview } };
      if (input.action === 'import') return { ok: true as const, value: { kind: 'preview' as const, preview: { ...preview, phase: 'committed' as const } } };
      return { ok: false as const, error: new RemoteError('dsh-bot/invalid', 'bad', {}) };
    });
    const refreshBots = vi.fn(async () => {});
    const actions = { workspace, graph: vi.fn(), createGraph: vi.fn(), refreshBots } as unknown as WorkspaceActions;
    const { element, root } = mountNode();
    await act(async () => root.render(<TransferPanel actions={actions} t={t} />));

    // Invalid JSON triggers error; editing document clears the error.
    await fill(field(element, en.ui['manage.document']), 'not-json');
    await fill(field(element, en.ui['manage.newId']), 'imported-bot');
    await click(button(element, en.ui['manage.preview']));
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(en.ui['manage.failed']);
    await fill(field(element, en.ui['manage.document']), JSON.stringify(doc));
    expect(element.querySelector('[role="alert"]')).toBeNull();

    // Preview + Confirm import triggers refreshBots().
    await click(button(element, en.ui['manage.preview']));
    await click(button(element, en.ui['manage.confirmImport']));
    expect(refreshBots).toHaveBeenCalledOnce();
  });

  it('BotDialogs Duplicate modal renders Host errors inline and clears copyInvalid when editing copyId', async () => {
    const entry = bot({ id: 'alpha', name: 'Alpha' });
    const app = await mountClient([entry], 'en');
    cleanups.push(() => app.dispose());
    await openProfile(app, 'en', 'alpha');
    await click(button(app.container, en.ui['card.more']));
    await click(button(document.body, en.ui['card.duplicate']));
    const dialog = requireValue(document.body.querySelector('dialog'));
    const input = field(dialog, en.ui['duplicate.id']) as HTMLInputElement;

    // Invalid ID shows validation error, and editing copyId immediately clears it.
    await fill(input, 'INVALID ID!');
    await click(button(dialog, en.ui['duplicate.action']));
    expect(dialog.textContent).toContain(en.ui['validation.id']);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await fill(input, 'valid-copy');
    expect(dialog.textContent).not.toContain(en.ui['validation.id']);
    expect(input.getAttribute('aria-invalid')).toBe('false');

    // Host duplicate error renders INSIDE the modal dialog (not hidden behind backdrop).
    app.remote.methods.duplicate.mockResolvedValueOnce({ ok: false, error: new RemoteError('bot/conflict', 'Already exists', {}) });
    await click(button(dialog, en.ui['duplicate.action']));
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Already exists');
  });

  it('NotificationsPanel keeps tab on Bot switch and separates policy preapproved vs test-send confirmations', async () => {
    const records = [bot({ id: 'alpha', name: 'Alpha' }), { ...bot({ id: 'beta', name: 'Beta' }), createdAt: 2 }];
    const existingPolicy = policySchema.parse({
      id: 'pol-1', owner: { botId: 'alpha', botCreatedAt: 1 }, channel: 'in-app', enabled: true,
      timezone: 'UTC', dailyLimit: 20, cooldownSec: 60, authorization: { mode: 'preapproved' },
      revision: 1, createdAt: 1, updatedAt: 1, schemaVersion: 1, scopeDigest: 'scope-1', targetDigest: 'in-app',
    });
    const data = {
      definitions: [], assignments: [], runtime: [], notifications: [], policies: [existingPolicy],
      unread: 0, imSupported: false, defaults: { dailyLimit: 20, cooldownSec: 60 },
      loaded: true, loading: false, pollIntervalMs: 5_000,
    };
    const actions = {
      catalog: { subscribe: () => () => {}, getSnapshot: () => data, refresh: async () => {} },
      notifications: () => ({ savePolicy: vi.fn(), test: vi.fn(), markRead: vi.fn() }),
      connectors: () => ({}),
      credentials: () => undefined,
      write: async (fn: () => Promise<unknown>) => fn(),
    } as unknown as IntegrationActions;
    const { element, root } = mountNode();
    await act(async () => root.render(<NotificationsPanel actions={actions} bots={records} onOpenSession={async () => {}} t={t} />));

    // Switching Bot while on Records tab must stay on Records and NOT open a blank policy form.
    const recordsTab = button(element, en.ui['notifications.records']);
    expect(recordsTab.getAttribute('aria-selected')).toBe('true');
    const botSelect = field(element, en.ui['integrations.bot']) as HTMLSelectElement;
    await act(async () => { botSelect.value = 'beta'; botSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(recordsTab.getAttribute('aria-selected')).toBe('true');
    expect(element.querySelector('form')).toBeNull();

    // Switch back to alpha, open existing preapproved policy: scope checkbox and test-send checkbox must be independent!
    await act(async () => { botSelect.value = 'alpha'; botSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(button(element, en.ui['notifications.policies']));
    await click(button(element, 'pol-1 · in-app · v1'));
    const scopeBox = field(element, en.ui['notifications.confirmScope']) as HTMLInputElement;
    const sendBox = field(element, en.ui['notifications.confirmSend']) as HTMLInputElement;
    expect(scopeBox.checked).toBe(false);
    expect(sendBox.checked).toBe(false);
    await click(scopeBox);
    expect(scopeBox.checked).toBe(true);
    expect(sendBox.checked).toBe(false);
    await fill(field(element, en.ui['notifications.testText']), 'Hello test');
    expect(scopeBox.checked).toBe(true);
    await click(sendBox);
    expect(sendBox.checked).toBe(true);
    await click(scopeBox);
    expect(scopeBox.checked).toBe(false);
    expect(sendBox.checked).toBe(true);
  });

  it('GroupsPanel sets send-invalid for invalid followup combinations and clears definitive errors in updateTopic', async () => {
    const ctx = new Context();
    cleanups.push(() => ctx.fiber.dispose());
    const data = view();
    data.group.mode = 'natural';
    const jarvis = bot({ id: 'outside', name: 'Jarvis' });
    const catalogBots = [bot({ id: 'alpha', name: 'Alpha' }), bot({ id: 'beta', name: 'Beta' }), jarvis];
    ctx.provide('remote.dshBot.groups', {
      view: async () => ({ ok: true, value: data }),
      list: async () => ({ ok: true, value: [summary()] }),
      send: vi.fn(async () => { throw { code: 'dsh-bot/relay-topic-required' }; }),
    } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const { element, root } = mountNode();
    await act(async () => root.render(<GroupConversation workspace summary={summary()} actions={actions} bots={catalogBots}
      expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={async () => {}} t={t} />));
    await vi.waitFor(() => expect(element.querySelector('textarea')).toBeTruthy());

    // 1. Followup + replyTo triggers client-side guard -> errorCode 'send-invalid' (NOT bare setError(true)), clears on edit.
    const rootId = data.group.rootSessionId;
    await act(async () => actions.patchDraft(rootId, old => ({
      ...old,
      text: 'Invalid followup with reply',
      followup: { turnId: 'turn:1', deliveryId: 'delivery:1' },
      replyTo: data.messages[0],
    })));
    await click(button(element, t('groups.send')));
    expect(actions.draft(rootId).errorCode).toBe('send-invalid');
    expect(element.textContent).toContain(en.ui['groups.sendInvalid']);
    await fill(field(element, en.ui['groups.message']), 'Edited draft clears send-invalid');
    expect(actions.draft(rootId).error).toBe(false);
    expect(actions.draft(rootId).errorCode).toBeUndefined();

    // 2. Relay topic edit clears definitive errorCode ('relay-topic-required').
    await act(async () => actions.patchDraft(rootId, old => ({ ...old, followup: undefined, replyTo: undefined })));
    await fill(field(element, en.ui['groups.message']), '@Beta ask Jarvis: anything about this?');
    await fill(field(element, en.ui['groups.relay.topicLabel']), 'Initial topic');
    await click(button(element, t('groups.send')));
    expect(actions.draft(rootId).errorCode).toBe('relay-topic-required');
    await fill(field(element, en.ui['groups.relay.topicLabel']), 'Updated clear topic');
    expect(actions.draft(rootId).error).toBe(false);
    expect(actions.draft(rootId).errorCode).toBeUndefined();
  });

  it('GroupExportQueue preserves changed receipt across membershipRevision updates', async () => {
    const data = view();
    const key = { groupId: data.group.id, groupCreatedAt: data.group.createdAt };
    data.turns = [{
      id: 'turn:1', group: key, operationId: 'op:1', requestDigest: 'd', inputMessageId: 'q:1',
      createdAt: 1, updatedAt: 1, revision: 1, schemaVersion: 1, membershipRevision: 1,
      orderedMemberIds: ['member:alpha', 'member:beta'], mode: 'natural', state: 'partial', contextThroughSeq: 1,
    }];
    data.messages = [{ id: 'q:1', seq: 1, at: 1, text: 'Question', turnId: 'turn:1', authorKind: 'user' }];
    data.deliveries = [{
      id: 'delivery:0', turnId: 'turn:1', revision: 1, memberId: 'member:alpha', ordinal: 0,
      bot: data.members[0]!.bot, botRevision: 1, presetId: 'bot-alpha',
      contextOutputMessageIds: [], contextTruncated: false, state: 'failed',
      reasonCode: 'export-approval-required', exportFlowId: crypto.randomUUID(), stopReason: 'completed',
    } satisfies GroupDelivery];
    const reviewExport = vi.fn().mockRejectedValueOnce({ code: 'dsh-bot/conflict' });
    const refresh = vi.fn(async () => {});
    const actions = {
      remote: () => ({ reviewExport, decideExport: vi.fn(), discardExport: vi.fn(), closeStaleExports: vi.fn() }),
      messageView: () => ({ refresh }),
      catalog: { refresh },
    } as unknown as GroupActions;
    const { element, root } = mountNode();
    const render = () => act(async () => root.render(<GroupExportQueue view={structuredClone(data)} bots={bots} actions={actions} t={t} />));
    await render();
    await click(button(element, t('groups.export.queueCount', { count: 1 })));
    await click(button(element, en.ui['groups.export.review']));
    expect(element.textContent).toContain(en.ui['groups.export.receipt.changed']);

    // Re-render after membershipRevision bumps (delivery revision also bumps while still pending): receipt must NOT vanish.
    data.group.membershipRevision = 2;
    data.turns[0]!.membershipRevision = 2;
    data.deliveries[0]!.revision = 2;
    await render();
    expect(element.textContent).toContain(en.ui['groups.export.receipt.changed']);

    // Even if the delivery becomes stale (no longer pending), the explicit 'changed' receipt remains visible & clearable.
    data.group.membershipRevision = 3;
    await render();
    expect(element.textContent).toContain(en.ui['groups.export.receipt.changed']);
    await click(button(element, en.ui['groups.export.clearReceipts']));
    expect(element.textContent).not.toContain(en.ui['groups.export.receipt.changed']);
  });

  it('GroupExportSettings clears load problem after successful reload while preserving save problem across its refresh', async () => {
    const data = view();
    const getExportApprovalSettings = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({
        ok: true,
        value: {
          groupRevision: 2, membershipRevision: 1,
          readers: data.members.map(m => ({ bot: m.bot, name: m.bot.botId })),
          eligibleBots: data.members.map(m => m.bot), enabledBots: [], canEnable: true,
        },
      });
    const setExportApproval = vi.fn().mockRejectedValueOnce({ code: 'dsh-bot/conflict' });
    const actions = {
      remote: () => ({ getExportApprovalSettings, setExportApproval }),
      catalog: { refresh: async () => {} },
      messageView: () => ({ refresh: async () => {} }),
    } as unknown as GroupActions;
    const { element, root } = mountNode();
    await act(async () => root.render(<GroupExportSettings group={data.group} actions={actions} bots={bots} onSaved={async () => {}} t={t} />));
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(en.ui['groups.export.policyLoadFailed']);

    // Revision bump triggers reload -> succeeds -> clears 'load' problem automatically.
    await act(async () => root.render(<GroupExportSettings group={{ ...data.group, revision: 2 }} actions={actions} bots={bots} onSaved={async () => {}} t={t} />));
    expect(element.querySelector('[role="alert"]')).toBeNull();

    // Save conflict sets 'changed' and triggers finally reload -> 'changed' alert must stay visible.
    await click(requireValue(element.querySelector<HTMLButtonElement>('[data-export-policy-action]')));
    await click(requireValue(element.querySelector<HTMLButtonElement>('[data-export-policy-confirm]')));
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(en.ui['groups.export.policyChanged']);
  });

  it('GroupModelControl lets user dismiss saveError after conflict refreshes modelRevision', async () => {
    const group = view().group;
    const setModel = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'dsh-bot/conflict' } });
    const snapshot = {
      loaded: true, loading: false, error: undefined,
      providers: [{ id: 'p', name: 'P', available: true, models: [{ provider: 'p', id: 'm', name: 'New Model' }] }],
    };
    const models = { catalog: { getSnapshot: () => snapshot, refresh: async () => {} }, modelInfo: vi.fn() } as unknown as ModelActions;
    const actions = { remote: () => ({ setModel }), catalog: { refresh: async () => {} }, modelMetadata: new Map() } as unknown as GroupActions;
    const { element, root } = mountNode();
    const render = (g = group) => act(async () => root.render(
      <GroupModelControl group={g} members={view().members} bots={bots} actions={actions} models={models} t={t} />,
    ));
    await render();
    await click(requireValue(element.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')));
    await click(requireValue([...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent?.startsWith(en.ui['groups.modelGroupDefault']))));
    await click(button(element, 'New Model'));

    // Conflict refreshed modelRevision -> Retry is disabled, Dismiss clears the alert cleanly.
    await render({ ...group, modelRevision: 5 });
    expect(button(element, en.ui['groups.modelRetry']).disabled).toBe(true);
    await click(requireValue(element.querySelector<HTMLButtonElement>('[data-model-error-dismiss]')));
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it('GroupDeleteDialog unlocks stale deleteBusy when running clears or user clicks refresh', async () => {
    const ctx = new Context();
    cleanups.push(() => ctx.fiber.dispose());
    const row = summary();
    let currentRow = { ...row, running: false };
    const deleteGroup = vi.fn<GroupMethods['deleteGroup']>()
      .mockImplementationOnce(async () => {
        currentRow = { ...row, running: true };
        throw { code: 'dsh-bot/busy' };
      })
      .mockResolvedValueOnce({ ok: true, value: true });
    ctx.provide('remote.dshBot.groups', {
      list: async () => ({ ok: true, value: [currentRow] }),
      deleteGroup,
    } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    const { element, root } = mountNode();
    await act(async () => root.render(<GroupDeleteDialog group={row.group} actions={actions} onDeleted={onDeleted} onClose={onClose} t={t} />));
    await vi.waitFor(() => expect(button(element, en.ui['groups.delete']).disabled).toBe(false));

    // Late busy failure -> refresh reports running:true -> Delete disabled.
    await click(button(element, en.ui['groups.delete']));
    expect(element.textContent).toContain(en.ui['groups.deleteBusy']);
    expect(button(element, en.ui['groups.delete']).disabled).toBe(true);

    // Work finishes: running transitions true -> false -> stale deleteBusy error clears automatically!
    currentRow = { ...row, running: false };
    await act(async () => actions.catalog.refresh());
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(button(element, en.ui['groups.delete']).disabled).toBe(false);

    // Retry succeeds cleanly.
    await click(button(element, en.ui['groups.delete']));
    expect(deleteGroup).toHaveBeenCalledTimes(2);
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it('GroupOverview sorts members by order when toggling onDemand', async () => {
    const ctx = new Context();
    cleanups.push(() => ctx.fiber.dispose());
    const data = view();
    data.group.mode = 'natural';
    // Deliberately reverse array order relative to member.order (0 and 1).
    const [first, second] = data.members;
    data.members = [requireValue(second), requireValue(first)];
    const edit = vi.fn<GroupMethods['edit']>(async () => ({ ok: true, value: data.group }));
    ctx.provide('remote.dshBot.groups', {
      view: async () => ({ ok: true, value: data }),
      list: async () => ({ ok: true, value: [summary()] }),
      edit,
      getExportApprovalSettings: async () => ({
        ok: true,
        value: { groupRevision: 1, membershipRevision: 1, readers: [], eligibleBots: [], enabledBots: [], canEnable: false },
      }),
    } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const { element, root } = mountNode();
    await act(async () => root.render(<GroupOverview summary={summary()} actions={actions} bots={bots} section="settings" t={t} />));
    const toggle = requireValue([...element.querySelectorAll('label')].find(l => l.textContent === en.ui['teams.onDemand'])?.querySelector('input'));
    await click(toggle);
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      { groupId: data.group.id, groupCreatedAt: data.group.createdAt },
      expect.objectContaining({
        members: [requireValue(first).bot, requireValue(second).bot],
        onDemand: true,
      }),
    );
  });

  it('onEditPersona returns cleanly on navigation.aborted and checks draft result before openSession', async () => {
    const entry = bot({ id: 'alpha', name: 'Alpha' });
    const app = await mountClient([entry], 'en');
    cleanups.push(() => app.dispose());
    const init = vi.fn(() => 'blocked' as const);
    app.ctx.provide('conversation', { input: { requestDraftInitialization: init }, send: vi.fn() } as never);
    const ready = { ctx: app.ctx };
    Object.assign(app.ctx.sessions, {
      using: vi.fn(async (_id: unknown, _opts: unknown, fn: (ref: unknown) => Promise<void>) => fn({ ready: Promise.resolve(ready) })),
    });
    const page = app.main.inject?.() as unknown as BotsPageInjected;

    // 1. Draft initialization blocked -> throws persona.draftBlocked and NEVER opens session!
    await expect(page.onEditPersona?.(entry)).rejects.toThrow(en.ui['persona.draftBlocked']);
    expect(app.openSession).not.toHaveBeenCalled();

    // 2. Navigation aborted mid-flight -> returns cleanly (no throw, no openSession).
    const beginNavigation = vi.spyOn(app.ctx.layout, 'beginNavigation').mockReturnValueOnce({ aborted: true } as never);
    await expect(page.onEditPersona?.(entry)).resolves.toBeUndefined();
    expect(app.openSession).not.toHaveBeenCalled();
    beginNavigation.mockRestore();
  });
});

describe('Area 5: WorkspaceMessage AbortSignal & StrictMode catalog/trigger lifecycles', () => {
  it('WorkspaceMessage passes AbortSignal to quotedMessage and aborts pagination on unmount', async () => {
    const ctx = new Context();
    cleanups.push(() => ctx.fiber.dispose());
    let releaseFirstPage!: (value: { ok: true; value: ReturnType<typeof view> }) => void;
    const remoteView = vi.fn<GroupMethods['view']>(async () => new Promise(resolve => { releaseFirstPage = resolve; }));
    ctx.provide('remote.dshBot.groups', {
      view: remoteView,
      list: async () => ({ ok: true, value: [summary()] }),
    } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const spyQuoted = vi.spyOn(actions, 'quotedMessage');
    const snapshot = { view: undefined };
    const wrappedActions = {
      ...actions,
      messageView: () => ({ subscribe: () => () => {}, getSnapshot: () => snapshot }),
    } as unknown as GroupActions;
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    await act(async () => root.render(
      <WorkspaceMessage
        node={{ data: { group: { groupId: 'group:one', groupCreatedAt: 1 }, message: { id: 'm2', seq: 2, at: 1, text: 'Reply', turnId: 't1', authorKind: 'user', replyTo: 'missing-old' } } } as never}
        actions={wrappedActions}
        onOpenSession={async () => {}}
        t={t}
      />,
    ));
    expect(spyQuoted).toHaveBeenCalledOnce();
    const signal = requireValue(spyQuoted.mock.calls[0]?.[2]);
    expect(signal.aborted).toBe(false);
    expect(remoteView).toHaveBeenCalledTimes(1);

    // Unmount aborts signal -> resolving page 1 with hasEarlier=true MUST NOT fetch page 2.
    await act(async () => root.unmount());
    element.remove();
    expect(signal.aborted).toBe(true);
    const page1 = view();
    page1.hasEarlier = true;
    page1.messages = [{ id: 'm1', seq: 5, at: 1, text: 'Other', turnId: 't0', authorKind: 'user' }];
    releaseFirstPage({ ok: true, value: page1 });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(remoteView).toHaveBeenCalledTimes(1);
  });

  it('all 7 disposable catalog/trigger sites load cleanly under React 18 StrictMode double-effect replay', async () => {
    const ctx = new Context();
    cleanups.push(() => ctx.fiber.dispose());
    const data = view();
    data.group.mode = 'natural';
    ctx.provide('remote.dshBot.groups', {
      view: async () => ({ ok: true, value: data }),
      list: async () => ({ ok: true, value: [summary()] }),
    } as unknown as GroupMethods);
    const groupActions = createGroupActions(ctx, {});
    await groupActions.catalog.refresh();

    // 1. GroupOverview under StrictMode
    const m1 = mountNode();
    await act(async () => m1.root.render(<StrictMode><GroupOverview summary={summary()} actions={groupActions} bots={bots} t={t} /></StrictMode>));
    await vi.waitFor(() => expect(m1.element.querySelector('[data-group-overview="group:one"]')).toBeTruthy());

    // 2. GroupConversation (workspace=false) under StrictMode
    const m2 = mountNode();
    await act(async () => m2.root.render(<StrictMode><GroupConversation workspace={false} summary={summary()} actions={groupActions} bots={bots} expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={async () => {}} t={t} /></StrictMode>));
    await vi.waitFor(() => expect(m2.element.querySelector('textarea')).toBeTruthy());

    // 3. GroupDetails -> GroupMaterials under StrictMode
    let detailsTab: ((props: Record<string, unknown>) => React.ReactNode) | undefined;
    ctx.provide('locale', { bind: () => t } as never);
    ctx.provide('sidebarRight', { isExpanded: () => true, toggleExpanded: vi.fn(), mounted: { getSnapshot: () => data.group.rootSessionId }, openTab: vi.fn() } as never);
    ctx.provide('sidebarRightTabs', { register: () => () => {} } as never);
    ctx.provide('slots', {
      inject: (_name: string, factory: () => () => void) => factory(),
      register: (_meta: unknown, component: (props: Record<string, unknown>) => React.ReactNode) => {
        detailsTab = component;
        return () => {};
      },
    } as never);
    const strictBotSnapshot = { entries: bots.map(b => ({ bot: b })), loaded: true, loading: false, pollIntervalMs: 5_000 };
    registerGroupDetails(ctx, {
      actions: groupActions,
      bots: { subscribe: () => () => {}, getSnapshot: () => strictBotSnapshot } as never,
      work: { list: async () => [], tasks: {} as never, integrations: {} as never, openSession: async () => {} },
      openOrigin: async () => {},
      stopWork: async () => {},
      openBot: async () => {},
    });
    await vi.waitFor(() => expect(detailsTab).toBeTruthy());
    const DetailsComp = requireValue(detailsTab);
    const m3 = mountNode();
    await act(async () => m3.root.render(<StrictMode><DetailsComp sessionId={data.group.rootSessionId} useTabInfo={() => ({ tab: { visible: true, navigation: { revision: 1, params: { id: data.group.id, createdAt: data.group.createdAt } } } })} t={t} /></StrictMode>));
    await click(button(m3.element, en.ui['botMode.materials']));
    await vi.waitFor(() => expect(m3.element.querySelector('[data-group-materials]')).toBeTruthy());

    // 4. RoutinePanel DeliveryHistory under StrictMode
    const routineRecord = {
      id: 'sched-1', title: 'Daily check', prompt: 'Check', status: 'active', kind: 'every', everySeconds: 3600,
      scheduledAt: '2026-11-26T00:00:00.000Z', sessionId: 'sess-1', botId: 'alpha', botCreatedAt: 1, nativeScheduleId: 'sched-1',
    };
    const routineCatalog = createPollingCatalog(ctx, { routines: [routineRecord as never], legacy: [], legacyUnavailable: false, legacySkipped: 0, nativeAvailable: true }, async () => ({
      routines: [routineRecord as never], legacy: [], legacyUnavailable: false, legacySkipped: 0, nativeAvailable: true,
    }));
    const routineActions: RoutineActions = {
      catalog: routineCatalog,
      update: async () => {},
      remove: async () => {},
      deleteLegacy: async () => {},
      runNow: async () => {},
      history: () => {
        const cat = createPollingCatalog(ctx, { records: [] as never[], more: false, unavailable: false }, async () => ({
          records: [{ messageId: 'msg-hist-1', deliveredAt: '2026-11-26T00:00:00.000Z', scheduledAt: '2026-11-26T00:00:00.000Z', prompt: 'Delivered prompt' } as never],
          more: false, unavailable: false,
        }));
        return { ...cat, loadMore: async () => {} };
      },
    };
    const m4 = mountNode();
    await act(async () => m4.root.render(<StrictMode><RoutinePanel actions={routineActions} bots={bots} onOpenSession={async () => {}} t={t} /></StrictMode>));
    await vi.waitFor(() => expect(m4.element.querySelector('[data-routine-id="sched-1"]')).toBeTruthy());
    await click(button(m4.element, en.ui['routine.history']));
    await vi.waitFor(() => expect(m4.element.querySelector('[data-delivery-id="msg-hist-1"]')).toBeTruthy());

    // 5. CollaborationPanel Board under StrictMode
    const collabActions: CollaborationActions = {
      remote: () => ({}) as never,
      im: createPollingCatalog(ctx, { pin: '4645cf767257b4bc32c80f4f18e1f9f6cfbb5060' as const, installed: false, contractDetected: false, inboundSupported: false, outboundSupported: false, reason: 'plugin-missing' as const }, async () => ({
        pin: '4645cf767257b4bc32c80f4f18e1f9f6cfbb5060' as const, installed: false, contractDetected: false, inboundSupported: false, outboundSupported: false, reason: 'plugin-missing' as const,
      })),
      createBoard: () => createPollingCatalog(ctx, EMPTY_BOARD, async () => ({
        supported: true, members: [], tasks: [],
        link: { nativeTeamId: 'team-strict', leadSessionId: 'lead-1', revision: 1, bot: { botId: 'alpha', botCreatedAt: 1 } },
      }) as never),
    };
    const m5 = mountNode();
    await act(async () => m5.root.render(<StrictMode><CollaborationPanel actions={collabActions} bots={bots} onOpenSession={async () => {}} t={t} /></StrictMode>));
    await vi.waitFor(() => expect(m5.element.textContent).toContain('team-strict'));

    // 6. BackgroundTasksPanel under StrictMode
    const bgActions: BackgroundActions = {
      forBot: () => {
        const cat = createPollingCatalog(ctx, { tasks: [] as Array<{ address: { parentSessionId: string; childSessionId: string; mode: 'continuable' }; label: string; running: boolean }> }, async () => ({
          tasks: [{ address: { parentSessionId: 'main', childSessionId: 'child-strict', mode: 'continuable' as const }, label: 'Strict Task', running: true }],
        }));
        return { catalog: cat, open: async () => {}, supplement: async () => {}, stop: async () => {}, stopAll: async () => {}, dispose: () => cat.dispose() } as never;
      },
    };
    const m6 = mountNode();
    await act(async () => m6.root.render(<StrictMode><BackgroundTasksPanel bot={bots[0]!} actions={bgActions} t={t as never} /></StrictMode>));
    await vi.waitFor(() => expect(m6.element.textContent).toContain('Strict Task'));

    // 7. GroupComposerInput (@ mention trigger) under StrictMode
    function ComposerHarness() {
      const [text, setText] = useState('');
      const [bindings, setBindings] = useState<Array<{ start: number; end: number; text: string; memberId: string }>>([]);
      const ref = useRef<HTMLTextAreaElement>(null);
      return <GroupComposerInput sessionId="strict-session" text={text} bindings={bindings} targets={[{ id: 'm1', botId: 'alpha', name: 'Alpha' }]} inputRef={ref} onChange={(next, b) => { setText(next); setBindings(b); }} onSubmit={() => {}} t={t} />;
    }
    const m7 = mountNode();
    await act(async () => m7.root.render(<StrictMode><ComposerHarness /></StrictMode>));
    await fill(field(m7.element, en.ui['groups.message']), '@');
    await vi.waitFor(() => expect(Array.from(m7.element.querySelectorAll('[role="option"] strong'), el => el.textContent)).toEqual(['everyone', 'Alpha']));
  });
});
