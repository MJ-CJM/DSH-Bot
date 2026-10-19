// @vitest-environment jsdom
import type { Locator, Page } from 'playwright-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginRefreshProbe, endRefreshProbe, verifyRefreshStability, isSuccessfulRefreshResponse, captureFailureEvidence, completeChatWorkspaceChoice, composite, contrastRatio, dismissFirstRunOverlays, hostOnboardingAction, installOverlayHandler, measureAvatars, readBotsRightTab, readFailureState, readWorkspaceSessionRows, redactScreenshotText, screenshotCases, verifyAvatarContrast, verifyBotsRightTab, verifyScreenshotActivity, verifyWorkspaceSessionRows, type OverlayEvent } from '../scripts/screenshot-support.js';
import type { ActivityListResult } from '../src/shared/activity.js';
import en from '../locale/en.json';
import zh from '../locale/zh.json';
import { readBotsLayout, waitForInitialBotHistory } from '../scripts/screenshot-support.js';

describe('initial Bot history screenshot barrier', () => {
  it.each(['en', 'zh'] as const)('waits for the history region then its initial status, without retrying row IDs/order (%s)', async (language) => {
    const copy = language === 'zh' ? zh.ui : en.ui;
    let showHistory!: () => void;
    let finishLoading!: () => void;
    const regionVisible = new Promise<void>((resolve) => { showHistory = resolve; });
    const loadingHidden = new Promise<void>((resolve) => { finishLoading = resolve; });
    const waitForStatus = vi.fn(() => loadingHidden);
    const history = { waitFor: vi.fn(() => regionVisible), getByRole: vi.fn(() => ({ waitFor: waitForStatus })) };
    const detail = { getByRole: vi.fn(() => history) } as unknown as Locator;
    let finished = false;
    const pending = waitForInitialBotHistory(detail, copy['bots.history']).then(() => { finished = true; });
    expect(detail.getByRole).toHaveBeenCalledWith('region', { name: copy['bots.history'], exact: true });
    expect(history.waitFor).toHaveBeenCalledWith({ state: 'visible' });
    expect(waitForStatus).not.toHaveBeenCalled();
    showHistory(); await regionVisible;
    expect(history.getByRole).toHaveBeenCalledExactlyOnceWith('status');
    expect(waitForStatus).toHaveBeenCalledExactlyOnceWith({ state: 'hidden' });
    expect(finished).toBe(false);
    finishLoading(); await pending;
    // An empty or incorrectly ordered loaded list is returned as-is, not
    // retried until it happens to match the screenshot's strict assertion.
    document.body.innerHTML = '<section data-bots-page><article data-bot-detail="atlas"></article></section>';
    expect(readBotsLayout().sessionIds).toEqual([]);
    const article = document.querySelector('article');
    if (!article) throw new Error('Missing detail fixture');
    article.innerHTML = '<button data-session-id="old"></button><button data-session-id="new"></button>';
    expect(readBotsLayout().sessionIds).toEqual(['old', 'new']);
    expect(waitForStatus).toHaveBeenCalledTimes(1);
  });

  it('propagates initial-load timeout instead of accepting an empty history', async () => {
    const timeout = new Error('Initial history still loading');
    const detail = { getByRole: () => ({ waitFor: async () => {},
      getByRole: () => ({ waitFor: async () => { throw timeout; } }) }) } as unknown as Locator;
    await expect(waitForInitialBotHistory(detail, zh.ui['bots.history'])).rejects.toBe(timeout);
  });
});

describe('refresh stability DOM evidence', () => {
  it('only counts completed successful Gateway result envelopes, not HTTP-only success or business errors', () => {
    expect(isSuccessfulRefreshResponse({ type: 'server-response', result: { ok: true, value: [] } })).toBe(true);
    expect(isSuccessfulRefreshResponse({ type: 'server-response', result: { ok: false, error: { code: 'store/unavailable' } } })).toBe(false);
    expect(isSuccessfulRefreshResponse({ ok: true })).toBe(false);
    expect(isSuccessfulRefreshResponse({ type: 'server-response', result: { ok: true } })).toBe(false);
  });
  function setup() {
    document.body.innerHTML = '<section data-bots-page><div role="listbox" tabindex="0"><button role="option" aria-selected="true">Alpha</button></div></section>';
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const list = document.querySelector<HTMLElement>('[role="listbox"]');
    if (!list) throw new Error('Missing fixture');
    list.focus(); list.scrollTop = 14;
    return { focus, list };
  }
  it('compares actual node identities, focus, scrolling and complete DOM without adding DOM markers', () => {
    const { focus } = setup();
    try {
      const before = document.body.innerHTML;
      beginRefreshProbe();
      expect(document.body.innerHTML).toBe(before);
      const evidence = endRefreshProbe();
      expect(evidence).toMatchObject({ sameNodes: true, sameDOM: true, sameFocus: true, sameScroll: true, mutations: 0 });
      expect(() => verifyRefreshStability(evidence)).not.toThrow();
    } finally { focus.mockRestore(); }
  });
  it('fails a same-markup remount and even a transient loading attribute restored before B', () => {
    const { focus, list } = setup();
    try {
      beginRefreshProbe();
      list.firstElementChild?.replaceWith(list.firstElementChild.cloneNode(true));
      let evidence = endRefreshProbe();
      expect(evidence.sameDOM).toBe(true); expect(evidence.sameNodes).toBe(false);
      expect(() => verifyRefreshStability(evidence)).toThrow();
      beginRefreshProbe();
      list.setAttribute('aria-busy', 'true'); list.removeAttribute('aria-busy');
      evidence = endRefreshProbe();
      expect(evidence.sameDOM).toBe(true); expect(evidence.mutations).toBe(2);
      expect(() => verifyRefreshStability(evidence)).toThrow();
    } finally { focus.mockRestore(); }
  });
  it('rejects loss of scroll or focus even when the nodes and text do not change', () => {
    const { focus, list } = setup();
    try {
      beginRefreshProbe(); list.scrollTop = 0; list.blur();
      const evidence = endRefreshProbe();
      expect(evidence.sameNodes).toBe(true); expect(evidence.sameDOM).toBe(true);
      expect(evidence.sameScroll).toBe(false); expect(evidence.sameFocus).toBe(false);
      expect(() => verifyRefreshStability(evidence)).toThrow();
    } finally { focus.mockRestore(); }
  });
});

/** Semantic DOM adapter for the small Playwright surface used by the helper.
 * These tests verify sequencing/decisions, not browser actionability or pixels. */
function harness() {
  let insideHandler = false;
  type Options = { name?: RegExp | string; exact?: boolean };
  const role = (root: ParentNode, kind: string, options: Options = {}) => Array.from(root.querySelectorAll<HTMLElement>(kind === 'button' ? 'button' : kind === 'combobox' ? 'select' : `[role="${kind}"]`)).filter((element) => {
    const label = element.getAttribute('aria-label') ?? element.getAttribute('aria-labelledby')?.split(/\s+/u).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') ?? element.textContent ?? '';
    return options.name === undefined || (typeof options.name === 'string' ? label === options.name : options.name.test(label));
  });
  const locator = (resolve: () => HTMLElement[]) => ({
    or(other: { elements(): HTMLElement[] }) { return locator(() => [...new Set([...resolve(), ...other.elements()])]); },
    elements: resolve,
    first() { return locator(() => resolve().slice(0, 1)); },
    last() { return locator(() => resolve().slice(-1)); },
    async all() { return resolve().map((node) => locator(() => node.isConnected ? [node] : [])); },
    async isVisible() { return resolve().length > 0; },
    async count() { return resolve().length; },
    async evaluate<T>(callback: (element: HTMLElement) => T) { const node = resolve()[0]; if (!node) throw new Error('missing element'); return callback(node); },
    getByRole(kind: string, options: Options) { return locator(() => resolve().flatMap((node) => role(node, kind, options))); },
    async getAttribute(key: string) { return resolve()[0]?.getAttribute(key) ?? null; },
    async innerText() { return resolve()[0]?.textContent ?? ''; },
    async click() {
      const callback = handler.mock.calls[0]?.[1];
      if (callback && !insideHandler && handler.mock.calls[0]?.[0].elements().length) {
        insideHandler = true;
        try { await callback(); } finally { insideHandler = false; }
      }
      const node = resolve()[0]; if (!node) throw new Error('missing action'); node.click();
    },
    async selectOption(value: string) {
      const select = resolve()[0];
      if (!(select instanceof HTMLSelectElement) || ![...select.options].some((option) => option.value === value)) throw new Error('Missing workspace option');
      select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
    },
    async waitFor(options: { state: string }) {
      if (options.state === 'hidden') expect(resolve()).toHaveLength(0);
      else expect(resolve().length).toBeGreaterThan(0);
    },
  });
  const handler = vi.fn();
  const page = {
    getByRole: (kind: string, options?: Options) => locator(() => role(document, kind, options)),
    addLocatorHandler: handler,
    waitForTimeout: vi.fn(async () => {}),
  } as unknown as Page;
  return { page, handler };
}
function show(title: string, label: string, after?: () => void, role = 'dialog') {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', role);
  dialog.setAttribute('aria-label', title);
  const button = document.createElement('button');
  button.textContent = label;
  button.addEventListener('click', () => { dialog.remove(); after?.(); });
  dialog.append(button); document.body.append(dialog);
  return button;
}
beforeEach(() => { document.body.replaceChildren(); });

describe('T08d screenshot preparation', () => {
  const fixtures = [
    { botId: 'atlas', sessionId: 'old', title: 'Earlier conversation', unread: false },
    { botId: 'atlas', sessionId: 'new', title: 'Latest conversation', unread: true },
  ];
  const activity = (): ActivityListResult => ({
    sessions: fixtures.map((fixture, index) => ({ ...fixture, updatedAt: index + 1,
      ...(fixture.unread ? {} : { lastReadAt: 1 }), lastMessage: { role: 'assistant', preview: 'Mock reply', at: index + 1 } })),
    bots: [{ botId: 'atlas', lastActivityAt: 2, unreadCount: 1, latest: { sessionId: 'new', role: 'assistant', preview: 'Mock reply', at: 2 } }],
  });
  it('requires committed assistant preview/title/unread and matching Bot aggregates', () => {
    expect(() => verifyScreenshotActivity(activity(), fixtures, 'Mock reply')).not.toThrow();
    const missing = activity(); missing.sessions = [];
    expect(() => verifyScreenshotActivity(missing, fixtures, 'Mock reply')).toThrow('activity mismatch');
    const userOnly = activity(); const row = userOnly.sessions[1]; if (row) row.lastMessage.role = 'user';
    expect(() => verifyScreenshotActivity(userOnly, fixtures, 'Mock reply')).toThrow('activity mismatch');
    const read = activity(); const readRow = read.sessions[1]; if (readRow) readRow.unread = false;
    expect(() => verifyScreenshotActivity(read, fixtures, 'Mock reply')).toThrow('activity mismatch');
    expect(() => verifyScreenshotActivity(activity(), fixtures, 'different reply')).toThrow('activity mismatch');
    const staleAggregate = activity(); const bot = staleAggregate.bots[0]; if (bot) bot.unreadCount = 2;
    expect(() => verifyScreenshotActivity(staleAggregate, fixtures, 'Mock reply')).toThrow('aggregate mismatch');
  });
  it('defines all requested language/theme/width cases and keeps optional editor regression separate', () => {
    expect(screenshotCases().map(({ language, theme, viewport }) => `${language}-${theme}-${viewport}`)).toEqual([
      'en-light-wide', 'en-dark-wide', 'zh-light-wide', 'zh-dark-wide', 'zh-light-narrow',
    ]);
    expect(screenshotCases().filter((entry) => entry.language === 'zh' && entry.viewport === 'wide')).toHaveLength(2);
    expect(screenshotCases(true).map(({ language, theme, viewport }) => `${language}-${theme}-${viewport}`)).toEqual(['zh-light-wide', 'zh-dark-wide']);
  });
});

describe('native workspace screenshot evidence', () => {
  const fixture = { botId: 'atlas', sessionId: 'native-bot', title: 'Bot session', unread: false };
  it('requires a native row and rejects Bot-page lookalikes, missing avatars and misalignment', () => {
    document.body.innerHTML = `<section data-bots-page><button data-session-id="native-bot"><span data-bot-session-leading data-session-id="native-bot"><span data-bot-avatar="whale" data-bot-id="atlas"></span></span></button></section>`;
    expect(readWorkspaceSessionRows()).toEqual([]);
    expect(() => verifyWorkspaceSessionRows(readWorkspaceSessionRows(), [fixture])).toThrow('missing');
    document.body.innerHTML = `<div role="treeitem" data-row-key="session:native-bot"><span><span data-bot-session-leading data-session-id="native-bot"><span data-bot-avatar="whale" data-bot-id="atlas"></span></span></span><span>Bot session</span></div>`;
    const bounds = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.hasAttribute('data-bot-avatar')) return new DOMRect(8, 8, 16, 16);
      if (this.getAttribute('role') === 'treeitem') return new DOMRect(0, 0, 240, 32);
      if (this === this.parentElement?.firstElementChild) return new DOMRect(8, 6, 16, 20);
      return new DOMRect(28, 6, 180, 20);
    });
    try {
      const rows = readWorkspaceSessionRows();
      expect(() => verifyWorkspaceSessionRows(rows, [fixture])).not.toThrow();
      expect(() => verifyWorkspaceSessionRows(rows.map((row) => ({ ...row, botId: 'other' })), [fixture])).toThrow('missing');
      expect(() => verifyWorkspaceSessionRows(rows.map((row) => ({ ...row, inLeadingCell: false })), [fixture])).toThrow('missing');
      expect(() => verifyWorkspaceSessionRows(rows.map((row) => ({ ...row, avatar: { x: 8, y: 2, width: 16, height: 16 } })), [fixture])).toThrow('alignment');
      expect(() => verifyWorkspaceSessionRows(rows.map((row) => ({ ...row, avatar: { x: 8, y: 8, width: 24, height: 24 } })), [fixture])).toThrow('alignment');
    } finally { bounds.mockRestore(); }
  });
});

describe('native right-tab screenshot evidence', () => {
  const bot = { id: 'atlas', name: 'Atlas' };
  it('requires the real session/tab slots, selected chrome, visible conversation and complete Bot content', () => {
    const content = `<section data-bots-right-tab><div role="option" data-bot-id="atlas">Atlas<span data-bot-avatar="whale" data-bot-id="atlas" aria-hidden="true"></span><span data-activity-preview style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Mock reply</span><i data-unread></i></div></section>`;
    document.body.innerHTML = `<section data-bots-page>${content}</section>`;
    expect(() => verifyBotsRightTab(readBotsRightTab(), 'session-a', [bot], 'Mock reply')).toThrow('layout missing');
    document.body.innerHTML = `<div data-conversation-content data-conversation-session="session-a"></div><div data-slot="rightbar.session"><aside data-sidebar-right-panel="push" data-sidebar-right-session="session-a" data-sidebar-right-open><button role="tab" aria-selected="true" data-dockkit-tab="tab2">Bots</button><div data-sidebar-right-tab="tab2"><div data-slot="sidebar.right.pane.tab">${content}</div></div></aside></div>`;
    const bounds = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.hasAttribute('data-conversation-content') ? new DOMRect(0, 0, 600, 800) : new DOMRect(600, 0, 300, 800);
    });
    try {
      const evidence = readBotsRightTab();
      expect(() => verifyBotsRightTab(evidence, 'session-a', [bot], 'Mock reply')).not.toThrow();
      expect(() => verifyBotsRightTab(evidence, 'another-session', [bot], 'Mock reply')).toThrow('layout missing');
      expect(() => verifyBotsRightTab({ ...evidence, inTabSlot: false }, 'session-a', [bot], 'Mock reply')).toThrow('layout missing');
      expect(() => verifyBotsRightTab({ ...evidence, chipSelected: false }, 'session-a', [bot], 'Mock reply')).toThrow('layout missing');
      expect(() => verifyBotsRightTab({ ...evidence, conversation: null }, 'session-a', [bot], 'Mock reply')).toThrow('layout missing');
      expect(() => verifyBotsRightTab({ ...evidence, rows: evidence.rows.map((row) => ({ ...row, avatarVisible: false })) }, 'session-a', [bot], 'Mock reply')).toThrow('row missing');
      expect(() => verifyBotsRightTab(evidence, 'session-a', [bot], 'Wrong preview')).toThrow('row missing');
      expect(() => verifyBotsRightTab({ ...evidence, rows: evidence.rows.map((row) => ({ ...row, unreadVisible: false })) }, 'session-a', [bot], 'Mock reply')).toThrow('unread indicator missing');
      document.querySelector('[data-bots-right-tab]')?.setAttribute('hidden', '');
      expect(() => verifyBotsRightTab(readBotsRightTab(), 'session-a', [bot], 'Mock reply')).toThrow('layout missing');
    } finally { bounds.mockRestore(); }
  });
});

describe('screenshot first-run handling', () => {
  it.each([
    ['Preview Notice', 'Continue', 'Add an API key to get started', 'Configure later'],
    ['预览版说明', '继续', '添加一个 API Key 开始使用', '稍后配置'],
    ['预览说明', '继续', '添加一个 API Key 开始使用', '稍后配置'],
  ])('dismisses %s and the next overlay through localized role/name actions', async (title, proceed, next, close) => {
    const { page } = harness();
    show(title, proceed, () => show(next, close));
    const events: OverlayEvent[] = [];
    await dismissFirstRunOverlays(page, (event) => events.push(event), 'new-page');
    expect(events.map((event) => [event.outcome, event.title, event.button])).toEqual([
      ['dismissed', title, proceed], ['dismissed', next, close],
    ]);
    expect(document.body.children).toHaveLength(0);
  });
  it('skips absent overlays and handles a late dialog through the actionability handler', async () => {
    const { page, handler } = harness();
    const events: OverlayEvent[] = [];
    await dismissFirstRunOverlays(page, (event) => events.push(event), 'absent');
    expect(events).toEqual([{ checkpoint: 'absent', outcome: 'absent' }]);
    await installOverlayHandler(page, (event) => events.push(event));
    show('Preview Notice', 'Continue');
    await handler.mock.calls[0]?.[1]();
    expect(events.at(-1)).toMatchObject({ checkpoint: 'actionability', outcome: 'dismissed' });
  });
  it('supports a known labelledby alertdialog', async () => {
    const { page } = harness();
    const button = show('Preview Notice', 'Continue', undefined, 'alertdialog');
    const title = document.createElement('h2'); title.id = 'notice'; title.textContent = 'Preview Notice';
    button.parentElement?.removeAttribute('aria-label');
    button.parentElement?.setAttribute('aria-labelledby', title.id);
    button.parentElement?.append(title);
    const events: OverlayEvent[] = [];
    await dismissFirstRunOverlays(page, (event) => events.push(event), 'labelledby');
    expect(events).toEqual([{ checkpoint: 'labelledby', outcome: 'dismissed', title: 'Preview Notice', button: 'Continue' }]);
  });
  it.each([
    ['Choose a workspace for this conversation.', 'Close'],
    ['请选择本次聊天使用的工作区。', '关闭'],
    ['Edit Bot', 'Continue'],
    ['Unknown onboarding', 'Configure later'],
    ['Preview Notice - custom', 'Continue'],
    ['Upgrade', 'Install now'],
  ])('never matches or dismisses an unlisted dialog: %s', async (title, label) => {
    const { page, handler } = harness();
    const events: OverlayEvent[] = [];
    await installOverlayHandler(page, (event) => events.push(event));
    const button = show(title, label);
    const click = vi.fn(); button.addEventListener('click', click);
    expect(hostOnboardingAction(title)).toBeUndefined();
    expect(await handler.mock.calls[0]?.[0].count()).toBe(0);
    await dismissFirstRunOverlays(page, (event) => events.push(event), 'scan');
    expect(events).toEqual([{ checkpoint: 'scan', outcome: 'ignored', title }]);
    expect(click).not.toHaveBeenCalled();
    expect(button.isConnected).toBe(true);
  });
  it('does not substitute Close for the expected action even on a known title', async () => {
    const { page } = harness();
    const close = show('Preview Notice', 'Close');
    await expect(dismissFirstRunOverlays(page, () => {}, 'wrong-action')).rejects.toThrow('missing its expected action');
    expect(close.isConnected).toBe(true);
  });
  it('keeps the installed allowlist valid when a later page or locale shows another known notice', async () => {
    const { page, handler } = harness();
    const events: OverlayEvent[] = [];
    await installOverlayHandler(page, (event) => events.push(event));
    for (const [title, action] of [['Preview Notice', 'Continue'], ['预览版说明', '继续'], ['添加一个 API Key 开始使用', '稍后配置']]) {
      if (!title || !action) throw new Error('Missing fixture');
      show(title, action);
      expect(await handler.mock.calls[0]?.[0].count()).toBe(1);
      await handler.mock.calls[0]?.[1]();
    }
    expect(events.map((event) => event.button)).toEqual(['Continue', '继续', '稍后配置']);
  });
  it('does not reenter dismissal when an explicit scan clicks with the handler installed', async () => {
    const { page } = harness();
    const events: OverlayEvent[] = [];
    const record = (event: OverlayEvent) => events.push(event);
    await installOverlayHandler(page, record);
    show('Preview Notice', 'Continue', () => show('Add an API key to get started', 'Configure later'));
    await dismissFirstRunOverlays(page, record, 'explicit');
    expect(events.map((event) => event.button)).toEqual(['Continue', 'Configure later']);
    expect(document.body.children).toHaveLength(0);
  });
});

describe('explicit screenshot workspace choice', () => {
  it.each([['en', en.ui], ['zh', zh.ui]] as const)('selects the exact created workspace and confirms in %s without closing it', async (_language, copy) => {
    const { page, handler } = harness();
    const events: OverlayEvent[] = [];
    await installOverlayHandler(page, (event) => events.push(event));
    const select = document.createElement('select');
    select.setAttribute('aria-label', copy['chat.workspace']);
    select.add(new Option('Other workspace', 'other-id'));
    select.add(new Option('Screenshot workspace', 'target-id'));
    const confirmed = vi.fn();
    const confirm = show(copy['chat.workspaceChoose'], copy['card.start'], () => { confirmed(select.value); });
    const close = document.createElement('button'); close.textContent = copy['actions.close'];
    const closed = vi.fn(); close.addEventListener('click', closed);
    confirm.parentElement?.append(select, close);
    expect(await handler.mock.calls[0]?.[0].count()).toBe(0);
    await dismissFirstRunOverlays(page, (event) => events.push(event), 'after-start');
    const composer = page.getByRole('textbox', { name: 'blank composer', exact: true });
    await expect(completeChatWorkspaceChoice(page, composer, 'target-id', copy)).resolves.toBe('selected');
    expect(confirmed).toHaveBeenCalledExactlyOnceWith('target-id');
    expect(closed).not.toHaveBeenCalled();
    expect(events.every((event) => event.outcome === 'ignored')).toBe(true);
  });
  it('accepts a blank composer without requiring a nonblank-session badge', async () => {
    const { page } = harness();
    const composer = document.createElement('div'); composer.setAttribute('role', 'textbox'); composer.setAttribute('aria-label', 'blank composer'); document.body.append(composer);
    await expect(completeChatWorkspaceChoice(page, page.getByRole('textbox', { name: 'blank composer' }), 'target-id', en.ui)).resolves.toBe('direct');
  });
});

describe('failure evidence captured before context disposal', () => {
  it('samples DOM before the asynchronous PNG and labels their separate timing', async () => {
    document.body.innerHTML = '<main>Loading sessions</main>';
    const evaluate = vi.fn(async () => readFailureState());
    const screenshot = vi.fn(async () => {
      document.body.innerHTML = '<main>Conversation new / Conversation old</main>';
      return Buffer.from([]);
    });
    const page = { isClosed: () => false, url: () => 'http://localhost/', evaluate, screenshot } as unknown as Page;
    const evidence = await captureFailureEvidence(page, '/evidence', 'initial-history', redactScreenshotText);
    expect(evidence.mainText).toBe('Loading sessions');
    expect(readFailureState().mainText).toContain('Conversation new');
    expect(evidence.domCapturedAt).toEqual(expect.any(String));
    expect(evidence.screenshotStartedAt).toEqual(expect.any(String));
    expect(evidence.screenshotFinishedAt).toEqual(expect.any(String));
    expect(evaluate).toHaveBeenCalledBefore(screenshot);
  });
  it('redacts tokens in URLs, text, encoded secrets and credentials', () => {
    const text = 'http://localhost/?token=abc&x=1 plain secret/a encoded secret%2Fa\nCookie: private';
    expect(redactScreenshotText(text, ['secret/a'])).toBe('http://localhost/?token=[REDACTED]&x=1 plain [REDACTED] encoded [REDACTED]\nCookie: [REDACTED]');
  });
  it('captures a named PNG, URL, visible dialog titles and main text, all metadata redacted', async () => {
    document.body.innerHTML = '<main>Main token=test-secret</main><dialog open aria-label="Choose test-secret"></dialog><div role="dialog" style="display:none" aria-label="hidden"></div>';
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 100 } as DOMRect);
    try {
      const screenshot = vi.fn(async () => Buffer.from([]));
      const page = { isClosed: () => false, url: () => 'http://localhost/?token=test-secret', screenshot,
        evaluate: vi.fn(async () => readFailureState()) } as unknown as Page;
      const evidence = await captureFailureEvidence(page, '/evidence', 'en-light-wide-workspace-choice', (value) => redactScreenshotText(value, ['test-secret']));
      expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ path: '/evidence/failure-en-light-wide-workspace-choice.png', timeout: 5000 }));
      expect(evidence).toMatchObject({ screenshot: 'failure-en-light-wide-workspace-choice.png', url: 'http://localhost/?token=[REDACTED]',
        dialogs: ['Choose [REDACTED]'], mainText: 'Main token=[REDACTED]' });
      expect(JSON.stringify(evidence)).not.toContain('test-secret');
    } finally { bounds.mockRestore(); }
  });
  it('keeps DOM diagnostics if taking the failure screenshot also fails', async () => {
    const page = { isClosed: () => false, url: () => 'http://localhost/', screenshot: vi.fn(async () => { throw new Error('PNG unavailable'); }),
      evaluate: vi.fn(async () => ({ dialogs: [], mainSource: 'root-fallback', mainText: 'Navigation failed' })) } as unknown as Page;
    const evidence = await captureFailureEvidence(page, '/evidence', 'failure', redactScreenshotText);
    expect(evidence.screenshot).toBeUndefined();
    expect(evidence.screenshotError).toContain('PNG unavailable');
    expect(evidence.mainText).toBe('Navigation failed');
  });
  it('records that there is no screenshot when the browser never opened', async () => {
    const evidence = await captureFailureEvidence(undefined, '/evidence', 'browser-launch', redactScreenshotText);
    expect(evidence.screenshot).toBeUndefined();
    expect(evidence.screenshotError).toContain('No live browser page');
  });
});

describe('measured screenshot contrast', () => {
  it('calculates known sRGB luminance and composites transparent foregrounds', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBe(21);
    expect(contrastRatio([30, 30, 30], [30, 30, 30])).toBe(1);
    expect(composite([0, 0, 0, 0.5], [200, 200, 200])).toEqual([100, 100, 100]);
    expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.478, 3);
  });
  it('records browser-returned values and fails low contrast or missing whale measurements', async () => {
    const measured = { botId: 'measured-bot', kind: 'whale', measured: true, foregroundCss: 'color(srgb 1 1 1)', backgroundCss: 'rgb(0, 0, 0)', glyphFillCss: 'color(srgb 1 1 1)', foregroundRgba: [255, 255, 255, 1], foregroundRgb: [255, 255, 255], backgroundRgb: [0, 0, 0] };
    const evaluate = vi.fn(async () => [measured]);
    const values = await measureAvatars({ evaluate } as unknown as Page);
    expect(values[0]).toMatchObject({ foregroundCss: measured.foregroundCss, backgroundCss: measured.backgroundCss, contrastRatio: 21 });
    expect(() => verifyAvatarContrast(values, ['measured-bot'])).not.toThrow();
    expect(() => verifyAvatarContrast(values, ['missing-bot'])).toThrow('missing');
    expect(() => verifyAvatarContrast([], ['measured-bot'])).toThrow('missing');
    expect(() => verifyAvatarContrast(values.map((value) => value.measured ? { ...value, contrastRatio: 2.99 } : value), ['measured-bot'])).toThrow('below 3:1');
    expect(() => verifyAvatarContrast(values.map((value) => value.measured ? { ...value, contrastRatio: Number.NaN } : value), ['measured-bot'])).toThrow('below 3:1');
  });
});
