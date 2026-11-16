import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { buildBotModeAdapter } from '../../scripts/build-bot-mode-adapter.mjs';
import { buildBotModeChatAdapter } from '../../scripts/build-bot-mode-chat-adapter.mjs';
import { buildBotModeWorkspaceAdapter } from '../../scripts/build-bot-mode-workspace-adapter.mjs';
import { buildBotModeRendererAdapter } from '../../scripts/build-bot-mode-renderer-adapter.mjs';
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
const artifact = resolve(process.argv[2]); assert.ok(artifact.startsWith(`${root}/.dsh-dev/`));
const dir = resolve('.dsh-dev/bot-mode-renderer', `${Date.now()}-${process.pid}`); await mkdir(dir, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
const save = (name, value) => writeFile(resolve(dir, `${name}.json`), JSON.stringify(value, null, 2));
const runtime = resolve(dir, 'runtime'); execFileSync('/bin/cp', ['-cR', resolve('.dsh-dev/proactive-bot/host-runtime'), runtime]);
const require = createRequire(resolve(runtime, 'package.json')), cli = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const adapters = { shortcuts: await buildBotModeAdapter({ runtime, output: resolve(dir, 'shortcuts-package') }),
  chat: await buildBotModeChatAdapter({ output: resolve(dir, 'chat-package') }),
  workspace: await buildBotModeWorkspaceAdapter({ output: resolve(dir, 'workspace-package') }),
  renderer: await buildBotModeRendererAdapter({ output: resolve(dir, 'renderer-package') }) };
for (const [id, adapter] of [['@deepseek-ai/dsh-client-shortcuts', adapters.shortcuts], ['@deepseek-ai/dsh-client-ui-chat', adapters.chat], ['@deepseek-ai/dsh-client-ui-workspace', adapters.workspace]]) {
  const destination = dirname(cli.resolve(`${id}/package.json`)); assert.ok(destination.startsWith(`${runtime}/`));
  await cp(resolve(adapter.package, 'lib'), resolve(destination, 'lib'), { recursive: true });
  await cp(resolve(adapter.package, 'package.json'), resolve(destination, 'package.json'));
}
const layoutClient = resolve(dirname(cli.resolve('@deepseek-ai/dsh-client-ui-layout/package.json')), 'lib/client.js');
assert.ok(layoutClient.startsWith(`${runtime}/`));
const renderer = dirname(cli.resolve('@deepseek-ai/dsh-client-ui-renderer/package.json')); assert.ok(renderer.startsWith(`${runtime}/`));
const bin = resolve(runtime, 'renderer-probe-dsh');
await writeFile(bin, `#!/bin/sh\nset -eu\nbase=$(CDPATH= cd "$(dirname "$0")" && pwd)\nexec node "$base/${relative(runtime, resolve(dirname(cli.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js'))}" "$@"\n`); await chmod(bin, 0o755);
const env = { PATH: process.env.PATH, SHELL: process.env.SHELL, DSH_BOT_DSH_BIN: bin, DSH_HOME: resolve(dir, 'home'),
  HOME: resolve(dir, 'environment-home'), DSH_AGENTS_HOME: resolve(dir, 'agents'), TMPDIR: resolve(dir, 'tmp'),
  DSH_TELEMETRY_DISABLED: '1', pnpm_config_offline: 'true', pnpm_config_store_dir: resolve('.dsh-dev/pnpm-store'), pnpm_config_cache_dir: resolve('.dsh-dev/pnpm-cache') };
await mkdir(env.HOME, { recursive: true }); await mkdir(env.TMPDIR, { recursive: true });
const commands = []; let host;
async function command(args, label) {
  const child = spawn(resolve('scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((accept, reject) => { child.on('error', reject); child.on('close', accept); });
  await writeFile(resolve(dir, `${label}.log`), redact(output)); commands.push({ label, args, code }); assert.equal(code, 0, label);
}
await command(['--profile', 'renderer-recovery', '--from-default-profile', 'web', '--dump-config'], 'initialize');
await command(['plugin', '--profile', 'renderer-recovery', 'add', artifact], 'install');
const fixture = resolve(dir, 'fixture.mjs');
await writeFile(fixture, `export const inject=['loader','clientModules'];export function apply(ctx,config){ctx.effect(()=>{let stopped=false;const run=(async()=>{await ctx.loader.await();if(!stopped)console.log('RENDERER_READY')})();return async()=>{stopped=true;await run}})}`);
const patch = [
  '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(dir, 'storage'))}`,
  '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(dir, 'sessions'))}`,
  '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(dir, 'credentials.yml'))}`, '    watch: false',
  '- id: dsh-bot', '  config:', '    seedExamples: false', `    dataDir: ${JSON.stringify(resolve(dir, 'bots'))}`, '    supergroup:', '      enabled: false',
  ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
  '- insert:', '    - id: renderer-probe', `      name: ${JSON.stringify(fixture)}`,
];
await writeFile(resolve(env.DSH_HOME, 'profiles/renderer-recovery/cordis.patch.yml'), `${patch.join('\n')}\n`);
const reservation = createServer(); await new Promise(accept => reservation.listen(0, '127.0.0.1', accept));
const port = reservation.address().port; await new Promise(accept => reservation.close(accept));
let generation = 0;
async function startHost() {
  const args = ['--profile', 'renderer-recovery', '--no-open', '--host', '127.0.0.1', '--port', String(port)];
  const child = spawn(resolve('scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', code;
  const label = `host-${++generation}`;
  const done = new Promise((accept, reject) => { child.on('error', reject); child.on('close', value => { code = value; accept(value); }); });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  host = { child, done, save: async () => { await writeFile(resolve(dir, `${label}.log`), redact(output)); commands.push({ label, args, code }); } };
  for (let attempt = 0; attempt < 600; attempt++) {
    if (output.includes('RENDERER_READY')) { const url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1]; assert.ok(url); return url; }
    if (code !== undefined) throw Error(`Host exited ${code}: ${label}`); await delay(100);
  }
  throw Error(`Host startup timed out: ${label}`);
}
async function stopHost() {
  if (!host) return; const current = host; host = undefined; current.child.kill('SIGTERM');
  const result = await Promise.race([current.done, delay(10000).then(() => 'timeout')]);
  if (result === 'timeout') { current.child.kill('SIGKILL'); await current.done; }
  await current.save(); assert.notEqual(result, 'timeout');
}
const driverRequire = createRequire(resolve('packages/dsh-bot/package.json')), { chromium } = driverRequire('playwright-core');
const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
const executablePath = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
  .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync); assert.ok(executablePath);
let browser; const checks = [], evidence = [];
async function phase(label, adapted) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, locale: 'en-US' });
  await context.addInitScript(() => {
    const state = { waiting: 0, roots: 0, documents: 1 }; window.__rendererRecovery = state;
    const observed = new WeakSet();
    new MutationObserver(() => { for (const node of document.querySelectorAll('[data-slot-waiting="root"],[data-slot="root"]')) {
      if (observed.has(node)) continue; observed.add(node);
      if (node.hasAttribute('data-slot-waiting')) state.waiting++; else state.roots++;
    } }).observe(document, { subtree: true, childList: true });
  });
  const page = await context.newPage(), errors = [], responses = []; page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push(redact(error.stack ?? error)));
  page.on('response', response => { if (!response.url().includes('plugins/')) return; void response.text().then(body => {
    if (body.includes(adapters.renderer.marker)) responses.push({ sha256: sha(body), marker: true });
  }).catch(() => {}); });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const url = await startHost(); await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-slot="root"]').first().waitFor(); await delay(500);
  const before = await page.evaluate(() => ({ ...window.__rendererRecovery, navigation: performance.getEntriesByType('navigation').length }));
  await stopHost(); await delay(500);
  // A real module-graph revision change makes the unchanged root owner go through
  // native HMR teardown/reapply; only this independent runtime copy is touched.
  await writeFile(layoutClient, `${await readFile(layoutClient, 'utf8')}\n/* renderer-recovery probe graph generation ${generation} */\n`);
  const restartedUrl = await startHost();
  // Keep the same Document, route, and page. No goto/reload and no token replacement.
  await page.waitForFunction(() => window.__rendererRecovery.waiting > 0 && !!document.querySelector('[data-slot="root"]'), undefined, { timeout: 30000 }).catch(() => {});
  await delay(1000);
  const after = await page.evaluate(() => ({ ...window.__rendererRecovery, navigation: performance.getEntriesByType('navigation').length,
    rootPresent: !!document.querySelector('[data-slot="root"]'), waitingPresent: !!document.querySelector('[data-slot-waiting="root"]') }));
  const auth = await context.request.post(new URL('/api/dshBotSupergroup/settings', restartedUrl).href, { data: { type: 'client-request', rpcId: `renderer-${label}`, method: 'dshBotSupergroup/settings', payload: { args: {} } } });
  const result = { label, adapted, before, after, errors, responses, ownerSettingsStatus: auth.status(), tokenStable: new URL(url).searchParams.get('token') === new URL(restartedUrl).searchParams.get('token') };
  await save(label, result); evidence.push(result); await page.screenshot({ path: resolve(dir, `${label}.png`), fullPage: true });
  await stopHost(); await context.close(); return result;
}
try {
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env });
  const baseline = await phase('baseline', false);
  assert.ok(baseline.errors.some(error => error.includes("before any 'root' registration")), 'Original native failure was not reproduced');
  checks.push({ name: 'unadapted native old-page restart reproduces SlotAssemblyError', status: 'PASS' });
  await cp(resolve(adapters.renderer.package, 'lib'), resolve(renderer, 'lib'), { recursive: true });
  const adapted = await phase('adapted', true);
  assert.ok(adapted.after.waiting > 0 && adapted.after.rootPresent && !adapted.after.waitingPresent, 'Old page did not automatically recover from observed gap');
  assert.equal(adapted.after.navigation, adapted.before.navigation); assert.deepEqual(adapted.errors, []); assert.ok(adapted.responses.length > 0);
  checks.push({ name: 'adapted same Document waits then automatically restores real root with zero page errors and no reload', status: 'PASS' });
  await save('result', { status: 'PASS', dir, checks, evidence, adapters, productSha256: sha(await readFile(artifact)), realModelRequests: 0 });
  console.log(JSON.stringify({ status: 'PASS', dir, checks: checks.length }));
} catch (error) { await save('result', { status: 'FAIL', error: redact(error.stack ?? error), checks, evidence, adapters }); console.error(JSON.stringify({ status: 'FAIL', dir, error: redact(error) })); process.exitCode = 1; }
finally { await browser?.close(); await stopHost(); await save('commands', commands); }
