// Actual official CLI/Client regression, with profile-owned compatibility only.
// Every writable runtime path is under official-desktop-rc3/validation.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256, auditArtifact, auditInstalled } from './p34-artifact.mjs';
import { openArchive } from '../adapters/bot-mode-desktop022/archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = resolve(root, '.dsh-dev/official-desktop-rc3/validation');
const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (['--mock-only', '--keep-review', '--external-browser', '--host-only'].includes(flag)) { options[flag.slice(2)] = true; continue; }
  assert.ok(['--app', '--compat', '--artifact', '--suite', '--expected-artifact-sha', '--expected-compat-sha', '--offline-cache'].includes(flag) && args[index + 1], `Unknown/incomplete option ${flag}`);
  options[flag.slice(2)] = args[++index];
}
assert.equal(process.cwd(), root, 'Run from repository root');
assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
assert.ok(options['mock-only'], 'Explicit --mock-only required');
assert.ok(!(options['host-only'] && (options['external-browser'] || options['keep-review'])), 'Host-only validation cannot supply Browser evidence');
for (const key of ['app', 'compat', 'artifact']) assert.ok(options[key], `Missing --${key}`);
const app = resolve(options.app), compat = resolve(options.compat), artifact = resolve(options.artifact);
const productManifest = JSON.parse(execFileSync('/usr/bin/tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' }));
const packageName = productManifest.name;
assert.equal(packageName, 'dsh-botgroup', 'Use the current public package identity');
assert.ok(app.startsWith(`${root}/.dsh-dev/official-desktop-rc3/`), 'Use the isolated official candidate');
assert.ok(compat.startsWith(`${root}/.dsh-dev/`));
assert.ok(artifact.startsWith(`${root}/.dsh-dev/`));
const appArchive = resolve(app, 'Contents/Resources/app.asar');
const appSha256 = sha256(await readFile(appArchive));
let archive;
async function clientBytes(path) {
  if (!path.startsWith(`${appArchive}/`)) return readFile(path);
  archive ??= openArchive(await readFile(appArchive));
  return archive.read(path.slice(appArchive.length + 1));
}
const artifactSha256 = sha256(await readFile(artifact));
const expectedArtifactSha = options['expected-artifact-sha'] ?? 'fe1782c61892a79478d3b4fe210b6e44d701df642f2f068b1097dba707048a5e';
assert.match(expectedArtifactSha, /^[a-f0-9]{64}$/);
assert.equal(artifactSha256, expectedArtifactSha, 'Frozen product hash differs from the explicit reviewed input');
const out = resolve(base, `${Date.now()}-${process.pid}`);
await mkdir(out, { recursive: true, mode: 0o700 });
console.log(out);
let installCompat = compat;
let compatSha256;
const compatIsDirectory = (await stat(compat)).isDirectory();
if (compatIsDirectory) {
  // pnpm may materialize peers next to linked packages. Keep that reversible
  // write inside this run even when the input bundle is an unpacked directory.
  installCompat = resolve(out, 'compat-input');
  await cp(compat, installCompat, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
} else {
  const bytes = await readFile(compat); compatSha256 = sha256(bytes);
  installCompat = resolve(out, 'compat-input.tgz');
  await writeFile(installCompat, bytes);
}
const compatInput = compatIsDirectory
  ? JSON.parse(await readFile(resolve(installCompat, 'compatibility.json'), 'utf8'))
  : JSON.parse(execFileSync('/usr/bin/tar', ['-xOf', installCompat, 'package/compatibility.json'], { encoding: 'utf8' }));
const canonicalIds = compatInput.mode === 'web-app-replacement';
const compatPackageName = canonicalIds ? 'dsh-bot-web-app' : 'dsh-bot-native-compat';
if (canonicalIds) {
  const expectedCompatSha = options['expected-compat-sha'] ?? 'cda873f49f67125aec6f1c4ce95522d1f72accbb37e3eeff9bbd72f0b1c65524';
  assert.match(expectedCompatSha, /^[a-f0-9]{64}$/);
  assert.equal(compatSha256, expectedCompatSha, 'Frozen web-app hash differs from the explicit reviewed input');
}
assert.equal(compatInput.archiveSha256, appSha256, 'Compatibility was built for this exact official app');
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const yaml = require('js-yaml');
const suites = [
  { id: 'openmaus', suite: 'openmaus', fixture: 'packages/dsh-bot/tests/openmaus-profile.mjs', marker: 'OPENMAUS', result: 'openmaus-host.json', provider: 'openmaus-local', bots: [] },
  { id: 'openmaus-p0', suite: 'openmaus', fixture: 'packages/dsh-bot/tests/openmaus-profile.mjs', marker: 'OPENMAUS', result: 'openmaus-host.json', provider: 'openmaus-local', bots: [], extra: { phases: ['materialsResume'] } },
  { id: 'openmaus-followup', suite: 'openmaus', fixture: 'packages/dsh-bot/tests/openmaus-profile.mjs', marker: 'OPENMAUS', result: 'openmaus-host.json', provider: 'openmaus-local', bots: [], extra: { phases: ['followupMemory'] } },
  { id: 'direct', suite: 'collaboration', fixture: 'packages/dsh-bot/tests/supergroup-collaboration-profile.mjs', marker: 'B4_WEB', result: 'collaboration.json', provider: 'dp-loopback', bots: ['auto-owner', 'auto-reviewer', 'auto-expert'] },
  { id: 'first-turn', suite: 'first-turn', fixture: 'packages/dsh-bot/tests/bot-message-first-turn-profile.mjs', marker: 'B4_WEB', result: 'first-turn.json', provider: 'dp-loopback', bots: [] },
  { id: 'group', suite: 'runtime', fixture: 'packages/dsh-bot/tests/supergroup-runtime-profile.mjs', marker: 'SG_RUNTIME', result: 'result.json', provider: 'dp-b6b', bots: ['sg-alpha', 'sg-beta', 'sg-gamma'], extra: { phase: 'promotion' } },
  { id: 'group-input', suite: 'input', fixture: 'packages/dsh-bot/tests/bot-mode-supergroup-input-profile.mjs', marker: 'B03_INPUT', result: 'result.json', provider: 'dp-b6b', bots: ['b03-a', 'b03-b', 'b03-c'] },
  { id: 'messages', suite: 'review', fixture: 'packages/dsh-bot/tests/supergroup-collaboration-profile.mjs', marker: 'B4_WEB', result: 'review-ready.json', provider: 'dp-loopback', bots: ['auto-owner', 'auto-reviewer', 'auto-expert'] },
  { id: 'review', suite: 'review', fixture: 'scripts/bot-mode-approval-profile.mjs', marker: 'BOT_MODE_APPROVAL', result: 'fixture.json', provider: 'bot-mode-local', bots: ['local-assistant', 'local-research', 'local-review', 'local-tech'] },
].filter(suite => !options.suite || options.suite === 'all' || options.suite.split(',').includes(suite.id));
assert.ok(suites.length, 'Unknown --suite');
const results = [], active = new Set();
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
async function waitFor(test, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await test()) return; }
    catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error; }
    assert.ok(Date.now() < deadline, 'Validation deadline'); await delay(50);
  }
}
// Seed private offline caches using copy-on-write. Shared caches remain read-only.
const cacheRoot = options['offline-cache'] ? resolve(options['offline-cache']) : resolve(out, 'offline-cache');
assert.ok(cacheRoot.startsWith(`${root}/.dsh-dev/`), 'Only repository-local offline caches are allowed');
if (options['offline-cache']) assert.equal(await realpath(cacheRoot), cacheRoot, 'Offline cache must be canonical');
else {
  await mkdir(cacheRoot);
  for (const name of ['pnpm-store', 'pnpm-cache'])
    await cp(resolve(root, '.dsh-dev', name), resolve(cacheRoot, name), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
}

async function hostFor(suite) {
  const dir = resolve(out, suite.id), profile = 'official-compat';
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const env = { PATH: process.env.PATH, SHELL: process.env.SHELL, USER: 'synthetic',
    HOME: resolve(dir, 'environment-home'), DSH_HOME: resolve(dir, 'home'),
    DSH_BOT_DSH_BIN: resolve(app, 'Contents/Resources/runtime/cli/bin/dsh'),
    DSH_AGENTS_HOME: resolve(dir, 'agents'), XDG_STATE_HOME: resolve(dir, 'state'),
    XDG_DATA_HOME: resolve(dir, 'data'), XDG_CONFIG_HOME: resolve(dir, 'config'),
    XDG_CACHE_HOME: resolve(dir, 'cache'), NODE_COMPILE_CACHE: resolve(dir, 'node-cache'),
    TMPDIR: resolve(dir, 'tmp'), DSH_TELEMETRY_DISABLED: '1', DP_MOCK_PORT: '0',
    DP_NETWORK_RECEIPT: resolve(dir, 'network-denials.jsonl'),
    pnpm_config_store_dir: resolve(cacheRoot, 'pnpm-store'),
    pnpm_config_cache_dir: resolve(cacheRoot, 'pnpm-cache'), pnpm_config_offline: 'true' };
  for (const key of ['HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) await mkdir(env[key], { recursive: true });
  const commands = [];
  async function command(args, label, live = false) {
    const started = Date.now(), child = spawn(resolve(root, 'scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', closed = false;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes; });
    const done = new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => { closed = true; accept({ code, signal }); }); });
    const timer = setTimeout(() => child.kill('SIGKILL'), live ? 1200000 : 120000);
    const save = async () => {
      const result = await done; clearTimeout(timer);
      await writeFile(resolve(dir, `${label}.log`), redact(output));
      commands.push({ args, label, ...result, durationMs: Date.now() - started });
      await writeFile(resolve(dir, 'commands.json'), JSON.stringify(commands, null, 2));
      return result;
    };
    if (!live) { assert.equal((await save()).code, 0, `See ${dir}/${label}.log`); return output; }
    const handle = { child, done, async stop() {
      if (!closed) child.kill('SIGTERM');
      await Promise.race([done, delay(5000)]); if (!closed) child.kill('SIGKILL');
      await save(); active.delete(handle);
    } };
    active.add(handle);
    try {
      await waitFor(() => closed || new RegExp(`${suite.marker}_(READY|DONE|FAILED)`).test(output));
      assert.match(output, new RegExp(`${suite.marker}_(READY|DONE)`), `Native fixture failed: ${dir}`);
      const url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1];
      assert.ok(url, 'Official Host did not expose its loopback URL');
      return { ...handle, dir, url, env };
    } catch (error) { await handle.stop(); throw error; }
  }
  const versionLines = (await command(['--version'], 'version')).trim().split(/\r?\n/).filter(line => /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(line));
  assert.deepEqual(versionLines, ['0.2.2-rc.3'], 'Exact official CLI version required (native stderr diagnostics stay in the private log)');
  await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await command(['plugin', '--profile', profile, 'add', artifact], 'install-product');
  await command(['plugin', '--profile', profile, 'add', installCompat], 'install-compat');
  let bundles;
  if (canonicalIds) {
    const filename = resolve(env.DSH_HOME, 'profiles', profile, 'package.json');
    const manifest = await json(filename);
    bundles = ['@deepseek-ai/dsh-base', compatPackageName, packageName];
    assert.ok(bundles.every(name => manifest.dsh.profile.bundles.includes(name)));
    manifest.dsh.profile.bundles = bundles;
    await writeFile(filename, JSON.stringify(manifest, null, 2) + '\n');
  }
  const installed = resolve(env.DSH_HOME, 'profiles', profile, 'node_modules', packageName);
  const compatInstalled = await realpath(resolve(env.DSH_HOME, 'profiles', profile, 'node_modules', compatPackageName));
  const audit = await auditArtifact(root, artifact, dir);
  await auditInstalled(env.DSH_HOME, profile, audit);
  const compatReceipt = await json(resolve(compatInstalled, 'compatibility.json'));
  assert.equal(compatReceipt.version, '0.2.2-rc.3');
  for (const row of [...compatReceipt.inventory, ...(compatReceipt.officialInventory ?? [])]) assert.equal(sha256(await readFile(resolve(compatInstalled, row.path))), row.sha256, `Installed compatibility mismatch: ${row.path}`);
  await writeFile(resolve(dir, 'installed-compatibility.json'), JSON.stringify({ status: 'PASS', packageName: compatPackageName, mode: compatReceipt.mode, compatSha256,
    bundles, nativeFiles: compatReceipt.inventory.length, officialFiles: compatReceipt.officialInventory?.length ?? 0 }, null, 2));
  // A public Host observer is kept separate from the product and fixtures.
  const provenanceSource = resolve(dir, 'provenance.mjs');
  await writeFile(provenanceSource, `import assert from 'node:assert/strict';\nimport {writeFile} from 'node:fs/promises';\nimport { apply as probe } from ${JSON.stringify(resolve(root, 'adapters/bot-mode-profile-compat/probe.mjs'))};\nexport const inject=['clientModules'];\nexport function apply(ctx) {\nprobe(ctx,${JSON.stringify({ output: dir, package: compatInstalled, canonicalIds })});\nctx.effect(()=>{let stopped=false;const task=(async()=>{await ctx.loader.await(); if(stopped)return; const counts=Object.fromEntries(['shortcuts','ui-chat','ui-workspace'].map(id=>[id,[...ctx.loader.entries()].filter(row=>row.options.id===id).length])); ${canonicalIds ? "for(const count of Object.values(counts))assert.equal(count,1,'Canonical root Loader ids must be unique');" : ''} await writeFile(${JSON.stringify(resolve(dir, 'loader-identity.json'))},JSON.stringify({status:'PASS',counts},null,2));})();void task.catch(error=>console.error('OFFICIAL_LOADER_IDENTITY_FAILED',error));return async()=>{stopped=true;await task;};});\n}\n`);
  let fixturePath = resolve(root, suite.fixture);
  if (suite.id.startsWith('openmaus')) {
    // A test entry inside packages/dsh-bot inherits that manifest's client.
    // Keep Loader ownership outside the product so the installed Client wins.
    const entry = resolve(dir, 'openmaus-fixture-entry.mjs');
    await writeFile(entry, `export { inject, apply } from ${JSON.stringify(fixturePath)};\n`);
    fixturePath = entry;
  }
  if (suite.id === 'review') {
    // Keep synthetic fixtures independent of native context notices added since
    // the original visual harness. This is test-only adapter selection logic.
    const source = (await readFile(fixturePath, 'utf8'))
      .replace("import './deepening/network-guard.mjs';", `import ${JSON.stringify(resolve(root, 'scripts/deepening/network-guard.mjs'))};`)
      .replace("createRequire(new URL('../packages/dsh-bot/package.json', import.meta.url))", `createRequire(${JSON.stringify(resolve(root, 'packages/dsh-bot/package.json'))})`)
      .replace("['runtime-context', 'agent-instructions', 'time-context', 'tmux-context']", "['runtime-context', 'agent-instructions', 'time-context', 'tmux-context', 'skill-catalog', 'user-approval', 'model-selection']");
    fixturePath = resolve(dir, 'browser-fixture.mjs');
    await writeFile(fixturePath, source);
  }
  const chatConfig = { transcriptView: 'standard', collapseTiming: 'next-input', foldedReplies: 'final', performanceUsage: 'detailed', linkOpening: 'new-tab' };
  const legacyChat = { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat', config: chatConfig };
  const patch = [
    ...(canonicalIds ? [yaml.dump([legacyChat], { lineWidth: -1 }).trimEnd(), '- id: ui-chat', `  config: ${JSON.stringify(chatConfig)}`] : []),
    '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(dir, 'storage'))}`,
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(dir, 'sessions'))}`,
    '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(dir, 'synthetic-credentials.yml'))}`, '    watch: false',
    '- id: dsh-bot', '  config:', ...yaml.dump({ seedExamples: false, dataDir: resolve(dir, 'bots'), messagingEnabled: true,
      messagePairRequests: 30, messagePairTotal: 60, proactiveEnabled: suite.id.startsWith('openmaus'), proactiveExecutionEnabled: false,
      ...(suite.id.startsWith('openmaus') ? { proactiveNodeExecutable: process.execPath, proactiveMaintenanceIntervalMs: 250,
        proactiveCiFeed: { scope: { repository: 'openmaus/fixture', branch: 'main', generation: 14 },
          github: { credentialRef: 'OPENMAUS_CI_READONLY', since: '2026-11-01T00:00:00.000Z', maxRuns: 32, timeoutMs: 1000 }, intervalMs: 3600000 } } : {}),
      supergroup: { enabled: suite.id !== 'first-turn', maxRequests: 36, timeoutMs: suite.id.startsWith('openmaus') ? 900000 : 120000, allowedBotIds: suite.bots } }, { lineWidth: -1 }).trimEnd().split('\n').map(line => `    ${line}`),
    '- id: agent-default-model', '  config:', `    provider: ${suite.provider}`, `    model: ${suite.id === 'review' ? 'review' : 'fixture'}`,
    ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
    '- insert:', '    - id: official-provenance', `      name: ${JSON.stringify(provenanceSource)}`,
    '    - id: official-fixture', `      name: ${JSON.stringify(fixturePath)}`,
    `      config: ${JSON.stringify({ outputDir: dir, suite: suite.suite, installedRoot: installed, productPackageName: packageName, ...(suite.extra ?? {}) })}`,
  ].join('\n') + '\n';
  await writeFile(resolve(env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), patch);
  await command(['--profile', profile, '--dump-config'], 'effective-config');
  const host = await command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'host', true);
  await waitFor(() => existsSync(resolve(dir, 'host-provenance.json')));
  const provenance = await json(resolve(dir, 'host-provenance.json')); assert.equal(provenance.status, 'PASS');
  await waitFor(() => existsSync(resolve(dir, 'loader-identity.json')));
  assert.equal((await json(resolve(dir, 'loader-identity.json'))).status, 'PASS');
  if (canonicalIds) {
    assert.deepEqual(provenance.settingsRoundtrip, { namespace: 'ui-chat', before: 'detailed', changed: 'compact', restored: 'detailed' });
    assert.deepEqual(provenance.settingsForms.find(row => row.ns === 'ui-chat').value, chatConfig);
    const persisted = yaml.load(await readFile(resolve(env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), 'utf8'));
    assert.deepEqual(persisted.find(row => row.id === 'ui-chat' && row.name === legacyChat.name), legacyChat, 'Old name-qualified Chat override is unchanged');
    assert.deepEqual(persisted.find(row => row.id === 'ui-chat' && !row.name).config, chatConfig, 'Settings restoration keeps the complete migrated config');
    await writeFile(resolve(dir, 'settings-migration.json'), JSON.stringify({ status: 'PASS', bundles, uniqueRootIds: true, oldNameQualifiedOverrideRetained: true,
      completeMigratedConfig: chatConfig, actualNativeSettingsRoundtrip: provenance.settingsRoundtrip }, null, 2));
  }
  return host;
}

async function browserRegression(host) {
  const { chromium } = require('playwright-core');
  const { dismissFirstRunOverlays, installOverlayHandler } = await import('../packages/dsh-bot/scripts/screenshot-support.ts');
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const executablePath = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync);
  assert.ok(executablePath, 'A preinstalled Chromium is required');
  const checks = [], errors = [];
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  let browser;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env }); }
  finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
  let currentPage;
  const check = (name, value = true) => { assert.ok(value, name); checks.push(name); };
  try {
    for (const [theme, language] of [['light', 'zh'], ['dark', 'en']]) {
      const context = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', colorScheme: theme, viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
      const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(30000);
      page.on('pageerror', error => errors.push(redact(error.stack ?? error)));
      const bodies = [];
      page.on('response', response => { if (new URL(response.url()).pathname === '/plugins/' && /javascript/.test(response.headers()['content-type'] ?? '')) void response.text().then(text => bodies.push(text)).catch(() => {}); });
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await installOverlayHandler(page, () => {});
      await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'official-rc3');
      const sidebar = page.locator('[data-bot-mode-sidebar]'), nav = sidebar.getByRole('navigation');
      if (host.messagesReview) {
        // Native workspace restoration completes after the sidebar mounts.
        // Wait for its initial conversation before issuing user navigation.
        await page.locator('[data-bot-mode-object="bot"] [contenteditable="true"]:visible').first().waitFor();
        const ready = await json(resolve(host.dir, 'review-ready.json'));
        for (const [role, label] of [['sender', ready.sender.name], ['recipient', ready.recipient.name]]) {
          await nav.getByRole('button', { name: new RegExp(`^${label}`) }).first().click();
          const chat = page.locator('[data-bot-mode-object="bot"]'); await chat.waitFor();
          const exchange = ready.exchanges[0];
          for (const [messageId, body, direction] of [
            [exchange.requestMessageId, ready.actualQuestion, role === 'sender' ? 'sent' : 'received'],
            [exchange.replyMessageId, 'SG_AUTO_CHECKED_RESULT:reviewer', role === 'sender' ? 'received' : 'sent'],
          ]) {
            const card = chat.locator(`[data-bot-message="${messageId}"]`); await card.waitFor();
            const toggle = card.locator('button[aria-expanded]');
            if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
            await card.getByText(body, { exact: false }).last().waitFor();
            check(`${theme}: ${role} ${direction} card retains the actual message identity`, await card.getAttribute('data-message-direction') === direction);
          }
          check(`${theme}: ${role} main chat displays the actual question and linked answer`);
          await page.screenshot({ path: resolve(host.dir, `browser-${theme}-${role}-messages.png`), fullPage: true });
        }
        check(`${theme}: neither main chat loses the concrete question`, ready.exchanges.every(row => row.visibleMainRecords === 4));
        await context.close(); continue;
      }
      await nav.getByRole('button', { name: /^通用助手/ }).first().click();
      const chat = page.locator('[data-bot-mode-object="bot"]'); await chat.waitFor();
      const composer = chat.locator('[contenteditable="true"]:visible').first(); await composer.waitFor();
      check(`${theme}: original Bot native composer visible`, await composer.isVisible());
      const provenance = await json(resolve(host.dir, 'client-provenance.json'));
      for (const [id, resource] of Object.entries(provenance)) {
        const bytes = await clientBytes(resource.path); assert.equal(sha256(bytes), resource.sha256);
        const expected = bytes.toString().trimEnd().replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*$/u, '').trimEnd();
        await waitFor(() => bodies.some(body => body.includes(expected)), 20000);
        check(`${theme}: actual HTTP Client bytes match ${id}`);
      }
      await page.screenshot({ path: resolve(host.dir, `browser-${theme}-bot.png`), fullPage: true });
      if (theme === 'light') {
        await page.keyboard.press('Meta+Alt+N'); await page.getByRole('dialog').waitFor();
        check('native New routes to Bot creation');
        await page.getByRole('dialog').getByRole('button', { name: /^(取消|Cancel)$/ }).click();
        await nav.getByRole('button', { name: /^通用助手/ }).first().click(); await composer.waitFor();
        await composer.fill('独立 rc3 草稿');
        await nav.getByRole('button', { name: /^研究员/ }).first().click();
        await waitFor(async () => await chat.locator('[data-bot-mode-title]').textContent() === '研究员');
        check('other Bot has an independent draft', !((await page.locator('[contenteditable="true"]:visible').first().textContent()) ?? '').includes('独立 rc3 草稿'));
        await nav.getByRole('button', { name: /^通用助手/ }).first().click();
        await waitFor(async () => ((await composer.textContent()) ?? '').includes('独立 rc3 草稿'));
        check('original Bot draft is restored'); await composer.fill('你好'); await composer.press('Enter');
        await page.getByText('你好，这是独立的 Bot 模式审批服务。', { exact: false }).last().waitFor();
        check('actual native main chat sends and receives a synthetic reply');
        await composer.fill('方案验收：比较这份迁移项目的成本、风险与验收步骤。'); await composer.press('Enter');
        await waitFor(async () => (await json(resolve(host.dir, 'work-state.json'))).some(row => ['completed', 'partial'].includes(row.work.state)), 90000);
        const work = (await json(resolve(host.dir, 'work-state.json'))).find(row => ['completed', 'partial'].includes(row.work.state));
        check('automatic group invites an expert and returns to original Bot', work.group.members.filter(row => row.enabled && row.removedAt === undefined).length >= 3 && await chat.isVisible());
        await page.getByText('【本地演示】本次协作已完成。', { exact: false }).last().waitFor();
        await page.screenshot({ path: resolve(host.dir, 'browser-original-delivery.png'), fullPage: true });
        await composer.fill('继续细化同一份迁移建议。'); await composer.press('Enter');
        await waitFor(async () => (await json(resolve(host.dir, 'work-state.json'))).some(row => row.work.id === work.work.id && row.work.inputMessageIds.length > work.work.inputMessageIds.length && ['completed', 'partial'].includes(row.work.state)), 90000);
        check('original Bot continues the same work');
        await page.keyboard.press('Meta+Alt+A'); check('Archive shortcut retains the Bot conversation', await chat.isVisible());
        // Exit via the actual published mode menu and restore native standard paths.
        await page.locator('[data-bot-mode-switch-button]').click();
        await page.getByRole('menuitem', { name: /标准|Standard/ }).click();
        await sidebar.waitFor({ state: 'detached' });
        const nativeNew = page.getByRole('button', { name: /^(新建会话|New Session)$/ }).first(); await nativeNew.waitFor(); await nativeNew.click();
        await page.locator('[contenteditable="true"]:visible').first().waitFor();
        check('standard mode restores native New and composer');
        await page.screenshot({ path: resolve(host.dir, 'browser-standard-mode.png'), fullPage: true });
        await page.locator('[data-bot-mode-switch-button]').click();
        await page.getByRole('menuitem', { name: /^(Bot 模式|Bot mode)$/i }).click();
        await sidebar.waitFor();
        await nav.getByRole('button', { name: /^通用助手/ }).first().click();
        check('Bot mode restores the original contact after standard mode');
      }
      await context.close();
    }
    assert.deepEqual(errors, []);
    const receipt = { status: 'PASS', checks, errors, realModelRequests: 0 };
    await writeFile(resolve(host.dir, 'browser-result.json'), JSON.stringify(receipt, null, 2));
    return receipt;
  } catch (error) {
    await currentPage?.screenshot({ path: resolve(host.dir, 'browser-failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
    await currentPage?.content().then(html => writeFile(resolve(host.dir, 'browser-failure.html'), html)).catch(() => {});
    await writeFile(resolve(host.dir, 'browser-result.json'), JSON.stringify({ status: 'FAIL', checks, errors, error: redact(error.stack ?? error), realModelRequests: 0 }, null, 2));
    throw error;
  } finally { await browser.close(); }
}

async function externalBrowserRegression(host) {
  const file = resolve(host.dir, 'external-browser-result.json');
  console.log(`OFFICIAL_EXTERNAL_BROWSER_READY ${host.dir}`);
  await waitFor(() => existsSync(file), 1200000);
  const receipt = await json(file);
  assert.equal(receipt.status, 'PASS'); assert.equal(receipt.source, 'CUA native isolated browser');
  assert.equal(receipt.artifactSha256, artifactSha256); assert.equal(receipt.realModelRequests, 0);
  assert.ok(Array.isArray(receipt.checks) && receipt.checks.length > 0, 'Actual Browser checks required');
  return receipt;
}

try {
  for (const suite of suites) {
    console.log(`OFFICIAL_COMPAT_PHASE ${suite.id}`);
    const host = await hostFor(suite);
    try {
      const receipt = await json(resolve(host.dir, suite.result));
      if (suite.id !== 'review') assert.equal(receipt.status, 'PASS');
      if ('realModelRequests' in receipt) assert.equal(receipt.realModelRequests, 0);
      else assert.equal(receipt.zeroRealRequests, true);
      if (options['host-only'] && (suite.id === 'review' || suite.id === 'messages' || suite.id === 'openmaus')) {
        results.push({ suite: suite.id, status: 'PARTIAL', hostStatus: 'PASS', dir: host.dir, receipt,
          browser: { status: 'FAIL (NOT_RUN)', reason: 'Explicit Host-only run; root must run the original Browser matrix against this exact package.' } });
      } else if (suite.id === 'review' || suite.id === 'messages' || suite.id === 'openmaus') {
        await writeFile(resolve(host.dir, 'service.json'), JSON.stringify({ status: 'READY', pid: process.pid, url: host.url, app, compat, artifact, artifactSha256, realModelRequests: 0 }, null, 2), { mode: 0o600 });
        host.messagesReview = suite.id === 'messages';
        const browser = options['external-browser'] ? await externalBrowserRegression(host) : suite.id === 'openmaus'
          ? await (await import('./openmaus-browser.mjs')).verifyOpenmausBrowser(host, { root, clientBytes })
          : await browserRegression(host);
        results.push({ suite: suite.id, status: 'PASS', dir: host.dir, browser });
        await writeFile(resolve(out, 'progress.json'), JSON.stringify({ status: 'IN_PROGRESS', results, remaining: suites.filter(row => !results.some(result => result.suite === row.id)).map(row => row.id), realModelRequests: 0 }, null, 2));
        if (options['keep-review'] && suite.id === suites.at(-1).id) {
          assert.equal(sha256(await readFile(appArchive)), appSha256, 'Official app archive remains byte-identical');
          assert.equal(sha256(await readFile(artifact)), artifactSha256);
          await writeFile(resolve(out, 'summary.json'), JSON.stringify({ status: 'PASS', app, version: '0.2.2-rc.3', appSha256, artifact, artifactSha256, compat, compatSha256, results, realModelRequests: 0, officialAppUnchanged: true, retainedReview: host.dir }, null, 2));
          console.log(`OFFICIAL_COMPAT_REVIEW_READY ${host.dir}`);
          let stop = false; process.once('SIGINT', () => { stop = true; }); process.once('SIGTERM', () => { stop = true; });
          while (!stop) await delay(250);
        }
      } else results.push({ suite: suite.id, status: 'PASS', dir: host.dir, receipt });
      const denied = await readFile(resolve(host.dir, 'network-denials.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      assert.equal(denied, '', 'Unexpected outbound network attempt');
    } finally { await host.stop(); }
  }
  assert.equal(sha256(await readFile(appArchive)), appSha256, 'Official app archive remains byte-identical');
  assert.equal(sha256(await readFile(artifact)), artifactSha256, 'Frozen product package remains byte-identical');
  await writeFile(resolve(out, 'summary.json'), JSON.stringify({ status: options['host-only'] ? 'PARTIAL' : 'PASS', hostStatus: 'PASS', app, version: '0.2.2-rc.3', appSha256, artifact, artifactSha256, compat, compatSha256, results, realModelRequests: 0, officialAppUnchanged: true }, null, 2));
  console.log(options['host-only'] ? 'OFFICIAL_COMPAT_HOST_PASS_BROWSER_NOT_RUN' : 'OFFICIAL_COMPAT_VALIDATION_PASS');
} catch (error) {
  await writeFile(resolve(out, 'summary.json'), JSON.stringify({ status: 'FAIL', app, appSha256, artifact, artifactSha256, compat, compatSha256, results, error: redact(error.stack ?? error), realModelRequests: 0 }, null, 2));
  throw error;
} finally { for (const host of active) await host.stop(); }
