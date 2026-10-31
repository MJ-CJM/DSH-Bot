// @vitest-environment jsdom
import { act } from 'react';
import { Context } from '@deepseek-ai/cordis';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { GroupModelControl } from '../../src/client/components/GroupModelControl.js';
import type { ModelActions } from '../../src/client/model-catalog-state.js';
import type { GroupActions } from '../../src/client/groups-state.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import { GroupConversation } from '../../src/client/components/GroupsPanel.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import type { GroupRecord } from '../../src/shared/groups.js';
import type { GroupPermissionState, GroupPermissionSnapshot } from '../../src/client/group-permission-state.js';
import { bots, view, summary } from './group-fixture.js';
import { button, click, field, fill } from './helpers.js';
import en from '../../locale/en.json';
import oldLabels from '../../../../docs/implementation/v061-toolbar-locales.json';
import memberLabels from '../../../../docs/implementation/v062-model-locales.json';
const labels = { en: { ...oldLabels.en, ...memberLabels.en }, zh: { ...oldLabels.zh, ...memberLabels.zh } };

const mounted: { root: Root; element: HTMLDivElement }[] = [];
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove(); } });
async function mount(language: 'en' | 'zh' = 'en', initial?: GroupRecord['modelSelection']) {
  let group: GroupRecord = { ...view().group, ...(initial ? { modelSelection: initial } : {}) };
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element); mounted.push({ root, element });
  const setModel = vi.fn<GroupMethods['setModel']>(async (_key, input) => {
    group = { ...group, revision: group.revision + 1, modelRevision: (group.modelRevision ?? 0) + 1, ...(input.memberId ? { memberModelSelections: [
      ...(group.memberModelSelections ?? []).filter(row => row.memberId !== input.memberId),
      ...(input.modelSelection ? [{ memberId: input.memberId, modelSelection: input.modelSelection }] : []),
    ] } : { modelSelection: input.modelSelection ?? undefined }) };
    return { ok: true, value: group };
  });
  const refresh = vi.fn(async () => {}), observe = vi.fn(), subscribe = vi.fn();
  const snapshot = { loaded: true, loading: false, error: undefined as string | undefined, providers: [
    { id: 'native-provider', name: 'Native provider', available: true, models: [{ provider: 'native-provider', id: 'native-model', name: 'Native model' }] },
    { id: 'alternate-provider', name: 'Alternate provider', available: true, models: [{ provider: 'alternate-provider', id: 'alternate-model', name: 'Alternate model' }] },
    { id: 'offline', name: 'Offline provider', available: false, models: [{ provider: 'offline', id: 'blocked', name: 'Unavailable model' }] },
  ] };
  const modelInfo = vi.fn(async (provider: string, model: string) => ({ provider, id: model, name: 'Native model', reasoning: { efforts: [
    { id: 'native-effort', name: 'Native reasoning' }, { id: 'native-low', name: 'Native low' },
  ] } }));
  const models = { catalog: { getSnapshot: () => snapshot, refresh, observe, subscribe }, modelInfo } as unknown as ModelActions;
  const groupRefresh = vi.fn(async () => {}), onSaved = vi.fn(async () => {}), onBusyChange = vi.fn();
  const actions = { remote: () => ({ setModel }), catalog: { refresh: groupRefresh }, modelMetadata: new Map() } as unknown as GroupActions;
  const t = ((key: keyof typeof labels.en) => labels[language][key]) as PropsLocale<'dsh-bot'>['t'];
  const members = view().members;
  const configuredBots = bots.map((bot, index) => ({ ...bot, model: index === 0 ? { provider: 'bot-provider', model: 'Alpha bot model' } : undefined }));
  const render = async (record = group) => { await act(async () => root.render(<GroupModelControl group={record} members={members} bots={configuredBots} actions={actions} models={models} t={t} onSaved={onSaved} onBusyChange={onBusyChange} />)); };
  const trigger = () => { const button = element.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]'); if (!button) throw new Error('Missing model trigger'); return button; };
  const click = async (label: string) => { const button = [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'), ...element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label); if (!button) throw new Error(`Missing ${label}`); await act(async () => button.click()); };
  const open = async () => { await act(async () => trigger().click()); };
  const menuAction = async (key: 'groups.model' | 'groups.reasoning') => {
    const button = [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith(labels[language][key === 'groups.model' ? (element.querySelector('[data-model-member-id]') ? 'groups.modelGroupDefault' : 'groups.model') : key]));
    if (!button) throw new Error('Missing model menu action'); await act(async () => button.click());
  };
  await render();
  return { element, root, setModel, refresh, modelInfo, observe, subscribe, snapshot, models, actions, groupRefresh, onSaved, onBusyChange, t, members, configuredBots, trigger, click, open, menuAction, render, get group() { return group; } };
}
describe('group model control', () => {
  it.each(['en', 'zh'] as const)('%s loads the native catalog only on open and persists a group-scoped selection', async language => {
    const f = await mount(language);
    expect(f.trigger().textContent).toContain(f.t('groups.modelDefault'));
    expect(f.refresh).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled(); expect(f.subscribe).not.toHaveBeenCalled();
    await f.open(); expect(f.refresh).toHaveBeenCalledOnce(); await f.menuAction('groups.model');
    const offline = [...f.element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Unavailable model');
    expect(offline?.disabled).toBe(true);
    await f.click('Native model');
    expect(f.setModel).toHaveBeenCalledExactlyOnceWith({ groupId: 'group:one', groupCreatedAt: 1 }, {
      expectedModelRevision: 0, modelSelection: { provider: 'native-provider', model: 'native-model' },
    });
    expect(f.trigger().textContent).toContain('Native model'); expect(f.group.membershipRevision).toBe(1);
    expect(f.element.querySelector('[role="menu"]')).toBeNull();
    expect(f.onSaved).toHaveBeenCalledOnce();
  });
  it('uses native reasoning names and clears the override back to each Bot model', async () => {
    const f = await mount('en', { provider: 'native-provider', model: 'native-model' });
    await f.open(); expect(f.modelInfo).toHaveBeenCalledWith('native-provider', 'native-model');
    await f.menuAction('groups.reasoning'); await f.click('Native reasoning');
    expect(f.setModel.mock.calls[0]?.[1]).toEqual({ expectedModelRevision: 0, modelSelection: { provider: 'native-provider', model: 'native-model', reasoningEffort: 'native-effort' } });
    await f.open(); expect(f.trigger().textContent).toContain('Native reasoning');
    await f.menuAction('groups.reasoning'); await f.click(f.t('groups.reasoningDefault'));
    expect(f.setModel.mock.calls[1]?.[1]).toEqual({ expectedModelRevision: 1, modelSelection: { provider: 'native-provider', model: 'native-model' } });
    await f.open(); await f.click(f.t('groups.modelDefault'));
    expect(f.setModel.mock.calls[2]?.[1]).toEqual({ expectedModelRevision: 2, modelSelection: null });
    expect(f.trigger().textContent).toContain(f.t('groups.modelDefault'));
  });
  it('preserves the selected model after failed save and supports retry without changing draft state', async () => {
    const f = await mount('en', { provider: 'existing', model: 'Keep this model' });
    f.setModel.mockResolvedValueOnce({ ok: false, error: { code: 'group/conflict' } } as never);
    await f.open(); await f.menuAction('groups.model'); await f.click('Native model');
    expect(f.trigger().textContent).toContain('Keep this model'); expect(f.element.textContent).toContain(f.t('groups.modelSaveFailed'));
    expect(f.element.querySelector('[role="menu"]')).toBeNull();
    await f.click(f.t('groups.modelRetry'));
    expect(f.setModel).toHaveBeenCalledTimes(2); expect(f.trigger().textContent).toContain('Native model');
    expect(f.element.textContent).not.toContain(f.t('groups.modelSaveFailed'));
  });
  it('catalog failure keeps the selection and retries only when requested', async () => {
    const f = await mount('en', { provider: 'existing', model: 'Keep this model' });
    f.snapshot.error = 'offline'; await f.open();
    expect(f.element.textContent).toContain(f.t('groups.modelLoadFailed')); expect(f.trigger().textContent).toContain('Keep this model');
    expect(f.setModel).not.toHaveBeenCalled(); expect(f.refresh).toHaveBeenCalledOnce();
    f.snapshot.error = undefined; await f.click(f.t('groups.modelRetry'));
    expect(f.refresh).toHaveBeenCalledTimes(2); expect(f.element.textContent).not.toContain(f.t('groups.modelLoadFailed'));
  });
  it('ignores a late model receipt after switching to a different group identity', async () => {
    const f = await mount(); let settle!: (value: Awaited<ReturnType<GroupMethods['setModel']>>) => void;
    f.setModel.mockReturnValueOnce(new Promise(resolve => { settle = resolve; }));
    await f.open(); await f.menuAction('groups.model'); await f.click('Native model');
    expect(f.onBusyChange).toHaveBeenLastCalledWith(true);
    await f.render({ ...f.group, id: 'group:two', createdAt: 2, modelSelection: { provider: 'other', model: 'Second group model' } });
    expect(f.onBusyChange).toHaveBeenLastCalledWith(false);
    await act(async () => settle({ ok: true, value: { ...f.group, revision: 2, modelSelection: { provider: 'native-provider', model: 'native-model' } } }));
    expect(f.trigger().textContent).toContain('Second group model'); expect(f.onSaved).not.toHaveBeenCalled();
    expect(f.groupRefresh).not.toHaveBeenCalled();
  });
  it('keeps an accepted receipt when the post-save refresh fails', async () => {
    const f = await mount(); f.onSaved.mockRejectedValueOnce(new Error('offline'));
    await f.open(); await f.menuAction('groups.model'); await f.click('Native model');
    expect(f.trigger().textContent).toContain('Native model'); expect(f.element.textContent).not.toContain(f.t('groups.modelSaveFailed'));
  });
  it('uses model revision across background group updates and retains the newer model receipt', async () => {
    const f = await mount();
    await f.render({ ...f.group, revision: 99 });
    await f.open(); await f.menuAction('groups.model'); await f.click('Native model');
    expect(f.setModel.mock.calls[0]?.[1]).toEqual({ expectedModelRevision: 0, modelSelection: { provider: 'native-provider', model: 'native-model' } });
    // The cached background view has a larger general revision but an older
    // model revision. It must not shadow the accepted model setting.
    expect(f.trigger().textContent).toContain('Native model');
    await f.render({ ...f.group, revision: 200 });
    await f.open(); await f.menuAction('groups.reasoning'); await f.click('Native reasoning');
    expect(f.setModel.mock.calls[1]?.[1]).toEqual({ expectedModelRevision: 1, modelSelection: { provider: 'native-provider', model: 'native-model', reasoningEffort: 'native-effort' } });
    expect(f.trigger().textContent).toContain('Native reasoning');
  });
  it('keeps catalog names across group remounts without a background model request', async () => {
    const f = await mount('en', { provider: 'native-provider', model: 'native-model' });
    await f.open(); await f.menuAction('groups.reasoning'); await f.click('Native reasoning');
    const saved = f.group;
    await f.render({ ...saved, id: 'group:two', createdAt: 2, modelSelection: undefined });
    await f.render(saved);
    expect(f.trigger().textContent).toContain('Native model'); expect(f.trigger().textContent).toContain('Native reasoning');
    expect(f.refresh).toHaveBeenCalledOnce(); expect(f.modelInfo).toHaveBeenCalledOnce();
  });
  it.each(['en', 'zh'] as const)('%s shows each active member with its exact identity, effective model and source', async language => {
    const f = await mount(language);
    const [alpha, beta] = f.members; if (!alpha || !beta) throw new Error('Missing members');
    const inactive = { ...alpha, id: 'removed-member', removedAt: 2 };
    f.members.push(inactive, { ...beta, id: 'disabled-member', enabled: false });
    await f.render(); await f.open();
    const rows = [...f.element.querySelectorAll<HTMLElement>('[data-model-member-id]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Same name'); expect(rows[0]?.textContent).toContain('alpha');
    expect(rows[1]?.textContent).toContain('Same name'); expect(rows[1]?.textContent).toContain('beta');
    expect(rows[0]?.textContent).toContain('Alpha bot model'); expect(rows[0]?.dataset.modelSource).toBe(f.t('groups.modelSourceBot'));
    expect(rows[1]?.dataset.modelSource).toBe(f.t('groups.modelSourceDsh'));
    expect(rows[0]?.querySelector('svg')).toBeTruthy();
  });
  it('persists different models and reasoning per member, then clears only one override', async () => {
    const f = await mount('en', { provider: 'native-provider', model: 'native-model' });
    const member = async (id: string) => { await f.open(); const row = f.element.querySelector(`[data-model-member-id="${id}"]`)?.closest<HTMLButtonElement>('button'); if (!row) throw new Error('Missing member row'); await act(async () => row.click()); };
    await member('member:alpha'); await f.menuAction('groups.model'); await f.click('Native model');
    await member('member:beta'); await f.menuAction('groups.model'); await f.click('Alternate model');
    await member('member:alpha'); await f.menuAction('groups.reasoning'); await f.click('Native reasoning');
    expect(f.setModel.mock.calls.map(call => call[1])).toEqual([
      { expectedModelRevision: 0, memberId: 'member:alpha', modelSelection: { provider: 'native-provider', model: 'native-model' } },
      { expectedModelRevision: 1, memberId: 'member:beta', modelSelection: { provider: 'alternate-provider', model: 'alternate-model' } },
      { expectedModelRevision: 2, memberId: 'member:alpha', modelSelection: { provider: 'native-provider', model: 'native-model', reasoningEffort: 'native-effort' } },
    ]);
    expect(f.group.modelSelection).toEqual({ provider: 'native-provider', model: 'native-model' });
    expect(f.trigger().textContent).toContain(f.t('groups.modelPerBot'));
    const persisted = f.group;
    await f.render({ ...persisted, id: 'other', createdAt: 100 }); await f.render(persisted);
    await f.open();
    expect(f.element.querySelector('[data-model-member-id="member:alpha"]')?.textContent).toContain('Native reasoning');
    expect(f.element.querySelector('[data-model-member-id="member:beta"]')?.textContent).toContain('Alternate model');
    await f.open(); await member('member:alpha'); await f.click(f.t('groups.modelFollowGroup'));
    expect(f.setModel.mock.calls[3]?.[1]).toEqual({ expectedModelRevision: 3, memberId: 'member:alpha', modelSelection: null });
    await f.open();
    expect(f.element.querySelector<HTMLElement>('[data-model-member-id="member:alpha"]')?.dataset.modelSource).toBe(f.t('groups.modelSourceGroup'));
    expect(f.element.querySelector<HTMLElement>('[data-model-member-id="member:beta"]')?.dataset.modelSource).toBe(f.t('groups.modelSourceMember'));
    expect(f.group.memberModelSelections).toEqual([{ memberId: 'member:beta', modelSelection: { provider: 'alternate-provider', model: 'alternate-model' } }]);
    expect(f.configuredBots[0]?.model?.model).toBe('Alpha bot model'); expect(f.configuredBots[1]?.model).toBeUndefined();
  });
  it('retains member overrides when the group default changes and clears back through Bot and DSH defaults', async () => {
    const f = await mount();
    await f.open();
    await act(async () => f.element.querySelector('[data-model-member-id="member:beta"]')?.closest<HTMLButtonElement>('button')?.click());
    await f.menuAction('groups.model'); await f.click('Alternate model');
    await f.open(); await f.menuAction('groups.model'); await f.click('Native model');
    await f.open();
    expect(f.element.querySelector<HTMLElement>('[data-model-member-id="member:alpha"]')?.dataset.modelSource).toBe(f.t('groups.modelSourceGroup'));
    await f.click(f.t('groups.modelDefault')); await f.open();
    expect(f.element.querySelector<HTMLElement>('[data-model-member-id="member:alpha"]')?.dataset.modelSource).toBe(f.t('groups.modelSourceBot'));
    expect(f.element.querySelector<HTMLElement>('[data-model-member-id="member:beta"]')?.dataset.modelSource).toBe(f.t('groups.modelSourceMember'));
    expect(f.group.memberModelSelections).toEqual([{ memberId: 'member:beta', modelSelection: { provider: 'alternate-provider', model: 'alternate-model' } }]);
  });
  it('closes a removed member menu and discards its failed retry target', async () => {
    const f = await mount(); await f.open();
    const row = f.element.querySelector('[data-model-member-id="member:alpha"]')?.closest<HTMLButtonElement>('button');
    await act(async () => row?.click());
    f.setModel.mockRejectedValueOnce(new Error('offline'));
    await f.menuAction('groups.model'); await f.click('Native model');
    expect(f.element.textContent).toContain(f.t('groups.modelSaveFailed'));
    f.members.splice(0, 1); await f.render();
    expect(f.element.querySelector('[role="alert"]')).toBeNull();
    await f.open(); expect(f.element.querySelector('[data-model-member-id="member:alpha"]')).toBeNull();
    expect(f.setModel).toHaveBeenCalledOnce();
  });
  it('hides metadata from the old route after an external model change', async () => {
    const f = await mount('en', { provider: 'native-provider', model: 'native-model' });
    await f.open(); expect(f.element.textContent).toContain(f.t('groups.reasoning'));
    await f.render({ ...f.group, modelRevision: 1, modelSelection: { provider: 'alternate-provider', model: 'alternate-model' } });
    expect(f.element.textContent).not.toContain(f.t('groups.reasoning'));
    await f.open(); await f.open();
    expect(f.modelInfo).toHaveBeenLastCalledWith('alternate-provider', 'alternate-model');
    expect(f.element.textContent).toContain(f.t('groups.reasoning'));
  });
  it('shows identity hints only for matching names and keeps full target identities in data attributes', async () => {
    const f = await mount();
    const [alpha, beta] = f.configuredBots; if (!alpha || !beta) throw new Error('Missing Bots');
    alpha.name = 'Unique alpha'; beta.name = 'Unique beta';
    await f.render(); await f.open();
    const rows = [...f.element.querySelectorAll<HTMLElement>('[data-model-member-id]')];
    expect(rows.every(row => !row.querySelector('small'))).toBe(true);
    expect(rows[0]?.dataset.modelBotId).toBe('alpha'); expect(rows[1]?.dataset.modelBotId).toBe('beta');
  });
  it('ignores a late metadata response after the selected member is removed', async () => {
    const f = await mount(); let settle!: (value: Awaited<ReturnType<typeof f.modelInfo>>) => void;
    f.modelInfo.mockReturnValueOnce(new Promise(resolve => { settle = resolve; }));
    await f.open();
    await act(async () => f.element.querySelector('[data-model-member-id="member:alpha"]')?.closest<HTMLButtonElement>('button')?.click());
    expect(f.modelInfo).toHaveBeenCalledWith('bot-provider', 'Alpha bot model');
    f.members.splice(0, 1); await f.render();
    await act(async () => settle({ provider: 'bot-provider', id: 'Alpha bot model', name: 'Late metadata', reasoning: { efforts: [{ id: 'late', name: 'Late reasoning' }] } }));
    expect(f.element.querySelector('[role="menu"]')).toBeNull();
    await f.open(); expect(f.element.querySelector('[data-model-member-id="member:alpha"]')).toBeNull();
    expect(f.setModel).not.toHaveBeenCalled(); expect(f.element.textContent).not.toContain('Late reasoning');
  });
  it('does not silently rebase a failed member save onto a newer model revision', async () => {
    const f = await mount(); await f.open();
    await act(async () => f.element.querySelector('[data-model-member-id="member:alpha"]')?.closest<HTMLButtonElement>('button')?.click());
    f.setModel.mockResolvedValueOnce({ ok: false, error: { code: 'group/conflict' } } as never);
    await f.menuAction('groups.model'); await f.click('Native model');
    await f.render({ ...f.group, modelRevision: 8, modelSelection: { provider: 'other', model: 'Someone else chose this' } });
    expect(button(f.element, f.t('groups.modelRetry')).disabled).toBe(true);
    await click(button(f.element, f.t('groups.modelRetry'))); expect(f.setModel).toHaveBeenCalledOnce();
  });
  it('shares one native-style footer with attachment and send, and blocks send during a model change', async () => {
    const f = await mount(), ctx = new Context(), data = view(); data.group.mode = 'natural';
    const send = vi.fn();
    let settle!: (value: Awaited<ReturnType<GroupMethods['setModel']>>) => void;
    f.setModel.mockReturnValueOnce(new Promise(resolve => { settle = resolve; }));
    ctx.provide('remote.dshBot.groups', { view: async () => ({ ok: true, value: data }), list: async () => ({ ok: true, value: [summary()] }), setModel: f.setModel, send } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const t = ((key: keyof typeof en.ui) => ({ ...en.ui, ...labels.en })[key]) as PropsLocale<'dsh-bot'>['t'];
    try {
      await act(async () => f.root.render(<GroupConversation workspace summary={summary()} actions={actions} models={f.models} bots={bots} expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={async () => {}} t={t} />));
      await vi.waitFor(() => expect(f.element.querySelector('textarea')).toBeTruthy());
      const footer = f.trigger().closest('form')?.lastElementChild;
      expect(footer?.querySelector('button')?.getAttribute('aria-label')).toBe(en.ui['groups.attach']);
      expect(footer?.querySelector('[aria-haspopup="menu"]')).toBe(f.trigger());
      expect(footer?.querySelector('button[type="submit"]')?.getAttribute('aria-label')).toBe(en.ui['groups.send']);
      let finishRefresh!: () => void;
      vi.spyOn(actions.catalog, 'refresh').mockImplementationOnce(() => new Promise<void>(resolve => { finishRefresh = resolve; }));
      await fill(field(f.element, en.ui['groups.message']), 'A preserved draft');
      await f.open(); await f.menuAction('groups.model'); await f.click('Native model');
      expect(button(f.element, en.ui['groups.send']).disabled).toBe(true); expect(f.trigger().disabled).toBe(true);
      await click(button(f.element, en.ui['groups.send'])); expect(send).not.toHaveBeenCalled();
      await act(async () => settle({ ok: true, value: { ...data.group, revision: 2, modelRevision: 1, modelSelection: { provider: 'native-provider', model: 'native-model' } } }));
      expect(f.element.querySelector('[role="menu"]')).toBeNull();
      expect(f.trigger().disabled).toBe(true); // Accepted receipt, post-save refresh still pending.
      await act(async () => finishRefresh());
      expect(button(f.element, en.ui['groups.send']).disabled).toBe(false); expect(f.trigger().disabled).toBe(false);
      expect(field(f.element, en.ui['groups.message']).value).toBe('A preserved draft');
      expect(f.element.querySelector('[role="log"]')).toBeNull();
    } finally { await act(async () => f.root.unmount()); mounted.splice(mounted.findIndex(item => item.root === f.root), 1); f.element.remove(); await ctx.fiber.dispose(); }
  });
  it.each(['accepted', 'failed', 'switched'] as const)('blocks new work and model selection while the permission command is pending, then releases after %s', async outcome => {
    const f = await mount(), ctx = new Context(), data = view(); data.group.mode = 'natural';
    const send = vi.fn(), listeners = new Set<() => void>(); let finish!: () => void;
    let snapshot: GroupPermissionSnapshot = { catalog: { options: [{ value: 'read-only', name: 'Read Only' }, { value: 'workspace-write', name: 'Workspace Write' }], defaultOptions: [], defaultPreset: 'read-only' },
      currentValue: 'read-only', loading: false, saving: false, loadError: false, saveError: false, catalogVersion: 1 };
    const publish = (patch: Partial<GroupPermissionSnapshot>) => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
    const permissionState = { rootSessionId: data.group.rootSessionId, store: {
      getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    }, select: async () => { publish({ saving: true }); await new Promise<void>(resolve => { finish = resolve; }); publish({ saving: false, saveError: outcome === 'failed' }); return outcome === 'accepted'; }, refresh: async () => {}, dispose: () => {} } as GroupPermissionState;
    ctx.provide('remote.dshBot.groups', { view: async () => ({ ok: true, value: data }), list: async () => ({ ok: true, value: [summary()] }), setModel: f.setModel, send } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const t = ((key: keyof typeof en.ui) => ({ ...en.ui, ...labels.en })[key]) as PropsLocale<'dsh-bot'>['t'];
    const render = async (state: GroupPermissionState | undefined) => { await act(async () => f.root.render(<GroupConversation workspace summary={summary()} actions={actions} models={f.models} permissionState={state} bots={bots} expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={async () => {}} t={t} />)); };
    try {
      await render(permissionState); await vi.waitFor(() => expect(f.element.querySelector('textarea')).toBeTruthy());
      await fill(field(f.element, en.ui['groups.message']), 'Work waits for permission');
      await click(button(f.element, en.ui['groups.permissionReadOnly'])); await click(button(f.element, en.ui['groups.permissionWorkspaceWrite']));
      expect(button(f.element, en.ui['groups.send']).disabled).toBe(true); expect(f.trigger().disabled).toBe(true);
      await click(button(f.element, en.ui['groups.send'])); expect(send).not.toHaveBeenCalled(); expect(f.setModel).not.toHaveBeenCalled();
      if (outcome === 'switched') { await render({ ...permissionState, rootSessionId: 'other-group-root' }); expect(button(f.element, en.ui['groups.send']).disabled).toBe(false); }
      await act(async () => finish());
      expect(button(f.element, en.ui['groups.send']).disabled).toBe(false); expect(f.trigger().disabled).toBe(false);
      expect(field(f.element, en.ui['groups.message']).value).toBe('Work waits for permission');
    } finally { await act(async () => f.root.unmount()); mounted.splice(mounted.findIndex(item => item.root === f.root), 1); f.element.remove(); await ctx.fiber.dispose(); }
  });
});
