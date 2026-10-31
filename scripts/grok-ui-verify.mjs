import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { openSidebarSession, openBotsPanel } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const artifactPath = process.env.DSH_BOT_ARTIFACT ? resolve(root, process.env.DSH_BOT_ARTIFACT) : undefined;
const dir = resolve(root, '.dsh-dev/grok-ui', `${Date.now()}-${process.pid}`); await mkdir(dir, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const matrix = ['en', 'zh'].flatMap(language => ['light', 'dark'].flatMap(theme => [1360, 390].map(width => ({ language, theme, width }))));
const results = [], pageErrors = []; let host, browser, phase = 'host';
let artifact;
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
try {
  artifact = { version: JSON.parse(await readFile(resolve(root, 'packages/dsh-bot/package.json'), 'utf8')).version,
    clientSha256: createHash('sha256').update(await readFile(resolve(root, 'packages/dsh-bot/lib/client.js'))).digest('hex') };
  host = await webHost(dir, 'grok-ui', artifactPath, resolve(root, 'packages/dsh-bot/tests/grok-ui-profile.mjs'));
  if (artifactPath) {
    // webHost audits source→tarball→installed bytes before starting the Web profile.
    const manifest = JSON.parse(await readFile(resolve(dir, 'artifact-manifest.json'), 'utf8'));
    artifact = { ...artifact, tarball: manifest.artifact, tarballSha256: manifest.sha256,
      installedBytesVerified: true, packedClientSha256: manifest.files.find(file => file.file === 'lib/client.js')?.sha256 };
  }
  let fixture; const deadline = Date.now() + 60000;
  while (!fixture) {
    const failure = await readFile(resolve(dir, 'grok-fixture-error.json'), 'utf8').catch(() => '');
    assert.equal(failure, '', failure);
    fixture = await readFile(resolve(dir, 'grok-fixture.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    assert.ok(Date.now() < deadline, 'Grok fixture timeout'); if (!fixture) await delay(50);
  }
  phase = 'browser';
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright'), releases = await readdir(cache).catch(() => []);
  const candidates = releases.filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell')));
  const executablePath = process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync) ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env, timeout: 30000 }); }
  finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
  phase = 'matrix';
  for (const item of matrix) {
    const { language, theme, width } = item, id = `${language}-${theme}-${width}`;
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`), 'utf8')).ui;
    const context = await browser.newContext({ colorScheme: theme, locale: language === 'en' ? 'en-US' : 'zh-CN',
      viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => pageErrors.push(redact(error)));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const checks = [], screenshots = [];
    const check = (name, value = true) => { assert.ok(value, `${id}: ${name}`); checks.push(name); };
    const shot = async state => {
      check(`${state}: viewport does not overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const colors = await page.locator('[data-bots-page]').evaluate(el => ({
        background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color,
      }));
      const rgb = colors.background.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      check(`${state}: actual requested theme`, rgb?.length === 3 && (theme === 'dark' ? rgb.reduce((a,b) => a+b,0) < 384 : rgb.reduce((a,b) => a+b,0) > 384));
      const file = `${id}-${state}.png`; await page.screenshot({ path: resolve(dir, file), fullPage: true });
      screenshots.push({ state, file, colors });
    };
    try {
      await installOverlayHandler(page, () => {});
      await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'grok-ui');
      await openSidebarSession(page, fixture.sessions[id]);
      await openBotsPanel(page, t['bots.title']);
      const bots = page.locator('[data-bots-page]');
      await page.setViewportSize({ width, height: 1000 });
      await bots.getByRole('option').and(page.locator(`[data-bot-id="${id}"]`)).click();
      const detail = bots.locator(`[data-bot-detail="${id}"]:visible`); await detail.waitFor();
      const capability = detail.locator('details').filter({ has: page.locator('summary', { hasText: t['capabilities.title'] }) });
      check('capabilities collapsed by default', await capability.getAttribute('open') === null);
      const background = detail.getByRole('region', { name: t['background.title'], exact: true });
      await background.getByText('Synthetic background sample', { exact: false }).waitFor();
      check('native child catalog displayed', await background.getByRole('button', { name: t['background.open'], exact: true }).count() > 0);
      await background.scrollIntoViewIfNeeded(); await shot('background');
      await capability.locator('summary').click();
      await capability.getByRole('button', { name: t['capabilities.new'], exact: true }).click();
      const skillName = `ui-${id}`;
      await capability.getByRole('textbox', { name: t['capabilities.name'], exact: true }).fill(skillName);
      const content = `---\nname: ${skillName}\ndescription: Synthetic browser verification skill\n---\n\nUse only harmless fixture content.\n`;
      await capability.getByRole('textbox', { name: t['capabilities.content'], exact: true }).fill(content);
      await capability.getByRole('button', { name: t['capabilities.save'], exact: true }).click();
      await capability.getByText(t['capabilities.saved'], { exact: true }).waitFor();
      check('native skill file saved', await capability.getByRole('textbox', { name: t['capabilities.content'], exact: true }).inputValue() === content);
      await capability.getByRole('textbox', { name: t['capabilities.content'], exact: true }).scrollIntoViewIfNeeded(); await shot('skill-editor');
      await bots.getByRole('tab', { name: t['groups.title'], exact: true }).click();
      await bots.getByRole('button', { name: t['groups.create'], exact: true }).click();
      const form = bots.getByRole('form', { name: t['groups.create'], exact: true });
      const groupName = `UI ${id}`; await form.getByRole('textbox', { name: t['groups.name'], exact: true }).fill(groupName);
      const select = form.locator('select'); check('new group defaults to natural', await select.inputValue() === 'natural');
      check('legacy mode hidden in advanced settings', await select.evaluate(el => el.closest('details')?.open === false));
      const teammate = id === 'en-light-1360' ? 'zh-dark-390' : 'en-light-1360';
      await form.getByRole('checkbox', { name: new RegExp(id) }).check();
      await form.getByRole('checkbox', { name: new RegExp(teammate) }).check();
      await form.getByRole('checkbox', { name: t['groups.historyConsent'], exact: true }).check();
      await form.getByRole('button', { name: t['integrations.save'], exact: true }).click();
      const conversation = bots.getByRole('article', { name: groupName, exact: true }); await conversation.waitFor();
      const composer = conversation.getByRole('textbox', { name: t['groups.message'], exact: true });
      await composer.fill(`**Natural question ${id}**`);
      check('plain text without mentions can send', await conversation.getByRole('button', { name: t['groups.send'], exact: true }).isEnabled());
      await conversation.getByRole('button', { name: t['groups.send'], exact: true }).click();
      await conversation.locator('[data-group-message]').filter({ hasText: `Natural question ${id}` }).waitFor();
      check('real platform Markdown renderer formats the message', await conversation.locator('[role="log"] [data-group-message] strong')
        .filter({ hasText: `Natural question ${id}` }).count() > 0);
      await conversation.getByText('DP_LOOPBACK_OK', { exact: true }).first().waitFor();
      check('natural reply visible outside execution details', await conversation.locator('[role="log"] [data-group-message]').count() >= 2);
      check('execution details default collapsed', await conversation.locator('[data-group-turn] button[aria-expanded="true"]').count() === 0);
      await conversation.locator('[role="log"] [data-group-message]').last().getByRole('button', { name: t['groups.reply'], exact: true }).click();
      await composer.fill(`Follow-up draft ${id}`);
      check('quoted reply bar visible', await conversation.getByRole('button', { name: t['groups.clearReply'], exact: true }).isVisible());
      if (id === 'en-light-1360') {
        await conversation.getByRole('button', { name: t['groups.clearReply'], exact: true }).click();
        await composer.fill('');
        await conversation.locator('input[type="file"]').setInputFiles({ name: 'ui-attachment.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic upload bytes') });
        await conversation.getByText(new RegExp(t['groups.uploaded'])).waitFor();
        await conversation.getByRole('button', { name: t['groups.send'], exact: true }).click();
        await conversation.locator('[role="log"]').getByText('ui-attachment.txt', { exact: false }).first().waitFor();
        check('real browser upload receipt accepted and projected');
        await composer.fill('A later question while files remain visible');
      }
      await composer.scrollIntoViewIfNeeded(); await shot('group');
      if (id === 'en-light-1360') {
        await bots.getByRole('tab', { name: t['bots.title'], exact: true }).click();
        await bots.getByRole('option').and(page.locator(`[data-bot-id="${id}"]`)).click();
        const recovery = bots.locator(`[data-bot-detail="${id}"]:visible`).locator('details')
          .filter({ has: page.locator('summary', { hasText: t['capabilities.title'] }) });
        await recovery.locator('summary').click();
        const button = recovery.getByRole('button', { name: t['capabilities.freshConversation'], exact: true });
        await button.waitFor();
        await recovery.getByText(t['capabilities.flowRestricted'], { exact: true }).waitFor();
        check('legacy unknown/no-egress scope is diagnosed without silently clearing it');
        let confirmed = false;
        page.once('dialog', async dialog => {
          assert.equal(dialog.message(), t['capabilities.freshConfirm']); confirmed = true; await dialog.accept();
        });
        await button.click();
        const native = page.locator('[data-conversation-content]:visible'); await native.first().waitFor();
        const newMain = await native.first().getAttribute('data-conversation-session');
        check('explicit recovery confirmed and opened a different main conversation', confirmed && Boolean(newMain) && newMain !== fixture.sessions[id]);
        await page.setViewportSize({ width: 1360, height: 1000 });
        await openSidebarSession(page, fixture.sessions[id]);
        await page.locator(`[data-conversation-content][data-conversation-session="${fixture.sessions[id]}"]:visible`)
          .getByText('Synthetic initial turn', { exact: true }).waitFor();
        check('old native conversation and original history remain accessible after recovery');
      }
      results.push({ ...item, status: 'PASS', checks, screenshots });
      await writeFile(resolve(dir, 'progress.json'), JSON.stringify(results, null, 2));
    } catch (error) {
      const file = `${id}-failure.png`; await page.screenshot({ path: resolve(dir, file), fullPage: true }).catch(() => {});
      await writeFile(resolve(dir, `${id}-failure-aria.txt`), redact(await page.locator('body').ariaSnapshot()));
      results.push({ ...item, status: 'FAIL', checks, screenshots, error: redact(error), failureScreenshot: file });
      throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'PASS', results, pageErrors, realModelRequests: 0,
    loopbackRequests: host.requests(), isolatedHost: true, chromiumSandbox: true, artifact }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', dir, screenshots: results.flatMap(result => result.screenshots).length }));
} catch (error) {
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'FAIL', phase, results, pageErrors,
    error: redact(error), stack: redact(error.stack), realModelRequests: 0, artifact }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: redact(error) })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
