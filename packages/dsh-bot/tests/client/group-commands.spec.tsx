// @vitest-environment jsdom
import { act } from 'react';
import { Context } from '@deepseek-ai/cordis';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { availableGroupCommands, bareGroupCommand, createGroupCommandServices, type GroupCommandServices } from '../../src/client/group-commands.js';
import { createGroupTrigger } from '../../src/client/group-trigger.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import { GroupConversation } from '../../src/client/components/GroupsPanel.js';
import type { GroupPermissionSnapshot, GroupPermissionState } from '../../src/client/group-permission-state.js';
import type { ModelActions } from '../../src/client/model-catalog-state.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import { bots, view, summary } from './group-fixture.js';
import { button, click, field, fill } from './helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const rows = [{ name: 'file', label: 'File', section: 'Add' }, { name: 'export', label: 'Download log', section: 'Commands' }];

describe('group composer command source (real published InputTriggerController)', () => {
  it('lists commands only for a leading slash, removes the typed token, then runs the pick', async () => {
    const insert = vi.fn(() => true), run = vi.fn();
    const bridge = createGroupTrigger('group-root', () => [], insert, () => ({ rows: async () => rows, run }));
    cleanups.push(() => bridge.dispose());
    bridge.track('/', 1, 1);
    await vi.waitFor(() => expect(bridge.controller.menu.getSnapshot().groups[0]?.items.map(row => row.name)).toEqual(['file', 'export']));
    bridge.track('/down', 5, 2);
    await vi.waitFor(() => expect(bridge.controller.menu.getSnapshot().groups[0]?.items.map(row => row.name)).toEqual(['export']));
    expect(bridge.controller.arbitrate('enter', false)).toBe('pick-highlighted');
    expect(insert).toHaveBeenCalledExactlyOnceWith({ start: 0, end: 5, draftRev: 2 }, undefined, '');
    expect(run).toHaveBeenCalledExactlyOnceWith('export');
    // An inline slash (a path, a fraction) stays text: the empty group closes the menu.
    bridge.track('see a /', 7, 3);
    await vi.waitFor(() => expect(bridge.controller.menu.getSnapshot().open).toBe(false));
  });
  it('opens the same rows from the add button at the caret, and leaves members on @', async () => {
    const insert = vi.fn(() => true), run = vi.fn();
    const bridge = createGroupTrigger('group-root', () => [{ id: 'member-a', name: 'Planner', botId: 'planner' }], insert, () => ({ rows: async () => rows, run }));
    cleanups.push(() => bridge.dispose());
    bridge.toggleCommands(4, 7);
    await vi.waitFor(() => expect(bridge.controller.menu.getSnapshot().groups[0]?.status).toBe('ready'));
    bridge.controller.pick('dsh-bot-group-commands', 0);
    expect(insert).toHaveBeenCalledExactlyOnceWith({ start: 4, end: 4, draftRev: 7 }, undefined, '');
    expect(run).toHaveBeenCalledExactlyOnceWith('file');
    bridge.track('@Pla', 4, 8);
    await vi.waitFor(() => expect(bridge.controller.menu.getSnapshot().groups[0]?.items[0]?.name).toBe('member-a'));
    expect(bridge.controller.arbitrate('enter', false)).toBe('pick-highlighted');
    expect(insert).toHaveBeenLastCalledWith({ start: 0, end: 4, draftRev: 8 }, 'member-a', '@Planner ');
    expect(run).toHaveBeenCalledOnce();
  });
  it('keeps / as plain text without a command provider', async () => {
    const bridge = createGroupTrigger('group-root', () => [], vi.fn(() => true));
    cleanups.push(() => bridge.dispose());
    bridge.track('/', 1, 1);
    await vi.waitFor(() => expect(bridge.controller.menu.getSnapshot().open).toBe(false));
  });
});

describe('group command availability', () => {
  const local = { file: true, model: true, permission: true };
  it('offers native commands only when the root catalog has them and their browser half is installed', () => {
    const all = new Set(['export', 'feedback', 'permission']);
    expect(availableGroupCommands(all, local, () => true)).toEqual(['file', 'model', 'permission', 'export', 'feedback']);
    expect(availableGroupCommands(new Set(['permission']), local, () => true)).toEqual(['file', 'model', 'permission']);
    expect(availableGroupCommands(all, local, name => name === 'export')).toEqual(['file', 'model', 'permission', 'export']);
    expect(availableGroupCommands(all, { file: false, model: false, permission: false }, () => true)).toEqual(['export', 'feedback']);
    // The root runs no model: the Host offers no goal, plan or compact, and the composer adds none.
    expect(availableGroupCommands(new Set([...all, 'goal', 'plan', 'compact']), local, () => true)).not.toContain('goal');
  });
  it('treats a whole-draft bare command, by name or localized label, as the command', () => {
    const label = (name: string) => ({ export: '下载日志', file: '文件' })[name] ?? name;
    expect(bareGroupCommand(' /export ', ['export'], label)).toBe('export');
    expect(bareGroupCommand('/下载日志', ['export'], label)).toBe('export');
    expect(bareGroupCommand('/export now', ['export'], label)).toBeUndefined();
    expect(bareGroupCommand('/export', ['file'], label)).toBeUndefined();
    expect(bareGroupCommand('export', ['export'], label)).toBeUndefined();
  });
  it('reads the root catalog through the public commands Remote, refreshes on change, and calls native browser services', async () => {
    let names = ['export', 'permission'];
    const list = vi.fn(async (_root: string) => ({ ok: true as const, value: names.map(name => ({ name, description: name })) }));
    const download = vi.fn(async () => {}), openSession = vi.fn();
    const handlers = new Map<string, () => void>(), stops: (() => void)[] = [];
    let installed = true;
    const ctx = {
      get: (name: string) => name === 'remote.commands' ? { list } : name === 'sessionLogDownload' && installed ? { download }
        : name === 'feedbackUi' && installed ? { openSession } : undefined,
      remote: { $on: (name: string, handler: () => void) => { handlers.set(name, handler); return () => handlers.delete(name); } },
      effect: (setup: () => () => void) => { const stop = setup(); stops.push(stop); return stop; },
    } as unknown as Context;
    cleanups.push(() => { for (const stop of stops) stop(); });
    const services = createGroupCommandServices(ctx);
    expect([...await services.hostCommands('root-a')]).toEqual(['export', 'permission']);
    await services.hostCommands('root-a');
    expect(list).toHaveBeenCalledExactlyOnceWith('root-a');
    names = ['feedback']; handlers.get('commands/change')?.();
    expect([...await services.hostCommands('root-a')]).toEqual(['feedback']);
    list.mockResolvedValueOnce({ ok: false, error: new Error('agent gone') } as never);
    handlers.get('commands/change')?.();
    expect(await services.hostCommands('root-a')).toEqual(new Set());
    expect([...await services.hostCommands('root-a')]).toEqual(['feedback']);
    expect(services.exportLog('root-a')).toBe(true); expect(download).toHaveBeenCalledExactlyOnceWith('root-a');
    expect(services.feedback('root-a')).toBe(true); expect(openSession).toHaveBeenCalledExactlyOnceWith('root-a');
    installed = false;
    expect(services.installed('export')).toBe(false); expect(services.exportLog('root-a')).toBe(false); expect(services.feedback('root-a')).toBe(false);
  });
});

async function composer(language: 'en' | 'zh', host = ['export', 'feedback', 'permission']) {
  const labels = (language === 'en' ? en : zh).ui;
  const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => labels[key].replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? name))) as PropsLocale<'dsh-bot'>['t'];
  const ctx = new Context(), data = view(); data.group.mode = 'natural';
  const send = vi.fn<GroupMethods['send']>();
  ctx.provide('remote.dshBot.groups', { view: async () => ({ ok: true, value: data }), list: async () => ({ ok: true, value: [summary()] }), send } as unknown as GroupMethods);
  const actions = createGroupActions(ctx, {});
  const snapshot: GroupPermissionSnapshot = { catalog: { options: [{ value: 'read-only', name: 'Read Only' }, { value: 'workspace-write', name: 'Workspace Write' }], defaultOptions: [], defaultPreset: 'read-only' },
    currentValue: 'read-only', loading: false, saving: false, loadError: false, saveError: false, catalogVersion: 1 };
  const permissionState = { rootSessionId: data.group.rootSessionId, store: { subscribe: () => () => {}, getSnapshot: () => snapshot },
    select: vi.fn(async () => true), refresh: async () => {}, dispose: () => {} } as unknown as GroupPermissionState;
  const catalog = { loaded: true, loading: false, providers: [{ id: 'native-provider', name: 'Native provider', available: true, models: [{ provider: 'native-provider', id: 'native-model', name: 'Native model' }] }] };
  const models = { catalog: { getSnapshot: () => catalog, refresh: vi.fn(async () => {}), observe: vi.fn(), subscribe: vi.fn() }, modelInfo: vi.fn(async () => ({})) } as unknown as ModelActions;
  const services: GroupCommandServices = { hostCommands: vi.fn(async () => new Set(host)), exportLog: vi.fn(() => true), feedback: vi.fn(() => true), installed: () => true };
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  cleanups.push(async () => { await act(async () => root.unmount()); element.remove(); await ctx.fiber.dispose(); });
  await act(async () => root.render(<GroupConversation workspace summary={summary()} actions={actions} models={models} permissionState={permissionState}
    commandServices={services} bots={bots} expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={async () => {}} t={t} />));
  await vi.waitFor(() => expect(element.querySelector('textarea')).toBeTruthy());
  const input = field(element, labels['groups.message']) as HTMLTextAreaElement;
  const listbox = () => element.querySelector<HTMLElement>('[data-group-command-menu]');
  const type = async (text: string) => { await fill(input, text); await vi.waitFor(() => expect(listbox()).not.toBeNull()); };
  const key = async (name: string) => { await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); }); };
  return { element, input, labels, services, send, data, listbox, type, key };
}

describe('group composer / menu', () => {
  it.each(['en', 'zh'] as const)('lists Add and Commands like the native composer, without goal, plan or compact (%s)', async language => {
    const f = await composer(language);
    expect(f.input.placeholder).toBe(f.labels['groups.pickCommands']);
    await f.type('/');
    const menu = f.listbox(); if (!menu) throw new Error('Missing command menu');
    expect(menu.getAttribute('role')).toBe('listbox'); expect(menu.getAttribute('aria-label')).toBe(f.labels['groups.commands']);
    expect([...menu.querySelectorAll('[role="group"]')].map(group => group.getAttribute('aria-label'))).toEqual([f.labels['groups.commandsAdd'], f.labels['groups.commands']]);
    expect([...menu.querySelectorAll('[role="option"]')].map(row => row.getAttribute('data-group-command'))).toEqual(['file', 'model', 'permission', 'export', 'feedback']);
    const exportRow = menu.querySelector('[data-group-command="export"]');
    expect(exportRow?.textContent).toContain(f.labels['groups.commandExport']); expect(exportRow?.textContent).toContain(f.labels['groups.commandExportHint']);
    expect(menu.textContent).not.toMatch(/goal|plan|compact/);
    expect(f.services.hostCommands).toHaveBeenCalledWith(f.data.group.rootSessionId);
  });
  it('hides native rows the group root does not offer, and never sends their bare command as a message', async () => {
    const f = await composer('en', ['permission']);
    await f.type('/');
    expect([...(f.listbox()?.querySelectorAll('[role="option"]') ?? [])].map(row => row.getAttribute('data-group-command'))).toEqual(['file', 'model', 'permission']);
    await fill(f.input, '/export'); await f.key('Escape'); await f.key('Enter');
    await act(async () => {});
    expect(f.services.exportLog).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.input.value).toBe('/export');
  });
  it('runs export and feedback through the native services and removes the typed token', async () => {
    const f = await composer('en');
    await f.type('/down'); await f.key('Enter');
    expect(f.services.exportLog).toHaveBeenCalledExactlyOnceWith(f.data.group.rootSessionId);
    expect(f.input.value).toBe(''); expect(f.send).not.toHaveBeenCalled();
    await f.type('/feed');
    await click(f.listbox()?.querySelector<HTMLElement>('[data-group-command="feedback"]') as HTMLElement);
    expect(f.services.feedback).toHaveBeenCalledExactlyOnceWith(f.data.group.rootSessionId);
  });
  it('opens the group model and access menus, and the file picker, from their rows', async () => {
    const f = await composer('en');
    const picker = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await f.type('/mod'); await f.key('Enter');
    const model = f.element.querySelector<HTMLButtonElement>(`button[aria-label^="${f.labels['groups.model']}:"]`);
    expect(model?.getAttribute('aria-expanded')).toBe('true');
    await f.key('Escape'); await click(model as HTMLButtonElement);
    await f.type('/perm'); await f.key('Enter');
    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain(f.data.group.cwd);
    await f.type('/fi'); await f.key('Enter');
    expect(picker).toHaveBeenCalledOnce();
  });
  it('opens the menu from the add button, and runs a bare command typed with the menu dismissed', async () => {
    const f = await composer('zh');
    await click(button(f.element, f.labels['groups.addOrCommand']));
    await vi.waitFor(() => expect(f.listbox()?.querySelectorAll('[role="option"]').length).toBe(5));
    expect(document.activeElement).toBe(f.input);
    await f.key('Escape'); expect(f.listbox()).toBeNull();
    await f.type('/下载日志'); await f.key('Escape');
    await f.key('Enter');
    expect(f.services.exportLog).toHaveBeenCalledExactlyOnceWith(f.data.group.rootSessionId);
    expect(f.send).not.toHaveBeenCalled(); expect(f.input.value).toBe('');
  });
});
