/**
 * Reproducible T04 integration probe against the built, public package.
 * Run from the repository root after `scripts/pnpm -F dsh-bot build`:
 * DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/tests/registry-profile.mjs
 * Or verify an existing tarball without rebuilding or linking source:
 * DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/tests/registry-profile.mjs --package dist/dsh-bot-0.1.6.tgz
 * No model sessions or prompts are created. Credentials stay in memory.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
assert.equal(process.cwd(), root, 'Run this probe from the repository root');
const home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home, 'Set DSH_HOME="$PWD/.dsh-dev"');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--package'),
  'Usage: registry-profile.mjs [--package path/to/dsh-bot.tgz]');
const packagePath = args.length ? resolve(root, args[1]) : undefined;
const sourcePackage = resolve(root, 'packages/dsh-bot');
const task = packagePath ? 't10' : 't04';
const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
const runDir = resolve(home, task, `run-${stamp}`);
const profile = `${task}-${Date.now()}-${process.pid}`;
const profileDir = resolve(home, 'profiles', profile);
const patchPath = resolve(runDir, 'profile.patch.yml');
const observerPath = resolve(runDir, 'log-observer.mjs');
const sharedStore = resolve(home, 'storages/dsh_bot.json');
const hashFile = (path) => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
const sharedStoreBefore = hashFile(sharedStore);
const secrets = new Set();
const children = new Set();
const checks = [];
const phases = [];
let remoteContribution;
let packageEvidence;
let packageHashBefore;
let interrupted = false;
mkdirSync(runDir, { recursive: true });
mkdirSync(resolve(home, 'tmp'), { recursive: true });
writeFileSync(resolve(home, `${task}/latest-run.txt`), `${runDir}\n`);
const env = {
  ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
  XDG_STATE_HOME: resolve(home, 'state'), NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'),
  TMPDIR: resolve(home, 'tmp'), pnpm_config_store_dir: resolve(home, 'pnpm-store'),
  pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
};

function redact(value) {
  let output = stripVTControlCharacters(String(value));
  for (const secret of secrets) if (secret) output = output.replaceAll(secret, '[REDACTED]');
  return output.replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|set-cookie|cookie)\s*[:=])[^\r\n]+/gi, '$1 [REDACTED]');
}
function save(name, value) {
  writeFileSync(resolve(runDir, name), `${redact(JSON.stringify(value, null, 2))}\n`);
}
function check(name, actual, expected = true) {
  try {
    assert.deepEqual(actual, expected, name);
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', reason: redact(error.message) });
    throw error;
  }
}
function ok(result, label) {
  assert.equal(result.ok, true, `${label}: ${result.error?.code ?? ''} ${result.error?.message ?? ''}`);
  return result.value;
}
function failureDetail(result) {
  return result.ok ? { ok: true, value: result.value } : {
    ok: false, error: { code: result.error.code, message: result.error.message, details: result.error.details },
  };
}
function verifyInstalledTarball() {
  const files = execFileSync('tar', ['-tzf', packagePath], { encoding: 'utf8' }).trim().split('\n');
  check('tarball contains only safe package file paths', files.every((file) =>
    file.startsWith('package/') && !file.endsWith('/') && !file.split('/').includes('..')));
  const installedRoot = realpathSync(resolve(profileDir, 'node_modules/dsh-bot'));
  const installedRelative = relative(realpathSync(profileDir), installedRoot);
  check('installed package resolves within the isolated profile',
    installedRelative.length > 0 && !installedRelative.startsWith(`..${sep}`) && installedRelative !== '..');
  check('installed package is not linked to the source package', installedRoot === realpathSync(sourcePackage), false);
  const hashes = files.map((file) => {
    const archiveBytes = execFileSync('tar', ['-xOf', packagePath, file], { maxBuffer: 8 * 1024 * 1024 });
    const name = file.slice('package/'.length);
    const expected = createHash('sha256').update(archiveBytes).digest('hex');
    const actual = hashFile(resolve(installedRoot, name));
    check(`installed tarball bytes: ${name}`, actual, expected);
    return { file: name, sha256: actual };
  });
  const manifest = JSON.parse(readFileSync(resolve(installedRoot, 'package.json'), 'utf8'));
  check('installed package name', manifest.name, 'dsh-bot');
  const installedRequire = createRequire(resolve(profileDir, 'package.json'));
  const hostEntry = installedRequire.resolve('dsh-bot');
  const remoteEntry = installedRequire.resolve('dsh-bot/remote');
  check('Host public entry resolves into installed package', hostEntry.startsWith(`${installedRoot}${sep}`));
  check('Remote public entry resolves into installed package', remoteEntry.startsWith(`${installedRoot}${sep}`));
  // The CLI resolves shared peers from its installation. This standalone Node
  // client uses the workspace's peer instances and a byte-identical public
  // Remote contribution; it does not load or link the workspace Host package.
  const driverFiles = hashes.filter(({ file }) => file === 'lib/typert.remote-client.js'
    || (file.startsWith('lib/shared/') && file.endsWith('.js')));
  for (const { file, sha256 } of driverFiles) {
    check(`workspace Remote driver matches tarball: ${file}`, hashFile(resolve(sourcePackage, file)), sha256);
  }
  packageEvidence = {
    archive: packagePath, archiveSha256: packageHashBefore,
    name: manifest.name, version: manifest.version, installedRoot, hostEntry, remoteEntry, files: hashes,
    remoteDriver: { entry: import.meta.resolve('dsh-bot/remote'), verifiedFiles: driverFiles },
  };
  save('installed-package.json', packageEvidence);
}
function attachLines(child, filename, observe = () => {}) {
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    const line = (value) => {
      const clean = stripVTControlCharacters(value);
      observe(clean);
      appendFileSync(resolve(runDir, filename), `${redact(clean)}\n`);
    };
    stream.on('data', (chunk) => {
      pending += chunk.toString();
      let index = pending.indexOf('\n');
      while (index >= 0) {
        line(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
    });
    stream.on('end', () => { if (pending) line(pending); });
  }
}
function launch(args) {
  const child = spawn(resolve(root, 'scripts/dsh'), args, {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const completion = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      children.delete(child);
      accept({ code, signal });
    });
  });
  // Keep an early spawn error handled while readiness is being observed.
  completion.catch(() => {});
  return { child, completion };
}
async function command(args, name) {
  const { child, completion } = launch(args);
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  attachLines(child, `${name}.log`);
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  try {
    const result = await completion;
    save(`${name}-exit.json`, { args, ...result });
    assert.equal(result.code, 0, `${name} failed; inspect its sanitized log`);
    return redact(stdout);
  } finally { clearTimeout(timer); }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) child.kill('SIGTERM');
  });
}

async function probe(startupUrl, phase, operation) {
  const base = new URL('/', startupUrl);
  const auth = await fetch(startupUrl, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const cookie = auth.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
  secrets.add(cookie);
  check(`${phase}: startup token exchange`, auth.status, 303);
  check(`${phase}: authenticated cookie present`, Boolean(cookie));
  const anonymous = await fetch(new URL('/api/dshBot/list', base), {
    method: 'POST', signal: AbortSignal.timeout(30_000),
  });
  check(`${phase}: anonymous request rejected`, anonymous.status, 401);
  const ctx = new Context();
  const owner = ctx.plugin({ apply(ownerCtx) {
    new TypertRegistry(ownerCtx);
    installConnection(ownerCtx, {
      interactions: 'none',
      transport: {
        streamBaseUrl: base.href,
        fetch: (input, init) => fetch(new URL(String(input), base), {
          ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
          signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]),
        }),
        createWebSocket: (url) => new WebSocket(url, { headers: { cookie } }),
      },
    });
    ownerCtx.plugin(Gateway);
  } });
  try {
    await owner.await();
    check(`${phase}: namespace absent before mount`, ctx.get('remote.dshBot') === undefined);
    const unmount = await ctx.effect(() => ctx.remote.$mount(remoteContribution));
    check(`${phase}: namespace available after mount`, ctx.get('remote.dshBot') !== undefined);
    const raw = (endpoint, args = {}) => ctx.connection.rpc.call(
      '/api', endpoint, { args }, AbortSignal.timeout(30_000),
    );
    const roster = async () => ok(await raw('agentPresets/list'), 'agentPresets/list').presets;
    const result = await operation(ctx.remote.dshBot, raw, roster);
    await unmount();
    check(`${phase}: namespace absent after unmount`, ctx.get('remote.dshBot') === undefined);
    save(`${phase}-remote.json`, result);
    return result;
  } finally {
    await owner.dispose();
    await ctx.fiber.dispose();
  }
}

async function runPhase(phase, operation) {
  console.log(`${task.toUpperCase()} ${phase}: starting isolated profile ${profile}`);
  const { child, completion } = launch([
    '--profile', profile, '--patch', patchPath,
    '--no-open', '--host', '127.0.0.1', '--port', '0',
  ]);
  let startupUrl;
  let registered;
  let loaded = false;
  let startupFailed = false;
  let fatal;
  let closed = false;
  completion.finally(() => { closed = true; }).catch(() => {});
  attachLines(child, `${phase}.log`, (line) => {
    const match = line.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
    if (match) {
      startupUrl = new URL(match[1]);
      secrets.add(startupUrl.searchParams.get('token'));
    }
    const registration = line.match(/\[dsh-bot\] registered (\d+) presets:(.*)/);
    if (registration) registered = { count: Number(registration[1]), ids: registration[2].trim() };
    if (line.includes('[dsh-bot] loaded')) loaded = true;
    if (line.includes('[dsh-bot] startup failed bot=*')) startupFailed = true;
    if (phase !== 'failed-startup' && line.includes('[dsh-bot] startup failed')) fatal = redact(line);
  });
  try {
    const deadline = Date.now() + 120_000;
    while ((!startupUrl || !(phase === 'failed-startup' ? startupFailed : loaded)) && !closed && !fatal && !interrupted && Date.now() < deadline) {
      await new Promise((accept) => setTimeout(accept, 100));
    }
    if (fatal) throw new Error(fatal);
    assert.ok(startupUrl && (phase === 'failed-startup' ? startupFailed : loaded) && !closed && !interrupted, `${phase}: Web host and Bot registry did not become ready; inspect log`);
    if (phase !== 'failed-startup') check(`${phase}: Host reports registered preset count`, registered?.count,
      { initial: 2, restart: 1, 'empty-restart': 0 }[phase]);
    if (phase === 'initial') check('initial: Host log names both examples', registered.ids, 'review-assistant, review-researcher');
    const result = await probe(startupUrl, phase, operation);
    phases.push({ phase, status: 'PASS' });
    return result;
  } finally {
    if (!closed) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    try {
      const result = await completion;
      save(`${phase}-exit.json`, result);
      check(`${phase}: clean host shutdown`, result, { code: 0, signal: null });
    } finally { clearTimeout(timer); }
  }
}

let failure;
try {
  if (packagePath) {
    const packageRelative = relative(root, packagePath);
    check('tarball input is an existing repository file', packagePath.endsWith('.tgz')
      && packageRelative.length > 0 && !packageRelative.startsWith(`..${sep}`) && existsSync(packagePath));
    packageHashBefore = hashFile(packagePath);
  } else {
    check('built Host and Client artifacts exist', existsSync(resolve(sourcePackage, 'lib/index.js'))
      && existsSync(resolve(sourcePackage, 'lib/client.js')));
  }
  check('new profile does not overwrite an existing profile', existsSync(profileDir), false);
  check('locked CLI version', (await command(['--version'], 'version')).trim(), '0.2.1-rc.2');
  // storage-json is profile-global by default. Override it before any Host starts
  // so the older T02 dsh_bot domain and all existing profiles remain untouched.
  // Web's default logger does not print Host info messages. This fixture uses
  // only the public logger exporter; the readiness service orders observation
  // before the formal package starts, without changing that package's behavior.
  writeFileSync(observerPath, [
    "import { format } from 'node:util';",
    'export function apply(ctx) {',
    '  ctx.effect(() => ctx.logger.exporter({',
    '    export(message) {',
    '      const text = format(...message.args);',
    "      if (text.includes('[dsh-bot]')) console.log(text);",
    '    },',
    '  }));',
    "  ctx.provide('t04LogReady', true);",
    '}', '',
  ].join('\n'));
  writeFileSync(patchPath, [
    '- insert:', '    - id: t04-log-observer', `      name: ${JSON.stringify(observerPath)}`,
    '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'storages'))}`,
    ...(packagePath ? [
      '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'sessions'))}`,
    ] : []),
    '- id: dsh-bot', '  inject: [t04LogReady]', '  config:', '    seedExamples: true', '    presetIdPrefix: review-',
    '    presetOrder: 50', `    dataDir: ${JSON.stringify(resolve(runDir, 'data'))}`, '',
  ].join('\n'));
  await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await command(['plugin', '--profile', profile, 'add', packagePath ?? sourcePackage], 'plugin-add');
  const dump = await command(['--profile', profile, '--patch', patchPath, '--dump-config'], 'dump');
  writeFileSync(resolve(runDir, 'dump.yml'), dump);
  check('dump contains formal package bundle layer', /^# == dsh-bot(?:,|\s*$)/m.test(dump));
  check('dump points storage-json at isolated run directory', dump.includes(resolve(runDir, 'storages')));
  const manifest = JSON.parse(readFileSync(resolve(profileDir, 'package.json'), 'utf8'));
  if (packagePath) {
    check('profile installs a tarball file dependency', /^file:.*\.tgz$/.test(manifest.dependencies['dsh-bot']));
    check('dump points session logs at isolated run directory', dump.includes(resolve(runDir, 'sessions')));
    verifyInstalledTarball();
  } else {
    check('profile links formal package', manifest.dependencies['dsh-bot'], `link:${sourcePackage}`);
  }
  remoteContribution = (await import('dsh-bot/remote')).default;

  const initial = await runPhase('initial', async (remote, raw, roster) => {
    check('Host publishes configured ownership prefix', ok(await remote.catalogInfo(), 'catalog info'), { presetIdPrefix: 'review-' });
    const seeds = ok(await remote.list(), 'initial list');
    check('initial: two examples only', seeds.map((bot) => bot.id).sort(), ['assistant', 'researcher']);
    check('initial: Chinese example names', seeds.map((bot) => bot.name).sort(), ['研究员', '通用助手'].sort());
    check('initial: Chinese personas', seeds.every((bot) => /[\u4e00-\u9fff]/u.test(bot.persona.prefix)));
    const activity = ok(await remote.activity.list(), 'initial activity list');
    check('activity namespace lists no sessions for idle seeded Bots', activity.sessions, []);
    check('activity namespace includes empty Bot aggregates', activity.bots.slice().sort((a, b) => a.botId.localeCompare(b.botId)),
      seeds.map((bot) => ({ botId: bot.id, lastActivityAt: 0, unreadCount: 0 })).sort((a, b) => a.botId.localeCompare(b.botId)));
    const missingActivity = await remote.activity.markRead('t08c-unknown-session');
    check('activity markRead unknown session has a structured error', missingActivity.error?.code, 'activity/not-found');
    check('activity error details survive the real Remote codec', missingActivity.error?.details, {});
    const initialPresets = (await roster()).filter((row) => row.id.startsWith('review-'));
    check('initial: two example presets registered and healthy', initialPresets.map((row) => ({ id: row.id, broken: row.broken ?? null })), [
      { id: 'review-assistant', broken: null }, { id: 'review-researcher', broken: null },
    ]);
    const statuses = ok(await remote.status(), 'initial status');
    check('status exposes configured preset ids and health', statuses, [
      { id: 'assistant', presetId: 'review-assistant', preset: { state: 'ok' } },
      { id: 'researcher', presetId: 'review-researcher', preset: { state: 'ok' } },
    ]);
    const seedAssistant = ok(await remote.get('assistant'), 'get assistant');
    check('initial: get returns stored example', seedAssistant, seeds.find((bot) => bot.id === 'assistant'));
    const invalid = await raw('dshBot/create', { input: { id: 't04-invalid', name: 'Invalid', unexpected: true } });
    check('strict Host rejects unknown input property', invalid.ok, false);
    check('strict Host boundary error code', invalid.error.code, 'gateway/input-invalid');
    const invalidArgs = await raw('dshBot/list', { unexpected: true });
    check('strict Host rejects unexpected method argument', invalidArgs.ok, false);
    check('strict method argument error code', invalidArgs.error.code, 'gateway/arguments-invalid');
    const missing = await remote.get('t04-missing');
    save('initial-error-results.json', { invalid, invalidArgs, missing: failureDetail(missing) });
    check('Remote missing Bot code', missing.ok ? null : missing.error.code, 'bot/not-found');
    check('Remote error has a transport-safe details object', missing.error.details, {});
    const created = ok(await remote.create({
      id: 't04-probe', name: '运行验证', persona: { prefix: '仅用于注册表验证。' },
      avatar: '🤖', avatarColor: '--dsw-alias-state-success-primary', defaultCwd: root, order: 67,
    }), 'create');
    check('create stores optional fields before clear',
      { avatar: created.avatar, defaultCwd: created.defaultCwd, order: created.order },
      { avatar: '🤖', defaultCwd: root, order: 67 });
    check('avatarColor survives real Remote codec and storage',
      ok(await remote.get(created.id), 'read avatar color').avatarColor, '--dsw-alias-state-success-primary');
    check('create registers healthy preset', (await roster()).some((row) => row.id === 'review-t04-probe' && !row.broken));
    const conflict = await remote.create({ id: 't04-probe', name: '重复' });
    save('initial-error-results.json', {
      invalid, invalidArgs, missing: failureDetail(missing), conflict: failureDetail(conflict),
    });
    check('Remote duplicate id conflict code', conflict.ok ? null : conflict.error.code, 'bot/conflict');
    const badAvatar = await raw('dshBot/update', { id: created.id, patch: { avatar: 'data:image/svg+xml;base64,PHN2Zz4=' } });
    check('strict Host rejects SVG avatar on real transport', badAvatar.error?.code, 'gateway/input-invalid');
    const badColor = await raw('dshBot/update', { id: created.id, patch: { avatarColor: '#123456' } });
    check('strict Host rejects colors outside the theme palette', badColor.error?.code, 'gateway/input-invalid');
    const manual = ok(await remote.memory.save(created.id, { content: 'T09 profile manual memory' }), 'manual memory');
    check('memory Remote stamps manual source', ok(await remote.memory.list(created.id, {}), 'memory list')[0]?.source.by, 'user');
    check('memory Remote count', ok(await remote.memory.count(created.id), 'memory count'), 1);
    ok(await remote.memory.update(created.id, manual.id, { pinned: true }), 'pin memory');
    check('memory Remote search finds pinned row', ok(await remote.memory.search(created.id, { query: 'manual' }), 'memory search')[0]?.pinned);
    ok(await remote.memory.delete(created.id, manual.id), 'delete memory');
    const createdStatus = ok(await remote.status(), 'created status').find((row) => row.id === created.id);
    check('created Bot status supplies actual preset id', createdStatus, { id: created.id, presetId: 'review-t04-probe', preset: { state: 'ok' } });
    const updated = ok(await remote.update(created.id, {
      name: '已更新', persona: { prefix: '更新后的中文人设。' },
      avatar: null, avatarColor: null, defaultCwd: null, order: null,
    }), 'update and clear optional fields through JSON');
    const clearedKeys = ['avatar', 'avatarColor', 'defaultCwd', 'order'];
    check('Remote null patch clears optional fields in update result', clearedKeys.every((key) => !Object.hasOwn(updated, key)));
    const clearedFetched = ok(await remote.get(created.id), 'read cleared optional fields');
    check('Remote null patch persists absent optional fields', clearedKeys.every((key) => !Object.hasOwn(clearedFetched, key)));
    check('read after null patch matches update result', clearedFetched, updated);
    check('update publishes new metadata under stable preset id', (await roster()).filter((row) => row.id === 'review-t04-probe')
      .map((row) => ({ name: row.name, broken: row.broken ?? null })), [{ name: '已更新', broken: null }]);
    const duplicated = ok(await remote.duplicate(updated.id, 't04-copy'), 'duplicate');
    check('duplicate copies editable persona', duplicated.persona, updated.persona);
    check('duplicate registers independent preset', (await roster()).some((row) => row.id === 'review-t04-copy' && !row.broken));
    // rc.2 reserves `remove` on its Client namespace service. The public wire
    // name is `delete`, whose descriptor targets the Host's remove method.
    ok(await remote.delete(created.id, { deleteMemories: true }), 'remove source');
    ok(await remote.delete(duplicated.id, { deleteMemories: false }), 'remove duplicate');
    check('remove withdraws both test presets', (await roster()).some((row) => ['review-t04-probe', 'review-t04-copy'].includes(row.id)), false);
    check('deleted Bots disappear from status', ok(await remote.status(), 'status after delete').some((row) => [created.id, duplicated.id].includes(row.id)), false);
    const deletedPreset = await raw('agentPresets/read', { agentPreset: createdStatus.presetId });
    check('deleted preset lookup reports not found', deletedPreset.error?.code, 'agent-preset/not-found');
    const kept = ok(await remote.update('assistant', { description: `T04 persisted ${profile}` }), 'persist assistant');
    ok(await remote.delete('researcher', undefined), 'remove researcher with default options');
    check('only modified assistant remains', ok(await remote.list(), 'final initial list'), [kept]);
    return { seeds, statuses, createdStatus, deletedPreset, initialPresets, invalid, invalidArgs, created, updated, clearedFetched, duplicated, kept };
  });

  // Only this run's stopped Host storage is changed to simulate a pre-upgrade avatar.
  const legacyFile = resolve(runDir, 'storages/dsh_bot.json');
  const legacyData = JSON.parse(readFileSync(legacyFile, 'utf8'));
  legacyData.tables.bots.assistant.avatar = 'data:text/html;base64,PHNjcmlwdD4=';
  writeFileSync(legacyFile, JSON.stringify(legacyData));
  const legacyHash = hashFile(legacyFile);
  await runPhase('restart', async (remote, _raw, roster) => {
    const rows = ok(await remote.list(), 'restart list');
    check('restart preserves record including timestamps and does not reseed researcher', rows, [initial.kept]);
    const presets = (await roster()).filter((row) => row.id.startsWith('review-'));
    check('restart registers persisted assistant only', presets.map((row) => ({ id: row.id, broken: row.broken ?? null })), [
      { id: 'review-assistant', broken: null },
    ]);
    check('legacy avatar is hidden with a structured warning', ok(await remote.status(), 'legacy status')[0]?.warnings, ['avatar/invalid']);
    check('legacy avatar read leaves original bytes untouched', hashFile(legacyFile), legacyHash);
    ok(await remote.update('assistant', { avatar: null }), 'explicit avatar repair');
    check('explicit repair clears warning', Object.hasOwn(ok(await remote.status(), 'repaired status')[0], 'warnings'), false);
    ok(await remote.delete('assistant', { deleteMemories: true }), 'remove final seed');
    check('all Bots can be removed', ok(await remote.list(), 'empty list'), []);
    return { rows, presets };
  });
  await runPhase('empty-restart', async (remote, _raw, roster) => {
    const rows = ok(await remote.list(), 'empty restart list');
    check('seed marker prevents reseeding after deliberate emptying and cold restart', rows, []);
    const presets = (await roster()).filter((row) => row.id.startsWith('review-'));
    check('empty restart leaves no Bot presets', presets, []);
    check('ownership prefix remains available after deletion and cold restart', ok(await remote.catalogInfo(), 'empty catalog info'), { presetIdPrefix: 'review-' });
    check('empty registry status is empty', ok(await remote.status(), 'empty status'), []);
    check('empty restart activity Remote remains callable without arguments',
      ok(await remote.activity.list(), 'empty restart activity'), { sessions: [], bots: [] });
    return { rows, presets };
  });

  const invalidRoot = resolve(runDir, 'invalid-storages');
  mkdirSync(invalidRoot);
  writeFileSync(resolve(invalidRoot, 'dsh_bot.json'), JSON.stringify({
    unit: { name: 'dsh_bot', version: 1 }, global: null, tables: { bots: { invalid: { id: 'invalid' } } },
  }));
  writeFileSync(patchPath, readFileSync(patchPath, 'utf8').replace(
    JSON.stringify(resolve(runDir, 'storages')), JSON.stringify(invalidRoot)));
  await runPhase('failed-startup', async (remote) => {
    const results = { list: failureDetail(await remote.list()), status: failureDetail(await remote.status()),
      create: failureDetail(await remote.create({ id: 'test-bot', name: 'Unavailable' })) };
    for (const [method, result] of Object.entries(results)) {
      check(`failed startup ${method} returns bot/unavailable`, result.error?.code, 'bot/unavailable');
    }
    const activity = ok(await remote.activity.list(), 'unavailable activity list');
    check('failed storage startup activity degrades to an empty list', activity, { sessions: [], bots: [] });
    const activityRead = await remote.activity.markRead('t08c-unknown-session');
    check('failed storage startup markRead returns a structured unavailable error', activityRead.error?.code, 'store/unavailable');
    return { ...results, activity, activityRead: failureDetail(activityRead) };
  });
} catch (error) {
  failure = redact(error.stack ?? error);
  process.exitCode = 1;
} finally {
  const sharedStoreAfter = hashFile(sharedStore);
  try { check('pre-existing shared T02 storage unchanged', sharedStoreAfter, sharedStoreBefore); }
  catch (error) { failure ??= redact(error.stack ?? error); process.exitCode = 1; }
  if (packageHashBefore) {
    try { check('input tarball unchanged after integration run', hashFile(packagePath), packageHashBefore); }
    catch (error) { failure ??= redact(error.stack ?? error); process.exitCode = 1; }
  }
  save('summary.json', {
    runDir, profile, dshHome: home, phases, checks,
    ...(packageEvidence ? { package: packageEvidence } : {}),
    sharedStore: { path: sharedStore, before: sharedStoreBefore, after: sharedStoreAfter },
    modelSessionsCreated: 0, promptsSent: 0, ...(failure ? { failure } : {}),
  });
  console.log(`${task.toUpperCase()} ${failure ? 'FAIL' : 'PASS'}: ${runDir}`);
  if (failure) console.error(failure);
}
