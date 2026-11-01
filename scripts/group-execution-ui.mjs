import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { webHost } from './deepening/b4-web-host.mjs';
import { openSidebarSession } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const dir = resolve(root, '.dsh-dev/group-execution-ui', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
let host, browser, page, phase = 'host'; const errors = [], checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
try {
  host = await webHost(dir, 'group-api', process.env.DSH_BOT_ARTIFACT && resolve(process.env.DSH_BOT_ARTIFACT), resolve(root, 'packages/dsh-bot/tests/group-native-api-profile.mjs'), ['- id: agent-default-model', '  config:', '    provider: dp-b6b', '    model: fixture']);
  const fixture = JSON.parse(await readFile(resolve(dir, 'ui-fixture.json'), 'utf8'));
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const candidates = (await readdir(cache).catch(() => [])).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell')));
  const executablePath = process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync) ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
  const beforeTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env }); }
  finally { if (beforeTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = beforeTmp; }
  const matrix = ['en', 'zh'].flatMap(language => ['light', 'dark'].flatMap(theme => [1360, 390].map(width => ({ language, theme, width }))));
  if (process.env.DSH_BOT_UI_CASE) assert.ok(matrix.some(({ language, theme, width }) => `${language}-${theme}-${width}` === process.env.DSH_BOT_UI_CASE));
  for (const { language, theme, width } of matrix) {
    const id = `${language}-${theme}-${width}`;
    if (process.env.DSH_BOT_UI_CASE && process.env.DSH_BOT_UI_CASE !== id) continue;
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`), 'utf8')).ui;
    const context = await browser.newContext({ colorScheme: theme, locale: language === 'en' ? 'en-US' : 'zh-CN', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(`${id}: ${error}`));
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warn') errors.push(`${id}: ${message.text()}`); });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    phase = `${id}:open`; await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
    await dismissFirstRunOverlays(page, () => {}, 'group-api'); await openSidebarSession(page, fixture.rootId);
    await page.setViewportSize({ width, height: 1000 });
    const composer = page.locator('[data-workspace-group-composer]');
    const draft = composer.locator('textarea:visible'); await draft.fill(`draft-${id}`);
    const question = page.locator(`[data-workspace-group-message="${fixture.inputMessageId}"]`);
    const secondQuestion = page.locator(`[data-workspace-group-message="${fixture.secondInputMessageId}"]`);
    const execution = question.locator(`[data-group-turn="${fixture.turnId}"]`);
    const disclosure = execution.locator(':scope > button[aria-expanded]');
    await disclosure.waitFor();
    await secondQuestion.locator(`[data-group-turn="${fixture.secondTurnId}"]`).waitFor();
    check(`${id}: each question owns exactly its execution`, await question.locator('[data-group-turn]').count() === 1 && await secondQuestion.locator('[data-group-turn]').count() === 1);
    check(`${id}: composer contains no task list or status bars`, await composer.locator('[data-group-turn],[data-group-execution-card],[data-group-working]').count() === 0);
    check(`${id}: execution defaults to a collapsed line`, await disclosure.getAttribute('aria-expanded') === 'false');
    const composerHeight = (await composer.boundingBox()).height;
    const card = execution.locator('[data-group-execution-card]').filter({ hasText: 'api-alpha' }).last();
    const count = host.requests();
    phase = `${id}:expand`; await disclosure.click();
    check(`${id}: disclosure does not grow the composer`, Math.abs((await composer.boundingBox()).height - composerHeight) < 2);
    const inline = card.locator('[data-group-member-process]');
    await inline.getByText('Synthetic native reasoning', { exact: true }).waitFor();
    await inline.locator('[data-disclosure-row]').click();
    await inline.locator('.markdown-body, [class*="markdown"], p').filter({ hasText: 'Synthetic native reasoning' }).first().waitFor();
    check(`${id}: official reasoning is embedded under the correct member`, await inline.getAttribute('data-group-member-process') === fixture.childId);
    const human = await question.locator('[data-group-author="user"]').boundingBox();
    const bot = await page.locator('[data-group-author="bot"]').first().boundingBox();
    const frame = await question.boundingBox();
    check(`${id}: user right and bots left`, human.x > bot.x + 10 && Math.abs(human.x + human.width - frame.x - frame.width) < 8);
    check(`${id}: inline process remains left`, (await inline.boundingBox()).x < human.x);
    check(`${id}: message and reasoning fit the viewport`, await question.evaluate(el => el.scrollWidth <= el.clientWidth + 2));
    await page.screenshot({ path: resolve(dir, `${id}-inline.png`), fullPage: true });
    await disclosure.click(); check(`${id}: user can collapse execution`, await disclosure.getAttribute('aria-expanded') === 'false');
    await disclosure.focus(); await disclosure.press('Enter');
    check(`${id}: keyboard can expand execution`, await disclosure.getAttribute('aria-expanded') === 'true');
    await card.getByRole('button', { name: t['execution.viewDetails'], exact: true }).click();
    const embedded = page.locator(`[data-group-execution="${fixture.childId}"]`);
    await embedded.locator(`[data-conversation-content][data-conversation-session="${fixture.childId}"]`).waitFor();
    check(`${id}: native factory bound to exact child`, await embedded.getAttribute('data-group-execution') === fixture.childId);
    check(`${id}: no visible child composer`, await embedded.locator('[contenteditable="true"]:visible,textarea:visible').count() === 0);
    await embedded.getByText('Native result 2', { exact: false }).waitFor();
    await embedded.locator('[data-turn-process]').first().click();
    await embedded.locator('[data-process-activity="tools"]').click();
    await embedded.locator('[data-disclosure-row]').filter({ hasText: 'Synthetic native reasoning' }).first().click();
    await embedded.getByText('Synthetic native reasoning', { exact: true }).first().waitFor();
    await page.screenshot({ path: resolve(dir, `${id}.png`), fullPage: true });
    await writeFile(resolve(dir, `${id}-text.txt`), await embedded.innerText());
    check(`${id}: native reasoning present`, (await embedded.innerText()).includes('Synthetic native reasoning'));
    check(`${id}: native tool present`, (await embedded.innerText()).includes('group_message'));
    const background = await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor);
    await writeFile(resolve(dir, `${id}-theme.txt`), background);
    phase = `${id}:collapse`; await page.locator('[data-dockkit-tab-close]').last().click();
    check(`${id}: collapsed view unmounted`, await page.locator('[data-group-execution]').count() === 0);
    check(`${id}: group draft preserved`, await draft.inputValue() === `draft-${id}`);
    await card.getByRole('button', { name: t['execution.viewDetails'], exact: true }).click(); await embedded.locator('[data-conversation-content]').waitFor();
    check(`${id}: viewing and reopening do not execute models`, host.requests() === count);
    if (language === 'zh' && theme === 'dark' && width === 1360) {
      await page.locator('[data-dockkit-tab-close]').last().click();
      phase = `${id}:live`; await draft.fill('UI_LIVE_TRACE');
      await composer.getByRole('button', { name: t['groups.send'], exact: true }).click();
      const liveQuestion = page.locator('[data-workspace-group-message]').filter({ has: page.locator('[data-group-author="user"]', { hasText: 'UI_LIVE_TRACE' }) });
      await liveQuestion.locator('[data-group-turn] > button[aria-expanded]').click();
      const liveProcess = liveQuestion.locator('[data-group-member-process]');
      await liveProcess.nth(1).waitFor();
      for (const process of await liveProcess.all()) {
        const childId = await process.getAttribute('data-group-member-process');
        await process.getByText(`Live reasoning ${childId}`, { exact: true }).first().waitFor();
      }
      for (const process of await liveProcess.all()) {
        const childId = await process.getAttribute('data-group-member-process');
        await process.getByText(`Live reasoning ${childId} — streamed update`, { exact: true }).first().waitFor();
      }
      check('live concurrent reasoning follows each actual child', await liveProcess.count() === 2);
      const liveCount = host.requests();
      await liveProcess.first().locator('[data-disclosure-row]').click();
      await liveQuestion.scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(dir, 'live-members.png'), fullPage: true });
      const liveDisclosure = liveQuestion.locator('[data-group-turn] > button[aria-expanded]');
      await liveDisclosure.click(); check('folding releases inline member views', await liveProcess.count() === 0);
      await liveDisclosure.click(); await liveProcess.nth(1).waitFor();
      check('reopening live reasoning does not execute models', host.requests() === liveCount);
      await liveQuestion.getByRole('button', { name: t['groups.cancelTurn'], exact: true }).click();
    }
    await context.close(); page = undefined;
  }
  check('browser reports no uncaught errors', errors.length === 0);
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'PASS', checks, errors, modelRequestsAfter: host.requests(), fixture }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', dir }));
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(dir, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(resolve(dir, 'failure-text.txt'), await page.locator('body').innerText().catch(() => '')); await writeFile(resolve(dir, 'failure-dom.html'), await page.locator('body').innerHTML().catch(() => '')); }
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'FAIL', phase, error: String(error), errors, checks }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', phase, error: String(error), dir })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
