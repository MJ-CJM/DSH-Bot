// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { ActivitySession } from '../../src/shared/activity.js';
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
  vi.restoreAllMocks();
});

function session(id: string, preset: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id: id as SessionSummary['id'], title: id, displayTitle: id, updatedAt, running: false, blank: false,
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
  const summary = (sessionId: string, preview = 'Assistant reply', updatedAt = Date.now()): ActivitySession => ({
    sessionId, botId: 'alpha-bot', updatedAt, unread: true, lastMessage: { role: 'assistant', preview, at: updatedAt },
  });

  it.each(['en', 'zh'] as const)('renders unread counts, localized hidden previews, and awaits markRead before navigating in %s', async (language) => {
    const app = await setup(language);
    const now = Date.now();
    app.remote.data.activities = [summary('alpha-new', '[已隐藏]', now - 60_000),
      { ...summary('beta-one', 'Research reply', now), botId: 'beta-bot' }];
    const actions = app.core.entries('sidebar.footer.action')[0]?.inject?.() as unknown as BotSessionsSidebarInjected;
    await act(async () => actions.onRefresh());
    await app.setSessions(catalog([session('alpha-new', 'host-selected/alpha-bot', now - 60_000, { running: true }),
      session('beta-one', 'host-selected/beta-bot', now)]));
    expect(app.sidebar.querySelector('[data-bot-unread="footer"]')?.getAttribute('aria-label'))
      .toBe(app.dictionary['activity.unreadCount'].replace('{count}', '2'));
    await app.show();
    expect([...app.sidebar.querySelectorAll('section[data-bot-id]')].map((item) => item.getAttribute('data-bot-id')))
      .toEqual(['beta-bot', 'alpha-bot']);
    expect(app.sidebar.querySelector('[data-bot-unread="alpha-bot"]')?.textContent).toBe('1');
    const row = app.sidebar.querySelector<HTMLButtonElement>('[data-session-id="alpha-new"]');
    if (!row) throw new Error('Missing activity session');
    expect(row.querySelector('[data-activity-preview]')?.textContent).toBe(app.dictionary['activity.hidden']);
    expect(row.textContent).toContain(new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' }).format(-1, 'minute'));
    expect(row.textContent).toContain(app.dictionary['activity.running']);
    expect(row.querySelector('[data-session-unread]')).not.toBeNull();
    const originalMarkRead = app.remote.methods.activity.markRead.getMockImplementation();
    if (!originalMarkRead) throw new Error('Missing markRead double');
    let resolveRead!: () => void;
    app.remote.methods.activity.markRead.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { resolveRead = resolve; });
      return originalMarkRead(...args);
    });
    await click(row);
    expect(app.remote.methods.activity.markRead).toHaveBeenCalledExactlyOnceWith('alpha-new');
    expect(app.openSession).not.toHaveBeenCalled();
    expect(app.sidebar.querySelector('dialog')).not.toBeNull();
    expect(row.disabled).toBe(true);
    await act(async () => resolveRead());
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('alpha-new');
    expect(app.sidebar.querySelector('dialog')).toBeNull();
    await app.show();
    expect(app.sidebar.querySelector('[data-session-unread="alpha-new"]')).toBeNull();
    expect(app.sidebar.querySelector('[data-bot-unread="alpha-bot"]')).toBeNull();
  });

  it('opens the session and closes the dialog after markRead failure, retaining unread for retry', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await setup();
    app.remote.data.activities = [summary('alpha-new')];
    const actions = app.core.entries('sidebar.footer.action')[0]?.inject?.() as unknown as BotSessionsSidebarInjected;
    await act(async () => actions.onRefresh());
    await app.setSessions(catalog([session('alpha-new', 'host-selected/alpha-bot', Date.now())]));
    await app.show();
    app.remote.methods.activity.markRead.mockResolvedValueOnce({ ok: false, error: new RemoteError('store/unavailable', 'private transport detail', {}) });
    await click(button(app.sidebar, 'alpha-new'));
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('alpha-new');
    expect(app.sidebar.querySelector('dialog')).toBeNull();
    expect(warning).toHaveBeenCalledExactlyOnceWith(en.ui['activity.readFailed']);
    await app.show();
    expect(app.sidebar.textContent).not.toContain('private transport detail');
    expect(app.sidebar.querySelector('[data-session-unread="alpha-new"]')).not.toBeNull();
    await click(button(app.sidebar, 'alpha-new'));
    expect(app.openSession).toHaveBeenCalledTimes(2);
    expect(app.sidebar.querySelector('dialog')).toBeNull();
  });

  it('does not navigate or refresh after an in-flight read finishes following plugin unload', async () => {
    const app = await setup();
    app.remote.data.activities = [summary('alpha-new')];
    const actions = app.core.entries('sidebar.footer.action')[0]?.inject?.() as unknown as BotSessionsSidebarInjected;
    await act(async () => actions.onRefresh());
    await app.setSessions(catalog([session('alpha-new', 'host-selected/alpha-bot', Date.now())]));
    await app.show();
    const originalMarkRead = app.remote.methods.activity.markRead.getMockImplementation();
    if (!originalMarkRead) throw new Error('Missing markRead double');
    let resolveRead!: () => void;
    app.remote.methods.activity.markRead.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { resolveRead = resolve; });
      return originalMarkRead(...args);
    });
    await click(button(app.sidebar, 'alpha-new'));
    await app.unloadPlugin();
    const before = app.remote.methods.activity.list.mock.calls.length;
    await act(async () => resolveRead());
    expect(app.openSession).not.toHaveBeenCalled();
    expect(app.remote.methods.activity.list).toHaveBeenCalledTimes(before);
    expect(app.sidebar.textContent).toBe('');
    expect(app.sessionListeners.size).toBe(0);
  });

  it('keeps previews on a single ellipsized line using theme tokens', () => {
    const css = readFileSync('src/client/styles/sidebar.module.css', 'utf8');
    expect(css).toMatch(/\.name, \.sessionTitle, \.preview\s*\{[^}]*overflow:\s*hidden;[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis/s);
    expect(css).toMatch(/\.unreadDot\s*\{[^}]*var\(--dsw-alias-state-error-primary\)/s);
  });

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
    expect([...app.sidebar.querySelectorAll('[data-session-id]')].map((node) => node.getAttribute('data-session-id'))).toEqual(['alpha-new', 'alpha-mid', 'beta-one']);
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

  it('polls only activity in the footer, follows session events and mutation refreshes, and cleans up on unload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const app = await setup();
    const startCalls = app.remote.methods.list.mock.calls.length;
    await app.show();
    // jsdom queues a zero-delay selectionchange when the modal focuses a control.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.getTimerCount()).toBe(1);
    const activityCalls = app.remote.methods.activity.list.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    // Unchanged results back off through 5, 10, 15 and 20 seconds.
    expect(app.remote.methods.activity.list).toHaveBeenCalledTimes(activityCalls + 4);
    expect(app.remote.methods.list).toHaveBeenCalledTimes(startCalls);
    await app.setSessions(catalog([session('first', 'host-selected/alpha-bot', 1)]));
    expect(app.sidebar.textContent).toContain('first');
    await app.setSessions(catalog([session('first', 'standard', 1), session('second', 'host-selected/alpha-bot', 3)]));
    expect(app.sidebar.textContent).not.toContain('first');
    expect(app.sidebar.textContent).toContain('second');
    const actions = app.main.inject?.() as unknown as { onUpdate(id: string, patch: { name: string }): Promise<void> };
    await act(async () => actions.onUpdate('alpha-bot', { name: 'Renamed Bot' }));
    expect(app.sidebar.textContent).toContain('Renamed Bot');
    expect(vi.getTimerCount()).toBe(1);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(0);
    visibility.mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(1);
    expect(app.sessionListeners.size).toBe(1);
    await app.unloadPlugin();
    expect(app.core.entries('sidebar.footer.action')).toHaveLength(0);
    expect(app.sidebar.textContent).toBe('');
    expect(app.sessionListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('creates directly with the Host preset and offers a keyboard-accessible collapsed action', async () => {
    const app = await setup();
    await app.mountSidebar(false);
    expect(button(app.sidebar, en.ui['sidebar.sessions']).textContent).toBe('');
    await app.show();
    const focused = document.activeElement;
    expect(focused?.closest('dialog')).not.toBeNull();
    await click(button(app.sidebar, en.ui['sidebar.newSession'].replace('{name}', 'Alpha Bot')));
    expect(app.createSession).toHaveBeenCalledExactlyOnceWith({ cwd: '/test/dsh-bot/bots/alpha-bot/home', agentPreset: 'host-selected/alpha-bot' });
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('test-created-session');
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.sidebar.querySelector('dialog')).toBeNull();
  });

  it('asks for multiple workspaces, remembers the successful choice across page/sidebar and cancels without creating', async () => {
    const app = await setup();
    await app.setWorkspaces({ items: [workspace(), workspace('workspace-two', 'Second workspace')] });
    await app.show();
    await click(button(app.sidebar, en.ui['sidebar.moreActions'].replace('{name}', 'Alpha Bot')));
    await click(button(app.sidebar, en.ui['chat.inWorkspace']));
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(field(app.sidebar, en.ui['chat.workspace']).value).toBe('');
    await fill(field(app.sidebar, en.ui['chat.workspace']), 'workspace-two');
    await submit(app.sidebar);
    expect(app.openWorkspace).toHaveBeenCalledWith('workspace-two', expect.any(Function), { agentPreset: 'host-selected/alpha-bot' });
    await app.remountPage();
    await click(button(app.container, en.ui['card.more']));
    await click(button(app.container, en.ui['chat.inWorkspace']));
    expect(field(app.container, en.ui['chat.workspace']).value).toBe('workspace-two');
    await click(button(app.container, en.ui['actions.cancel']));
    expect(app.openWorkspace).toHaveBeenCalledTimes(1);
    await app.unmountPage();
    await app.show();
    await click(button(app.sidebar, en.ui['sidebar.moreActions'].replace('{name}', 'Beta Bot')));
    await click(button(app.sidebar, en.ui['chat.inWorkspace']));
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
    await actions.onStartInWorkspace('alpha-bot', 'workspace-two');
    expect(actions.getPreferredWorkspace()).toBe('');
    const lifetime = new AbortController();
    app.openWorkspace.mockImplementationOnce(async (_id, beforeOpen) => {
      beforeOpen?.('created' as SessionSummary['id']);
      // A real selectPanel switches the page immediately after beforeOpen.
      lifetime.abort();
    });
    await actions.onStartInWorkspace('alpha-bot', 'workspace-two', lifetime.signal);
    expect(actions.getPreferredWorkspace()).toBe('workspace-two');
  });

  it('settles a pending workspace chooser on unload without creating or retaining subscriptions', async () => {
    const app = await setup();
    await app.setWorkspaces({ items: [workspace(), workspace('workspace-two', 'Second workspace')] });
    await app.show();
    await click(button(app.sidebar, en.ui['sidebar.moreActions'].replace('{name}', 'Alpha Bot')));
    await click(button(app.sidebar, en.ui['chat.inWorkspace']));
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
    await actions.onOpenSession('late' as SessionSummary['id']);
    expect(app.selectPanel).not.toHaveBeenCalled();
    expect(app.openSession).not.toHaveBeenCalled();
  });
});
