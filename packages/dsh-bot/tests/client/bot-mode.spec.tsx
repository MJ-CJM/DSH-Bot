// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { projectObjects, findObjectForSession, sortObjects, readPreferences, splitObjectSections, RECENT_GROUP_WINDOW_MS, hasDuplicateName, distinctDescription } from '../../src/client/bot-mode/objects.js';
import { stopGroupWork } from '../../src/client/bot-mode/stop-group.js';
import { BOT_MODE_COMMANDS, createModeLifecycle, type CommandMode } from '../../src/client/bot-mode/lifecycle.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import { bot, botModeCapabilities as chatActionCapability } from './helpers.js';
import { summary, view } from './group-fixture.js';
import type { SupergroupWorkView } from '../../src/shared/supergroup.js';

describe('Bot Center verified object projection', () => {
  it('never treats a display name, preset or unrelated private history as an object binding', () => {
    const a = { ...bot({ id: 'alpha', name: 'Same' }), createdAt: 10 };
    const b = { ...bot({ id: 'beta', name: 'Same' }), createdAt: 20 };
    const rows = projectObjects([{ bot: a, status: { id: a.id, presetId: 'preset', mainSessionId: 'verified', preset: { state: 'ok' } } }, { bot: b }], [summary()], { sessions: [
      { sessionId: 'unrelated', botId: a.id, botCreatedAt: a.createdAt, lastMessage: { role: 'assistant', preview: 'private', at: 90 }, updatedAt: 90, unread: true },
      { sessionId: 'verified', botId: a.id, botCreatedAt: 1, lastMessage: { role: 'assistant', preview: 'old generation', at: 95 }, updatedAt: 95, unread: true },
    ] });
    expect(findObjectForSession(rows, 'unrelated')).toBeUndefined();
    expect(findObjectForSession(rows, 'verified')?.bot).toEqual(a);
    expect(rows.find(row => row.id === a.id)?.preview).toBe('');
    expect(findObjectForSession(rows, 'group-root-one')?.kind).toBe('group');
    expect(findObjectForSession([...rows, { ...rows[0]!, key: 'collision' }], 'verified')).toBeUndefined();
  });
  it('sorts pinned objects before visible activity and searches without widening history', () => {
    const rows = projectObjects([{ bot: { ...bot({ id: 'alpha', name: 'Alpha' }), createdAt: 1 } }, { bot: { ...bot({ id: 'beta', name: 'Beta' }), createdAt: 3 } }], [summary()], { sessions: [] });
    expect(sortObjects(rows, '', [rows[0]!.key]).map(row => row.id)).toEqual(['alpha', 'beta', 'group:one']);
    expect(sortObjects(rows, 'BET', []).map(row => row.id)).toEqual(['beta']);
    expect(readPreferences({ getItem: () => '{"selected":{"kind":"bot","id":"old","createdAt":1},"pinned":[5,"known"]}' }, 'key')).toEqual({ selected: { kind: 'bot', id: 'old', createdAt: 1 }, pinned: ['known'], read: {} });
  });
});

describe('Bot Center reversible public command mode', () => {
  it('waits for async command readiness before installing UI and restores once', async () => {
    let ready!: () => void, mode!: CommandMode;
    const dispose = vi.fn(async () => {}), uninstall = vi.fn(), install = vi.fn(() => uninstall);
    const newBot = vi.fn(), search = vi.fn();
    const lifecycle = createModeLifecycle({ service: () => ({ ...chatActionCapability, registerCommandMode(value) { mode = value; return { ready: new Promise(resolve => { ready = resolve; }), dispose }; } }), install, newBot, search, blocked: () => 'objects only' });
    const pending = lifecycle.enable();
    await vi.waitFor(() => expect(lifecycle.getSnapshot().state).toBe('starting'));
    expect(install).not.toHaveBeenCalled();
    ready(); await pending;
    expect(install).toHaveBeenCalledTimes(1); expect(lifecycle.getSnapshot().state).toBe('ready');
    expect(Object.keys(mode.commands)).toEqual([...BOT_MODE_COMMANDS]);
    const command = mode.commands['session.new']!.resolve({}); if (command.status === 'handled') command.run();
    expect(newBot).toHaveBeenCalledTimes(1);
    expect(mode.commands['session.archive']!.resolve({})).toEqual({ status: 'blocked', reason: 'objects only' });
    await lifecycle.enable(); expect(install).toHaveBeenCalledTimes(1);
    await lifecycle.disable(); await lifecycle.dispose();
    expect(dispose).toHaveBeenCalledTimes(1); expect(uninstall).toHaveBeenCalledTimes(1);
  });
  it('rejects a legacy shortcuts-only adapter before any partial takeover', async () => {
    const registerCommandMode = vi.fn();
    const install = vi.fn(() => vi.fn());
    const legacy = createModeLifecycle({ service: () => ({ registerCommandMode }) as never,
      install, newBot: vi.fn(), search: vi.fn(), blocked: () => 'blocked' });
    await expect(legacy.enable()).rejects.toThrow('chat-action-mode-unavailable');
    expect(legacy.getSnapshot().state).toBe('failed');
    expect(registerCommandMode).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
    await legacy.dispose();
  });
  it('rejects a host missing blank-preset preservation before registering a mode', async () => {
    const registerCommandMode = vi.fn();
    const install = vi.fn(() => vi.fn());
    const incomplete = createModeLifecycle({ service: () => ({ ...chatActionCapability,
      commandModeSurfaces: ['keyboard', 'menu', 'chat.branch'], registerCommandMode }),
      install, newBot: vi.fn(), search: vi.fn(), blocked: () => 'blocked' });
    await expect(incomplete.enable()).rejects.toThrow('workspace-blank-preset-unavailable');
    expect(incomplete.getSnapshot()).toEqual({ state: 'failed', reason: 'workspace-blank-preset-unavailable' });
    expect(registerCommandMode).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
    await incomplete.dispose();
  });
  it('fails honestly without an adapter and cleans rejected or cancelled startup', async () => {
    const install = vi.fn(() => vi.fn());
    const options = { install, newBot: vi.fn(), search: vi.fn(), blocked: () => 'blocked' };
    const absent = createModeLifecycle({ ...options, service: () => undefined });
    await expect(absent.enable()).rejects.toThrow('command-mode-unavailable');
    expect(absent.getSnapshot().state).toBe('failed'); expect(install).not.toHaveBeenCalled(); await absent.dispose();
    let ready!: () => void;
    const dispose = vi.fn(async () => {});
    const pending = createModeLifecycle({ ...options, service: () => ({ ...chatActionCapability, registerCommandMode: () => ({ ready: new Promise(resolve => { ready = resolve; }), dispose }) }) });
    const enabling = pending.enable(); await vi.waitFor(() => expect(pending.getSnapshot().state).toBe('starting'));
    await pending.disable(); ready(); await enabling;
    expect(install).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledTimes(1); await pending.dispose();
  });
});

function workView(): SupergroupWorkView {
  const group = view();
  group.group.supergroup = { workId: 'work', originSessionId: 'origin', originMessageId: 'input', owner: group.members[0]!.bot, readers: group.members.map(row => row.bot), expiresAt: 1000 };
  return { group, work: { id: 'work', revision: 5, owner: group.members[0]!.bot, originSessionId: 'origin', inputMessageId: 'input', inputMessageIds: ['input'], configDigest: 'digest', readers: group.members.map(row => row.bot), createdAt: 1, updatedAt: 1, expiresAt: 1000, group: { groupId: group.group.id, groupCreatedAt: group.group.createdAt }, turnIds: [], state: 'running', groupInputs: [], experts: [] } };
}
describe('automatic group composer bridge', () => {
  it('passes real member identities/reply through owner Remote, preserves conflict draft, and never falls back to ordinary send', async () => {
    const ctx = new Context(); const current = workView();
    const send = vi.fn();
    const sendGroupInput = vi.fn(async () => ({ ok: true, value: { view: current, receipt: { operationId: 'op', digest: 'digest', messageId: 'actual-root-input', expectedRevision: 5, state: 'conflict' } } }));
    const release = ctx.provide('remote.dshBot.groups', { send, list: async () => ({ ok: true, value: [current.group] }), view: async () => ({ ok: true, value: current.group }) } as never);
    const releaseSuper = ctx.provide('remote.dshBotSupergroup', { byGroup: async () => ({ ok: true, value: current }), sendGroupInput } as never);
    const actions = createGroupActions(ctx, { pollIntervalMs: 5000 });
    actions.catalog.reset({ groups: [current.group!] });
    const key = current.work.group!; const root = current.group!.group.rootSessionId;
    actions.patchDraft(root, value => ({ ...value, text: '@Alpha inspect cost', mentions: ['member:alpha'] }));
    try {
      await expect(actions.send!(key, { operationId: 'op', expectedMembershipRevision: 1, text: '@Alpha inspect cost', memberIds: ['member:alpha'], replyTo: 'historic-beta' })).rejects.toThrow('not queued');
      expect(sendGroupInput).toHaveBeenCalledExactlyOnceWith({ group: key, workId: 'work', expectedRevision: 5, operationId: 'op', text: '@Alpha inspect cost', memberIds: ['member:alpha'], replyTo: 'historic-beta' });
      expect(send).not.toHaveBeenCalled(); expect(actions.draft(root).text).toBe('@Alpha inspect cost');
      expect(actions.draft(root).errorCode).toBe('supergroup-conflict');
      await expect(actions.send!(key, { operationId: 'op2', expectedMembershipRevision: 1, text: 'file', fileReceiptIds: ['file'] })).rejects.toThrow('unsupported');
      expect(sendGroupInput).toHaveBeenCalledTimes(1);
    } finally { await releaseSuper(); await release(); await ctx.fiber.dispose(); }
  });
});

it('mounts the actual Bot shell only with the adapter, gates unknown links before native content, and restores registrations', async () => {
  const { mountClient, click } = await import('./helpers.js');
  const client = await import('../../src/client/index.js');
  let commandMode: CommandMode | undefined;
  const releaseMode = vi.fn(async () => {});
  const plugin: typeof client = { ...client, async apply(ctx, options) {
    ctx.effect(() => ctx.provide('shortcuts', { ...chatActionCapability, registerCommandMode(value: CommandMode) {
      commandMode = value; return { ready: Promise.resolve(), dispose: releaseMode };
    } } as never));
    await client.apply(ctx, options);
  } };
  const app = await mountClient([bot()], 'en', remote => {
    remote.data.statuses = [{ id: 'alpha-bot', presetId: 'custom-alpha-bot', mainSessionId: 'verified-main', preset: { state: 'ok' } }];
  }, {}, plugin);
  const settings = await app.mountEntry('plugins.bundle.config', options => options.key === 'dsh-botgroup', { view: 'page' });
  let main: Awaited<ReturnType<typeof app.mountEntry>> | undefined;
  try {
    const toggle = settings.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await vi.waitFor(() => expect(toggle.disabled).toBe(false)); await click(toggle);
    await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(commandMode?.commands['session.new']?.label?.()).toBe('Create a Bot');
    expect(app.core.entries('sidebar').some(entry => entry.options.priority === -100)).toBe(true);
    const ordinaryDock = await app.mountEntry('conversation.composer.dock', options => options.id === 'dsh-bot-mode-floor');
    expect(ordinaryDock.container.querySelector('[data-bot-mode-dock-floor]')).toBeNull();
    await ordinaryDock.unmount();
    const renderFactorySlot = vi.fn(() => <div data-native-conversation="" />);
    main = await app.mountEntry('main.conversation', options => options.priority === -100, { sessionId: 'unrelated-private', useSession: () => ({ openState: 'open' }), renderFactorySlot });
    await vi.waitFor(() => expect(main!.container.textContent).toContain('This link cannot be verified'));
    expect(renderFactorySlot).not.toHaveBeenCalled();
    await main.rerender({ sessionId: 'verified-main', useSession: () => ({ openState: 'open' }), renderFactorySlot });
    expect(main.container.textContent).toContain('Alpha Bot');
    expect(main.container.querySelector('[data-native-conversation]')).not.toBeNull();
    // A custom shell has no native main ConversationRoot ancestor. The
    // public embedded variant owns its complete scroll/composer layout.
    expect(renderFactorySlot).toHaveBeenLastCalledWith('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, { slots: { views: expect.any(Function) } });
    await main.rerender({ sessionId: 'verified-main', useSession: () => ({ openState: 'loading' }), renderFactorySlot });
    expect(renderFactorySlot).toHaveBeenLastCalledWith('conversation.content', { variant: 'embedded', phase: 'settling', hero: false }, { slots: { views: expect.any(Function) } });
    await click(toggle); expect(releaseMode).toHaveBeenCalledTimes(1);
    expect(app.core.entries('sidebar')).toHaveLength(0);
    expect(app.core.entries('main.conversation')).toHaveLength(0);
    expect(app.core.entries('conversation.composer.dock').filter(entry => entry.options.id === 'dsh-bot-mode-floor')).toHaveLength(0);
  } finally { await main?.unmount(); await settings.unmount(); await app.dispose(); }
});

it('guards an enabled cold start without focus and retries when the native shortcuts service arrives later', async () => {
  const { act } = await import('react');
  const { mountClient } = await import('./helpers.js');
  const client = await import('../../src/client/index.js');
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  const plugin = client;
  const app = await mountClient([bot()], 'en', undefined, {}, plugin);
  const remote = app.ctx.get('remote.dshBotSupergroup')!;
  const releaseMode = vi.fn(async () => {});
  let releaseService: (() => void | Promise<void>) | undefined;
  try {
    vi.mocked(remote.settings).mockResolvedValue({ ok: true, value: { enabled: true } });
    await act(async () => { app.ctx.emit('connection/reset'); });
    await vi.waitFor(() => expect(app.core.entries('sidebar').some(entry => entry.options.priority === -200)).toBe(true));
    const unavailable = await app.mountEntry('main.conversation', options => options.priority === -200);
    try { expect(unavailable.container.querySelector('[data-bot-mode-guard]')?.textContent).toContain('Bot Center is not ready'); }
    finally { await unavailable.unmount(); }
    // Native service arrival, rather than browser focus or a timer, wakes the
    // same Client after an enabled-mode capability failure.
    let surfaces: readonly string[] = ['keyboard', 'menu'];
    const capabilityListeners = new Set<() => void>();
    await act(async () => { releaseService = app.ctx.provide('shortcuts', { ...chatActionCapability,
      get commandModeSurfaces() { return surfaces; },
      modePresentation: { getSnapshot: () => [], subscribe(listener: () => void) { capabilityListeners.add(listener); return () => capabilityListeners.delete(listener); } },
      registerCommandMode: () => ({ ready: Promise.resolve(), dispose: releaseMode }),
    } as never); });
    expect(app.core.entries('sidebar').some(entry => entry.options.priority === -200)).toBe(true);
    expect(app.core.entries('sidebar').some(entry => entry.options.priority === -100)).toBe(false);
    // Chat may load after the keyboard service without replacing that service.
    // A native presentation invalidation wakes readiness without focus/polling.
    await act(async () => { surfaces = [...surfaces, 'chat.branch']; for (const listener of capabilityListeners) listener(); });
    expect(app.core.entries('sidebar').some(entry => entry.options.priority === -200)).toBe(true);
    expect(app.core.entries('sidebar').some(entry => entry.options.priority === -100)).toBe(false);
    await act(async () => { surfaces = [...surfaces, 'workspace.blank-preset']; for (const listener of capabilityListeners) listener(); });
    await vi.waitFor(() => {
      const entries = app.core.entries('sidebar');
      expect(entries.some(entry => entry.options.priority === -100)).toBe(true);
      expect(entries.some(entry => entry.options.priority === -200)).toBe(false);
    });
    vi.mocked(remote.settings).mockResolvedValue({ ok: true, value: { enabled: false } });
    await act(async () => { app.ctx.emit('connection/reset'); });
    await vi.waitFor(() => expect(app.core.entries('sidebar')).toHaveLength(0));
    expect(releaseMode).toHaveBeenCalledTimes(1);
  } finally { await releaseService?.(); await app.dispose(); vi.restoreAllMocks(); }
});


it('keeps recently completed, pinned and searched groups visible without archiving them', () => {
  const now = 10 * RECENT_GROUP_WINDOW_MS;
  const rows = projectObjects([], [summary()], { sessions: [] });
  const old = { ...rows[0]!, ended: true, at: now - RECENT_GROUP_WINDOW_MS - 1 };
  const recent = { ...old, key: 'recent', at: now - 1 };
  const active = { ...old, key: 'active', ended: false };
  expect(splitObjectSections([recent, old, active], [], '', now)).toEqual({ recent: [recent, active], earlier: [old] });
  expect(splitObjectSections([old], [old.key], '', now).recent).toEqual([old]);
  expect(splitObjectSections([old], [], 'Synthetic', now).recent).toEqual([old]);
  expect(old.group!.group.archived).toBe(false);
});

it('disambiguates equal names with distinct responsibilities and otherwise exposes creation identity', () => {
  const rows = projectObjects([{ bot: bot({ id: 'alpha', name: 'Same', description: 'Research' }) }, { bot: bot({ id: 'beta', name: 'Same', description: 'Review' }) }], [], { sessions: [] });
  expect(hasDuplicateName(rows[0]!, rows)).toBe(true);
  expect(distinctDescription(rows[0]!, rows)).toBe('Research');
  rows[1]!.bot!.description = 'Research';
  expect(distinctDescription(rows[0]!, rows)).toBeUndefined();
  expect(sortObjects(rows, 'review', [])).toHaveLength(0);
  expect(sortObjects(rows, 'research', [])).toHaveLength(2);
});

it('renders contact identity, one settings menu, and object-scoped pin controls', async () => {
  const { mountClient, click, fill } = await import('./helpers.js');
  const client = await import('../../src/client/index.js');
  const plugin: typeof client = { ...client, async apply(ctx, options) {
    ctx.effect(() => ctx.provide('shortcuts', { ...chatActionCapability, registerCommandMode: () => ({ ready: Promise.resolve(), dispose() {} }) } as never));
    await client.apply(ctx, options);
  } };
  const app = await mountClient([bot({ id: 'alpha', name: 'Same', description: 'Research' }), bot({ id: 'beta', name: 'Same', description: 'Review' })], 'en', undefined, {}, plugin);
  const settings = await app.mountEntry('plugins.bundle.config', options => options.key === 'dsh-botgroup', { view: 'page' });
  let sidebar: Awaited<ReturnType<typeof app.mountEntry>> | undefined;
  try {
    const toggle = settings.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await vi.waitFor(() => expect(toggle.disabled).toBe(false)); await click(toggle);
    sidebar = await app.mountEntry('sidebar', options => options.priority === -100, { collapsed: false, width: 266 });
    await vi.waitFor(() => expect(sidebar!.container.querySelectorAll('[data-bot-mode-row]')).toHaveLength(2));
    expect([...sidebar.container.querySelectorAll('.dsh-bot-mode-contact')].map(row => row.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Same · Research', 'Same · Review']));
    expect(sidebar.container.querySelectorAll('[data-bot-mode-settings]')).toHaveLength(1);
    expect(sidebar.container.querySelectorAll('[data-bot-avatar]')).toHaveLength(2);
    const first = sidebar.container.querySelector<HTMLButtonElement>('[data-bot-mode-object-menu]')!;
    await click(first);
    await click([...sidebar.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(row => row.textContent === 'Pin Same')!);
    expect(sidebar.container.querySelectorAll('[data-bot-mode-pinned]')).toHaveLength(1);
    expect(sidebar.container.querySelector('[data-bot-mode-section="pinned"]')?.querySelector('[data-bot-mode-pinned]')).not.toBeNull();
    expect(sidebar.container.querySelector('[data-bot-mode-section="recent"]')).not.toBeNull();
    await fill(sidebar.container.querySelector<HTMLInputElement>('[data-bot-mode-search]')!, 'unknown');
    expect(sidebar.container.querySelector('[data-bot-mode-list-empty]')?.textContent).toContain('No matching');
    expect(sidebar.container.querySelector('[data-bot-mode-list-empty]')?.querySelector('button')).toBeNull();
    await fill(sidebar.container.querySelector<HTMLInputElement>('[data-bot-mode-search]')!, 'Review');
    expect(sidebar.container.querySelectorAll('[data-bot-mode-row]')).toHaveLength(1);
    await click(sidebar.container.querySelector<HTMLButtonElement>('[data-bot-mode-add-menu]')!);
    expect(sidebar.container.querySelector('[role="menu"]')?.textContent).toContain('Create a Bot');
  } finally { await sidebar?.unmount(); await settings.unmount(); await app.dispose(); }
});


it('selects native Chat only for the Bot occurrence while retaining saved view, native draft and mounted Session across details changes', async () => {
  const { mountClient, click } = await import('./helpers.js');
  const client = await import('../../src/client/index.js');
  const plugin: typeof client = { ...client, async apply(ctx, options) {
    ctx.effect(() => ctx.provide('shortcuts', { ...chatActionCapability, registerCommandMode: () => ({ ready: Promise.resolve(), dispose() {} }) } as never));
    await client.apply(ctx, options);
  } };
  const app = await mountClient([bot()], 'en', remote => {
    remote.data.statuses = [{ id: 'alpha-bot', presetId: 'custom-alpha-bot', mainSessionId: 'verified-main', preset: { state: 'ok' } }];
  }, {}, plugin);
  const settings = await app.mountEntry('plugins.bundle.config', options => options.key === 'dsh-botgroup', { view: 'page' });
  let main: Awaited<ReturnType<typeof app.mountEntry>> | undefined;
  let blank = true, draft = '';
  const setDraft = vi.fn((value: string) => { draft = value; }), persistDraft = vi.fn();
  const preferenceKey = 'dsh.conversation.verified-main';
  const previousPreference = localStorage.getItem(preferenceKey);
  const savedPreference = JSON.stringify({ view: 'trace', draft: 'native draft' });
  localStorage.setItem(preferenceKey, savedPreference);
  const writePreference = vi.spyOn(Storage.prototype, 'setItem');
  // Model the public owner contract: an occurrence override wins, otherwise the
  // native renderer uses its saved selection. It remains the native renderer.
  const renderSession = vi.fn((_slot: string, owner: { view?: string }) => {
    const preference = JSON.parse(localStorage.getItem(preferenceKey)!) as { view: string };
    return <div data-native-session="" data-session-view={owner.view ?? preference.view}><input defaultValue="native draft" /></div>;
  });
  const factory = vi.fn((...args: unknown[]) => {
    const options = args[2] as { slots: { views: import('react').ComponentType<import('@deepseek-ai/dsh-client-ui-conversation/client').ConversationViewsProps> } };
    const View = options.slots.views;
    const viewProps = { sessionId: 'verified-main', useSession: (select: (value: unknown) => unknown) => select({ blank, running: false, awaitingFirstTurn: false }),
      useConversation: (select: (value: unknown) => unknown) => select({ activeTargets: new Set() }),
      useInput: (select: (value: unknown) => unknown) => select({ draft, phase: 'plain' }), inputActions: { setDraft, persistDraft }, renderSlot: renderSession };
    const Floor = app.core.entries('conversation.composer.dock').find(entry => entry.options.id === 'dsh-bot-mode-floor')!.component as import('react').ComponentType;
    return <><View {...viewProps as unknown as import('@deepseek-ai/dsh-client-ui-conversation/client').ConversationViewsProps} /><Floor /></>;
  });
  const runtime = { sessionId: 'verified-main', useSession: () => ({ openState: 'open' }), renderFactorySlot: factory };
  try {
    const toggle = settings.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await vi.waitFor(() => expect(toggle.disabled).toBe(false)); await click(toggle);
    main = await app.mountEntry('main.conversation', options => options.priority === -100, runtime);
    await vi.waitFor(() => expect(main!.container.querySelector('[data-bot-mode-empty]')).not.toBeNull());
    expect(renderSession).toHaveBeenLastCalledWith('conversation.session', { view: 'chat' });
    expect(main.container.querySelector('[data-native-session]')?.getAttribute('data-session-view')).toBe('chat');
    const dockFloor = main.container.querySelector('[data-bot-mode-dock-floor]');
    expect(dockFloor?.getAttribute('aria-hidden')).toBe('true');
    const native = main.container.querySelector('[data-native-session]');
    await click(main.container.querySelector<HTMLButtonElement>('.dsh-bot-mode-example')!);
    expect(setDraft).toHaveBeenCalledExactlyOnceWith('Help me plan my next task');
    expect(persistDraft).toHaveBeenCalledTimes(1);
    await main.rerender(runtime);
    expect(main.container.querySelector<HTMLButtonElement>('.dsh-bot-mode-example')?.disabled).toBe(true);
    await click(main.container.querySelector<HTMLButtonElement>('[data-bot-mode-details]')!);
    expect(main.container.querySelector('[data-bot-mode-details-panel]')).not.toBeNull();
    const profile = main.container.querySelector('[data-bot-mode-profile]')!;
    const tabs = main.container.querySelector('.dsh-bot-mode-tabs')!;
    expect(profile.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main.container.querySelector<HTMLDetailsElement>('[data-bot-mode-advanced]')?.open).toBe(false);
    await click(main.container.querySelector<HTMLButtonElement>('[data-bot-mode-tab="materials"]')!);
    expect(main.container.querySelector('[data-native-session]')).toBe(native);
    expect(main.container.querySelector<HTMLInputElement>('[data-native-session] input')?.value).toBe('native draft');
    await click(main.container.querySelector<HTMLButtonElement>('.dsh-bot-mode-details-heading button')!);
    blank = false; await main.rerender(runtime);
    expect(main.container.querySelector('[data-bot-mode-empty]')).toBeNull();
    expect(main.container.querySelector('[data-bot-mode-dock-floor]')).toBe(dockFloor);
    expect(main.container.querySelector('[data-native-session]')).toBe(native);
    expect(renderSession.mock.calls.every(([slot, owner]) => slot === 'conversation.session' && owner.view === 'chat')).toBe(true);
    await click(toggle);
    expect(app.core.entries('main.conversation')).toHaveLength(0);
    expect(localStorage.getItem(preferenceKey)).toBe(savedPreference);
    expect(writePreference.mock.calls.filter(([key]) => key === preferenceKey)).toEqual([]);
    // Leaving Bot mode still lets an ordinary native occurrence use Trace.
    expect(renderSession('conversation.session', {}).props['data-session-view']).toBe('trace');
  } finally {
    writePreference.mockRestore();
    if (previousPreference === null) localStorage.removeItem(preferenceKey);
    else localStorage.setItem(preferenceKey, previousPreference);
    await main?.unmount(); await settings.unmount(); await app.dispose();
  }
});


it('does not cancel a completed work from a stale running group, or cancel a different generation', async () => {
  const current = workView(), group = current.group!.group;
  const cancel = vi.fn(async () => {}), refresh = vi.fn(async () => {});
  const actions = { read: async () => current, cancel, refresh };
  current.work.state = 'completed';
  await stopGroupWork(group, actions);
  expect(cancel).not.toHaveBeenCalled(); expect(refresh).toHaveBeenCalledTimes(1);
  current.work.state = 'running'; current.work.group!.groupCreatedAt += 1;
  await expect(stopGroupWork(group, actions)).rejects.toThrow('identity mismatch');
  expect(cancel).not.toHaveBeenCalled();
  current.work.group!.groupCreatedAt = group.createdAt; current.work.id = 'other-work';
  await expect(stopGroupWork(group, actions)).rejects.toThrow('identity mismatch');
  expect(cancel).not.toHaveBeenCalled();
});
