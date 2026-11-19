import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { webHost } from './deepening/b4-web-host.mjs';
import { openSidebarSession } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const artifact = process.env.DSH_BOT_E2E_PACKAGE; assert.ok(artifact, 'Use the exact new settings artifact');
process.env.DSH_BOT_DSH_BIN ??= resolve(root, '.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh');
const dir = resolve(root, '.dsh-dev/supergroup-settings-browser', `${Date.now()}-${process.pid}`); await mkdir(dir, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const checks = [], screenshots = [], errors = []; let host, browser, phase = 'host';
const read = async name => JSON.parse(await readFile(resolve(dir, `${name}.json`), 'utf8'));
const save = (name, value) => writeFile(resolve(dir, `${name}.json`), JSON.stringify(value, null, 2));
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); };
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
const start = preserveProfile => webHost(dir, 'supergroup-settings-browser', resolve(artifact),
  resolve(root, 'packages/dsh-bot/tests/supergroup-browser-profile.mjs'), [
    '- id: dsh-bot', '  config:', '    supergroup:', '      enabled: false',
    '      allowedBotIds: [sgui-alpha, sgui-beta, sgui-gamma]',
  ], { offline: false, preserveProfile });
const dictionaries = {};
for (const language of ['en', 'zh']) dictionaries[language] = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`), 'utf8'));
const open = async (language, theme) => {
  const context = await browser.newContext({ colorScheme: theme, locale: language === 'en' ? 'en-US' : 'zh-CN', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(redact(error)));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
  await dismissFirstRunOverlays(page, () => {}, 'supergroup-settings-browser');
  await page.getByRole('navigation').getByRole('button', { name: language === 'en' ? 'Plugins' : '插件', exact: true }).click();
  await page.getByText(dictionaries[language].meta.title, { exact: true }).last().click();
  await page.locator('[data-plugin-name]').filter({ hasText: 'dsh-bot' }).waitFor();
  const panel = page.locator('[data-supergroup-settings]');
  try { await panel.waitFor(); }
  catch (error) {
    await writeFile(resolve(dir, `plugin-${language}-last-snapshot.txt`), await page.locator('body').ariaSnapshot()).catch(() => {});
    await page.screenshot({ path: resolve(dir, `plugin-${language}-failure.png`) }).catch(() => {});
    throw error;
  }
  const toggle = panel.getByRole('switch', { name: dictionaries[language].ui['supergroup.settingsTitle'], exact: true });
  await toggle.waitFor(); await page.waitForFunction(() => document.querySelector('[data-supergroup-settings] [role="switch"]')?.disabled === false);
  return { context, page, panel, toggle };
};
try {
  host = await start(false);
  const fixture = await read('browser-fixture'), initialCalls = (await read('calls')).length;
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const executablePath = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync);
  assert.ok(executablePath, 'No cached Chromium; no install attempted');
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env, timeout: 30000 }); }
  finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
  phase = 'native-plugin-settings';
  const first = await open('zh', 'light');
  check('visible native bundle settings slot under exact dsh-bot detail', await first.toggle.getAttribute('aria-checked') === 'false');
  check('global and return-to-main instructions visible', (await first.panel.textContent()).includes(dictionaries.zh.ui['supergroup.settingsReturn']));
  const shot = async (page, name) => { await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true, animations: 'disabled' }); screenshots.push(`${name}.png`); };
  await shot(first.page, 'zh-off-native-details');
  await first.toggle.focus(); await first.toggle.press('Space');
  await first.page.waitForFunction(() => document.querySelector('[data-supergroup-settings] [role="switch"]')?.getAttribute('aria-checked') === 'true');
  check('keyboard Space enables and waits for saved true');
  check('switch save starts zero model requests', (await read('calls')).length === initialCalls);
  await shot(first.page, 'zh-enabled-native-details'); await first.context.close();
  phase = 'cold-restart';
  await host.stop(); await copyFile(resolve(dir, 'commands.json'), resolve(dir, 'commands-before-restart.json'));
  await copyFile(resolve(dir, 'host.log'), resolve(dir, 'host-before-restart.log'));
  host = await start(true);
  const resumed = await read('browser-fixture');
  check('all existing Bot main session IDs retained across cold Host restart', JSON.stringify(resumed.sessions) === JSON.stringify(fixture.sessions));
  check('cold restart starts zero model requests', (await read('calls')).length === 0);
  const second = await open('en', 'dark');
  check('enabled mode persists through complete Host restart', await second.toggle.getAttribute('aria-checked') === 'true');
  await shot(second.page, 'en-enabled-after-restart');
  await second.toggle.click();
  await second.page.waitForFunction(() => document.querySelector('[data-supergroup-settings] [role="switch"]')?.getAttribute('aria-checked') === 'false');
  check('click disables and confirms saved false');
  check('disable starts zero model requests', (await read('calls')).length === 0);
  await shot(second.page, 'en-disabled-native-details');
  const closedBots = second.page.locator('[data-row-key^="workspace:"][aria-expanded="false"]').filter({ hasText: 'Bots' });
  if (await closedBots.count()) await closedBots.first().click();
  await openSidebarSession(second.page, fixture.sessions['en-light-1360']);
  await second.page.locator(`[data-conversation-content][data-conversation-session="${fixture.sessions['en-light-1360']}"]:visible`).waitFor();
  check('user returns to exact retained Bot main conversation');
  await second.context.close();
  const audit = await read('artifact-manifest'); assert.deepEqual(errors, []);
  await save('result', { status: 'PASS', checks, screenshots, errors, artifact: audit.artifact, artifactSha256: audit.sha256,
    auditedFiles: audit.files.length, realModelRequests: 0, modelRequestsForSettings: 0, coldRestartModelRequests: 0, finalEnabled: false });
  console.log(JSON.stringify({ status: 'PASS', dir, checks: checks.length, artifactSha256: audit.sha256, screenshots }));
} catch (error) {
  await save('result', { status: 'FAIL', phase, error: redact(error.stack ?? error), checks, screenshots, errors });
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: redact(error) })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
