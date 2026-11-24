import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel, openSidebarSession, selectBotDirectoryAction } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const dir = resolve(root, '.dsh-dev/bots-navigation-ui', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
const matrix = ['en', 'zh'].flatMap(language => ['light', 'dark'].flatMap(theme => [1360, 390].map(width => ({ language, theme, width }))));
const results = [], errors = [];
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
let host, browser, phase = 'host';
try {
  host = await webHost(dir, 'bots-navigation', undefined, resolve(root, 'packages/dsh-bot/tests/bots-navigation-ui-profile.mjs'));
  const fixture = JSON.parse(await readFile(resolve(dir, 'navigation-fixture.json'), 'utf8'));
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const candidates = (await readdir(cache).catch(() => [])).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell')));
  const executablePath = process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync) ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env }); }
  finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
  phase = 'browser';
  for (const item of matrix) {
    const { language, theme, width } = item, id = `${language}-${theme}-${width}`, checks = [], screenshots = [];
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`), 'utf8')).ui;
    const context = await browser.newContext({ colorScheme: theme, locale: language === 'en' ? 'en-US' : 'zh-CN', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(redact(error)));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const check = (name, value) => { assert.ok(value, `${id}: ${name}`); checks.push(name); };
    const shot = async name => {
      check(`${name}: no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const background = await page.evaluate(() => { const el = document.createElement('div'); el.style.backgroundColor = 'var(--dsw-alias-bg-base)'; document.body.append(el); const color = getComputedStyle(el).backgroundColor; el.remove(); return color; });
      const channels = background.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      check(`${name}: actual theme`, channels?.length === 3 && (theme === 'dark' ? channels.reduce((a, b) => a + b, 0) < 384 : channels.reduce((a, b) => a + b, 0) > 384));
      const file = `${id}-${name}.png`; await page.screenshot({ path: resolve(dir, file), fullPage: true }); screenshots.push(file);
    };
    try {
      await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'bots-navigation');
      await openBotsPanel(page, t['bots.title']);
      const panel = page.locator('[data-bots-page]:visible');
      const navigation = panel.getByRole('navigation', { name: t['navigation.sections'], exact: true });
      const settings = panel.locator('[data-settings-navigation]');
      const scroll = panel.locator(':scope > div').first();
      await panel.locator('button[data-bot-id="navigation-bot-23"]').waitFor();
      await page.setViewportSize({ width, height: 1000 });
      check('all Bots visible without any chat history', await panel.locator('button[data-bot-id]').count() === 24);
      check('stable three-way navigation', await navigation.getByRole('button').count() === 3);
      check('Bot previews stay inside their row', await panel.locator('[data-bots-list="bots"] li').evaluateAll(rows => rows.every(row => { const preview = row.querySelector('[data-activity-preview]')?.getBoundingClientRect(), more = row.querySelector('summary')?.getBoundingClientRect(); return !preview || !more || preview.right <= more.left; })));
      await shot('my-bots');
      const search = panel.getByRole('searchbox', { name: t['navigation.searchBots'], exact: true });
      await search.fill('Assistant 02');
      await settings.click(); check('return describes My Bots', (await settings.textContent()).includes(t['navigation.myBots']));
      await settings.click(); check('search retained', await search.inputValue() === 'Assistant 02');
      check('settings return restores focus', await settings.evaluate(el => document.activeElement === el));
      await search.fill('');
      // Enter settings from a scrolled list by keyboard, without a click that first scrolls the trigger into view.
      await settings.focus(); await scroll.evaluate(el => { el.scrollTop = 420; });
      await page.waitForFunction(() => document.querySelector('[data-bots-page] > div')?.scrollTop >= 400);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.keyboard.press('Enter'); await settings.click();
      check('original scroll restored', await scroll.evaluate(el => el.scrollTop >= 400));
      await navigation.getByRole('button', { name: t['chat.recent'], exact: true }).click();
      await selectBotDirectoryAction(panel, 'navigation-bot-0', t['chat.hide']);
      check('hidden only in recent', await panel.locator('button[data-bot-id="navigation-bot-0"]').count() === 0);
      await navigation.getByRole('button', { name: t['navigation.myBots'], exact: true }).click();
      check('hidden Bot remains in My Bots', await panel.locator('button[data-bot-id="navigation-bot-0"]').count() === 1);
      await navigation.getByRole('button', { name: t['groups.title'], exact: true }).click();
      await panel.getByRole('navigation', { name: t['groups.list'], exact: true }).getByRole('button').filter({ hasText: fixture.group.name }).click();
      const group = panel.getByRole('article', { name: fixture.group.name, exact: true }); await group.waitFor();
      check('three individually named members', await group.getByRole('list', { name: t['groups.members'], exact: true }).getByRole('listitem').count() === 3);
      await shot('group-members');
      await group.getByRole('button', { name: t['chat.profile'], exact: true }).first().click();
      await panel.locator('[data-bot-detail="navigation-bot-0"]').waitFor();
      await panel.locator('dialog').getByRole('button', { name: t['actions.close'], exact: true }).click();
      check('member details close returns to same group', await group.isVisible());
      await settings.click(); check('settings names originating group', (await settings.textContent()).includes(fixture.group.name));
      await shot('settings');
      await settings.click(); check('settings returns to same group', await group.isVisible());
      await settings.click();
      await panel.getByRole('textbox', { name: t['integrations.label'], exact: true }).fill('Unsaved navigation fixture');
      await settings.click(); await panel.getByRole('dialog', { name: t['navigation.unsaved'], exact: true }).waitFor();
      await shot('unsaved-settings');
      await panel.getByRole('button', { name: t['navigation.keepEditing'], exact: true }).click();
      check('cancel return retains draft', await panel.getByRole('textbox', { name: t['integrations.label'], exact: true }).inputValue() === 'Unsaved navigation fixture');
      await settings.click(); await panel.getByRole('button', { name: t['navigation.discardLeave'], exact: true }).click();
      check('discard returns to original group', await group.isVisible());
      // Explicitly open an existing native group session, then reopen the global plugin panel.
      await group.getByRole('button', { name: t['groups.open'], exact: true }).click();
      await page.locator(`[data-workspace-group-composer="${fixture.group.rootSessionId}"]:visible`).waitFor();
      await page.setViewportSize({ width: 1360, height: 1000 });
      await openSidebarSession(page, fixture.group.rootSessionId);
      await openBotsPanel(page, t['bots.title']); await group.waitFor();
      await navigation.getByRole('button', { name: t['navigation.myBots'], exact: true }).click();
      await openSidebarSession(page, fixture.group.rootSessionId); await openBotsPanel(page, t['bots.title']);
      check('old group selection does not hijack remounted My Bots', await panel.locator('[data-bots-list="bots"]').isVisible());
      check('navigation never starts a model', host.requests() === 0);
      results.push({ ...item, status: 'PASS', checks, screenshots });
    } catch (error) {
      await page.screenshot({ path: resolve(dir, `${id}-failure.png`), fullPage: true }).catch(() => {});
      await writeFile(resolve(dir, `${id}-failure-aria.txt`), redact(await page.locator('body').ariaSnapshot()));
      results.push({ ...item, status: 'FAIL', checks, screenshots, error: redact(error) }); throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  const clientSha256 = createHash('sha256').update(await readFile(resolve(root, 'packages/dsh-bot/lib/client.js'))).digest('hex');
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'PASS', results, errors, clientSha256, modelRequests: host.requests(), isolatedHost: true, chromiumSandbox: true }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', dir, cases: results.length, screenshots: results.flatMap(result => result.screenshots).length }));
} catch (error) {
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'FAIL', phase, results, errors, error: redact(error) }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: redact(error) })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
