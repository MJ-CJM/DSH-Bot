import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { webHost } from './deepening/b4-web-host.mjs';
import { openSidebarSession } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
// Read the literal rather than importing the Host fixture's network guard into the driver.
const clientProbeSource = (await readFile(resolve(root, 'packages/dsh-bot/tests/bot-mode-shell-profile.mjs'), 'utf8')).match(/export const clientProbeSource = String\.raw`([\s\S]*)`;\s*$/)?.[1];
assert.ok(clientProbeSource);
process.env.DSH_BOT_DSH_BIN ??= resolve(root, '.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh');
const dir = resolve(root, '.dsh-dev/bot-mode-shell', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
const results = [], errors = [];
const save = (name, value) => writeFile(resolve(dir, `${name}.json`), JSON.stringify(value, null, 2));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let browser, host, page;
async function files(base, prefix = '') {
  const out = [];
  for (const entry of await readdir(resolve(base, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await files(base, name));
    else out.push({ file: name, sha256: sha256(await readFile(resolve(base, name))) });
  }
  return out;
}
try {
  const version = execFileSync(resolve(root, 'scripts/dsh'), ['--version'], { env: process.env, encoding: 'utf8' }).trim();
  assert.equal(version, process.env.DSH_BOT_EXPECT_HOST_VERSION ?? '0.2.1-rc.2');
  const packageRoot = resolve(dir, 'probe/package'); await mkdir(packageRoot, { recursive: true });
  for (const name of ['package.json', 'lib', 'locale', 'cordis.patch.yml', 'icon.svg', 'assets', 'README.md', 'README.en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
    const source = resolve(root, 'packages/dsh-bot', name);
    if (existsSync(source)) await cp(source, resolve(packageRoot, name), { recursive: true });
  }
  const clientPath = resolve(packageRoot, 'lib/client.js'), client = await readFile(clientPath, 'utf8');
  assert.equal(client.split('return module.exports;').length, 2, 'Instrument only the public apply entry of the copied Client bundle');
  await writeFile(clientPath, client.replace('return module.exports;', clientProbeSource));
  const artifact = resolve(dir, 'shell-probe.tgz');
  execFileSync('/usr/bin/tar', ['-czf', artifact, '-C', resolve(dir, 'probe'), 'package']);
  const artifactAudit = { sha256: sha256(await readFile(artifact)), version: JSON.parse(await readFile(resolve(packageRoot, 'package.json'))).version,
    files: await files(packageRoot), scope: 'test-only instrumented copy; not a releasable product artifact' };
  await save('artifact-manifest', artifactAudit);
  host = await webHost(dir, 'bot-mode-shell', artifact, resolve(root, 'packages/dsh-bot/tests/bot-mode-shell-profile.mjs'), [
    '- id: dsh-bot', `  name: ${JSON.stringify(resolve(dir, 'home/profiles/b4-browser/node_modules/dsh-bot/lib/index.js'))}`,
  ], { offline: true, artifactAudit });
  const fixture = JSON.parse(await readFile(resolve(dir, 'fixture.json'), 'utf8'));
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const executablePath = process.env.DSH_BOT_CHROMIUM ?? (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync);
  assert.ok(executablePath, 'Cached Chromium required; no download');
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, locale: 'en-US' });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) errors.push(`${message.type()}: ${message.text()}`); });
  page.on('response', response => {
    if (/plugins|manifest/.test(response.url())) void response.text().then(async body => {
      if (body.includes('dsh-bot')) await save(`response-${sha256(response.url()).slice(0, 8)}`, { url: response.url(), instrumented: body.includes('bot-mode-shell-controls'), body: body.length < 80000 ? body : body.slice(body.indexOf('const original = module.exports;'), body.indexOf('const original = module.exports;') + 400) });
    }).catch(() => {});
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (!url.pathname.includes('plugins/') || !url.search.includes('dsh-bot/client.js')) return route.continue();
    const response = await route.fetch(), body = await response.text();
    if (body.includes('bot-mode-shell-controls')) return route.fulfill({ response });
    const start = body.indexOf('id: "dsh-bot", factory(require)'), end = body.indexOf('return module.exports;', start);
    assert.ok(start >= 0 && end > start, 'Test-only instrumentation must find the actual public Client factory');
    const instrumented = body.slice(0, end) + clientProbeSource + body.slice(end + 'return module.exports;'.length);
    await save('browser-client-instrumentation', { reason: 'Installed copy shadowed by runtime Client resolution; test instrumentation at the actual public apply entry', originalSha256: sha256(body), instrumentedSha256: sha256(instrumented) });
    return route.fulfill({ response, body: instrumented });
  });
  await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
  await dismissFirstRunOverlays(page, () => {}, 'bot-mode-shell');
  await openSidebarSession(page, fixture.sessionId);
  const main = page.locator(`[data-conversation-content][data-conversation-session="${fixture.sessionId}"]:visible`);
  await main.waitFor(); await main.getByText('BOT_MODE_SHELL_NATIVE_REPLY', { exact: false }).first().waitFor();
  const state = async () => JSON.parse(await page.locator('[data-shell-state]').textContent());
  const check = (name, value, evidence = {}) => { assert.ok(value, name); results.push({ name, status: 'PASS', ...evidence }); };
  await page.getByRole('button', { name: 'Install shell probe', exact: true }).click();
  await page.locator('[data-probe-sidebar]').waitFor();
  check('public sidebar replacement preserves native Conversation and composer', await main.isVisible() && await main.locator('[contenteditable="true"]').count() > 0);
  const installed = await state();
  check('same command id fails atomically', /Duplicate shortcut command: session.new/.test(installed.registrationErrors.sameId), { error: installed.registrationErrors.sameId });
  check('same default binding fails atomically', /Conflicting shortcut defaults/.test(installed.registrationErrors.sameBinding), { error: installed.registrationErrors.sameBinding });
  check('native Session commands remain in public catalog', installed.catalog.length === 4, { catalog: installed.catalog });
  const key = id => {
    const binding = installed.catalog.find(row => row.id === id).binding; assert.ok(binding);
    return [...binding.modifiers.map(value => ({ meta: 'Meta', control: 'Control', alt: 'Alt', shift: 'Shift' })[value]), binding.code.replace(/^Key/, '')].join('+');
  };
  await page.screenshot({ path: resolve(dir, '01-native-conversation-with-bot-sidebar.png'), fullPage: true });
  // No DOM input interception: real keyboard input enters shipped DSH arbitration.
  await main.locator('[contenteditable="true"]').first().click();
  await page.keyboard.press(key('session.new'));
  await main.waitFor({ state: 'hidden' });
  check('counterexample: native New escapes object navigation with replacement sidebar', !(await main.isVisible()), { binding: key('session.new'), after: await state() });
  await page.screenshot({ path: resolve(dir, '02-native-new-escaped-bot.png'), fullPage: true });
  await save('new-counterexample', { status: 'PASS', b00Gate: 'FAIL', fixture, results, instrumentation: 'Actual public Client apply instrumented in Browser response; native commands untouched' });
  await page.getByRole('button', { name: 'Restore shell probe', exact: true }).click();
  await page.locator('[data-probe-sidebar]').waitFor({ state: 'detached' });
  await openSidebarSession(page, fixture.sessionId); await main.waitFor();
  check('public disposers restore native sidebar and exact previous main conversation', await main.isVisible());
  await page.getByRole('button', { name: 'Install shell probe', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle probe modal', exact: true }).click();
  await page.getByRole('dialog', { name: 'Probe modal' }).waitFor();
  await page.keyboard.press(key('session.new'));
  check('real modal blocks Web New while dialog is present', await main.isVisible());
  await page.getByRole('button', { name: 'Toggle probe modal', exact: true }).click();
  await main.locator('[contenteditable="true"]').first().fill('DRAFT_MUST_STAY_WITH_BOT');
  await page.keyboard.press(key('session.fork'));
  await page.waitForFunction(source => {
    const node = document.querySelector('[data-shell-state]');
    return node && JSON.parse(node.textContent).sessions.ids.some(id => id !== source && !JSON.parse(node.textContent).sessions.byId[id]?.blank);
  }, fixture.sessionId, { timeout: 3000 }).catch(() => {});
  const forked = await state(), rejectedFork = errors.find(error => error.includes('session fork rejected:') && error.includes('background task has ended'));
  if (rejectedFork) results.push({ name: 'Fork executes original Host path and existing Bot guard rejects it', status: 'PASS', effect: 'No successful fork claimed', evidence: rejectedFork });
  else results.push({ name: 'Fork result', status: 'FAIL', reason: 'NOT_RUN: no completed fork mutation or classified rejection receipt', after: forked });
  await page.keyboard.press(key('session.archive'));
  await page.waitForFunction(id => JSON.parse(document.querySelector('[data-shell-state]').textContent).workspaces.archivedSessionIds.includes(id), fixture.sessionId);
  check('counterexample: native Archive archives bound Bot Session and clears selection', !(await main.isVisible()), { after: await state() });
  await page.screenshot({ path: resolve(dir, '03-native-archive-escaped-bot.png'), fullPage: true });
  await save('result', { status: 'PASS', b00Gate: 'FAIL', reason: 'Verified command escape counterexamples; complete Bot-mode takeover is not established.', version, results, errors,
    desktopBridge: { status: 'FAIL', reason: 'NOT_RUN: no isolated macOS desktop bridge supplied; Web is not desktop evidence' }, realModelRequests: 0 });
  console.log(JSON.stringify({ status: 'PASS', b00Gate: 'FAIL', dir, checks: results.length, errors }));
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(dir, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(resolve(dir, 'failure.html'), await page.content()).catch(() => {}); }
  await save('result', { status: 'FAIL', b00Gate: 'FAIL', error: String(error.stack ?? error), results, errors });
  console.error(JSON.stringify({ status: 'FAIL', dir, error: String(error) })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
