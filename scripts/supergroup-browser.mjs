import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { webHost } from './deepening/b4-web-host.mjs';
import { openSidebarSession } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const artifactPath = process.env.DSH_BOT_E2E_PACKAGE ? resolve(root, process.env.DSH_BOT_E2E_PACKAGE) : undefined;
process.env.DSH_BOT_DSH_BIN ??= resolve(root, '.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh');
const dir = resolve(root, '.dsh-dev/supergroup-browser', `${Date.now()}-${process.pid}`); await mkdir(dir, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const matrix = [{ language: 'en', theme: 'light', width: 1360 }, { language: 'en', theme: 'dark', width: 390 },
  { language: 'zh', theme: 'light', width: 390 }, { language: 'zh', theme: 'dark', width: 1360 }];
const results = [], errors = []; let host, browser, phase = 'version';
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
const save = (name, value) => writeFile(resolve(dir, `${name}.json`), JSON.stringify(value, null, 2));
const read = name => readFile(resolve(dir, `${name}.json`), 'utf8').then(JSON.parse).catch(() => undefined);
const wait = async (name, condition = value => value) => {
  const deadline = Date.now() + 45000;
  for (;;) {
    const failure = await read('browser-fixture-error'); assert.ok(!failure, JSON.stringify(failure));
    const value = await read(name); if (value && condition(value)) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${name}`); await delay(50);
  }
};
try {
  const version = execFileSync(resolve(root, 'scripts/dsh'), ['--version'], { cwd: root, env: process.env, encoding: 'utf8' }).trim();
  assert.equal(version, '0.2.1-rc.2');
  const manifest = { version: JSON.parse(await readFile(resolve(root, 'packages/dsh-bot/package.json'), 'utf8')).version,
    hostVersion: version, clientSha256: createHash('sha256').update(await readFile(resolve(root, 'packages/dsh-bot/lib/client.js'))).digest('hex'),
    hostSha256: createHash('sha256').update(await readFile(resolve(root, 'packages/dsh-bot/lib/index.js'))).digest('hex'),
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), artifactScope: artifactPath ? 'frozen tarball with installed byte audit' : 'built local source, not frozen tarball',
    ...(artifactPath ? { artifactPath, artifactSha256: createHash('sha256').update(await readFile(artifactPath)).digest('hex') } : {}), realModelRequests: 0 };
  await save('manifest', manifest);
  phase = 'host';
  host = await webHost(dir, 'supergroup-browser', artifactPath, resolve(root, 'packages/dsh-bot/tests/supergroup-browser-profile.mjs'), [
    '- id: dsh-bot', '  config:', '    supergroup:', '      enabled: true', '      maxRequests: 24',
    '      timeoutMs: 240000', '      allowedBotIds: [sgui-alpha, sgui-beta, sgui-gamma]',
  ], { offline: !artifactPath || process.env.DSH_BOT_INSTALL_OFFLINE === '1' });
  const fixture = await wait('browser-fixture');
  phase = 'browser';
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright'), releases = await readdir(cache).catch(() => []);
  const executablePath = process.env.DSH_BOT_CHROMIUM ?? releases.filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync);
  assert.ok(executablePath, 'No cached Chromium; no download attempted'); await access(executablePath);
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env, timeout: 30000 }); }
  finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
  for (const item of matrix) {
    const id = `${item.language}-${item.theme}-${item.width}`, checks = [], screenshots = []; phase = id;
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${item.language}.json`), 'utf8')).ui;
    const context = await browser.newContext({ colorScheme: item.theme, locale: item.language === 'en' ? 'en-US' : 'zh-CN',
      viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(redact(error)));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const check = (name, value = true) => { assert.ok(value, `${id}: ${name}`); checks.push(name); };
    const shot = async state => { const file = `${id}-${state}.png`; await page.screenshot({ path: resolve(dir, file), fullPage: true }); screenshots.push(file); };
    try {
      await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'supergroup-browser');
      await openSidebarSession(page, fixture.sessions[id]);
      const original = page.locator(`[data-conversation-content][data-conversation-session="${fixture.sessions[id]}"]:visible`); await original.waitFor();
      const composer = page.locator('[contenteditable="true"]:visible').first(); await composer.waitFor();
      await composer.fill(`SG_UI_CASE_${id}: compare this supplied proposal; identify migration risks.`); await composer.press('Enter');
      const card = original.locator('[data-supergroup-work]'); await card.waitFor();
      await card.locator(':scope > p').filter({ hasText: t['supergroup.members'].replace('{count}', '2') }).first().waitFor();
      const initial = await wait(`work-${id}`, value => value.group?.members.filter(row => row.enabled && !row.removedAt).length === 2);
      check('real original human input binds exact work', initial.work.originSessionId === fixture.sessions[id]);
      check('native input row and composer remain; group composer absent', await original.locator('[data-workspace-group-composer]').count() === 0);
      const disclosure = card.locator('button[aria-expanded]').first();
      check('work process defaults collapsed', await disclosure.getAttribute('aria-expanded') === 'false');
      await page.setViewportSize({ width: item.width, height: 1000 }); await shot('two-collapsed');
      await disclosure.click();
      await card.getByText(`SG_NATIVE_REASONING_${id}`, { exact: false }).first().waitFor();
      await card.getByText(t['execution.thinking'], { exact: true }).first().click();
      check('expanded process is native child reasoning'); await shot('two-expanded');
      await writeFile(resolve(dir, `release-expert-${id}.json`), '{}');
      const expanded = await wait(`work-${id}`, value => value.group?.members.filter(row => row.enabled && !row.removedAt).length === 3
        && value.group.deliveries.some(row => row.bot.botId === 'sgui-gamma' && row.state === 'running'));
      await card.locator(':scope > p').filter({ hasText: t['supergroup.members'].replace('{count}', '3') }).first().waitFor();
      await card.locator(':scope > p').first().scrollIntoViewIfNeeded(); await shot('three-summary');
      check('2 to 3 uses real existing expert and linked successor turn', expanded.work.turnIds.length === 2
        && expanded.group.deliveries.some(row => row.bot.botId === 'sgui-gamma' && row.childSessionId));
      const nativeCalls = await read('calls');
      check('group root model requests remain zero', !nativeCalls.some(row => row.sessionId === expanded.group.group.rootSessionId));
      check('all three members execute their distinct existing Bot presets', ['sgui-alpha', 'sgui-beta', 'sgui-gamma'].every(botId =>
        expanded.group.deliveries.some(delivery => delivery.bot.botId === botId && nativeCalls.some(call =>
          call.sessionId === delivery.childSessionId && call.preset === `bot-${botId}`))));
      await card.locator(`[data-group-turn="${expanded.work.turnIds.at(-1)}"]`).waitFor();
      const rows = card.locator('[data-group-turn] > button[aria-expanded="false"]');
      for (let count = await rows.count(); count > 0; count = await rows.count()) await rows.first().click();
      await card.getByText(`SG_EXPERT_REASONING_${id}`, { exact: false }).first().waitFor();
      await card.getByText(t['execution.thinking'], { exact: true }).last().click();
      check('one card for one work', await original.locator('[data-supergroup-work]').count() === 1);
      check('no forced navigation', await original.isVisible());
      check('actual theme preference', await page.evaluate(theme => matchMedia('(prefers-color-scheme: dark)').matches === (theme === 'dark'), item.theme));
      const colors = await page.evaluate(() => {
        const probe = document.createElement('div'); probe.style.backgroundColor = 'var(--dsw-alias-bg-base)'; document.body.append(probe);
        const background = getComputedStyle(probe).backgroundColor; probe.remove(); return background.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      });
      check('actual light/dark theme tokens', colors?.length === 3 && (item.theme === 'dark' ? colors.reduce((a,b) => a+b,0) < 384 : colors.reduce((a,b) => a+b,0) > 384));
      await shot('three-expanded');
      await card.getByRole('button', { name: t['supergroup.stop'], exact: true }).click();
      await wait(`work-${id}`, value => value.work.state === 'cancelled');
      await card.locator('[data-supergroup-state="cancelled"]').count();
      check('stop targets original work', (await read(`work-${id}`)).work.id === initial.work.id);
      const cancellation = await wait(`cancelled-${id}`); check('real active expert aborted', cancellation.aborted);
      const cleanup = await wait(`cleanup-${id}`); check('native child resources released', cleanup.activeNativeChildren === 0 && cleanup.workId === initial.work.id);
      check('original main conversation stays visible after stop', await original.isVisible());
      check('no viewport overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await shot('stopped'); results.push({ id, status: 'PASS', checks, screenshots }); await save('progress', results);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []); await save('result', { status: 'PASS', results, errors, realModelRequests: 0, hostRequests: host.requests() });
  console.log(JSON.stringify({ status: 'PASS', dir, cases: results.length, screenshots: results.flatMap(row => row.screenshots) }));
} catch (error) {
  await save('result', { status: 'FAIL', phase, error: redact(error.stack ?? error), results, errors, realModelRequests: 0 });
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: redact(error) })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
