// @vitest-environment jsdom
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { Config } from '../../src/client/config.js';
import { BotSessionsSidebar, groupBotSessions, type BotSessionsSidebarInjected } from '../../src/client/components/BotSessionsSidebar.js';
import { bot, button, click, field, fill, mountClient, submit, workspace } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

function session(id: string, preset: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id: id as SessionSummary['id'], displayTitle: id, updatedAt, running: false, blank: false,
    retainedBy: {} as SessionSummary['retainedBy'], projectionValues: { agentPreset: preset }, ...extra };
}
function catalog(rows: SessionSummary[]): SessionListState {
  return { ids: rows.map((row) => row.id), byId: Object.fromEntries(rows.map((row) => [row.id, row])), phase: 'ready', projectionsBySession: {} };
}
async function setup(language: 'en' | 'zh' = 'en', limit = 2) {
  const app = await mountClient([bot(), bot({ id: 'beta-bot', name: 'Beta Bot' })], language, undefined, { sidebarSessionLimit: limit });
  cleanups.push(app.dispose);
  await app.unmountPage();
  const container = await app.mountSidebar();
  const dictionary = language === 'en' ? en.ui : zh.ui;
  const show = async () => { await click(button(container, dictionary['sidebar.sessions'])); };
  return { ...app, sidebar: container, dictionary, show };
}

describe('Bot conversations through the supported sidebar footer action', () => {
  it('groups only Host list members by exact status preset id, sorts by recency, and leaves native data intact', () => {
    const rows = catalog([
      session('older', 'namespace/alpha', 1), session('newer', 'namespace/alpha', 9),
      session('ordinary', 'standard', 10), session('wrong-prefix', 'bot-alpha-bot', 20),
      session('child', 'namespace/alpha', 30, { origin: 'subagent' }), session('archived', 'namespace/alpha', 40),
    ]);
    rows.byId['retained-only' as SessionSummary['id']] = session('retained-only', 'namespace/alpha', 100);
    const before = structuredClone(rows);
    const grouped = groupBotSessions([{ bot: bot(), status: { id: 'alpha-bot', presetId: 'namespace/alpha', preset: { state: 'ok' } } }], rows, ['archived' as SessionSummary['id']]);
    expect(grouped.get('alpha-bot')?.map((row) => row.id)).toEqual(['newer', 'older']);
    expect(rows).toEqual(before);
  });

  it.each(['en', 'zh'] as const)('renders localized groups, expands more, folds, opens sessions and reaches management in %s', async (language) => {
    const app = await setup(language);
    expect(button(app.sidebar, app.dictionary['sidebar.sessions']).textContent).toBe(language === 'en' ? 'Bot chats' : 'Bot 会话');
    await app.setSessions(catalog([
      session('alpha-new', 'host-selected/alpha-bot', 30), session('alpha-mid', 'host-selected/alpha-bot', 20),
      session('alpha-old', 'host-selected/alpha-bot', 10), session('beta-one', 'host-selected/beta-bot', 8),
      session('not-a-bot', 'standard', 100),
    ]));
    await app.show();
    expect(app.sidebar.querySelector('dialog h2')?.textContent).toBe(app.dictionary['sidebar.sessions']);
    expect(app.core.entries('sidebar.footer.action')[0]?.component).toBe(BotSessionsSidebar);
    expect(app.core.entries('sidebar.panellist')).toHaveLength(1);
    expect([...app.sidebar.querySelectorAll('[data-session-id]')].map((node) => node.textContent)).toEqual(['alpha-new', 'alpha-mid', 'beta-one']);
    await click(button(app.sidebar, app.dictionary['sidebar.more']));
    expect(app.sidebar.textContent).toContain('alpha-old');
    const toggle = button(app.sidebar, app.dictionary['sidebar.toggle'].replace('{name}', 'Alpha Bot'));
    await click(toggle);
    expect(app.sidebar.textContent).not.toContain('alpha-new');
    await click(toggle);
    await click(button(app.sidebar, 'alpha-new'));
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('alpha-new');
    expect(app.sidebar.querySelector('dialog')).toBeNull();
    await app.show();
    await click(button(app.sidebar, app.dictionary['sidebar.manage']));
    expect(app.selectPanel).toHaveBeenCalledExactlyOnceWith('dsh-bot');
    await app.show();
    const titleAction = app.sidebar.querySelector<HTMLButtonElement>('dialog h2 button');
    expect(titleAction?.title).toBe(app.dictionary['sidebar.manage']);
    if (!titleAction) throw new Error('Missing title management action');
    await click(titleAction);
    expect(app.selectPanel).toHaveBeenCalledTimes(2);
    expect(app.selectPanel).toHaveBeenLastCalledWith('dsh-bot');
    expect(app.sidebar.querySelector('dialog')).toBeNull();
  });

  it('subscribes passively, follows session events and mutation refreshes, and cleans up on unload', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const app = await setup();
    const startCalls = app.remote.methods.list.mock.calls.length;
    await app.show();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(startCalls);
    await app.setSessions(catalog([session('first', 'host-selected/alpha-bot', 1)]));
    expect(app.sidebar.textContent).toContain('first');
    await app.setSessions(catalog([session('first', 'standard', 1), session('second', 'host-selected/alpha-bot', 3)]));
    expect(app.sidebar.textContent).not.toContain('first');
    expect(app.sidebar.textContent).toContain('second');
    const actions = app.main.inject?.() as unknown as { onUpdate(id: string, patch: { name: string }): Promise<void> };
    await act(async () => actions.onUpdate('alpha-bot', { name: 'Renamed Bot' }));
    expect(app.sidebar.textContent).toContain('Renamed Bot');
    expect(vi.getTimerCount()).toBe(0);
    expect(app.sessionListeners.size).toBe(1);
    await app.unloadPlugin();
    expect(app.core.entries('sidebar.footer.action')).toHaveLength(0);
    expect(app.sidebar.textContent).toBe('');
    expect(app.sessionListeners.size).toBe(0);
  });

  it('opens in the only workspace with the Host preset and offers a keyboard-accessible collapsed action', async () => {
    const app = await setup();
    await app.mountSidebar(false);
    expect(button(app.sidebar, en.ui['sidebar.sessions']).textContent).toBe('');
    await app.show();
    const focused = document.activeElement;
    expect(focused?.closest('dialog')).not.toBeNull();
    await click(button(app.sidebar, en.ui['sidebar.newSession'].replace('{name}', 'Alpha Bot')));
    expect(app.openWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-one', expect.any(Function), { agentPreset: 'host-selected/alpha-bot' });
    expect(app.sidebar.querySelector('dialog')).toBeNull();
  });

  it('asks for multiple workspaces, remembers the successful choice across page/sidebar and cancels without creating', async () => {
    const app = await setup();
    await app.setWorkspaces({ items: [workspace(), workspace('workspace-two', 'Second workspace')] });
    await app.show();
    await click(button(app.sidebar, en.ui['sidebar.newSession'].replace('{name}', 'Alpha Bot')));
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(field(app.sidebar, en.ui['chat.workspace']).value).toBe('');
    await fill(field(app.sidebar, en.ui['chat.workspace']), 'workspace-two');
    await submit(app.sidebar);
    expect(app.openWorkspace).toHaveBeenCalledWith('workspace-two', expect.any(Function), { agentPreset: 'host-selected/alpha-bot' });
    await app.remountPage();
    await click(button(app.container, en.ui['card.start']));
    expect(field(app.container, en.ui['chat.workspace']).value).toBe('workspace-two');
    await click(button(app.container, en.ui['actions.cancel']));
    expect(app.openWorkspace).toHaveBeenCalledTimes(1);
    await app.unmountPage();
    await app.show();
    await click(button(app.sidebar, en.ui['sidebar.newSession'].replace('{name}', 'Beta Bot')));
    expect(field(app.sidebar, en.ui['chat.workspace']).value).toBe('workspace-two');
    await click(button(app.sidebar, en.ui['actions.cancel']));
    expect(app.openWorkspace).toHaveBeenCalledTimes(1);
    expect(app.sidebar.textContent).toContain(en.ui['sidebar.sessions']);
  });

  it('revalidates status at click time, reports failure and does not open an invalid preset', async () => {
    const app = await setup();
    await app.show();
    app.remote.data.statuses = [{ id: 'alpha-bot', presetId: 'host-selected/alpha-bot', preset: { state: 'broken' } }];
    await click(button(app.sidebar, en.ui['sidebar.newSession'].replace('{name}', 'Alpha Bot')));
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.sidebar.querySelector('[role="alert"]')?.textContent).toContain(en.ui['card.statusBroken']);
    await act(async () => {
      app.sidebar.querySelector('dialog')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(app.sidebar.querySelector('dialog')).toBeNull();
  });

  it('remembers before successful navigation unmounts the page, but not a superseded open', async () => {
    const app = await setup();
    await app.setWorkspaces({ items: [workspace(), workspace('workspace-two', 'Second workspace')] });
    const actions = app.core.entries('sidebar.footer.action')[0]?.inject?.() as unknown as BotSessionsSidebarInjected;
    app.openWorkspace.mockImplementationOnce(async () => {});
    await actions.onStart('alpha-bot', 'workspace-two');
    expect(actions.getPreferredWorkspace()).toBe('');
    const lifetime = new AbortController();
    app.openWorkspace.mockImplementationOnce(async (_id, beforeOpen) => {
      beforeOpen?.('created' as SessionSummary['id']);
      // A real selectPanel switches the page immediately after beforeOpen.
      lifetime.abort();
    });
    await actions.onStart('alpha-bot', 'workspace-two', lifetime.signal);
    expect(actions.getPreferredWorkspace()).toBe('workspace-two');
  });

  it('settles a pending workspace chooser on unload without creating or retaining subscriptions', async () => {
    const app = await setup();
    await app.setWorkspaces({ items: [workspace(), workspace('workspace-two', 'Second workspace')] });
    await app.show();
    await click(button(app.sidebar, en.ui['sidebar.newSession'].replace('{name}', 'Alpha Bot')));
    expect(app.sidebar.querySelector('select')).not.toBeNull();
    await app.unloadPlugin();
    expect(app.sidebar.textContent).toBe('');
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.sessionListeners.size).toBe(0);
  });

  it('validates the configurable page bound and guards captured navigation after disposal', async () => {
    expect(Config({}).sidebarSessionLimit).toBe(5);
    for (const sidebarSessionLimit of [0, 51, 1.5]) expect(() => Config({ sidebarSessionLimit })).toThrow();
    const app = await setup();
    const actions = app.core.entries('sidebar.footer.action')[0]?.inject?.() as unknown as BotSessionsSidebarInjected;
    await app.unloadPlugin();
    actions.onManage();
    actions.onOpenSession('late' as SessionSummary['id']);
    expect(app.selectPanel).not.toHaveBeenCalled();
    expect(app.openSession).not.toHaveBeenCalled();
  });
});
