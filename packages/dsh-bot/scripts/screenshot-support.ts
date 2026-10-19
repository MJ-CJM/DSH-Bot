import type { Locator, Page } from 'playwright-core';
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
    dialogs?: string[]; mainSource?: string; mainText?: string; diagnosticError?: string } = { step };
  if (!page || page.isClosed()) {
    evidence.screenshotError = 'No live browser page; screenshot unavailable';
    return evidence;
  }
  evidence.url = redact(page.url());
  const filename = `failure-${step.replace(/[^a-zA-Z0-9_-]+/gu, '-').slice(0, 120)}.png`;
  try {
    await page.screenshot({ path: join(output, filename), fullPage: true, animations: 'disabled', timeout: 5000 });
    evidence.screenshot = filename;
  } catch (error) { evidence.screenshotError = redact(error); }
  try {
    const state = await page.evaluate(readFailureState);
    evidence.dialogs = state.dialogs.map((title) => redact(title));
    evidence.mainSource = state.mainSource;
    evidence.mainText = redact(state.mainText).slice(0, 12_000);
  } catch (error) { evidence.diagnosticError = redact(error); }
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
