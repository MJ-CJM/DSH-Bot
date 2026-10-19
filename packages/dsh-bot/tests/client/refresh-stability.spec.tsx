// @vitest-environment jsdom
import { act } from 'react';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotsPageInjected } from '../../src/client/pages/BotsPage.js';
import { readBotsLayout } from '../../scripts/screenshot-support.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { bot, button, click, mountClient } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
async function mount(language: 'en' | 'zh' = 'en') {
  const app = await mountClient([bot()], language, undefined, {}, undefined, true);
  cleanups.push(app.dispose);
  return app;
}

describe('background refresh across mounted Bot surfaces', () => {
  it.each(['en', 'zh'] as const)('waits for the independent initial native session list, then retains history nodes/attributes on equal refresh (%s)', async (language) => {
    const copy = language === 'zh' ? zh.ui : en.ui;
    const sessions = ['old', 'new'].map((id, index) => ({ id, title: `Conversation ${id}`, running: false,
      blank: false, updatedAt: Date.now() - (2 - index) * 1000, retainedBy: {},
      projectionValues: { agentPreset: 'host-selected/alpha-bot' } }) as unknown as SessionSummary);
    const app = await mountClient([bot()], language, (remote) => {
      remote.data.activities = sessions.map((session) => ({ sessionId: session.id, botId: 'alpha-bot', title: session.title,
        updatedAt: session.updatedAt, unread: true, lastMessage: { role: 'assistant', preview: 'Mock reply', at: session.updatedAt } }));
    }, {}, undefined, false, { phase: 'pending' });
    cleanups.push(app.dispose);
    // This is the old script's race: Bot preview + detail already exist while
    // the native list's first response has not arrived. No row lost its ID.
    expect(app.container.querySelector('[role="option"]')?.textContent).toContain('Mock reply');
    expect(readBotsLayout()).toMatchObject({ detailBotId: 'alpha-bot', sessionIds: [], detailStatuses: [copy['activity.loading']] });
    const actions = app.main.inject?.() as unknown as BotsPageInjected;
    await act(async () => actions.onRefresh());
    expect(readBotsLayout().sessionIds).toEqual([]);
    await app.setSessions({ phase: 'ready', ids: sessions.map((session) => session.id),
      byId: Object.fromEntries(sessions.map((session) => [session.id, session])) });
    expect(readBotsLayout()).toMatchObject({ sessionIds: ['new', 'old'], detailStatuses: [] });
    const rows = [...app.container.querySelectorAll('[data-bot-detail] [data-session-id]')];
    const commits = app.renderCount();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(app.container, { childList: true, subtree: true, attributes: true, characterData: true });
    try {
      await act(async () => actions.onRefresh());
      await act(async () => actions.onRefresh());
      expect(app.renderCount()).toBe(commits);
      expect(readBotsLayout()).toMatchObject({ sessionIds: ['new', 'old'], detailStatuses: [] });
      const nextRows = [...app.container.querySelectorAll('[data-bot-detail] [data-session-id]')];
      nextRows.forEach((row, index) => { expect(row).toBe(rows[index]); });
      expect([...mutations, ...observer.takeRecords()]).toEqual([]);
    } finally { observer.disconnect(); }
  });

  it('does not commit another render, replace DOM, toggle loading or lose focus/scroll/expansion on equal refreshes', async () => {
    const app = await mount();
    const right = await app.mountRightTab();
    const sidebar = await app.mountSidebar();
    await click(button(sidebar, en.ui['sidebar.sessions']));
    const toggle = sidebar.querySelector<HTMLButtonElement>('[aria-expanded][aria-label^="Toggle"]')
      ?? sidebar.querySelector<HTMLButtonElement>('section[data-bot-id] button[aria-expanded]');
    if (!toggle) throw new Error('Missing Bot group');
    await click(toggle);
    const list = right.querySelector<HTMLElement>('[role="listbox"]');
    if (!list) throw new Error('Missing right list');
    list.scrollTop = 71;
    list.focus();
    const roots = [app.container, right, sidebar];
    const nodes = roots.map((root) => [...root.querySelectorAll('*')]);
    const html = roots.map((root) => root.innerHTML);
    const entries = [app.main, app.core.entries('sidebar.footer.action')[0], app.core.entries('sidebar.right.pane.tab')[0]];
    const counts = entries.map((entry) => entry ? app.renderCount(entry) : 0);
    const actions = app.main.inject?.() as unknown as BotsPageInjected;
    let resolve!: () => void;
    const load = app.remote.methods.list.getMockImplementation();
    if (!load) throw new Error('Missing list');
    app.remote.methods.list.mockImplementationOnce(async () => { await new Promise<void>((done) => { resolve = done; }); return load(); });
    let pending!: Promise<void>;
    await act(async () => { pending = actions.onRefresh(); });
    expect(roots.map((root) => root.innerHTML)).toEqual(html);
    await act(async () => { resolve(); await pending; });
    await act(async () => { await actions.onRefresh(); });
    expect(entries.map((entry) => entry ? app.renderCount(entry) : 0)).toEqual(counts);
    expect(roots.map((root) => root.innerHTML)).toEqual(html);
    roots.forEach((root, index) => {
      const next = [...root.querySelectorAll('*')];
      expect(next.length).toBe(nodes[index]?.length);
      next.forEach((node, offset) => { expect(node).toBe(nodes[index]?.[offset]); });
    });
    expect(document.activeElement).toBe(list);
    expect(list.scrollTop).toBe(71);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it.each(['en', 'zh'] as const)('keeps old rows through inline errors and removes the error on recovery in %s', async (language) => {
    const app = await mount(language);
    const copy = language === 'zh' ? zh.ui : en.ui;
    const actions = app.main.inject?.() as unknown as BotsPageInjected;
    const row = app.container.querySelector('[data-bot-id="alpha-bot"][role="option"]');
    expect(app.container.querySelector('[data-bot-detail] header')?.textContent).not.toContain(copy['bots.ready']);
    app.remote.methods.list.mockResolvedValueOnce({ ok: false, error: new RemoteError('store/unavailable', '', {}) });
    await act(async () => actions.onRefresh());
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(copy['errors.load']);
    expect(app.container.querySelector('[data-bot-id="alpha-bot"][role="option"]')).toBe(row);
    await act(async () => actions.onRefresh());
    expect(app.container.querySelector('[role="alert"]')).toBeNull();
    expect(app.container.querySelector('[data-bot-id="alpha-bot"][role="option"]')).toBe(row);
    expect(app.container.querySelector('[data-bot-detail] header [role="status"]')).toBeNull();
  });

  it.each(['en', 'zh'] as const)('uses localized new-conversation fallback and omits empty preview in page and dialog (%s)', async (language) => {
    const app = await mount(language);
    const copy = language === 'zh' ? zh.ui : en.ui;
    const session = { id: 'untitled', displayTitle: 'pod_0814', cwd: '/projects/pod_0814', running: false,
      blank: false, updatedAt: Date.now(), retainedBy: {}, projectionValues: { agentPreset: 'host-selected/alpha-bot' } } as unknown as SessionSummary;
    await app.setSessions({ ids: [session.id], byId: { [session.id]: session } });
    const sidebar = await app.mountSidebar();
    await click(button(sidebar, copy['sidebar.sessions']));
    for (const root of [app.container, sidebar]) {
      const row = root.querySelector('[data-session-id="untitled"]');
      expect(row?.textContent).toContain(copy['sidebar.untitled']);
      expect(row?.textContent).not.toContain('pod_0814');
      expect(row?.querySelector('[data-activity-preview]')).toBeNull();
      expect(row?.textContent).not.toContain(copy['activity.noPreview']);
    }
    await app.setSessions({ byId: { [session.id]: { ...session, title: 'Actual renamed conversation' } } });
    expect(app.container.querySelector('[data-session-id="untitled"]')?.textContent).toContain('Actual renamed conversation');
    expect(sidebar.querySelector('[data-session-id="untitled"]')?.textContent).toContain('Actual renamed conversation');
  });
});
