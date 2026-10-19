// @vitest-environment jsdom
import { act } from 'react';
import { readFileSync } from 'node:fs';
import type { ActivitySession } from '../../src/shared/activity.js';
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { Config } from '../../src/client/config.js';
import type { BotStatus } from '../../src/shared/remote-contract.js';
import { bot, button, click, field, fill, loadBuiltClient, mountClient, submit, workspace } from './helpers.js';

const t = en.ui;
const mounted: Awaited<ReturnType<typeof mountClient>>[] = [];
async function mount(...args: Parameters<typeof mountClient>) {
  const app = await mountClient(...args);
  mounted.push(app);
  return app;
}
afterEach(async () => {
  for (const app of mounted.splice(0).reverse()) await app.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});


function session(id: string, botId: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id: id as SessionSummary['id'], title: id, displayTitle: id, updatedAt, running: false, blank: false,
    retainedBy: {}, projectionValues: { agentPreset: `host-selected/${botId}` }, ...extra };
}
function activity(sessionId: string, botId: string, updatedAt: number, preview = 'Assistant answer'): ActivitySession {
  return { sessionId, botId, updatedAt, unread: true, lastMessage: { role: 'assistant', preview, at: updatedAt } };
}
async function setSessions(app: Awaited<ReturnType<typeof mount>>, rows: SessionSummary[]) {
  await app.setSessions({ ids: rows.map((row) => row.id), byId: Object.fromEntries(rows.map((row) => [row.id, row])) });
}
async function key(element: HTMLElement, value: string) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })); });
}

describe('Bots main page through the public Cordis and Slot registration contract', () => {
  it('orders Bots by activity then name, retains the selected Bot across polls, and supports listbox keys', async () => {
    const now = Date.now();
    const app = await mount([bot({ id: 'gamma-bot', name: 'Gamma' }), bot(), bot({ id: 'beta-bot', name: 'Beta' })], 'en', (remote) => {
      remote.data.activities = [activity('beta-session', 'beta-bot', now - 1000)];
    });
    const options = () => [...app.container.querySelectorAll('[role="option"]')];
    expect(options().map((item) => item.getAttribute('data-bot-id'))).toEqual(['beta-bot', 'alpha-bot', 'gamma-bot']);
    expect(app.container.querySelector('[data-bot-detail]')?.getAttribute('data-bot-detail')).toBe('beta-bot');
    const list = app.container.querySelector<HTMLElement>('[role="listbox"]');
    if (!list) throw new Error('Bot list is missing');
    await key(list, 'ArrowDown');
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(list.getAttribute('aria-activedescendant')).toBe(options()[1]?.id);
    expect(app.container.querySelector('[data-bot-detail]')?.getAttribute('data-bot-detail')).toBe('alpha-bot');
    app.remote.data.activities = [activity('gamma-session', 'gamma-bot', now)];
    await click(button(app.container, t['bots.refresh']));
    expect(options().map((item) => item.getAttribute('data-bot-id'))).toEqual(['gamma-bot', 'alpha-bot', 'beta-bot']);
    expect(app.container.querySelector('[data-bot-detail]')?.getAttribute('data-bot-detail')).toBe('alpha-bot');
    await key(list, 'End');
    expect(options()[2]?.getAttribute('aria-selected')).toBe('true');
    await key(list, 'ArrowUp');
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true');
    await key(list, 'Home');
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
    app.remote.data.records = app.remote.data.records.filter((row) => row.id !== 'gamma-bot');
    await click(button(app.container, t['bots.refresh']));
    expect(app.container.querySelector('[data-bot-detail]')?.getAttribute('data-bot-detail')).toBe('alpha-bot');
  });

  it.each(['en', 'zh'] as const)('renders session previews, unread and running states with locale-relative times in %s', async (language) => {
    const now = Date.now();
    const dictionary = language === 'en' ? en.ui : zh.ui;
    const preview = 'This is a long assistant reply. '.repeat(4);
    const app = await mount([bot()], language, (remote) => {
      remote.data.activities = [activity('older', 'alpha-bot', now - 120_000, preview),
        { ...activity('newer', 'alpha-bot', now - 60_000, '[已隐藏]'), title: 'Latest conversation' }];
    });
    await setSessions(app, [session('older', 'alpha-bot', now - 120_000), session('newer', 'alpha-bot', now - 60_000, { running: true, title: undefined })]);
    const rows = [...app.container.querySelectorAll('[data-session-id]')];
    expect(rows.map((row) => row.getAttribute('data-session-id'))).toEqual(['newer', 'older']);
    expect(rows[0]?.textContent).toContain('Latest conversation');
    expect(rows[0]?.textContent).toContain(dictionary['activity.hidden']);
    expect(rows[0]?.textContent).toContain(dictionary['activity.running']);
    expect(rows[0]?.querySelector('[data-unread]')).not.toBeNull();
    expect(rows[0]?.querySelector('time')?.textContent).toBe(new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' }).format(-1, 'minute'));
    const option = app.container.querySelector('[role="option"]');
    expect(option?.querySelector('[data-unread]')?.getAttribute('aria-label')).toBe(dictionary['activity.unreadCount'].replace('{count}', '2'));
    expect(option?.querySelector('[data-activity-preview]')?.textContent).toBe(dictionary['activity.hidden']);
    expect(rows[1]?.querySelector('[data-activity-preview]')?.getAttribute('title')).toBe(preview);
    // jsdom cannot measure ellipsis; verify the CSS contract without claiming a screenshot.
    const css = readFileSync('src/client/styles/bots.module.css', 'utf8');
    expect(css.match(/\.activityPreview\s*\{([^}]+)\}/)?.[1]).toMatch(/overflow:\s*hidden/);
    expect(css.match(/\.activityPreview\s*\{([^}]+)\}/)?.[1]).toMatch(/text-overflow:\s*ellipsis/);
    expect(css.match(/\.activityPreview\s*\{([^}]+)\}/)?.[1]).toMatch(/white-space:\s*nowrap/);
  });

  it('opens history even if markRead fails, logs only localized text, and preserves unread for retry', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = Date.now();
    const app = await mount([bot()], 'en', (remote) => { remote.data.activities = [activity('history', 'alpha-bot', now)]; });
    await setSessions(app, [session('history', 'alpha-bot', now)]);
    const row = app.container.querySelector<HTMLButtonElement>('[data-session-id="history"]');
    if (!row) throw new Error('History row is missing');
    app.remote.methods.activity.markRead.mockResolvedValueOnce({ ok: false, error: new RemoteError('store/unavailable', 'Sensitive transport detail', {}) });
    await click(row);
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('history');
    expect(row.querySelector('[data-unread]')).not.toBeNull();
    expect(warning).toHaveBeenCalledExactlyOnceWith(t['activity.readFailed']);
    expect(app.container.textContent).not.toContain('Sensitive transport detail');
    app.openSession.mockClear();
    const original = app.remote.methods.activity.markRead.getMockImplementation();
    if (!original) throw new Error('markRead implementation missing');
    let release!: () => void;
    app.remote.methods.activity.markRead.mockImplementationOnce(async (id) => { await new Promise<void>((resolve) => { release = resolve; }); return original(id); });
    await click(row);
    expect(app.openSession).not.toHaveBeenCalled();
    expect(row.disabled).toBe(true);
    await act(async () => { release(); });
    expect(app.remote.methods.activity.markRead).toHaveBeenLastCalledWith('history');
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('history');
    expect(row.querySelector('[data-unread]')).toBeNull();
  });

  it('shows list then detail on narrow panels, restores keyboard focus on return, and exposes all management actions', async () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect() {} });
    try {
      const app = await mount([bot()]);
      await act(async () => { resize?.([{ contentRect: { width: 759 } } as ResizeObserverEntry], {} as ResizeObserver); });
      expect(app.container.querySelector('[data-bot-detail]')).toBeNull();
      const list = app.container.querySelector<HTMLElement>('[role="listbox"]');
      if (!list) throw new Error('Narrow Bot list is missing');
      await key(list, 'Enter');
      expect(app.container.querySelector('[role="listbox"]')).toBeNull();
      expect(document.activeElement).toBe(button(app.container, t['bots.back']));
      for (const name of ['bots.newSession', 'card.edit', 'memory.title', 'card.more', 'bots.create'] as const) expect(button(app.container, t[name])).toBeDefined();
      await click(button(app.container, t['memory.title']));
      expect(app.container.querySelector('dialog')?.textContent).toContain(t['memory.empty']);
      expect(button(app.container, t['memory.add'])).toBeDefined();
      await click(button(app.container.querySelector('dialog') as HTMLElement, t['actions.close']));
      await click(button(app.container, t['card.more']));
      expect(button(app.container, t['card.duplicate'])).toBeDefined();
      expect(button(app.container, t['actions.delete'])).toBeDefined();
      await click(button(app.container, t['bots.back']));
      expect(app.container.querySelector('[data-bot-detail]')).toBeNull();
      expect(document.activeElement).toBe(app.container.querySelector('[role="listbox"]'));
      await click(app.container.querySelector<HTMLElement>('[role="option"]') as HTMLElement);
      expect(app.container.querySelector('[data-bot-detail]')).not.toBeNull();
      await act(async () => { resize?.([{ contentRect: { width: 760 } } as ResizeObserverEntry], {} as ResizeObserver); });
      expect(app.container.querySelector('[role="listbox"]')).not.toBeNull();
      expect(app.container.querySelector('[data-bot-detail]')).not.toBeNull();
      expect(app.container.textContent).toContain(t['bots.emptySessionsHint']);
    } finally { vi.unstubAllGlobals(); }
  });

  it('falls back to the description or localized no-conversation message in the Bot list', async () => {
    const app = await mount([bot({ id: 'alpha-bot', name: 'Alpha', description: 'A useful helper' }), bot({ id: 'beta-bot', name: 'Beta' })]);
    const previews = [...app.container.querySelectorAll('[role="option"] [data-activity-preview]')].map((item) => item.textContent);
    expect(previews).toEqual(['A useful helper', t['bots.noSessions']]);
    expect(app.container.querySelector('[data-session-id]')).toBeNull();
    expect(button(app.container, t['bots.newSession']).disabled).toBe(false);
  });

  it('renders a stored-avatar warning without disabling the healthy Bot or failing its list', async () => {
    const app = await mount([bot()], 'en', (remote) => {
      remote.data.statuses = [{ id: 'alpha-bot', presetId: 'custom-alpha', preset: { state: 'ok' }, warnings: ['avatar/invalid'] }];
    });
    expect(app.container.textContent).toContain(t['avatar.invalidStored']);
    expect(app.container.querySelector('img')).toBeNull();
    expect(button(app.container, t['bots.newSession']).disabled).toBe(false);
    await click(button(app.container, t['card.edit']));
    expect(app.container.querySelector('dialog')?.textContent).toContain(t['avatar.invalidStored']);
  });

  it('defaults to 5 seconds and validates the inclusive 1000–60000 ms Client configuration range', () => {
    expect(Config({})).toEqual({ pollIntervalMs: 5000, maxPollIntervalMs: 30000, memoryPageSize: 50, sidebarSessionLimit: 5 });
    for (const value of [1000, 2000, 60000]) expect(Config({ pollIntervalMs: value }).pollIntervalMs).toBe(value);
    for (const value of [999, 60001, 0, -1, 1000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => Config({ pollIntervalMs: value })).toThrow();
    }
    expect(() => Config({ pollIntervalMs: '5000' as never })).toThrow();
  });

  it('validates the memory page size configuration', () => {
    for (const value of [1, 50, 199]) expect(Config({ memoryPageSize: value }).memoryPageSize).toBe(value);
    for (const value of [0, 200, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => Config({ memoryPageSize: value })).toThrow();
  });

  it('counts all memories before Bot deletion and blocks when the count fails', async () => {
    const app = await mount([bot()], 'en', (remote) => {
      remote.methods.memory.count.mockResolvedValueOnce({ ok: false, error: new RemoteError('store/unavailable', 'offline', {}) });
    });
    await click(button(app.container, t['card.more']));
    await click(button(app.container, t['actions.delete']));
    const dialog = app.container.querySelector('dialog');
    if (!dialog) throw new Error('No delete dialog');
    expect(dialog.textContent).toContain(t['delete.countError']);
    expect(button(dialog, t['actions.delete']).disabled).toBe(true);
    expect(app.remote.methods.memory.list).not.toHaveBeenCalled();
    app.remote.methods.memory.count.mockResolvedValueOnce({ ok: true, value: 205 });
    await click(button(dialog, t['actions.retry']));
    expect(dialog.textContent).toContain(t['delete.memoryCount'].replace('{count}', '205'));
    expect(button(dialog, t['actions.delete']).disabled).toBe(false);
    await click(button(dialog, t['actions.cancel']));
    expect(app.remote.methods.delete).not.toHaveBeenCalled();
  });

  it('retains the default polling cadence without exposing refresh interval controls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const app = await mount([bot()]);
    expect(app.container.querySelector('header select')).toBeNull();
    expect(app.container.textContent).not.toContain(t['bots.pollInterval']);
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    await app.unmountPage();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    await app.remountPage();
    expect(app.remote.methods.list).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(4);
  });

  it('polls at the configured custom cadence with no visible interval selector', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const app = await mount([bot()], 'en', undefined, { pollIntervalMs: 2000 });
    expect(app.container.querySelector('header select')).toBeNull();
    expect(app.container.textContent).not.toContain(t['bots.pollInterval']);
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3999); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(3);
  });

  it('renders the native page frame and two-pane detail anatomy with only create and refresh in its header', async () => {
    const app = await mount([bot({ id: 'alpha-bot', name: 'Alpha Bot', description: 'A careful helper' })]);
    const page = app.container.querySelector('[data-bots-page]');
    const header = page?.querySelector('header');
    const article = page?.querySelector('article');
    expect(page?.className).toContain('page');
    expect(header?.parentElement?.className).toContain('pageContent');
    expect(header?.parentElement?.parentElement?.className).toContain('pageScroll');
    expect(header?.querySelector('h1')?.textContent).toBe(t['bots.title']);
    expect(header?.textContent).toContain(t['bots.subtitle']);
    expect(header?.querySelectorAll('button')).toHaveLength(2);
    expect(header?.querySelector('select')).toBeNull();
    expect(header?.textContent).not.toContain(t['chat.workspace']);
    expect(article?.querySelector('header h2')?.textContent).toBe('Alpha Bot');
    expect(article?.querySelector('header')?.textContent).toContain('alpha-bot');
    expect(article?.querySelector('header button[aria-haspopup="menu"]')?.getAttribute('aria-label')).toBe(t['card.more']);
    expect(page?.querySelector('[role="listbox"]')).not.toBeNull();
    expect(article?.getAttribute('data-bot-detail')).toBe('alpha-bot');
    for (const action of ['bots.newSession', 'card.edit', 'memory.title'] as const) {
      expect(button(article as HTMLElement, t[action]).getAttribute('data-platform-size')).toBe('sm');
    }
    expect(article?.querySelector('p')?.textContent).toBe('A careful helper');
  });

  it('switches narrow and wide classes from the actual main panel width and disconnects its observer', async () => {
    let resize: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    try {
      const app = await mount([bot()]);
      const page = app.container.querySelector('[data-bots-page]');
      expect(observe).toHaveBeenCalledWith(page);
      await act(async () => { resize?.([{ contentRect: { width: 540 } } as ResizeObserverEntry], {} as ResizeObserver); });
      expect(page?.className).toContain('compact');
      expect(page?.className).not.toContain('wide');
      await act(async () => { resize?.([{ contentRect: { width: 1080 } } as ResizeObserverEntry], {} as ResizeObserver); });
      expect(page?.className).toContain('wide');
      expect(page?.className).not.toContain('compact');
      await app.unmountPage();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it('renders Bot details and opens the server-selected preset, without constructing a Client prefix', async () => {
    const app = await mount([bot({ id: 'alpha-bot', name: 'Alpha Bot', avatar: '🦊', description: 'A careful helper' })]);
    expect(app.sidebarLabel()).toBe(t['bots.title']);
    expect(app.main.options.key).toBe('dsh-bot');
    expect(app.core.entries('sidebar.panellist')[0]?.options.id).toBe('dsh-bot');
    expect(app.container.querySelector('article')?.textContent).toContain('Alpha Bot');
    expect(app.container.querySelector('article')?.textContent).toContain('A careful helper');
    expect(app.container.querySelector('article')?.textContent).toContain('🦊');
    await click(button(app.container, t['bots.newSession']));
    expect(app.openWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-one', expect.any(Function), {
      agentPreset: 'host-selected/alpha-bot',
    });
  });

  it.each(['en', 'zh'] as const)('shows the localized empty page in %s', async (language) => {
    const app = await mount([], language);
    const dictionary = language === 'en' ? en.ui : zh.ui;
    expect(app.sidebarLabel()).toBe(dictionary['bots.title']);
    expect(app.container.textContent).toContain(dictionary['bots.empty']);
    expect(app.container.querySelectorAll('article')).toHaveLength(0);
    expect(button(app.container, dictionary['bots.create']).disabled).toBe(false);
  });

  it.each(['broken', 'missing'] as const)('disables %s presets and explains the Host reason', async (state) => {
    const app = await mount([bot()], 'en', (remote) => {
      remote.data.statuses = [{ id: 'alpha-bot', presetId: 'private-server-preset', preset: { state, reason: 'Host activation failed' } }];
    });
    const start = button(app.container, t['bots.newSession']);
    expect(start.disabled).toBe(true);
    expect(app.container.textContent).toContain('Host activation failed');
    await click(start);
    expect(app.openWorkspace).not.toHaveBeenCalled();
  });

  it('disables a Bot without a matching status instead of guessing its preset id', async () => {
    const app = await mount([bot()], 'en', (remote) => { remote.data.statuses = []; });
    expect(button(app.container, t['bots.newSession']).disabled).toBe(true);
    expect(app.container.textContent).toContain(t['card.statusUnknown']);
    expect(app.openWorkspace).not.toHaveBeenCalled();
  });

  it('validates the create form before Remote and saves editable fields, then refetches the list', async () => {
    const app = await mount();
    await click(button(app.container, t['bots.create']));
    await fill(field(app.container, t['editor.id']), '../bad');
    await submit(app.container);
    expect(app.remote.methods.create).not.toHaveBeenCalled();
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(t['validation.id']);
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(t['validation.name']);
    await fill(field(app.container, t['editor.id']), 'new-bot');
    await fill(field(app.container, t['editor.name']), 'New Bot');
    await fill(field(app.container, t['editor.description']), 'New description');
    await fill(field(app.container, t['editor.persona']), 'Be precise.\nAsk when needed.');
    await fill(field(app.container, t['editor.template']), 'minimal');
    await fill(field(app.container, t['editor.hiddenTools']), 'read, write\nread');
    await fill(field(app.container, t['editor.injectLimit']), '-1');
    await submit(app.container);
    expect(app.remote.methods.create).not.toHaveBeenCalled();
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(t['validation.memory']);
    await fill(field(app.container, t['editor.injectLimit']), '7');
    await click(app.container.querySelector('details > summary') as HTMLElement);
    await click(button(app.container, '🧠'));
    await submit(app.container);
    expect(app.remote.methods.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: 'new-bot', name: 'New Bot', avatar: '🧠', description: 'New description',
      persona: { prefix: 'Be precise.\nAsk when needed.' }, template: 'minimal',
      tools: { deny: ['read', 'write'] }, memory: { enabled: true, injectLimit: 7 },
    }));
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    expect(app.container.querySelector('dialog,[role="dialog"]')).toBeNull();
    expect(app.container.querySelector('article')?.textContent).toContain('New Bot');
    expect(app.container.textContent).toContain(t['bots.saveSuccess']);
  });

  it('keeps the id immutable and sends null when an avatar is cleared, retaining advanced persona options', async () => {
    const original = bot({
      id: 'alpha-bot', name: 'Alpha Bot', avatar: '🦊',
      persona: { prefix: 'Original', suffix: 'Keep this suffix', complete: false },
      model: { provider: 'provider', model: 'model' },
    });
    const app = await mount([original]);
    await click(button(app.container, t['card.edit']));
    const id = field(app.container, t['editor.id']) as HTMLInputElement;
    expect(id.value).toBe('alpha-bot');
    expect(id.readOnly).toBe(true);
    await click(app.container.querySelector('details > summary') as HTMLElement);
    await click(button(app.container, t['avatar.clear']));
    await fill(field(app.container, t['editor.persona']), 'Updated');
    await submit(app.container);
    expect(app.remote.methods.update).toHaveBeenCalledExactlyOnceWith('alpha-bot', expect.objectContaining({
      avatar: null, persona: { prefix: 'Updated', suffix: 'Keep this suffix', complete: false },
    }));
    const patch = app.remote.methods.update.mock.calls[0]?.[1];
    expect(patch).not.toHaveProperty('id');
    expect(patch).not.toHaveProperty('model');
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    expect(app.remote.data.records[0]).not.toHaveProperty('avatar');
    expect(app.remote.data.records[0]?.model).toEqual(original.model);
  });

  it('shows Remote failures as alerts, preserves the edit form, and can recover by retrying', async () => {
    const app = await mount([bot()]);
    await click(button(app.container, t['card.edit']));
    await fill(field(app.container, t['editor.name']), 'Changed locally');
    app.remote.methods.update.mockResolvedValueOnce({
      ok: false, error: new RemoteError('bot/conflict', 'Host rejected this change', {}),
    });
    await submit(app.container);
    expect(app.container.querySelector('dialog,[role="dialog"]')).not.toBeNull();
    expect(app.container.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
    expect((field(app.container, t['editor.name']) as HTMLInputElement).value).toBe('Changed locally');
    expect(app.remote.methods.list).toHaveBeenCalledTimes(1);
    await submit(app.container);
    expect(app.remote.methods.update).toHaveBeenCalledTimes(2);
    expect(app.container.querySelector('dialog,[role="dialog"]')).toBeNull();
    expect(app.container.querySelector('article')?.textContent).toContain('Changed locally');
  });

  it('shows an initial read failure and a manual refresh recovers the list', async () => {
    const app = await mount([bot()], 'en', (remote) => {
      remote.methods.list.mockRejectedValueOnce(new Error('Transport is offline'));
    });
    expect(app.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(app.container.querySelectorAll('article')).toHaveLength(0);
    await click(button(app.container, t['bots.refresh']));
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    expect(app.container.querySelector('article')?.textContent).toContain('Alpha Bot');
  });

  it('awaits an asynchronous Host refusal and displays the reason on the page', async () => {
    const app = await mount([bot()]);
    app.openWorkspace.mockRejectedValueOnce(new Error('Host refused the selected preset')); 
    await click(button(app.container, t['bots.newSession']));
    expect(app.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain('Host refused the selected preset');
    expect(button(app.container, t['bots.newSession']).disabled).toBe(false);
    await click(button(app.container, t['bots.newSession']));
    expect(app.openWorkspace).toHaveBeenCalledTimes(2);
    expect(app.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('explains that a workspace must be opened when none is available, without silent navigation', async () => {
    const app = await mount([bot()]);
    await app.setWorkspaces({ items: [] });
    await click(button(app.container, t['bots.newSession']));
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(t['chat.workspaceRequired']);
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.remote.methods.status).toHaveBeenCalledTimes(1);
  });

  it.each(['en', 'zh'] as const)('confirms the multi-workspace launcher through the real form and public API in %s', async (language) => {
    const app = await mount([bot()], language);
    const t = language === 'zh' ? zh.ui : en.ui;
    await app.setWorkspaces({ items: [workspace(), workspace('workspace-two', 'Second project')] });
    await click(button(app.container, t['bots.newSession']));
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.container.querySelector('dialog')?.textContent).toContain(t['chat.workspaceChoose']);
    await fill(field(app.container, t['chat.workspace']), 'workspace-two');
    expect(app.openWorkspace).not.toHaveBeenCalled();
    const dialog = app.container.querySelector('dialog');
    if (!dialog) throw new Error('Workspace picker is missing');
    await click(button(dialog, t['card.start']));
    expect(app.openWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-two', expect.any(Function), {
      agentPreset: 'host-selected/alpha-bot',
    });
    expect(app.container.querySelector('dialog')).toBeNull();
    expect(app.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows pending and failed workspace catalogs and revalidates a workspace after querying status', async () => {
    const app = await mount([bot()]);
    await app.setWorkspaces({ phase: 'pending', state: 'loading' });
    await click(button(app.container, t['bots.newSession']));
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(t['chat.workspaceLoading']);
    await app.setWorkspaces({ phase: 'ready', state: 'error', error: new RemoteError('gateway/service-unavailable', 'Offline', { endpoint: 'workspace/watch' }) });
    await click(button(app.container, t['bots.newSession']));
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(t['chat.workspaceUnavailable']);
    await app.setWorkspaces({ state: 'idle', error: null });
    let finish: ((value: RemoteResult<BotStatus[]>) => void) | undefined;
    app.remote.methods.status.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await click(button(app.container, t['bots.newSession']));
    await app.setWorkspaces({ items: [] });
    await act(async () => { finish?.({ ok: true, value: [{ id: 'alpha-bot', presetId: 'correct-preset', preset: { state: 'ok' } }] }); });
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(t['chat.workspaceRequired']);
  });

  it('uses beforeOpen to stop late navigation after its page unmounts', async () => {
    const app = await mount([bot()]);
    let finish: (() => void) | undefined;
    app.openWorkspace.mockImplementationOnce((_id, beforeOpen) => new Promise((resolve, reject) => {
      finish = () => {
        try { beforeOpen?.('late-session' as never); resolve(); } catch (error) { reject(error); }
      };
    }));
    await click(button(app.container, t['bots.newSession']));
    await app.unmountPage();
    await act(async () => { finish?.(); });
    expect(app.container.textContent).toBe('');
    expect(() => app.openWorkspace.mock.calls[0]?.[1]?.('late-session' as never)).toThrow(t['chat.cancelled']);
  });

  it('rechecks preset status when clicked and refuses a preset that broke since rendering', async () => {
    const app = await mount([bot()]);
    expect(button(app.container, t['bots.newSession']).disabled).toBe(false);
    app.remote.data.statuses = [{
      id: 'alpha-bot', presetId: 'host-selected/alpha-bot', preset: { state: 'broken', reason: 'Preset changed while open' },
    }];
    await click(button(app.container, t['bots.newSession']));
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain('Preset changed while open');
    expect(button(app.container, t['bots.newSession']).disabled).toBe(true);
  });

  it('does not start a session when its pending status response arrives after the page unmounts', async () => {
    const app = await mount([bot()]);
    let resolveStatus: ((result: RemoteResult<BotStatus[]>) => void) | undefined;
    app.remote.methods.status.mockReturnValueOnce(new Promise((resolve) => { resolveStatus = resolve; }));
    await click(button(app.container, t['bots.newSession']));
    expect(app.remote.methods.status).toHaveBeenCalledTimes(2);
    await app.unmountPage();
    await act(async () => {
      resolveStatus?.({ ok: true, value: [{
        id: 'alpha-bot', presetId: 'host-selected/alpha-bot', preset: { state: 'ok' },
      }] });
    });
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.container.textContent).toBe('');
  });

  it('validates a duplicate id and calls the dedicated Remote operation before refreshing', async () => {
    const app = await mount([bot()]);
    await click(button(app.container, t['card.more']));
    await click(button(app.container, t['card.duplicate']));
    const dialog = app.container.querySelector('dialog');
    expect(dialog?.textContent).toContain('Alpha Bot');
    expect(dialog?.textContent).not.toContain('{name}');
    await fill(field(app.container, t['duplicate.id']), 'INVALID');
    await submit(app.container);
    expect(app.remote.methods.duplicate).not.toHaveBeenCalled();
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(t['validation.id']);
    await fill(field(app.container, t['duplicate.id']), 'copied-bot');
    await submit(app.container);
    expect(app.remote.methods.duplicate).toHaveBeenCalledExactlyOnceWith('alpha-bot', 'copied-bot');
    expect(app.remote.methods.create).not.toHaveBeenCalled();
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    expect(app.container.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(app.container.querySelectorAll('[data-bot-detail]')).toHaveLength(1);
  });

  it('requires deletion confirmation with memory and history consequences; cancellation does not delete', async () => {
    const app = await mount([bot()]);
    const openDelete = async () => {
      await click(button(app.container, t['card.more']));
      await click(button(app.container, t['actions.delete']));
      const dialog = app.container.querySelector('dialog');
      if (!dialog) throw new Error('Delete dialog was not mounted');
      return dialog;
    };
    let dialog = await openDelete();
    expect((field(dialog, t['delete.memories']) as HTMLInputElement).checked).toBe(true);
    expect(dialog.textContent).toContain(t['delete.description'].replace('{name}', 'Alpha Bot'));
    expect(dialog.textContent).toContain(t['delete.history']);
    expect(app.remote.methods.delete).not.toHaveBeenCalled();
    await click(button(dialog, t['actions.cancel']));
    expect(app.remote.methods.delete).not.toHaveBeenCalled();
    dialog = await openDelete();
    await click(button(dialog, t['actions.delete']));
    expect(app.remote.methods.delete).toHaveBeenCalledOnce();
    const call = app.remote.methods.delete.mock.calls[0];
    expect(call).toHaveLength(2);
    expect(call?.[0]).toBe('alpha-bot');
    expect(call?.[1]).toEqual({ deleteMemories: true });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    expect(app.container.querySelectorAll('article')).toHaveLength(0);
    expect(app.container.textContent).toContain(t['delete.success']);
  });

  it('lets the user preserve memories, sends false, and resets the choice when reopening confirmation', async () => {
    const app = await mount([bot()]);
    const openDelete = async () => {
      await click(button(app.container, t['card.more']));
      await click(button(app.container, t['actions.delete']));
      return app.container.querySelector('dialog') as HTMLDialogElement;
    };
    let dialog = await openDelete();
    await click(field(dialog, t['delete.memories']));
    expect(dialog.textContent).toContain(t['delete.keepMemories']);
    expect(dialog.textContent).not.toContain(t['delete.memoriesWarning']);
    await click(button(dialog, t['actions.cancel']));
    dialog = await openDelete();
    expect((field(dialog, t['delete.memories']) as HTMLInputElement).checked).toBe(true);
    await click(field(dialog, t['delete.memories']));
    await click(button(dialog, t['actions.delete']));
    expect(app.remote.methods.delete).toHaveBeenCalledExactlyOnceWith('alpha-bot', { deleteMemories: false });
    expect(app.container.textContent).toContain(t['delete.keptSuccess']);
    expect(app.container.textContent).not.toContain(t['delete.success']);
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
  });

  it('owns the built CSS through React across redraw, page exit, plugin unload and repeated hot reload', async () => {
    const styleCount = () => document.querySelectorAll('style[data-dsh-bot-styles]').length;
    const plugin = loadBuiltClient();
    // Factory evaluation itself creates no style elements.
    expect(styleCount()).toBe(0);
    const app = await mount([bot()], 'en', undefined, {}, plugin);
    expect(styleCount()).toBe(1);
    const style = app.container.querySelector('style[data-dsh-bot-styles]');
    expect(style?.textContent).toContain('.bots_page');
    expect(app.container.querySelector('section')?.className).toContain('bots_page');
    await click(button(app.container, t['bots.refresh']));
    expect(styleCount()).toBe(1);
    expect(style?.isConnected).toBe(true);
    await app.unmountPage();
    expect(styleCount()).toBe(0);
    await app.remountPage();
    expect(styleCount()).toBe(1);
    for (let i = 0; i < 3; i++) {
      const previous = app.container.querySelector('style[data-dsh-bot-styles]');
      await app.reloadPlugin(loadBuiltClient());
      expect(previous?.isConnected).toBe(false);
      expect(styleCount()).toBe(1);
    }
    // Do not manually unmount React first: disappearance of the public slot must remove its view and style.
    await app.unloadPlugin();
    expect(styleCount()).toBe(0);
    expect(app.container.textContent).toBe('');
    await app.reloadPlugin(loadBuiltClient());
    expect(styleCount()).toBe(1);
    await app.dispose();
    expect(styleCount()).toBe(0);
  });

  it('releases public registrations and dictionaries when the Cordis plugin unloads', async () => {
    const app = await mount([bot()]);
    await app.unloadPlugin();
    expect(app.container.textContent).toBe('');
    expect(app.core.entries('main')).toHaveLength(0);
    expect(app.core.entries('sidebar.panellist')).toHaveLength(0);
    expect(app.dictionaries.size).toBe(0);
    expect(app.remoteMounted()).toBe(false);
    expect(app.ctx.get('remote.dshBot')).toBeUndefined();
    const reads = app.remote.methods.list.mock.calls.length;
    await act(async () => { app.ctx.emit('connection/reset'); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(reads);
  });
});
