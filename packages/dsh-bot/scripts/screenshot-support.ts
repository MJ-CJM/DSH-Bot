import type { Locator, Page, Response } from 'playwright-core';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { ActivityListResult } from '../src/shared/activity.js';

export interface ScreenshotSessionFixture {
  botId: string;
  sessionId: string;
  title: string;
  unread: boolean;
}
/** Verify committed assistant activity, rather than treating session turn counts
 * or a successful prompt receipt as proof that previews/unread were produced. */
export function verifyScreenshotActivity(activity: ActivityListResult, fixtures: readonly ScreenshotSessionFixture[], preview: string): void {
  for (const fixture of fixtures) {
    const row = activity.sessions.find((session) => session.sessionId === fixture.sessionId);
    if (!row || row.botId !== fixture.botId || row.title !== fixture.title || row.lastMessage.role !== 'assistant'
      || row.lastMessage.preview !== preview || row.unread !== fixture.unread) {
      throw new Error(`Screenshot assistant activity mismatch: ${fixture.botId}/${fixture.sessionId}`);
    }
  }
  for (const botId of new Set(fixtures.map((fixture) => fixture.botId))) {
    const rows = activity.sessions.filter((session) => session.botId === botId);
    const bot = activity.bots.find((entry) => entry.botId === botId);
    const latest = [...rows].sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))[0];
    if (!bot || !latest || bot.unreadCount !== rows.filter((session) => session.unread).length
      || bot.lastActivityAt !== latest.updatedAt || bot.latest?.sessionId !== latest.sessionId
      || bot.latest.preview !== preview) throw new Error(`Screenshot Bot aggregate mismatch: ${botId}`);
  }
}

export interface ScreenshotCase {
  language: 'en' | 'zh';
  theme: 'light' | 'dark';
  viewport: 'wide' | 'narrow';
  width: number;
  height: number;
}
export function screenshotCases(extrasOnly = false): ScreenshotCase[] {
  const cases: ScreenshotCase[] = [];
  for (const language of ['en', 'zh'] as const) for (const theme of ['light', 'dark'] as const) {
    if (!extrasOnly || language === 'zh') cases.push({ language, theme, viewport: 'wide', width: 1440, height: 1000 });
  }
  if (!extrasOnly) cases.push({ language: 'zh', theme: 'light', viewport: 'narrow', width: 600, height: 900 });
  return cases;
}

interface RefreshProbe {
  root: HTMLElement;
  nodes: Element[];
  html: string;
  focus: Element | null;
  scroll: Array<{ node: HTMLElement; top: number; left: number }>;
  observer: MutationObserver;
  mutations: number;
}
type ProbeDocument = Document & { dshBotRefreshProbe?: RefreshProbe };

/** Executed in the real page. Keep actual node references, not marker attributes
 * which a remount could accidentally reproduce. Observe transient changes too. */
export function beginRefreshProbe(): void {
  const page = document as ProbeDocument;
  page.dshBotRefreshProbe?.observer.disconnect();
  const root = page.querySelector<HTMLElement>('[data-bots-page]');
  if (!root?.querySelector('[role="option"]')) throw new Error('Loaded Bots page is required for refresh stability');
  if (page.visibilityState !== 'visible' || !page.hasFocus()) throw new Error('Refresh stability requires a visible focused window');
  const nodes = [root, ...root.querySelectorAll('*')];
  const probe: RefreshProbe = {
    root, nodes, html: root.outerHTML, focus: page.activeElement, mutations: 0,
    scroll: nodes.filter((node): node is HTMLElement => node instanceof HTMLElement)
      .map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft })),
    observer: new MutationObserver((records) => { probe.mutations += records.length; }),
  };
  probe.observer.observe(root, { subtree: true, attributes: true, characterData: true, childList: true });
  page.dshBotRefreshProbe = probe;
}

export function endRefreshProbe() {
  const page = document as ProbeDocument;
  const probe = page.dshBotRefreshProbe;
  if (!probe) throw new Error('Refresh stability probe was not started');
  probe.mutations += probe.observer.takeRecords().length;
  probe.observer.disconnect();
  delete page.dshBotRefreshProbe;
  const current = page.querySelector<HTMLElement>('[data-bots-page]');
  const nodes = current ? [current, ...current.querySelectorAll('*')] : [];
  return {
    nodeCount: probe.nodes.length,
    sameNodes: nodes.length === probe.nodes.length && nodes.every((node, index) => node === probe.nodes[index]),
    sameDOM: current?.outerHTML === probe.html,
    sameFocus: page.activeElement === probe.focus,
    sameScroll: probe.scroll.every(({ node, top, left }) => node.scrollTop === top && node.scrollLeft === left),
    mutations: probe.mutations,
    visibleAndFocused: page.visibilityState === 'visible' && page.hasFocus(),
  };
}

export function verifyRefreshStability(evidence: ReturnType<typeof endRefreshProbe>): void {
  if (!evidence.sameNodes || !evidence.sameDOM || !evidence.sameFocus || !evidence.sameScroll
    || evidence.mutations !== 0 || !evidence.visibleAndFocused) throw new Error('Bots changed during background refresh');
}

/** Additional A/B pair; the original screenshot matrix is unchanged. Real
 * successful RPC responses spaced by >=5 seconds prove two fallback cycles. */
export async function captureRefreshStability(page: Page, directory: string, prefix: string) {
  await page.bringToFront();
  const region = page.locator('[data-bots-page]');
  await region.getByRole('listbox').focus();
  const files = [`${prefix}-refresh-A.png`, `${prefix}-refresh-B.png`];
  const first = await region.screenshot({ path: join(directory, files[0] ?? ''), animations: 'disabled' });
  await page.evaluate(beginRefreshProbe);
  const start = Date.now();
  const paths = ['/api/dshBot/list', '/api/dshBot/status', '/api/dshBot.activity/list'];
  const cycles: Record<string, number[]> = Object.fromEntries(paths.map((path) => [path, []]));
  const onResponse = (response: Response) => {
    const times = cycles[new URL(response.url()).pathname];
    if (!response.ok() || !times) return;
    void (async () => {
      if (await response.finished()) return;
      const body: unknown = await response.json();
      if (!isSuccessfulRefreshResponse(body)) return;
      const elapsed = Date.now() - start;
      if (elapsed >= 5000 && elapsed - (times.at(-1) ?? -Infinity) >= 5000) times.push(elapsed);
    })().catch(() => {});
  };
  page.on('response', onResponse);
  try {
    while (!paths.every((path) => (cycles[path]?.length ?? 0) >= 2)) {
      if (Date.now() - start > 90_000) throw new Error('Two real background polling cycles were not observed within 90 seconds');
      await page.waitForTimeout(250);
    }
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const second = await region.screenshot({ path: join(directory, files[1] ?? ''), animations: 'disabled' });
    const dom = await page.evaluate(endRefreshProbe);
    const evidence = { files, elapsedMs: Date.now() - start, cycles, dom, pixelsIdentical: first.equals(second),
      sha256: [first, second].map((buffer) => createHash('sha256').update(buffer).digest('hex')) };
    // Return failed comparisons as evidence; the caller saves it before failing.
    return evidence;
  } finally {
    page.off('response', onResponse);
    await page.evaluate(() => {
      const page = document as ProbeDocument;
      page.dshBotRefreshProbe?.observer.disconnect();
      delete page.dshBotRefreshProbe;
    });
  }
}

/** Gateway domain success/failure is the Connection envelope's result; the
 * Client adds its own RemoteResult wrapper only after decoding result.value. */
export function isSuccessfulRefreshResponse(body: unknown): boolean {
  if (!body || typeof body !== 'object' || !('type' in body) || body.type !== 'server-response' || !('result' in body)) return false;
  const carrier = body.result;
  return !!carrier && typeof carrier === 'object' && 'ok' in carrier && carrier.ok === true && 'value' in carrier;
}

/** Inspect only native workspace tree rows, never the Bot page or its dialog.
 * The row-key marker belongs to the rc.2 rendered DOM; no Client state is read. */
export function readWorkspaceSessionRows() {
  const box = (element: Element | null) => {
    const rect = element?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  };
  return Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"][data-row-key^="session:"]')).map((row) => {
    const leading = row.querySelector('[data-bot-session-leading]');
    const avatar = leading?.querySelector<HTMLElement>('[data-bot-avatar]') ?? null;
    return {
      sessionId: row.dataset.rowKey?.slice('session:'.length) ?? '',
      botId: avatar?.dataset.botId ?? null,
      kind: avatar?.dataset.botAvatar ?? null,
      row: box(row), cell: box(row.firstElementChild), title: box(row.children.item(1)), avatar: box(avatar),
      leadingSessionId: leading?.getAttribute('data-session-id') ?? null,
      inLeadingCell: !!leading && row.firstElementChild?.contains(leading) === true,
    };
  });
}

export function verifyWorkspaceSessionRows(rows: ReturnType<typeof readWorkspaceSessionRows>, fixtures: readonly ScreenshotSessionFixture[]): void {
  for (const fixture of fixtures) {
    const row = rows.find((value) => value.sessionId === fixture.sessionId);
    if (!row || row.botId !== fixture.botId || row.kind !== 'whale' || !row.inLeadingCell
      || row.leadingSessionId !== fixture.sessionId || !row.row || row.row.width <= 0 || row.row.height <= 0
      || !row.avatar || !row.cell || !row.title) throw new Error(`Native workspace Bot avatar missing: ${fixture.sessionId}`);
    const avatar = row.avatar;
    if (Math.abs(avatar.width - 16) > 0.5 || Math.abs(avatar.height - 16) > 0.5
      || Math.abs(avatar.y + avatar.height / 2 - row.row.y - row.row.height / 2) > 1
      || avatar.x < row.cell.x - 0.5 || avatar.x + avatar.width > row.title.x + 0.5) {
      throw new Error(`Native workspace Bot avatar size/alignment mismatch: ${fixture.sessionId}`);
    }
  }
}

/** Read the native right-tab seat and its visible conversation together. A Bot
 * page or standalone component must never count as sidebar runtime evidence. */
export function readBotsRightTab() {
  const visible = (element: Element | null) => {
    if (!element || element.closest('[hidden]')) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const box = (element: Element | null) => {
    const rect = element?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  };
  const region = Array.from(document.querySelectorAll('[data-bots-right-tab]')).find(visible) ?? null;
  const panel = region?.closest('[data-sidebar-right-panel]') ?? null;
  const tabId = region?.closest('[data-sidebar-right-tab]')?.getAttribute('data-sidebar-right-tab') ?? null;
  const chip = Array.from(panel?.querySelectorAll('[role="tab"][data-dockkit-tab]') ?? [])
    .find((element) => element.getAttribute('data-dockkit-tab') === tabId) ?? null;
  const sessionId = panel?.getAttribute('data-sidebar-right-session') ?? null;
  const conversation = Array.from(document.querySelectorAll('[data-conversation-content][data-conversation-session]'))
    .find((element) => element.getAttribute('data-conversation-session') === sessionId && visible(element)) ?? null;
  return {
    inTabSlot: !!region?.closest('[data-slot="sidebar.right.pane.tab"]'),
    inSessionSlot: !!region?.closest('[data-slot="rightbar.session"]'),
    region: box(region), panel: box(panel), conversation: box(conversation), sessionId, tabId,
    panelOpen: panel?.hasAttribute('data-sidebar-right-open') === true,
    chipVisible: visible(chip), chipSelected: chip?.getAttribute('aria-selected') === 'true', chipTitle: chip?.textContent?.trim() ?? '',
    rows: Array.from(region?.querySelectorAll('[role="option"][data-bot-id]') ?? []).map((row) => {
      const avatar = row.querySelector('[data-bot-avatar]');
      const preview = row.querySelector('[data-activity-preview]');
      const style = preview ? getComputedStyle(preview) : null;
      return { botId: row.getAttribute('data-bot-id'), visible: visible(row), text: row.textContent ?? '',
        avatarVisible: visible(avatar), avatarBotId: avatar?.getAttribute('data-bot-id') ?? null, avatar: box(avatar),
        previewVisible: visible(preview), preview: preview?.textContent ?? '',
        previewCss: style ? { overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace } : null,
        unreadVisible: Array.from(row.querySelectorAll('[data-unread]')).some(visible) };
    }),
  };
}

export function verifyBotsRightTab(evidence: ReturnType<typeof readBotsRightTab>, sessionId: string,
  bots: readonly { id: string; name: string }[], preview: string): void {
  if (!evidence.inTabSlot || !evidence.inSessionSlot || !evidence.panelOpen || !evidence.panel || !evidence.region
    || !evidence.chipVisible || !evidence.chipSelected || !evidence.chipTitle.includes('Bots') || !evidence.tabId
    || evidence.sessionId !== sessionId || !evidence.conversation || evidence.conversation.width <= 0
    || evidence.conversation.x + evidence.conversation.width > evidence.panel.x + 2) {
    throw new Error('Native Bots right tab/conversation layout missing');
  }
  for (const bot of bots) {
    const row = evidence.rows.find((value) => value.botId === bot.id);
    if (!row?.visible || !row.text.includes(bot.name) || !row.avatarVisible || row.avatarBotId !== bot.id
      || !row.previewVisible || row.preview !== preview || row.previewCss?.overflow !== 'hidden'
      || row.previewCss.textOverflow !== 'ellipsis' || row.previewCss.whiteSpace !== 'nowrap') {
      throw new Error(`Native Bots right tab row missing: ${bot.id}`);
    }
  }
  if (!evidence.rows.some((row) => row.unreadVisible)) throw new Error('Native Bots right tab unread indicator missing');
}

/** Each matrix case creates a fresh Client. Bot/activity readiness does not
 * imply that the independent native sessions list has completed its first pull.
 * Wait only for that initial loading UI, never for the expected row IDs/order:
 * a loaded empty, incorrect or reordered history must still fail immediately. */
export async function waitForInitialBotHistory(detail: Locator, historyLabel: string): Promise<void> {
  const history = detail.getByRole('region', { name: historyLabel, exact: true });
  await history.waitFor({ state: 'visible' });
  await history.getByRole('status').waitFor({ state: 'hidden' });
}

/** DOM-only layout evidence. This measures actual displayed boxes and CSS;
 * responsive classes or jsdom render results are not screenshot evidence. */
export function readBotsLayout() {
  const visible = (element: Element | null) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const region = document.querySelector('[data-bots-page]');
  const list = region?.querySelector('[role="listbox"]') ?? null;
  const detail = region?.querySelector('[data-bot-detail]') ?? null;
  const box = (element: Element | null) => {
    const rect = element?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  };
  return {
    capturedAt: new Date().toISOString(),
    detailStatuses: Array.from(detail?.querySelectorAll('[role="status"]') ?? []).map((element) => element.textContent),
    listVisible: visible(list), detailVisible: visible(detail), list: box(list), detail: box(detail),
    selectedBotId: list?.querySelector('[aria-selected="true"]')?.getAttribute('data-bot-id') ?? null,
    detailBotId: detail?.getAttribute('data-bot-detail') ?? null,
    optionIds: Array.from(list?.querySelectorAll('[role="option"]') ?? []).map((option) => option.getAttribute('data-bot-id')),
    sessionIds: Array.from(detail?.querySelectorAll('[data-session-id]') ?? []).map((row) => row.getAttribute('data-session-id')),
    unreadDots: Array.from(region?.querySelectorAll('[data-unread]') ?? []).filter(visible).length,
    previews: Array.from(region?.querySelectorAll<HTMLElement>('[data-activity-preview]') ?? []).filter(visible).map((element) => {
      const style = getComputedStyle(element);
      return { text: element.textContent, overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace };
    }),
  };
}

export interface OverlayEvent {
  checkpoint: string;
  outcome: 'dismissed' | 'absent' | 'blocked' | 'ignored';
  title?: string;
  button?: string;
}
// Locked rc.2 ui-settings-models: WelcomeNotice + DeepSeekOnboardingDialog.
// Exact title/action pairs only. A Close/Continue button alone is NOT consent
// to dismiss a business dialog (in particular our workspace chooser).
const hostOnboarding = new Map([
  ['Preview Notice', 'Continue'],
  ['预览说明', '继续'],
  ['预览版说明', '继续'],
  ['Add an API key to get started', 'Configure later'],
  ['添加一个 API Key 开始使用', '稍后配置'],
]);
export function hostOnboardingAction(title: string): string | undefined {
  return hostOnboarding.get(title);
}
function knownHostDialogs(page: Page): Locator {
  const dialogs = [...hostOnboarding.keys()].map((name) => page.getByRole('dialog', { name, exact: true })
    .or(page.getByRole('alertdialog', { name, exact: true })));
  const first = dialogs[0];
  if (!first) throw new Error('Host onboarding allowlist is empty');
  return dialogs.slice(1).reduce((result, dialog) => result.or(dialog), first);
}

async function dialogTitle(dialog: Locator): Promise<string> {
  return dialog.evaluate((element) => {
    const direct = element.getAttribute('aria-label');
    if (direct) return direct.trim();
    const ids = element.getAttribute('aria-labelledby')?.split(/\s+/u) ?? [];
    return ids.map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').trim();
  });
}

const activeDismissals = new WeakSet<Page>();
/** Explicit scans also click buttons, so Playwright can invoke our locator
 * handler during the scan itself. Avoid dismissing the same dialog twice. */
export async function dismissFirstRunOverlays(page: Page, record: (event: OverlayEvent) => void, checkpoint: string): Promise<void> {
  if (activeDismissals.has(page)) return;
  activeDismissals.add(page);
  try { await dismissOverlays(page, record, checkpoint); }
  finally { activeDismissals.delete(page); }
}

/** Role/name based only; one dismissal can reveal the next onboarding step. */
async function dismissOverlays(page: Page, record: (event: OverlayEvent) => void, checkpoint: string): Promise<void> {
  let dismissed = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    const dialogs = page.getByRole('dialog').or(page.getByRole('alertdialog'));
    const visible = [];
    for (const dialog of await dialogs.all()) if (await dialog.isVisible()) visible.push(dialog);
    const dialog = visible.at(-1);
    if (!dialog) {
      if (!dismissed) record({ checkpoint, outcome: 'absent' });
      return;
    }
    const title = await dialogTitle(dialog);
    const name = hostOnboardingAction(title);
    if (!name) {
      record({ checkpoint, outcome: 'ignored', title });
      return;
    }
    const action = dialog.getByRole('button', { name, exact: true });
    if (await action.count() !== 1 || !await action.isVisible()) {
      record({ checkpoint, outcome: 'blocked', title });
      throw new Error(`Known host onboarding dialog is missing its expected action: ${title} / ${name}`);
    }
    const button = (await action.getAttribute('aria-label')) ?? (await action.innerText()).trim();
    await action.click();
    // Scope by the captured accessible name: nth()/last() would accidentally
    // wait on the NEXT onboarding step when React removes this dialog.
    if (title) {
      await page.getByRole('dialog', { name: title, exact: true })
        .or(page.getByRole('alertdialog', { name: title, exact: true })).waitFor({ state: 'hidden', timeout: 10_000 });
    }
    record({ checkpoint, outcome: 'dismissed', title, button });
    dismissed = true;
    await page.waitForTimeout(150);
  }
  throw new Error('First-run overlays did not settle after 12 dismissals');
}

/** Covers delayed notices appearing between explicit checks and a click. */
export async function installOverlayHandler(page: Page, record: (event: OverlayEvent) => void) {
  const overlay = knownHostDialogs(page).last();
  await page.addLocatorHandler(overlay, () => dismissFirstRunOverlays(page, record, 'actionability'), { noWaitAfter: true });
}

/** Complete our business flow explicitly, never through the overlay handler.
 * Wait for either the chooser or the already-open blank composer. */
export async function completeChatWorkspaceChoice(page: Page, conversationReady: Locator, workspaceId: string,
  copy: { 'chat.workspaceChoose': string; 'chat.workspace': string; 'card.start': string }): Promise<'selected' | 'direct'> {
  const chooser = page.getByRole('dialog', { name: copy['chat.workspaceChoose'], exact: true });
  await chooser.or(conversationReady).first().waitFor({ state: 'visible' });
  if (!await chooser.isVisible()) return 'direct';
  await chooser.getByRole('combobox', { name: copy['chat.workspace'], exact: true }).selectOption(workspaceId);
  await chooser.getByRole('button', { name: copy['card.start'], exact: true }).click();
  await chooser.waitFor({ state: 'hidden' });
  return 'selected';
}

export function redactScreenshotText(value: unknown, secrets: Iterable<string> = []): string {
  let clean = stripVTControlCharacters(String(value));
  for (const secret of secrets) if (secret) {
    clean = clean.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]');
  }
  return clean.replace(/([?&](?:token|access_token)=)[^\s&"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|set-cookie|cookie)\s*[:=])[^\r\n]+/gi, '$1 [REDACTED]');
}

/** Browser DOM only, including the visible dialog that may have blocked us.
 * The rc.2 shell has no main role, so use its conversation content marker or
 * our Bots region as fallbacks; never inspect React or private Client state. */
export function readFailureState() {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]')]
    .filter(visible).map((element) => element.getAttribute('aria-label')
      ?? element.getAttribute('aria-labelledby')?.split(/\s+/u).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
      ?? element.querySelector('h1, h2')?.textContent ?? '(unnamed)');
  const main = [...document.querySelectorAll<HTMLElement>('main, [role="main"], [data-bots-page], [data-conversation-content]')].find(visible);
  const fallback = document.getElementById('root') ?? document.body;
  const content = main?.hasAttribute('data-conversation-content') ? main.parentElement ?? main : main ?? fallback;
  return { dialogs, mainSource: main ? 'main-or-page-region' : 'root-fallback', mainText: content.innerText ?? content.textContent ?? '' };
}

/** Best-effort capture before closing the context. Diagnostic failures must
 * not replace the original failure. No fake PNG when Chromium never opened. */
export async function captureFailureEvidence(page: Page | undefined, output: string, step: string,
  redact: (value: unknown) => string) {
  const evidence: { step: string; screenshot?: string; screenshotError?: string; url?: string;
    dialogs?: string[]; mainSource?: string; mainText?: string; diagnosticError?: string;
    domCapturedAt?: string; screenshotStartedAt?: string; screenshotFinishedAt?: string } = { step };
  if (!page || page.isClosed()) {
    evidence.screenshotError = 'No live browser page; screenshot unavailable';
    return evidence;
  }
  evidence.url = redact(page.url());
  // DOM and PNG are separate samples. Read text before the asynchronous
  // screenshot, and label their timing rather than implying they are atomic.
  try {
    const state = await page.evaluate(readFailureState);
    evidence.domCapturedAt = new Date().toISOString();
    evidence.dialogs = state.dialogs.map((title) => redact(title));
    evidence.mainSource = state.mainSource;
    evidence.mainText = redact(state.mainText).slice(0, 12_000);
  } catch (error) { evidence.diagnosticError = redact(error); }
  const filename = `failure-${step.replace(/[^a-zA-Z0-9_-]+/gu, '-').slice(0, 120)}.png`;
  evidence.screenshotStartedAt = new Date().toISOString();
  try {
    await page.screenshot({ path: join(output, filename), fullPage: true, animations: 'disabled', timeout: 5000 });
    evidence.screenshot = filename;
  } catch (error) { evidence.screenshotError = redact(error); }
  evidence.screenshotFinishedAt = new Date().toISOString();
  return evidence;
}

export type Rgb = [number, number, number];
export type Rgba = [number, number, number, number];
export function composite(foreground: Rgba, background: Rgb): Rgb {
  return [0, 1, 2].map((index) => (foreground[index] ?? 0) * foreground[3] + (background[index] ?? 0) * (1 - foreground[3])) as Rgb;
}
export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const luminance = (rgb: Rgb) => rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * ([0.2126, 0.7152, 0.0722][index] ?? 0), 0);
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Runs in Chromium. Canvas converts the rendered elements' computed
 * CSS color()/color-mix() to sRGB; values never come from theme fixtures. */
export function readAvatarColors() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Cannot resolve computed avatar colors without a 2D canvas');
  const rgba = (css: string): Rgba => {
    if (!CSS.supports('color', css)) throw new Error(`Unsupported computed color: ${css}`);
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = css;
    context.fillRect(0, 0, 1, 1);
    const data = context.getImageData(0, 0, 1, 1).data;
    return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, (data[3] ?? 0) / 255];
  };
  const over = (fg: Rgba, bg: Rgb): Rgb => [0, 1, 2].map((i) => (fg[i] ?? 0) * fg[3] + (bg[i] ?? 0) * (1 - fg[3])) as Rgb;
  return Array.from(document.querySelectorAll<HTMLElement>('[data-bot-avatar]')).filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility === 'visible';
  }).map((element) => {
    const style = getComputedStyle(element);
    const kind = element.dataset.botAvatar;
    const identity = { botId: element.dataset.botId, kind, foregroundCss: style.color, backgroundCss: style.backgroundColor };
    if (kind !== 'whale') return { ...identity, measured: false as const, reason: 'Image/emoji has no single glyph foreground' };
    const path = element.querySelector('svg path');
    if (!path) throw new Error(`Whale SVG path missing for ${identity.botId}`);
    const pathStyle = getComputedStyle(path);
    const foreground = rgba(pathStyle.fill);
    foreground[3] *= Number(pathStyle.fillOpacity);
    // Honor actual glyph/ancestor opacity; fail rather than inventing a
    // background when a custom theme paints an image or translucent page.
    for (let node: Element | null = path; node && node !== element; node = node.parentElement) foreground[3] *= Number(getComputedStyle(node).opacity);
    const layers: Rgba[] = [];
    let opaque = false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const layerStyle = getComputedStyle(node);
      if (Number(layerStyle.opacity) !== 1 || layerStyle.backgroundImage !== 'none') throw new Error('Cannot measure avatar background with an opacity/image layer');
      const layer = rgba(layerStyle.backgroundColor);
      layers.push(layer);
      if (layer[3] === 1) { opaque = true; break; }
    }
    if (!opaque) throw new Error('Avatar has no resolved opaque background');
    const base = layers.pop();
    if (!base) throw new Error('Avatar background missing');
    let background: Rgb = [base[0], base[1], base[2]];
    for (const layer of layers.reverse()) background = over(layer, background);
    return { ...identity, measured: true as const, glyphFillCss: pathStyle.fill, foregroundRgba: foreground,
      foregroundRgb: over(foreground, background), backgroundRgb: background };
  });
}

export async function measureAvatars(page: Page) {
  const values = await page.evaluate(readAvatarColors);
  return values.map((value) => value.measured
    ? { ...value, contrastRatio: contrastRatio(value.foregroundRgb, value.backgroundRgb) }
    : { ...value, contrastRatio: null });
}

export function verifyAvatarContrast(avatars: Awaited<ReturnType<typeof measureAvatars>>, expectedIds: string[]): void {
  for (const id of expectedIds) {
    if (!avatars.some((avatar) => avatar.botId === id && avatar.measured)) throw new Error(`Actual whale colors missing for ${id}`);
  }
  for (const avatar of avatars) if (avatar.measured && (!Number.isFinite(avatar.contrastRatio) || avatar.contrastRatio < 3)) {
    throw new Error(`Whale contrast below 3:1 (${avatar.botId}): ${avatar.contrastRatio}`);
  }
}
