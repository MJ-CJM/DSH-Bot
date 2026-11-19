import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openArchive, sha256 } from '../adapters/bot-mode-desktop022/archive.mjs';
import { openBotsPanel, openSidebarSession } from './deepening/sidebar-session.mjs';
import { scratch } from './proactive/worker.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
const [seedArg, appArg, expectedSha, snapshotArg] = process.argv.slice(2);
assert.match(expectedSha, /^[a-f0-9]{64}$/);
const seed = await realpath(resolve(seedArg));
assert.ok(seed.startsWith(resolve('.dsh-dev') + '/'));
const seedProof = JSON.parse(await readFile(resolve(seed, 'result.json'), 'utf8'));
assert.equal(seedProof.status, 'PASS');
assert.equal(seedProof.artifactSha256, expectedSha);
const migration = JSON.parse(await readFile(resolve(seed, 'options.json'), 'utf8'));
const release = await readFile(migration.artifact);
assert.equal(sha256(release), expectedSha);
const dir = await scratch('native-bots-desktop');
console.log(dir);
const source = resolve(appArg);
const app = resolve(dir, 'DeepSeek Harness.app');
const asar = resolve(app, 'Contents/Resources/app.asar');
execFileSync('/usr/bin/ditto', [source, app]);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: ['ignore', 'ignore', 'pipe'] });
assert.equal(sha256(await readFile(asar)), migration.expectedAsar);
const archive = openArchive(await readFile(asar));
const root = resolve(dir, 'home');
const profile = resolve(root, 'profiles/desktop');
const installedRoot = resolve(profile, 'node_modules/dsh-botgroup');
const snapshot = await realpath(resolve(snapshotArg ?? resolve(seed, 'home/profiles/desktop')));
assert.ok(snapshot.startsWith(seed + '/'), 'Desktop seed must come from the isolated migration run');
await cp(snapshot, profile, { recursive: true, verbatimSymlinks: true });
const manifest = JSON.parse(await readFile(resolve(profile, 'package.json'), 'utf8'));
assert.ok(manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'));
assert.ok(!manifest.dsh.profile.bundles.includes('dsh-bot-web-app'));
const installedClient = await readFile(resolve(installedRoot, 'lib/client.js'));
const packedClient = execFileSync('/usr/bin/tar', ['-xOf', migration.artifact, 'package/lib/client.js'], { maxBuffer: 8 << 20 });
assert.deepEqual(installedClient, packedClient);

const fixture = resolve(dir, 'fixture.mjs');
await writeFile(fixture, `export { inject, apply } from ${JSON.stringify(resolve('scripts/bot-mode-approval-profile.mjs'))};\n`);
const patch = [
  '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(dir, 'storage'))}`,
  '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(dir, 'sessions'))}`,
  '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(dir, 'credentials.yml'))}`, '    watch: false',
  '- id: dsh-bot', '  config:', '    seedExamples: false', `    dataDir: ${JSON.stringify(resolve(dir, 'bots'))}`,
  '- id: agent-default-model', '  config:', '    provider: bot-mode-local', '    model: review',
  ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry',
    'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
  '- insert:', '    - id: native-desktop-fixture', `      name: ${JSON.stringify(fixture)}`, '      config:',
  '        suite: native-bots-workspace', `        outputDir: ${JSON.stringify(dir)}`, `        installedRoot: ${JSON.stringify(installedRoot)}`,
];
await writeFile(resolve(profile, 'cordis.patch.yml'), patch.join('\n') + '\n');
const home = resolve(dir, 'environment-home'), userData = resolve(dir, 'userData'), tmp = resolve(dir, 'tmp');
await Promise.all([home, userData, tmp].map(path => mkdir(path, { recursive: true })));
const env = { PATH: process.env.PATH, HOME: home, CFFIXED_USER_HOME: home, TMPDIR: tmp, USER: 'synthetic',
  DSH_HOME: root, DSH_AGENTS_HOME: resolve(dir, 'agents'), XDG_STATE_HOME: resolve(dir, 'state'),
  DSH_TELEMETRY_DISABLED: '1', DP_MOCK_PORT: '0', DP_NETWORK_RECEIPT: resolve(dir, 'network-denials.jsonl') };
const reservation = createServer();
await new Promise(accept => reservation.listen(0, '127.0.0.1', accept));
const port = reservation.address().port;
await new Promise(accept => reservation.close(accept));
const log = await open(resolve(dir, 'desktop.log'), 'w', 0o600);
const child = spawn(resolve(app, 'Contents/MacOS/DeepSeek Harness'), [
  `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
  '--disable-background-networking',
], { env, cwd: dir, stdio: ['ignore', log.fd, log.fd] });
await log.close();
const exited = new Promise(accept => { child.once('close', accept); child.once('error', accept); });
const read = name => readFile(resolve(dir, name + '.json'), 'utf8').then(JSON.parse);
const checks = [];
const check = (message, value) => { assert.ok(value, message); checks.push(message); };
let browser, page;
try {
  const deadline = Date.now() + 50000;
  let fixtureData;
  while (Date.now() < deadline && child.exitCode === null) {
    const failure = await read('fixture-error').catch(() => undefined);
    if (failure) throw new Error(failure.error);
    fixtureData = await read('fixture').catch(() => undefined);
    if (fixtureData) break;
    await delay(150);
  }
  check('official native Electron Host booted the isolated profile', fixtureData);
  const loaded = await read('client-provenance');
  for (const id of ['@deepseek-ai/dsh-client-shortcuts', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-workspace']) {
    const entry = loaded[id], path = entry.path.split('/app.asar/')[1];
    check(`${id} came from the original signed app`, Boolean(path) && sha256(archive.read(path)) === entry.sha256);
  }
  check('the Desktop Host served the frozen product Client', loaded['dsh-botgroup'].sha256 === sha256(packedClient));
  const { chromium } = createRequire(resolve('packages/dsh-bot/package.json'))('playwright-core');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 12000 });
  const context = browser.contexts()[0];
  const readyDeadline = Date.now() + 20000;
  while (Date.now() < readyDeadline) {
    const pages = context.pages();
    page = pages.find(candidate => candidate.url().includes('127.0.0.1')) ?? pages[0];
    for (const candidate of pages) {
      if (await candidate.getByRole('navigation').getByRole('button', { name: 'Bots', exact: true }).isVisible().catch(() => false)) {
        page = candidate;
        break;
      }
    }
    if (page && await page.getByRole('navigation').getByRole('button', { name: 'Bots', exact: true }).isVisible().catch(() => false)) break;
    await delay(200);
  }
  assert.ok(page);
  page.setDefaultTimeout(15000);
  const t = JSON.parse(await readFile(resolve(installedRoot, 'locale/en.json'), 'utf8')).ui;
  await installOverlayHandler(page, () => {});
  await dismissFirstRunOverlays(page, () => {}, 'native-desktop-smoke');
  await openBotsPanel(page, t['bots.title']);
  const id = 'local-assistant', session = fixtureData.sessions[id];
  await page.locator(`[data-directory-id="${id}"][data-directory-kind="bot"] [data-directory-open]`).click();
  const chat = page.locator(`[data-conversation-content][data-conversation-session="${session}"]:visible`);
  await chat.locator('[contenteditable="true"]:visible').first().waitFor();
  check('native Electron opens the original Bot main', await chat.isVisible());
  await openBotsPanel(page, t['bots.title']);
  await openSidebarSession(page, session);
  await chat.waitFor();
  check('native Electron history returns to the same session', await chat.isVisible());
  check('native Electron never mounts the private mode shell', await page.locator('[data-bot-mode-sidebar], [data-bot-mode-switch-button]').count() === 0);
  check('smoke opens no model turn', (await read('calls')).length === 0);
  await page.screenshot({ path: resolve(dir, 'native-electron.png') });
  await writeFile(resolve(dir, 'result.json'), JSON.stringify({ status: 'PASS', artifactSha256: expectedSha, checks, realModelRequests: 0 }, null, 2));
  console.log('NATIVE_BOTS_DESKTOP_PASS');
} catch (error) {
  if (page) await writeFile(resolve(dir, 'last-snapshot.txt'), await page.locator('body').ariaSnapshot()).catch(() => {});
  await writeFile(resolve(dir, 'result.json'), JSON.stringify({ status: 'FAIL', checks, error: String(error.stack) }, null, 2));
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([exited, delay(3500)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
