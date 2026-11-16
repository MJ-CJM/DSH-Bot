// Real installed rc.2 Conversation/composer layout checks. The Host uses its
// explicitly synthetic model adapter; no response rewriting or fake Client.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

const root = process.cwd();
const base = resolve(root, process.env.DSH_BOT_APPROVAL_DIR ?? '.dsh-dev/bot-mode-approval');
assert.ok(base.startsWith(`${root}/.dsh-dev/`));
const dir = resolve(root, '.dsh-dev/bot-mode-visual-browser', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
process.env.TMPDIR = resolve(base, 'tmp');
await mkdir(process.env.TMPDIR, { recursive: true });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const state = await json(resolve(base, 'service.json'));
const fixture = await json(resolve(base, 'fixture.json'));
assert.equal(fixture.synthetic, true); assert.equal(fixture.realModelRequests, 0);
const botId = 'local-research';
const botName = fixture.createdBots.find(bot => bot.id === botId)?.name;
assert.ok(botName && fixture.sessions[botId], 'Visual Bot must belong to the isolated fixture');
const provenance = await json(resolve(base, 'client-provenance.json'));
assert.equal(Object.keys(provenance).length, 5, 'All installed Client factories must be audited');
const expected = {};
for (const [id, resource] of Object.entries(provenance)) {
  const bytes = await readFile(resource.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), resource.sha256);
  expected[id] = bytes.toString().trimEnd().replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*$/u, '').trimEnd();
}
const responseHashes = Object.fromEntries(Object.entries(provenance).map(([id, resource]) => [id, resource.sha256]));
let reusedEmptyEvidence;
if (process.env.DSH_BOT_VISUAL_EMPTY_EVIDENCE) {
  const path = resolve(root, process.env.DSH_BOT_VISUAL_EMPTY_EVIDENCE);
  assert.ok(path.startsWith(`${root}/.dsh-dev/`), 'Empty evidence must stay in repository');
  const receipt = await json(path);
  assert.equal(receipt.status, 'PASS'); assert.equal(receipt.artifactSha256, state.artifactSha256);
  assert.equal(receipt.sessionId, fixture.sessions[botId]);
  assert.deepEqual(receipt.responseHashes, responseHashes);
  assert.ok(receipt.geometry?.empty && receipt.geometry?.first && receipt.emptyToFirstPassed === true);
  reusedEmptyEvidence = { path, receipt };
}
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
const executablePath = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
  .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync);
assert.ok(executablePath, 'Cached Chromium required');
const checks = [], errors = [], screenshots = [], measurements = [];
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
const check = (name, condition, detail) => { assert.ok(condition, `${name}${detail ? `: ${JSON.stringify(detail)}` : ''}`); checks.push({ name, status: 'PASS', ...(detail && { detail }) }); };
const waitFor = async (name, test, timeout = 45000) => { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await test()) return; } catch {} await delay(100); } throw new Error(`Timed out: ${name}`); };
let browser, page, phase = 'boot';
const step = name => { phase = name; console.log(JSON.stringify({ phase })); };
const shot = async name => { await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true, animations: 'disabled' }); screenshots.push(`${name}.png`); };
const title = chat => chat.locator('[data-bot-mode-title]');
const panelButton = chat => chat.locator('[data-bot-mode-details]');
const geometry = chat => chat.evaluate(node => {
  const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
  const scroll = node.querySelector('[data-conversation-scroll]');
  const seat = node.querySelector('[data-composer-seat]');
  const editor = node.querySelector('[contenteditable="true"]');
  const flow = node.querySelector('[data-chat-flow]');
  const card = node.querySelector('[data-composer-card]');
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d'); context.fillStyle = getComputedStyle(node).backgroundColor; context.fillRect(0, 0, 1, 1);
  const backgroundRgb = [...context.getImageData(0, 0, 1, 1).data];
  if (!scroll || !seat || !editor) throw new Error('Native Conversation geometry missing');
  return { chat: box(node), flow: flow ? box(flow) : null, card: card ? box(card) : null, backgroundRgb, scroll: box(scroll), seat: box(seat), editor: box(editor), scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth };
});
const readingAnchor = chat => chat.evaluate(node => {
  const scroll = node.querySelector('[data-conversation-scroll]');
  const seat = node.querySelector('[data-composer-seat]');
  const scrollBox = scroll.getBoundingClientRect(), seatBox = seat.getBoundingClientRect();
  const headings = [...node.querySelectorAll('[data-chat-flow] h3')];
  const heading = headings.find(element => { const box = element.getBoundingClientRect(); return box.y >= scrollBox.y && box.bottom <= Math.min(scrollBox.bottom, seatBox.y); });
  if (!heading) throw new Error('No actual long-reply heading in reading viewport');
  return { text: heading.textContent, offsetY: heading.getBoundingClientRect().y - scrollBox.y };
});
const floor = (label, value) => {
  measurements.push({ label, ...value });
  check(`${label}: native composer seat stays at viewport floor`, Math.abs(value.chat.bottom - value.seat.bottom) <= 5 && value.seat.bottom <= value.viewport.height + 1, value);
  check(`${label}: composer inside visible chat bounds`, value.editor.y >= value.chat.y && value.editor.bottom <= value.viewport.height && value.editor.x >= value.chat.x && value.editor.right <= value.viewport.width + 1, value);
  check(`${label}: no horizontal page overflow`, value.documentWidth <= value.viewport.width + 1, value);
  if (value.flow) check(`${label}: reading column respects approved maximum`, value.flow.width <= 762, { flow: value.flow });
  check(`${label}: native composer card respects approved maximum`, value.card && value.card.width <= 802, { card: value.card });
};
try {
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: { ...process.env, TMPDIR: process.env.TMPDIR } });
  let first = true;
  for (const width of [1440, 1024, 390, 320]) for (const language of ['zh', 'en']) for (const theme of ['light', 'dark']) {
    const label = `${width}-${language}-${theme}`; step(`${label}:open`);
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', colorScheme: theme, reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push({ phase, error: redact(error.stack ?? error) }));
    const bodies = [];
    page.on('response', response => { if (new URL(response.url()).pathname === '/plugins/' && /javascript/.test(response.headers()['content-type'] ?? '')) void response.text().then(body => bodies.push(body)).catch(() => {}); });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await installOverlayHandler(page, () => {});
    await page.goto(state.url, { waitUntil: 'domcontentloaded' }); await dismissFirstRunOverlays(page, () => {}, 'bot-mode-visual');
    const sidebar = page.locator('[data-bot-mode-sidebar]'), objects = sidebar.getByRole('navigation');
    await sidebar.waitFor();
    const row = objects.getByRole('button', { name: botName, exact: true }).first();
    if (await sidebar.getAttribute('data-collapsed') !== null) {
      const toggles = await page.getByRole('button', { name: /Show or hide Bots and groups|展开或收起 Bot 和群列表/ }).all();
      const visible = []; for (const toggle of toggles) if (await toggle.isVisible()) visible.push(toggle);
      assert.ok(visible.length, 'Collapsed native shell exposes an accessible object-list toggle');
      await visible[0].click();
    }
    await row.waitFor();
    check(`${label}: one settings entry`, await sidebar.locator('[data-bot-mode-settings]').count() === 1);
    await row.click();
    const chat = page.locator('[data-bot-mode-object="bot"]'); await title(chat).waitFor();
    await waitFor('selected exact Bot title', async () => await title(chat).textContent() === botName);
    check(`${label}: exact Bot identity in title`, await title(chat).textContent() === botName);
    if (width < 700) await row.waitFor({ state: 'hidden' });
    const editor = chat.locator('[contenteditable="true"]:visible').first(); await editor.waitFor();
    check(`${label}: native Conversation retains exact Bot session`, await chat.locator('[data-conversation-content]').getAttribute('data-conversation-session') === fixture.sessions[botId]);
    await waitFor('actual same-package Client factory responses', () => Object.values(expected).every(contents => bodies.some(body => body.includes(contents))), 20000);
    for (const id of Object.keys(expected)) check(`${label}: HTTP response matches frozen ${id}`, bodies.some(body => body.includes(expected[id])));
    check(`${label}: no actionable Session entry`, await page.getByRole('button', { name: /^(新建会话|New Session|归档会话|Archive Session)$/i }).count() === 0);
    check(`${label}: right panel initially closed`, await page.locator('[data-bot-mode-details-panel]').isVisible().catch(() => false) === false);
    if (first) {
      step(`${label}:empty-to-first`);
      if (reusedEmptyEvidence) {
        const receipt = reusedEmptyEvidence.receipt;
        floor('reused-empty', receipt.geometry.empty); floor('reused-first-short-message', receipt.geometry.first);
        check('explicit same-artifact empty to first receipt reused', Math.abs(receipt.geometry.empty.seat.y - receipt.geometry.first.seat.y) <= 5
          && Math.abs(receipt.geometry.empty.editor.y - receipt.geometry.first.editor.y) <= 5, { source: reusedEmptyEvidence.path, artifactSha256: receipt.artifactSha256, sessionId: receipt.sessionId });
      } else {
        await chat.locator('[data-bot-mode-empty]').waitFor();
        const empty = await geometry(chat); floor('empty', empty); await shot('1440-zh-light-empty');
        await editor.fill('你好'); await editor.press('Enter');
        await chat.getByText('你好，这是独立的 Bot 模式审批服务。', { exact: false }).last().waitFor();
        await waitFor('first reply settles', async () => await chat.getByRole('button', { name: /^(停止|Stop)$/ }).count() === 0);
        const short = await geometry(chat); floor('first-short-message', short);
        check('empty to first reply does not move composer', Math.abs(empty.seat.y - short.seat.y) <= 5 && Math.abs(empty.editor.y - short.editor.y) <= 5, { empty, short });
        await shot('1440-zh-light-first-reply');
        await writeFile(resolve(dir, 'empty-to-first.json'), JSON.stringify({ status: 'PASS', botId, botName, artifactSha256: state.artifactSha256, sessionId: fixture.sessions[botId], responseHashes,
          geometry: { empty, first: short }, emptyToFirstPassed: true, observedAt: new Date().toISOString(), screenshots: ['1440-zh-light-empty.png', '1440-zh-light-first-reply.png'] }, null, 2));
      }
      step(`${label}:long-real-message`);
      await editor.fill('布局长消息验收'); await editor.press('Enter');
      await waitFor('native long reply renders scrollable content', async () => {
        const value = await geometry(chat);
        return value.scrollHeight > value.clientHeight + 200 && await chat.getByRole('button', { name: /^(停止|Stop)$/ }).count() === 0;
      });
      first = false;
    }
    step(`${label}:layout`);
    await waitFor('layout settling', async () => (await geometry(chat)).seat.height > 50);
    const longGeometry = await geometry(chat); floor(`${label}:long`, longGeometry);
    check(`${label}: rendered host theme matches requested color scheme`, longGeometry.backgroundRgb[3] === 255 && (longGeometry.backgroundRgb.slice(0, 3).reduce((a, b) => a + b, 0) < 384) === (theme === 'dark'), { backgroundRgb: longGeometry.backgroundRgb });
    check(`${label}: actual message content scrolls`, longGeometry.scrollHeight > longGeometry.clientHeight + 200, longGeometry);
    await editor.click(); check(`${label}: composer receives pointer hit`, await editor.evaluate(node => node === document.activeElement || node.contains(document.activeElement)));
    const single = await editor.boundingBox();
    await editor.fill('多行草稿第一行\n第二行\n第三行\n第四行\n第五行');
    await waitFor('native multiline grows', async () => (await editor.boundingBox()).height > single.height + 25);
    const multiline = await geometry(chat); floor(`${label}:multiline`, multiline);
    check(`${label}: native composer grows upward for multiline draft`, multiline.editor.height > single.height + 25 && multiline.seat.y < longGeometry.seat.y, { single, multiline });
    await shot(`${label}-multiline`);
    await editor.fill(`保留草稿-${label}`);
    for (const [name, pattern] of [['model', /^(选择模型，当前|Select model, current)/], ['permission', /^(访问模式，当前|Access mode, current)/]]) {
      const control = chat.getByRole('button', { name: pattern }); await control.waitFor();
      check(`${label}: native ${name} entry enabled`, await control.isEnabled());
      check(`${label}: native ${name} label follows host locale`, (await control.getAttribute('aria-label')).startsWith(language === 'zh' ? name === 'model' ? '选择模型' : '访问模式' : name === 'model' ? 'Select model' : 'Access mode'));
      await control.click(); await page.getByRole('menu').last().waitFor(); check(`${label}: native ${name} menu opens`, true); await page.keyboard.press('Escape');
    }
    const approvalReply = chat.getByText('【本地演示】原生审批已结束：rejected。', { exact: false });
    const previousApprovalReplyCount = await approvalReply.count();
    const previousApproval = await json(resolve(base, 'native-approval.json')).catch(() => undefined);
    const previousApprovalId = previousApproval?.events.findLast(event => event.type === 'approval/asked')?.data.id;
    await editor.fill('布局审批验收'); await editor.press('Enter');
    const approval = chat.locator('[data-approval-key]'); await approval.waitFor();
    const reject = approval.getByRole('button', { name: /^(拒绝|Reject)$/ }); await reject.waitFor();
    const approvalBox = await approval.boundingBox(), rejectBox = await reject.boundingBox();
    check(`${label}: native approval takeover remains visible`, approvalBox.y >= 0 && approvalBox.y + approvalBox.height <= 901 && rejectBox.y + rejectBox.height <= 900, { approvalBox, rejectBox });
    check(`${label}: native approval reject is enabled`, await reject.isEnabled());
    await shot(`${label}-native-approval`); await reject.click();
    await approval.waitFor({ state: 'hidden' }); await editor.waitFor();
    await waitFor('native approval has durable rejected decision', async () => {
      const receipt = await json(resolve(base, 'native-approval.json'));
      const asked = receipt.events.findLast(event => event.type === 'approval/asked');
      return receipt.sessionId === fixture.sessions[botId] && receipt.outcome === 'rejected' && asked?.data.id !== previousApprovalId
        && asked?.data.toolName === 'dsh-bot-layout-review'
        && receipt.events.some(event => event.type === 'approval/decided' && event.data.id === asked.data.id && event.data.outcome === 'rejected');
    });
    const receipt = await json(resolve(base, 'native-approval.json'));
    const asked = receipt.events.findLast(event => event.type === 'approval/asked');
    check(`${label}: actual approval asked/decided match current Bot session`, receipt.sessionId === fixture.sessions[botId] && receipt.outcome === 'rejected' && asked.data.id !== previousApprovalId
      && receipt.events.some(event => event.type === 'approval/decided' && event.data.id === asked.data.id && event.data.outcome === 'rejected'), receipt);
    await waitFor('this approval reply reaches native transcript', async () => await approvalReply.count() > previousApprovalReplyCount);
    await editor.fill(`保留草稿-${label}`);
    const scroll = chat.locator('[data-conversation-scroll]');
    await scroll.evaluate(node => { node.scrollTop = Math.max(0, (node.scrollHeight - node.clientHeight) * 0.42); });
    await delay(150); const beforePanel = await scroll.evaluate(node => node.scrollTop), beforeAnchor = await readingAnchor(chat);
    await panelButton(chat).click();
    const details = page.locator('[data-bot-mode-details-panel]'); await details.waitFor();
    const profile = details.locator('[data-bot-mode-profile]');
    check(`${label}: real Bot details identifies selected Bot and avatar`, await profile.getByText(botName, { exact: true }).isVisible() && await profile.locator(`[data-bot-id="${botId}"]`).count() === 1);
    const panelBox = await chat.locator('.dsh-bot-mode-detail-surface').boundingBox();
    check(`${label}: details surface fits viewport`, panelBox.x >= 0 && panelBox.y >= 0 && panelBox.x + panelBox.width <= width + 1 && panelBox.y + panelBox.height <= 901, panelBox);
    check(`${label}: details uses approved responsive width`, Math.abs(panelBox.width - (width <= 700 ? longGeometry.chat.width : 352)) <= 2, panelBox);
    if (width < 1100) check(`${label}: overlay preserves conversation width`, Math.abs((await geometry(chat)).scroll.width - longGeometry.scroll.width) <= 2);
    const afterOpen = await scroll.evaluate(node => node.scrollTop), afterAnchor = await readingAnchor(chat);
    check(`${label}: opening details preserves actual text reading anchor`, beforeAnchor.text === afterAnchor.text && Math.abs(beforeAnchor.offsetY - afterAnchor.offsetY) <= 5, { beforeAnchor, afterAnchor });
    check(`${label}: opening details preserves reading offset`, Math.abs(beforePanel - afterOpen) <= 5, { beforePanel, afterOpen });
    await details.getByRole('button', { name: /^(资料|Materials)$/ }).click();
    const afterTab = await scroll.evaluate(node => node.scrollTop);
    check(`${label}: changing details tab preserves reading offset and draft`, Math.abs(afterOpen - afterTab) <= 5 && await editor.textContent() === `保留草稿-${label}`, { afterOpen, afterTab });
    await shot(`${label}-details`);
    await details.locator('.dsh-bot-mode-details-heading button').click(); await details.waitFor({ state: 'hidden' });
    check(`${label}: closing details preserves reading offset`, Math.abs(beforePanel - await scroll.evaluate(node => node.scrollTop)) <= 5);
    const restoredAnchor = await readingAnchor(chat);
    check(`${label}: closing details preserves actual text reading anchor`, beforeAnchor.text === restoredAnchor.text && Math.abs(beforeAnchor.offsetY - restoredAnchor.offsetY) <= 5, { beforeAnchor, restoredAnchor });
    await editor.press('Meta+A'); await editor.press('Backspace');
    await waitFor('native keyboard clears validation draft', async () => (await editor.textContent()).trim() === '');
    check(`${label}: validation draft cleared through native keyboard`, true);
    await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; }); await delay(100);
    floor(`${label}:after-panel`, await geometry(chat)); await shot(`${label}-chat`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  check('native Browser matrix has zero JavaScript errors', true);
  check('isolated fixture has no real model requests', (await json(resolve(base, 'fixture.json'))).realModelRequests === 0);
} catch (error) {
  checks.push({ name: phase, status: 'FAIL', error: redact(error.stack ?? error) }); process.exitCode = 1;
  if (page) { await shot('failure').catch(() => {}); await page.content().then(html => writeFile(resolve(dir, 'failure.html'), redact(html))).catch(() => {}); }
} finally {
  await browser?.close();
  const result = { status: checks.some(row => row.status === 'FAIL') ? 'FAIL' : 'PASS', phase, artifactSha256: state.artifactSha256, runtimeVersion: state.version, botId, botName, serviceBase: base, temporaryDirectory: process.env.TMPDIR, scope: 'Actual installed native Client/components and synthetic local Host model; no response rewrite; no real model', checks, errors, screenshots, measurements, ...(reusedEmptyEvidence && { reusedEmptyEvidence: reusedEmptyEvidence.path }) };
  await writeFile(resolve(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, phase, checks: checks.length, dir }));
}
