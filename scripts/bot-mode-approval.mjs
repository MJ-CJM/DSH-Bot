import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, realpath, writeFile, chmod, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildBotModeAdapter } from './build-bot-mode-adapter.mjs';
import { buildBotModeChatAdapter } from './build-bot-mode-chat-adapter.mjs';
import { buildBotModeWorkspaceAdapter } from './build-bot-mode-workspace-adapter.mjs';
import { auditArtifact, auditInstalled } from './p34-artifact.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = resolve(root, process.env.DSH_BOT_APPROVAL_DIR ?? '.dsh-dev/bot-mode-approval');
const profile = 'bot-mode-approval';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const yaml = require('js-yaml');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const inside = path => assert.ok(resolve(path).startsWith(`${root}/.dsh-dev/`), `Not an isolated repository path: ${path}`);
inside(base);
const exists = path => readFile(path).then(() => true, () => false);
async function copyChangedFile(source, target) {
  const next = await readFile(source), current = await readFile(target).catch(() => undefined);
  if (current?.equals(next)) return;
  await writeFile(target, next);
}
async function copyChangedTree(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyChangedTree(resolve(source, entry.name), resolve(target, entry.name));
    else { assert.ok(entry.isFile(), 'Adapter lib must contain ordinary files'); await copyChangedFile(resolve(source, entry.name), resolve(target, entry.name)); }
  }
}
async function assertStopped() {
  const previous = await json(resolve(base, 'service.json')).catch(() => undefined);
  if (previous) {
    try { process.kill(previous.pid, 0); throw new Error('Approval service already running; stop its recorded process before replacing the frozen package'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return previous;
}

/** Prepare an independent runtime; no file in the source runtime is modified. */
export async function prepareApprovalRuntime() {
  await assertStopped();
  const runtime = resolve(base, 'runtime'); inside(runtime);
  const source = resolve(root, '.dsh-dev/proactive-bot/host-runtime');
  await mkdir(base, { recursive: true, mode: 0o700 });
  if (!await exists(resolve(runtime, 'approval-runtime.json'))) {
    await cp(source, runtime, { recursive: true, verbatimSymlinks: true });
    await writeFile(resolve(runtime, 'approval-runtime.json'), JSON.stringify({ source: relative(root, source), baseline: '0.2.1-rc.2', isolated: true }));
  }
  const runtimeRequire = createRequire(resolve(runtime, 'package.json'));
  const cliManifest = await realpath(runtimeRequire.resolve('@deepseek-ai/dsh/package.json')); inside(cliManifest);
  const cliRequire = createRequire(cliManifest);
  const native = dirname(await realpath(cliRequire.resolve('@deepseek-ai/dsh-client-shortcuts/package.json'))); inside(native);
  const llmFolder = (await readdir(resolve(runtime, 'node_modules/.pnpm'))).find(name => name.startsWith('@deepseek-ai+dsh-llm@0.2.1-rc.2'));
  assert.ok(llmFolder, 'Pinned public LLM package missing from isolated runtime');
  const sdkManifest = resolve(runtime, 'node_modules/.pnpm', llmFolder, 'node_modules/@deepseek-ai/dsh-llm/package.json');
  const adapter = await buildBotModeAdapter({ runtime, output: resolve(base, 'adapter-package') });
  await copyChangedTree(resolve(adapter.package, 'lib'), resolve(native, 'lib'));
  const chatNative = dirname(await realpath(cliRequire.resolve('@deepseek-ai/dsh-client-ui-chat/package.json'))); inside(chatNative);
  const chatAdapter = await buildBotModeChatAdapter({ output: resolve(base, 'chat-adapter-package') });
  await copyChangedTree(resolve(chatAdapter.package, 'lib'), resolve(chatNative, 'lib'));
  await copyChangedFile(resolve(chatAdapter.package, 'package.json'), resolve(chatNative, 'package.json'));
  const workspaceNative = dirname(await realpath(cliRequire.resolve('@deepseek-ai/dsh-client-ui-workspace/package.json'))); inside(workspaceNative);
  const workspaceAdapter = await buildBotModeWorkspaceAdapter({ output: resolve(base, 'workspace-adapter-package') });
  await copyChangedTree(resolve(workspaceAdapter.package, 'lib'), resolve(workspaceNative, 'lib'));
  const rendererNative = dirname(await realpath(cliRequire.resolve('@deepseek-ai/dsh-client-ui-renderer/package.json'))); inside(rendererNative);
  const sourceRequire = createRequire(resolve(source, 'package.json'));
  const sourceCli = createRequire(sourceRequire.resolve('@deepseek-ai/dsh/package.json'));
  const rendererOriginal = dirname(await realpath(sourceCli.resolve('@deepseek-ai/dsh-client-ui-renderer/package.json'))); inside(rendererOriginal);
  const rendererSha256 = sha256(await readFile(resolve(rendererOriginal, 'lib/client.js')));
  assert.equal(rendererSha256, 'dbdb3f26bfbc1d143bc8a0eed5982a2507c4f0cf8027e7c170f3bed3604be356', 'Original Renderer baseline changed');
  await copyChangedTree(resolve(rendererOriginal, 'lib'), resolve(rendererNative, 'lib'));
  const executable = resolve(runtime, 'approval-dsh');
  // Relative runtime paths prevent pnpm's original shim from selecting the source installation.
  await writeFile(executable, `#!/bin/sh\nset -eu\nbase=$(CDPATH= cd "$(dirname "$0")" && pwd)\nexec node "$base/${relative(runtime, resolve(dirname(cliManifest), 'lib/bin.js'))}" "$@"\n`);
  await chmod(executable, 0o755);
  return { runtime, executable, native, adapter, chatAdapter, workspaceAdapter, rendererSha256, sdkManifest };
}

async function command(args, env, name) {
  const child = spawn(resolve(root, 'scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
  await writeFile(resolve(base, `${name}.log`), output.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]'));
  assert.equal(code, 0, `${name} failed; see ${relative(root, base)}/${name}.log`);
  return output;
}

export async function startApproval({ artifact, port, fixture = resolve(root, 'scripts/bot-mode-approval-profile.mjs'), enable } = {}) {
  assert.ok(artifact, 'Provide a frozen plugin tgz'); artifact = resolve(artifact); inside(artifact);
  const frozenSha = sha256(await readFile(artifact));
  const { name: packageName } = await json(resolve(root, 'packages/dsh-bot/package.json'));
  const previous = await assertStopped();
  const listenPort = port ?? (previous?.url ? Number(new URL(previous.url).port) : 0);
  const prepared = await prepareApprovalRuntime();
  const env = { PATH: process.env.PATH, SHELL: process.env.SHELL,
    DSH_BOT_DSH_BIN: prepared.executable, DSH_HOME: resolve(base, 'home'), DSH_AGENTS_HOME: resolve(base, 'agents'),
    XDG_STATE_HOME: resolve(base, 'state'), XDG_DATA_HOME: resolve(base, 'data'), XDG_CONFIG_HOME: resolve(base, 'config'),
    XDG_CACHE_HOME: resolve(base, 'cache'), NODE_COMPILE_CACHE: resolve(base, 'node-cache'), TMPDIR: resolve(base, 'tmp'),
    DSH_TELEMETRY_DISABLED: '1', DP_MOCK_PORT: '0', DP_NETWORK_RECEIPT: resolve(base, 'network-denials.jsonl'),
    pnpm_config_store_dir: resolve(root, '.dsh-dev/pnpm-store'), pnpm_config_cache_dir: resolve(root, '.dsh-dev/pnpm-cache'),
    pnpm_config_offline: 'true' };
  await mkdir(env.TMPDIR, { recursive: true });
  const version = (await command(['--version'], env, 'version')).trim(); assert.equal(version, '0.2.1-rc.2');
  if (!await exists(resolve(env.DSH_HOME, 'profiles', profile, 'package.json')))
    await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], env, 'initialize');
  if (previous?.artifactSha256 !== frozenSha || !await exists(resolve(env.DSH_HOME, 'profiles', profile, 'node_modules', packageName, 'package.json')))
    await command(['plugin', '--profile', profile, 'add', artifact], env, 'install');
  assert.equal(sha256(await readFile(artifact)), frozenSha, 'Artifact changed during installation');
  const auditDir = resolve(base, 'artifact-audit', frozenSha); await mkdir(auditDir, { recursive: true });
  const artifactManifest = await auditArtifact(root, artifact, auditDir);
  const installedReceipt = await auditInstalled(env.DSH_HOME, profile, artifactManifest);
  await writeFile(resolve(base, 'installed-artifact.json'), JSON.stringify(installedReceipt, null, 2));
  const installed = resolve(env.DSH_HOME, 'profiles', profile, 'node_modules', packageName);
  const patchFile = resolve(env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml');
  const previousPatch = await readFile(patchFile, 'utf8').then(value => yaml.load(value)).catch(() => []);
  const previousBot = Array.isArray(previousPatch) ? previousPatch.find(row => row?.id === 'dsh-bot')?.config : undefined;
  const botConfig = { ...(previousBot ?? {}), seedExamples: false, dataDir: resolve(base, 'bots'),
    supergroup: { maxRequests: 24, timeoutMs: 300000, ...(previousBot?.supergroup ?? {}), enabled: enable ?? previousBot?.supergroup?.enabled ?? true } };
  let entry = fixture;
  if (fixture === resolve(root, 'scripts/bot-mode-approval-profile.mjs')) {
    const frozenFixture = (await readFile(fixture, 'utf8'))
      .replace("import './deepening/network-guard.mjs';", "import './network-guard.mjs';")
      .replace("createRequire(new URL('../packages/dsh-bot/package.json', import.meta.url))", `createRequire(${JSON.stringify(prepared.sdkManifest)})`);
    entry = resolve(base, 'approval-fixture.mjs');
    await writeFile(entry, frozenFixture);
    await cp(resolve(root, 'scripts/deepening/network-guard.mjs'), resolve(base, 'network-guard.mjs'));
  }
  const patch = [
    '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(base, 'storage'))}`,
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(base, 'sessions'))}`,
    '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(base, 'credentials.yml'))}`, '    watch: false',
    '- id: dsh-bot', '  config:', ...yaml.dump(botConfig, { lineWidth: -1 }).trimEnd().split('\n').map(line => `    ${line}`),
    '- id: agent-default-model', '  config:', '    provider: bot-mode-local', '    model: review',
    ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry',
      'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
    '- insert:', '    - id: bot-mode-approval-fixture', `      name: ${JSON.stringify(entry)}`, '      config:',
    `        outputDir: ${JSON.stringify(base)}`, `        installedRoot: ${JSON.stringify(installed)}`, `        productPackageName: ${JSON.stringify(packageName)}`,
  ].join('\n');
  await writeFile(patchFile, `${patch}\n`);
  const logPath = resolve(base, 'server.log'), log = await open(logPath, 'w', 0o600);
  const args = ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', String(listenPort)];
  const child = spawn(resolve(root, 'scripts/dsh'), args, { cwd: resolve(env.DSH_HOME, 'profiles', profile), env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.unref(); await log.close();
  const record = { pid: child.pid, profile, version, artifact, artifactSha256: sha256(await readFile(artifact)),
    adapterSha256: prepared.adapter.sha256, chatAdapterSha256: prepared.chatAdapter.sha256, workspaceAdapterSha256: prepared.workspaceAdapter.sha256, rendererSha256: prepared.rendererSha256, executable: prepared.executable, log: logPath, home: env.DSH_HOME };
  await writeFile(resolve(base, 'service.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
  const deadline = Date.now() + 90000;
  try { while (Date.now() < deadline) {
    const output = await readFile(logPath, 'utf8');
    if (output.includes('BOT_MODE_APPROVAL_FAILED')) throw new Error('Approval fixture failed; see isolated server.log');
    const url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1];
    if (url && output.includes('BOT_MODE_APPROVAL_READY')) {
      const live = { ...record, url }; await writeFile(resolve(base, 'service.json'), JSON.stringify(live, null, 2), { mode: 0o600 });
      return live;
    }
    try { process.kill(child.pid, 0); } catch { throw new Error('Approval Host exited; see isolated server.log'); }
    await delay(100);
  }
  throw new Error('Approval Host readiness timed out; see isolated server.log');
  } catch (error) {
    // This exact process was just created here; never leave a failed startup listening.
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    throw error;
  }
}

export async function stopApproval() {
  const file = resolve(base, 'service.json'), record = await json(file);
  inside(record.executable); assert.equal(record.profile, profile);
  const { execFileSync } = await import('node:child_process');
  let processArgs;
  try { processArgs = execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' }); }
  catch { return { stopped: true, alreadyExited: true }; }
  assert.ok(processArgs.includes(resolve(base, 'runtime')) && processArgs.includes(profile), 'Recorded PID no longer belongs to this approval server');
  process.kill(record.pid, 'SIGTERM');
  for (let i = 0; i < 200; i++) { try { process.kill(record.pid, 0); } catch { return { stopped: true }; } await delay(50); }
  throw new Error('Approval server has not exited; no unrelated process was stopped');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, artifact] = process.argv.slice(2);
  if (action === 'start') console.log(JSON.stringify(await startApproval({ artifact }), null, 2));
  else if (action === 'prepare') console.log(JSON.stringify(await prepareApprovalRuntime(), null, 2));
  else if (action === 'stop') console.log(JSON.stringify(await stopApproval()));
  else if (action === 'status') { const record = await json(resolve(base, 'service.json')); console.log(JSON.stringify({ ...record, url: record.url?.replace(/token=.*/, 'token=[redacted]') }, null, 2)); }
  else throw new Error('Usage: node scripts/bot-mode-approval.mjs prepare|start <frozen.tgz>|status|stop');
}
