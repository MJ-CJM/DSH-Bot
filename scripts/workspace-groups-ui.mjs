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
const dir = resolve(root, '.dsh-dev/workspace-groups-ui', `${Date.now()}-${process.pid}`); await mkdir(dir, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const allMatrix = ['en', 'zh'].flatMap(language => ['light', 'dark'].flatMap(theme => [1360, 390].map(width => ({ language, theme, width }))));
// FILTER=en-light-1360,zh-dark-390 runs only explicitly named debug cases; default remains all eight.
const filter = process.env.FILTER?.trim();
const selectedIds = filter ? [...new Set(filter.split(',').map(value => value.trim()).filter(Boolean))] : undefined;
if (selectedIds) assert.ok(selectedIds.length && selectedIds.every(id => allMatrix.some(item => `${item.language}-${item.theme}-${item.width}` === id)), 'FILTER must be a comma-separated list of exact matrix IDs');
const matrix = selectedIds ? allMatrix.filter(item => selectedIds.includes(`${item.language}-${item.theme}-${item.width}`)) : allMatrix;
const coverage = { mode: selectedIds ? 'filtered-debug' : 'full', totalCases: allMatrix.length, selectedCases: matrix.length, selectedIds, hostBudgetMs: 300000 };

const results = [], pageErrors = []; let host, browser, phase = 'host';
let artifact;
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
try {
  artifact = { version: JSON.parse(await readFile(resolve(root, 'packages/dsh-bot/package.json'), 'utf8')).version,
    clientSha256: createHash('sha256').update(await readFile(resolve(root, 'packages/dsh-bot/lib/client.js'))).digest('hex') };
  host = await webHost(dir, 'workspace-groups-ui', artifactPath, resolve(root, 'packages/dsh-bot/tests/grok-ui-profile.mjs'));
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
  const matrixStartedAt = Date.now();
  for (const item of matrix) {
    const caseStartedAt = Date.now();
    const { language, theme, width } = item, id = `${language}-${theme}-${width}`;
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`), 'utf8')).ui;
    const context = await browser.newContext({ colorScheme: theme, locale: language === 'en' ? 'en-US' : 'zh-CN', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => pageErrors.push(redact(error)));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const checks = [], screenshots = [];
    const check = (name, value = true) => { assert.ok(value, `${id}: ${name}`); checks.push(name); };
    const shot = async state => {
      check(`${state}: no viewport overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const colors = await page.evaluate(() => {
        const probe = document.createElement('div'); probe.style.backgroundColor = 'var(--dsw-alias-bg-base)'; probe.style.color = 'var(--dsw-alias-label-primary)';
        document.body.append(probe); const style = getComputedStyle(probe), result = { background: style.backgroundColor, color: style.color }; probe.remove(); return result;
      });
      const rgb = colors.background.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      check(`${state}: actual theme tokens`, rgb?.length === 3 && (theme === 'dark' ? rgb.reduce((a,b) => a+b,0) < 384 : rgb.reduce((a,b) => a+b,0) > 384));
      const file = `${id}-${state}.png`; await page.screenshot({ path: resolve(dir, file), fullPage: true }); screenshots.push({ state, file, colors });
    };
    // Native sidebar navigation is exercised at desktop width, then actual composition is checked at the requested matrix width.
    const openNative = async sessionId => {
      await page.setViewportSize({ width: 1360, height: 1000 }); await openSidebarSession(page, sessionId);
      await page.locator(`[data-conversation-content][data-conversation-session="${sessionId}"]:visible`).waitFor();
      await page.setViewportSize({ width, height: 1000 });
    };
    const openManagement = async () => {
      await page.setViewportSize({ width: 1360, height: 1000 }); await openBotsPanel(page, t['bots.title']);
      const bots = page.locator('[data-bots-page]:visible'); await bots.getByRole('tab', { name: t['groups.title'], exact: true }).click(); return bots;
    };
    try {
      await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'workspace-groups-ui');
      await openNative(fixture.sessions[id]);
      check('ordinary Bot keeps native conversation and is not claimed by group composer', await page.locator('[data-workspace-group-composer]:visible').count() === 0);
      const bots = await openManagement();
      await bots.getByRole('button', { name: t['groups.create'], exact: true }).click();
      const form = bots.getByRole('form', { name: t['groups.create'], exact: true });
      const groupName = `Workspace ${id}`;
      await form.getByRole('textbox', { name: t['groups.name'], exact: true }).fill(groupName);
      check('new group defaults to natural', await form.locator('select').inputValue() === 'natural');
      const teammate = id === 'en-light-1360' ? 'zh-dark-390' : 'en-light-1360';
      await form.getByRole('checkbox', { name: new RegExp(id) }).check(); await form.getByRole('checkbox', { name: new RegExp(teammate) }).check();
      await form.getByRole('checkbox', { name: t['groups.historyConsent'], exact: true }).check();
      await form.getByRole('button', { name: t['integrations.save'], exact: true }).click();
      const groupComposer = page.locator('[data-workspace-group-composer]:visible'); await groupComposer.waitFor();
      const groupRoot = await groupComposer.getAttribute('data-workspace-group-composer'); check('creation opens native workspace root directly', /^group-root-/.test(groupRoot ?? ''));
      const native = page.locator(`[data-conversation-content][data-conversation-session="${groupRoot}"]:visible`); await native.waitFor();
      check('plugin management page no longer owns conversation surface', await page.locator('[data-bots-page]:visible').count() === 0);
      await page.locator(`[data-row-key="session:${groupRoot}"]`).filter({ hasText: groupName }).waitFor({ state: 'attached' });
      await openNative(fixture.sessions[id]); await openNative(groupRoot);
      check('empty group keeps its name and reopens from the native sidebar before any user message');
      await page.setViewportSize({ width, height: 1000 });
      let composer = groupComposer.getByRole('textbox', { name: t['groups.message'], exact: true });
      const question = `Workspace question ${id}`; await composer.fill(`**${question}**`);
      check('plain natural message is sendable', await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).isEnabled());
      await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).click();
      const botCards = native.locator('[data-workspace-group-message] [data-group-message]');
      await botCards.filter({ hasText: 'DP_LOOPBACK_OK' }).first().waitFor();
      // Assert the existing native row after admission; never navigate or issue a new query to repair its title.
      await page.setViewportSize({ width: 1360, height: 1000 });
      await page.locator(`[data-row-key="session:${groupRoot}"]`).filter({ hasText: groupName }).waitFor({ state: 'attached' });
      check('native sidebar session row retains group name after sending');
      await page.setViewportSize({ width, height: 1000 });
      const identities = await botCards.evaluateAll(cards => cards.map(card => card.getAttribute('data-group-message')));
      check('every Bot message has one exclusive native card', identities.length > 0 && new Set(identities).size === identities.length);
      for (const messageId of identities) check(`no duplicate renderer for ${messageId}`, await native.locator(`[data-group-message="${messageId}"]`).count() === 1);
      await page.waitForFunction(rootId => {
        const root = document.querySelector(`[data-conversation-content][data-conversation-session="${rootId}"]`);
        if (!root) return false;
        const cards = [...root.querySelectorAll('[data-workspace-group-message] [data-group-message]')].filter(card => card.textContent?.includes('DP_LOOPBACK_OK'));
        const leaves = [...root.querySelectorAll('*')].filter(el => el.textContent?.trim() === 'DP_LOOPBACK_OK' && ![...el.children].some(child => child.textContent?.trim() === 'DP_LOOPBACK_OK'));
        return cards.length > 0 && leaves.length === cards.length;
      }, groupRoot);
      check('native fallback does not render an extra copy of Bot response text');
      check('group composer has no second timeline', await groupComposer.locator('[role="log"]').count() === 0);
      await composer.scrollIntoViewIfNeeded(); await shot('native-group');

      await botCards.first().getByRole('button', { name: t['groups.reply'], exact: true }).click();
      await groupComposer.getByRole('button', { name: t['groups.clearReply'], exact: true }).waitFor();
      const draft = `Preserved group draft ${id}`; await composer.fill(draft);
      await openNative(fixture.sessions[id]);
      check('switching to ordinary Bot releases custom group composer', await page.locator('[data-workspace-group-composer]:visible').count() === 0);
      await openNative(groupRoot);
      composer = page.locator(`[data-workspace-group-composer="${groupRoot}"]:visible`).getByRole('textbox', { name: t['groups.message'], exact: true });
      check('draft survives native session switching', await composer.inputValue() === draft);
      check('reply target survives native session switching', await groupComposer.getByRole('button', { name: t['groups.clearReply'], exact: true }).isVisible());
      await shot('retained-draft');
      await groupComposer.getByRole('button', { name: t['groups.clearReply'], exact: true }).click();
      await openNative(fixture.sessions[id]); await openNative(groupRoot);
      composer = groupComposer.getByRole('textbox', { name: t['groups.message'], exact: true });
      check('explicitly cleared reply does not reappear after session switching', await groupComposer.getByRole('button', { name: t['groups.clearReply'], exact: true }).count() === 0);
      await composer.fill(`@${teammate} A directed follow-up ${id}`);
      check('confirmed group @ is accepted by composer', await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).isEnabled());
      const beforeMention = await botCards.count(); await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).click();
      await page.waitForFunction(({ root, before }) => document.querySelectorAll(`[data-conversation-content][data-conversation-session="${root}"] [data-workspace-group-message] [data-group-message]`).length > before, { root: groupRoot, before: beforeMention });
      await composer.fill('');
      await groupComposer.locator('input[type="file"]').setInputFiles({ name: `workspace-${id}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Synthetic workspace attachment ${id}`) });
      await groupComposer.getByText(t['groups.uploaded'], { exact: false }).waitFor();
      await openNative(fixture.sessions[id]); await openNative(groupRoot);
      composer = groupComposer.getByRole('textbox', { name: t['groups.message'], exact: true });
      await groupComposer.getByRole('list', { name: t['groups.attachments'], exact: true }).locator('li > span')
        .filter({ hasText: `workspace-${id}.txt` }).waitFor();
      await groupComposer.getByText(t['groups.uploaded'], { exact: false }).waitFor();
      check('accepted upload receipt survives switching away and back', await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).isEnabled());
      await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).click();
      await page.waitForFunction(({ rootId, name }) => {
        const root = document.querySelector(`[data-conversation-content][data-conversation-session="${rootId}"]`);
        return root && [...root.querySelectorAll('*')].some(el => el.textContent?.includes(name) &&
          !el.closest('[data-workspace-group-composer]') && !el.querySelector('[data-workspace-group-composer]'));
      }, { rootId: groupRoot, name: `workspace-${id}.txt` });
      check('pure attachment is admitted by real native upload receipt'); await shot('native-attachment');

      await page.setViewportSize({ width: 1360, height: 1000 });
      await page.getByRole('button', { name: `${t['groups.manage']} · ${groupName}`, exact: true }).click();
      const management = page.locator('[data-bots-page]:visible'); await management.waitFor();
      const groupArticle = management.getByRole('article', { name: groupName, exact: true }); await groupArticle.waitFor();
      check('plugin group page only manages and opens groups', await groupArticle.locator('textarea,[role="log"],[data-group-message]').count() === 0);
      await groupArticle.getByRole('button', { name: t['groups.open'], exact: true }).click();
      await page.locator(`[data-workspace-group-composer="${groupRoot}"]:visible`).waitFor();
      await openNative(fixture.sessions[id]); await openNative(groupRoot); check('native sidebar opens the registered group session');
      await shot('sidebar-reopened');

      // Create an unshared synthetic Bot just for deletion; never remove the shared matrix participants.
      await page.setViewportSize({ width: 1360, height: 1000 }); await openBotsPanel(page, t['bots.title']);
      const panel = page.locator('[data-bots-page]:visible'); await panel.getByRole('tab', { name: t['bots.title'], exact: true }).click();
      await panel.getByRole('button', { name: t['bots.create'], exact: true }).click();
      let dialog = panel.locator('dialog:visible'); const deleteId = `delete-${id}`;
      await dialog.getByRole('textbox', { name: `${t['editor.id']} ${t['editor.idHint']}`, exact: true }).fill(deleteId);
      await dialog.getByRole('textbox', { name: t['editor.name'], exact: true }).fill(`Synthetic ${deleteId}`);
      await dialog.getByRole('button', { name: t['editor.save'], exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      await panel.locator(`[role="option"][data-bot-id="${deleteId}"]`).click(); await page.setViewportSize({ width, height: 1000 });
      const detail = panel.locator(`[data-bot-detail="${deleteId}"]:visible`); await detail.waitFor();
      await detail.getByRole('button', { name: t['delete.title'], exact: true }).click();
      dialog = panel.locator('dialog:visible'); check('default deletion includes memory and retains private home', await dialog.getByRole('checkbox', { name: t['delete.memories'], exact: true }).isChecked() && !await dialog.getByRole('checkbox', { name: t['delete.home'], exact: true }).isChecked());
      await dialog.getByRole('button', { name: t['actions.cancel'], exact: true }).click(); check('cancelled Bot remains', await detail.isVisible());
      await detail.getByRole('button', { name: t['delete.title'], exact: true }).click(); dialog = panel.locator('dialog:visible'); await shot('delete-confirmation');
      await dialog.getByRole('button', { name: t['actions.delete'], exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      check('confirmed synthetic Bot removed', await panel.locator(`[role="option"][data-bot-id="${deleteId}"]`).count() === 0);
      results.push({ ...item, status: 'PASS', durationMs: Date.now() - caseStartedAt, checks, screenshots }); await writeFile(resolve(dir, 'progress.json'), JSON.stringify(results, null, 2));
    } catch (error) {
      const file = `${id}-failure.png`; await page.screenshot({ path: resolve(dir, file), fullPage: true }).catch(() => {});
      await writeFile(resolve(dir, `${id}-failure-aria.txt`), redact(await page.locator('body').ariaSnapshot()));
      results.push({ ...item, status: 'FAIL', durationMs: Date.now() - caseStartedAt, checks, screenshots, error: redact(error), failureScreenshot: file }); throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'PASS', results, pageErrors, realModelRequests: 0, loopbackRequests: host.requests(), isolatedHost: true, chromiumSandbox: true, artifact, coverage: { ...coverage, matrixElapsedMs: Date.now() - matrixStartedAt }, sidebarNavigationWidth: 1360 }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', dir, matrixMode: coverage.mode, cases: results.length, screenshots: results.flatMap(result => result.screenshots).length }));
} catch (error) {
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'FAIL', phase, coverage, results, pageErrors, error: redact(error), stack: redact(error.stack), realModelRequests: 0, artifact }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: redact(error) })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
