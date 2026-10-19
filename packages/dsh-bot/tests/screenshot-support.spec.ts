// @vitest-environment jsdom
import type { Page } from 'playwright-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureFailureEvidence, completeChatWorkspaceChoice, composite, contrastRatio, dismissFirstRunOverlays, hostOnboardingAction, installOverlayHandler, measureAvatars, readFailureState, readWorkspaceSessionRows, redactScreenshotText, screenshotCases, verifyAvatarContrast, verifyScreenshotActivity, verifyWorkspaceSessionRows, type OverlayEvent } from '../scripts/screenshot-support.js';
import type { ActivityListResult } from '../src/shared/activity.js';
import en from '../locale/en.json';
import zh from '../locale/zh.json';

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
