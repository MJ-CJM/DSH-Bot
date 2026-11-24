import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel } from './deepening/sidebar-session.mjs';
import { auditArtifact, sha256 } from './p34-artifact.mjs';
import { scratch } from './proactive/worker.mjs';

const [candidate, expectedSha] = process.argv.slice(2);
assert.match(expectedSha ?? '', /^[a-f0-9]{64}$/);
const artifact = resolve(candidate);
assert.equal(sha256(await readFile(artifact)), expectedSha);
const dir = await scratch('bots-collaboration-settings');
console.log(dir);
const version = execFileSync(resolve('scripts/dsh'), ['--version'], { encoding: 'utf8' }).trim();
const audit = await auditArtifact(process.cwd(), artifact, dir);
const fixture = resolve(dir, 'fixture.mjs');
const root = resolve(dir, 'home/profiles/b4-browser/node_modules/dsh-botgroup');
await writeFile(fixture, [
  `import { apply as mount } from ${JSON.stringify(resolve('scripts/bot-mode-approval-profile.mjs'))};`,
  `export { inject } from ${JSON.stringify(resolve('scripts/bot-mode-approval-profile.mjs'))};`,
  `export function apply(ctx, config) { return mount(ctx, { ...config, installedRoot: ${JSON.stringify(root)} }); }`,
].join('\n'));
const patch = ['- id: dsh-bot', '  config:', '    supergroup:', '      enabled: false'];
const boot = preserveProfile => webHost(dir, 'native-bots-workspace', artifact, fixture, patch,
  { artifactAudit: audit, preserveProfile, mockModel: false });
const read = name => readFile(resolve(dir, name + '.json'), 'utf8').then(JSON.parse);
const configFile = resolve(dir, 'home/profiles/b4-browser/cordis.patch.yml');
const { chromium } = createRequire(resolve('packages/dsh-bot/package.json'))('playwright-core');
const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
const executablePath = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
  .flatMap(name => ['arm64','x64'].map(arch => resolve(cache, name, 'chrome-headless-shell-mac-' + arch, 'chrome-headless-shell'))).find(existsSync);
assert.ok(executablePath);
const checks = [], errors = [], screenshots = [], appearance = [];
let host, browser, page, context, sessions;
const record = name => checks.push(name);
async function startScreen(language, theme, width) {
  const labels = JSON.parse(await readFile(resolve(root, 'locale', language + '.json'), 'utf8'));
  context = await browser.newContext({ colorScheme: theme, locale: language === 'zh' ? 'zh-CN' : 'en-US',
    viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.setDefaultTimeout(18000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await installOverlayHandler(page, () => {});
  await page.goto(host.url, { waitUntil: 'domcontentloaded' });
  await dismissFirstRunOverlays(page, () => {}, 'bots-collaboration-settings');
  await openBotsPanel(page, labels.ui['bots.title']);
  const appearanceNow = await page.locator('[data-bots-page]:visible').evaluate(el => {
    const box = el.getBoundingClientRect();
    return { dark: matchMedia('(prefers-color-scheme: dark)').matches, textColor: getComputedStyle(el).color,
      left: box.left, right: box.right, viewport: innerWidth };
  });
  const rgb = appearanceNow.textColor.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert.ok(rgb?.length === 3);
  assert.ok(theme === 'dark' ? Math.min(...rgb) > 120 : Math.max(...rgb) < 128);
  assert.equal(appearanceNow.dark, theme === 'dark');
  assert.ok(appearanceNow.left >= -1 && appearanceNow.right <= appearanceNow.viewport + 1);
  appearance.push({ language, theme, ...appearanceNow });
  return labels;
}
function inline(t) {
  const panel = page.locator('[data-bots-page]:visible');
  const button = panel.locator('button[data-supergroup-disclosure]');
  const settings = panel.locator('[data-supergroup-settings]');
  const toggle = settings.getByRole('switch', { name: t['supergroup.settingsTitle'], exact: true });
  return { panel, button, toggle, settings };
}
async function status(t, enabled, expanded) {
  const { panel, button, toggle, settings } = inline(t);
  const state = t[enabled ? 'supergroup.stateOn' : 'supergroup.stateOff'];
  assert.ok(state);
  await button.filter({ hasText: state }).waitFor();
  assert.ok((await button.innerText()).includes(t['supergroup.settingsTitle']));
  assert.equal(await button.getAttribute('aria-expanded'), String(expanded));
  assert.ok(await panel.locator('[data-bots-list="bots"]').isVisible());
  if (expanded) {
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), String(enabled));
    assert.ok(await toggle.isEnabled());
    const controlledId = await button.getAttribute('aria-controls');
    assert.ok(await settings.evaluate((el, id) => id && document.getElementById(id)?.contains(el), controlledId));
  } else {
    assert.ok(!(await settings.isVisible()));
  }
}
async function capture(name) {
  await page.screenshot({ path: resolve(dir, name + '.png'), animations: 'disabled' });
  screenshots.push(name + '.png');
}
async function closeHost() {
  assert.equal((await read('calls')).length, 0);
  assert.equal(host.requests(), 0);
  await context?.close();
  context = undefined;
  await host.stop();
  host = undefined;
}
async function verifyHost(expected) {
  const state = await read('fixture');
  assert.equal(state.supergroupEnabled, expected);
  if (sessions) assert.deepEqual(state.sessions, sessions);
  else sessions = state.sessions;
  assert.equal(Object.keys(sessions).length, 4);
  const source = await read('client-provenance');
  assert.equal(source['dsh-botgroup'].sha256, audit.files.find(row => row.file === 'lib/client.js').sha256);
}
try {
  host = await boot(false);
  await verifyHost(false);
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env });
  let labels = await startScreen('zh', 'light', 1280);
  let t = labels.ui;
  const before = await readFile(configFile);
  await status(t, false, false);
  await capture('zh-light-off');
  await inline(t).button.press('Enter');
  await status(t, false, true);
  await inline(t).button.click();
  await status(t, false, false);
  assert.deepEqual(await readFile(configFile), before);
  record('Initial off state, expand and collapse in Bots via keyboard and pointer, same persisted configuration');
  await inline(t).button.click();
  await status(t, false, true);
  await inline(t).toggle.press('Space');
  await status(t, true, true);
  assert.notDeepEqual(await readFile(configFile), before);
  await capture('zh-light-on-expanded');
  record('Enabling writes host configuration and updates both switch and Bots label');
  await page.getByRole('navigation').getByRole('button', { name: '插件', exact: true }).click();
  await page.getByText(labels.meta.title, { exact: true }).last().click();
  const native = page.locator('[data-supergroup-settings]:visible').getByRole('switch', { name: t['supergroup.settingsTitle'], exact: true });
  await native.and(page.locator('[aria-checked="true"]:enabled')).waitFor();
  record('Native plugin detail shows the same enabled preference');
  await native.click();
  await native.and(page.locator('[aria-checked="false"]:enabled')).waitFor();
  await openBotsPanel(page, t['bots.title']);
  const returned = inline(t);
  await returned.button.waitFor();
  const open = await returned.button.getAttribute('aria-expanded') === 'true';
  await status(t, false, open);
  if (!open) await returned.button.click();
  await status(t, false, true);
  await returned.toggle.click();
  await status(t, true, true);
  record('Bots re-reads the setting after a change in the plugin detail');
  await closeHost();

  host = await boot(true);
  await verifyHost(true);
  labels = await startScreen('en', 'dark', 900);
  t = labels.ui;
  await status(t, true, false);
  await inline(t).button.click();
  await status(t, true, true);
  await capture('en-dark-on-expanded');
  record('New Host and fresh browser context show persisted on after a cold restart');
  await inline(t).toggle.click();
  await status(t, false, true);
  await capture('en-dark-off-expanded');
  record('Disabling updates both switch and Bots label');
  await closeHost();

  host = await boot(true);
  await verifyHost(false);
  labels = await startScreen('zh', 'light', 1000);
  await status(labels.ui, false, false);
  record('A second cold restart preserves off and all four original Bot main sessions');
  await closeHost();
  record('All three boots and setting operations make zero model calls');
  assert.deepEqual(errors, []);
  await writeFile(resolve(dir, 'result.json'), JSON.stringify({ status: 'PASS', runtime: version, artifactSha256: expectedSha,
    filesVerified: audit.files.length, checks, screenshots, appearance, realModelRequests: 0 }, null, 2));
  console.log('BOTS_COLLABORATION_SETTINGS_PASS', version);
} catch (error) {
  await page?.screenshot({ path: resolve(dir, 'failure.png') }).catch(() => {});
  if (page && !page.isClosed()) await writeFile(resolve(dir, 'failure-ui.txt'), await page.locator('body').ariaSnapshot()).catch(() => {});
  await writeFile(resolve(dir, 'result.json'), JSON.stringify({ status: 'FAIL', runtime: version, checks, errors, error: String(error) }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await host?.stop();
}
