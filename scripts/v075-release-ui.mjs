import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel, openSidebarSession, selectBotDirectoryAction } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd();
assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
assert.ok(process.env.DSH_BOT_ARTIFACT && /^[a-f0-9]{64}$/.test(process.env.DSH_BOT_ARTIFACT_SHA256 ?? ''), 'Frozen artifact and SHA256 are required');
const artifactPath = resolve(process.env.DSH_BOT_ARTIFACT);
const artifactSha256 = createHash('sha256').update(await readFile(artifactPath)).digest('hex');
assert.equal(artifactSha256, process.env.DSH_BOT_ARTIFACT_SHA256);
const runId = `${Date.now()}-${process.pid}`;
const dir = resolve(root, '.dsh-dev/v075-release-ui', runId);
const screenshotDir = resolve(root, 'output/playwright/v075-release-ui', runId);
await mkdir(dir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });
const { chromium } = createRequire(resolve(root, 'packages/dsh-bot/package.json'))('playwright-core');
const matrix = ['en', 'zh'].flatMap(language => ['light', 'dark'].flatMap(theme => [1360, 390].map(width => ({ language, theme, width }))));
const results = [], errors = [];
let host, browser, page, phase = 'host';
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
try {
  host = await webHost(dir, 'group-api', artifactPath, resolve(root, 'packages/dsh-bot/tests/v075-release-ui-profile.mjs'),
    ['- id: agent-default-model', '  config:', '    provider: dp-b6b', '    model: fixture'], { hostTimeoutMs: 600000 });
  const artifact = JSON.parse(await readFile(resolve(dir, 'artifact-manifest.json'), 'utf8'));
  assert.equal(artifact.sha256, artifactSha256);
  assert.equal(artifact.version, '0.7.5');
  const fixture = JSON.parse(await readFile(resolve(dir, 'ui-fixture.json'), 'utf8'));
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const candidates = (await readdir(cache).catch(() => [])).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell')));
  const executablePath = process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync) ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
  const beforeTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env }); }
  finally { if (beforeTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = beforeTmp; }
  for (const item of matrix) {
    const { language, theme, width } = item, id = `${language}-${theme}-${width}`, checks = [], screenshots = [];
    const t = JSON.parse(await readFile(resolve(dir, 'unpacked/package/locale', `${language}.json`), 'utf8')).ui;
    const context = await browser.newContext({ colorScheme: theme, locale: language === 'en' ? 'en-US' : 'zh-CN', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(redact(error)));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const check = (name, value = true) => { assert.ok(value, `${id}: ${name}`); checks.push(name); };
    const shot = async state => {
      check(`${state}: no page overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const color = await page.evaluate(() => { const p = document.createElement('div'); p.style.backgroundColor = 'var(--dsw-alias-bg-base)'; document.body.append(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return c; });
      const rgb = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      check(`${state}: actual theme`, rgb?.length === 3 && (theme === 'dark' ? rgb.reduce((a,b) => a+b,0) < 384 : rgb.reduce((a,b) => a+b,0) > 384));
      const file = `${id}-${state}.png`; await page.screenshot({ path: resolve(screenshotDir, file), fullPage: true }); screenshots.push(file);
    };
    try {
      phase = `${id}:open`;
      await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'group-api'); await openSidebarSession(page, fixture.rootId);
      const chat = page.getByRole('tab', { name: language === 'zh' ? '对话' : 'Chat', exact: true });
      if (await chat.isVisible()) await chat.click();
      await page.setViewportSize({ width, height: 1000 });
      const composer = page.locator(`[data-workspace-group-composer="${fixture.rootId}"]:visible`), draft = composer.locator('textarea:visible');
      await draft.waitFor();
      const original = page.locator(`[data-workspace-group-message="${fixture.inputMessageId}"]`);
      await original.getByRole('button', { name: t['groups.reply'], exact: true }).first().click();
      await composer.getByRole('button', { name: t['groups.clearReply'], exact: true }).waitFor();
      await draft.fill(`Kept reply draft ${id}`); await shot('reply-composer');
      await composer.getByRole('button', { name: t['groups.clearReply'], exact: true }).click();
      check('clearing reply keeps draft', await draft.inputValue() === `Kept reply draft ${id}`);

      phase = `${id}:supplement`;
      const liveText = `UI_LIVE_TRACE ${id}`; await draft.fill(liveText);
      const beforeSend = host.requests();
      await composer.getByRole('button', { name: t['groups.send'], exact: true }).click();
      const live = page.locator('[data-workspace-group-message]').filter({ has: page.locator('[data-group-author="user"]', { hasText: liveText }) });
      const direct = live.locator('[data-group-running-supplement] [data-group-supplement-action]').first();
      await direct.waitFor();
      // Both natural-group members may publish their running status before their loopback call arrives.
      // Await those admitted requests so a concurrent initial call is not attributed to clicking Add note.
      const startedDeadline = Date.now() + 20000;
      while (host.requests() < beforeSend + 2 && Date.now() < startedDeadline) await delay(20);
      assert.equal(host.requests(), beforeSend + 2, 'Both fixture member streams have started');
      await draft.fill(`Supplement draft ${id}`); const before = host.requests(); await direct.click();
      check('direct supplement retains draft and focuses composer', await draft.inputValue() === `Supplement draft ${id}` && await draft.evaluate(el => el === document.activeElement));
      check('choosing supplement does not submit a model request', host.requests() === before);
      await composer.getByText(t['groups.supplement'], { exact: false }).first().waitFor();
      await shot('direct-supplement');
      await composer.getByRole('button', { name: t['groups.close'], exact: true }).click();
      await draft.fill('');
      const disclosure = live.locator('[data-group-turn] > button[aria-expanded]');
      if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
      await live.getByRole('button', { name: t['execution.stopTurn'], exact: true }).click();
      await live.locator('[data-group-turn][data-group-turn-state="cancelled"]').waitFor();

      phase = `${id}:group-mode`;
      await page.setViewportSize({ width: 1360, height: 1000 });
      await openBotsPanel(page, t['bots.title']);
      const groupPanel = page.locator('[data-bots-page]:visible');
      await groupPanel.getByRole('navigation', { name: t['navigation.sections'], exact: true }).getByRole('button', { name: t['groups.title'], exact: true }).click();
      await groupPanel.getByRole('button', { name: t['groups.create'], exact: true }).click();
      const form = groupPanel.getByRole('form', { name: t['groups.create'], exact: true });
      await page.setViewportSize({ width, height: 1000 });
      await form.locator('summary').filter({ hasText: t['groups.advanced'] }).click();
      const mode = form.getByRole('combobox', { name: t['groups.mode'], exact: true });
      for (const choice of ['mention', 'round-robin', 'natural']) {
        await mode.selectOption(choice); await form.getByText(t[`groups.modeHint.${choice}`], { exact: true }).waitFor();
      }
      check('group modes show matching readable descriptions'); await shot('group-mode');
      await form.getByRole('button', { name: t['groups.close'], exact: true }).click();

      phase = `${id}:bot-profile`;
      await page.setViewportSize({ width: 1360, height: 1000 }); await openBotsPanel(page, t['bots.title']);
      const panel = page.locator('[data-bots-page]:visible');
      await panel.getByRole('navigation', { name: t['navigation.sections'], exact: true }).getByRole('button', { name: t['navigation.myBots'], exact: true }).click();
      await selectBotDirectoryAction(panel, 'api-alpha', t['chat.profile']);
      const detail = panel.locator('[data-bot-detail="api-alpha"]');
      await detail.getByRole('tab', { name: t['detail.settings'], exact: true }).click();
      const profile = detail.locator('[data-bot-profile-editor]'); await profile.locator('form').waitFor();
      await page.setViewportSize({ width, height: 1000 });
      const description = profile.getByRole('textbox', { name: t['editor.description'], exact: true });
      const baseline = await description.inputValue(), reset = profile.getByRole('button', { name: t['editor.reset'], exact: true });
      check('profile opens directly in clean editor', await reset.isDisabled());
      await description.fill(`Unsaved profile ${id}`); check('editing enables reset', await reset.isEnabled());
      await shot('bot-profile'); await reset.click();
      check('reset restores original description', await description.inputValue() === baseline);
      const saved = `Release UI verified ${id}`; await description.fill(saved);
      await profile.getByRole('button', { name: t['editor.save'], exact: true }).click();
      await page.waitForFunction(({ text, label }) => { const p = document.querySelector('[data-bot-profile-editor]'); return p && [...p.querySelectorAll('textarea')].some(el => el.value === text) && [...p.querySelectorAll('button')].some(el => el.textContent.trim() === label && el.disabled); }, { text: saved, label: t['editor.reset'] });
      check('profile save keeps editor and establishes clean baseline');
      results.push({ ...item, status: 'PASS', checks, screenshots });
      await writeFile(resolve(dir, 'progress.json'), JSON.stringify(results, null, 2));
    } catch (error) {
      results.push({ ...item, status: 'FAIL', phase, checks, screenshots, error: redact(error) }); throw error;
    } finally { if (results.at(-1)?.status === 'PASS') { await context.close(); page = undefined; } }
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'PASS', artifactSha256, artifact, screenshotDir, installedBytesVerified: true, host: process.env.DSH_BOT_DSH_BIN, results, errors, realModelRequests: 0, loopbackRequests: host.requests(), navigationWidth: 1360 }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', dir, screenshotDir, cases: results.length, screenshots: results.flatMap(r => r.screenshots).length }));
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(screenshotDir, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(resolve(dir, 'failure-aria.txt'), redact(await page.locator('body').ariaSnapshot().catch(() => ''))); }
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'FAIL', artifactSha256, screenshotDir, phase, results, errors, error: redact(error), stack: redact(error.stack) }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', phase, error: redact(error), dir })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
