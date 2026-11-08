import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const spike = fileURLToPath(new URL('../../', import.meta.url));
const root = resolve(spike, '../..');
const home = join(root, '.dsh-dev');
const runtime = join(home, 'proactive-bot', 'host-runtime');
const profile = `pb00-host-${Date.now()}-${randomUUID().slice(0, 8)}`;
const outputDir = join(home, 'proactive-bot', `host-${profile}`);
const profileDir = join(home, 'profiles', profile);
const expectedVersion = '0.2.1-rc.2';
assert.equal(process.env.DSH_HOME, home, 'Set DSH_HOME="$PWD/.dsh-dev" from the repository root');
await mkdir(outputDir, { recursive: true });
const save = (name: string, value: unknown) => writeFile(join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
const relativePath = (path: string) => relative(root, path);
const summary: Record<string, unknown> = { profile, outputDir: relativePath(outputDir), checks: {} };
const commands: unknown[] = [];
const allRequests: unknown[] = [];
let invalidRequests = 0;

const http = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/model');
    assert.equal(request.socket.remoteAddress, '127.0.0.1');
    let body = '';
    for await (const bytes of request) {
      body += bytes.toString();
      assert.ok(body.length <= 512);
    }
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ['approvalTool', 'sequence', 'sessionId']);
    assert.equal(typeof parsed.sessionId, 'string');
    assert.equal(typeof parsed.approvalTool, 'boolean');
    assert.equal(typeof parsed.sequence, 'number');
    allRequests.push(parsed);
    response.writeHead(200).end('PB00_SYNTHETIC_REPLY');
  } catch {
    invalidRequests++;
    response.writeHead(400).end();
  }
});
await new Promise<void>((resolve, reject) => {
  http.once('error', reject);
  http.listen(0, '127.0.0.1', () => resolve());
});

const egressLog = join(outputDir, 'egress-attempts.log');
const guard = join(spike, 'host-fixture', 'loopback-only.mjs');
const configuredCli = process.env.DSH_BOT_DSH_BIN;
const fallbackCli = join(runtime, 'node_modules', '.bin', 'dsh');
const selectedCli = configuredCli ?? (await access(fallbackCli).then(() => fallbackCli, () => undefined));
const hostHome = join(outputDir, 'empty-home');
const tmp = join(outputDir, 'tmp');
const fixtureRoot = join(outputDir, 'fixture');
const modelAddress = http.address();
assert.ok(modelAddress && typeof modelAddress !== 'string');
await Promise.all([mkdir(hostHome), mkdir(tmp), mkdir(fixtureRoot)]);
// Copy the compiled artifact and runtime fixture into isolated output. Resolve
// only public dependencies through the selected rc.2 runtime's node_modules.
const fixtureManifest = join(fixtureRoot, 'package.json');
await writeFile(fixtureManifest, '{"type":"module"}\n');
const plugin = join(fixtureRoot, 'pb00-plugin.js');
await copyFile(join(spike, 'lib', 'host', 'index.js'), plugin);
const ipcChild = join(fixtureRoot, 'ipc-child.mjs');
const productGuardModule = join(root, 'packages', 'dsh-bot', 'lib', 'host', 'delegate', 'guard.js');
await copyFile(join(spike, 'host-fixture', 'ipc-child.mjs'), ipcChild);
const env: NodeJS.ProcessEnv = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: hostHome, USER: 'pb00-fixture', TMPDIR: tmp,
  DSH_HOME: home, DSH_AGENTS_HOME: join(outputDir, 'agents-home'),
  XDG_STATE_HOME: join(outputDir, 'state'), XDG_CONFIG_HOME: join(outputDir, 'config'),
  DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'read-only',
  PB00_EGRESS_LOG: egressLog, NODE_OPTIONS: `--import=${JSON.stringify(guard)}`,
  ...(selectedCli ? { DSH_BOT_DSH_BIN: selectedCli } : {}),
};

async function cli(args: string[], label: string, mode?: 'stop' | 'kill') {
  const child = spawn(join(root, 'scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let exited = false;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { exited = true; accept({ code, signal }); });
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
  const stopTimer = setTimeout(() => child.kill('SIGKILL'), mode ? 95000 : 45000);
  try {
    if (mode) {
      const deadline = Date.now() + 80000;
      const marker = mode === 'kill' ? 'PB00_HOST_CRASH_BARRIER' : 'PB00_HOST_DONE';
      while (!exited && Date.now() < deadline && !output.includes(marker) && !output.includes('PB00_HOST_FATAL')) await delay(100);
      child.kill(mode === 'kill' ? 'SIGKILL' : 'SIGTERM');
      const result = await done;
      assert.ok(output.includes(marker), `Missing ${marker}; see ${label}.log`);
      if (mode === 'kill') assert.equal(result.signal, 'SIGKILL');
      else assert.equal(result.code, 0);
    } else {
      assert.equal((await done).code, 0, `See ${label}.log`);
    }
    return stripVTControlCharacters(output).trim();
  } finally {
    clearTimeout(stopTimer);
    if (!exited) child.kill('SIGKILL');
    commands.push({ args, label, pid: child.pid, ...(await done.catch(error => ({ error: String(error) }))) });
    await writeFile(join(outputDir, `${label}.log`), stripVTControlCharacters(output)
      .replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]')
      .replace(/((?:authorization|set-cookie|cookie)\s*[:=])[^\r\n]+/gi, '$1 [redacted]'));
  }
}

try {
  const version = await cli(['--version'], 'version');
  summary.cliVersion = version;
  summary.selectedCli = selectedCli ? relativePath(await realpath(selectedCli)) : 'scripts/dsh default';
  assert.equal(version, expectedVersion, 'Set DSH_BOT_DSH_BIN to the verified rc.2 executable');
  const modules = process.env.PB00_DSH_RUNTIME_MODULES ?? join(runtime, 'node_modules', '.pnpm', 'node_modules');
  const moduleRoot = await realpath(modules);
  assert.ok(moduleRoot.startsWith(`${home}/`), 'Use repository-isolated rc.2 module resolution');
  for (const packageName of ['dsh-llm', 'dsh-session', 'dsh-storage-domain', 'dsh-tools', 'dsh-user-approval', 'dsh-subprocess']) {
    const manifest = JSON.parse(await readFile(join(moduleRoot, '@deepseek-ai', packageName, 'package.json'), 'utf8')) as { version: string };
    assert.equal(manifest.version, expectedVersion, packageName);
  }
  await symlink(moduleRoot, join(fixtureRoot, 'node_modules'), 'dir');
  const disabled = [
    'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'session-title-first-prompt-llm',
    'llm-retry', 'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry',
  ];
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  await save('manifest.json', { profile, actualCli: version, selectedCli: summary.selectedCli,
    referenceTag: 'dsh-v0.2.1-rc.2', node: process.version, hostNode: process.execPath,
    compiledFixtureSha256: hash(await readFile(plugin)), processFixtureSha256: hash(await readFile(ipcChild)),
    disabled, providerEndpoint: '127.0.0.1', inheritedSecretEnv: false, productionPluginLoaded: false,
    productGuardSha256: hash(await readFile(productGuardModule)) });
  await cli(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initial-dump');
  const flags = ['--profile', profile];
  for (const phase of ['live', 'crash', 'cold'] as const) {
    const patch = [
      ...disabled.map(id => `- id: ${id}\n  disabled: true`),
      `- id: agent-default-model\n  config: { provider: pb00-loopback, model: pb00-synthetic }`,
      `- id: approval\n  config: { policy: ask }`,
      `- id: credentials-local\n  config: { path: ${JSON.stringify(join(outputDir, 'synthetic-credentials.yml'))}, watch: false }`,
      `- id: storage-json\n  config: { root: ${JSON.stringify(join(outputDir, 'storages'))} }`,
      `- id: session-persistence-jsonl\n  config: { root: ${JSON.stringify(join(outputDir, 'sessions'))} }`,
      `- insert:\n    - id: pb00-probes\n      name: ${JSON.stringify(plugin)}\n      config: ${JSON.stringify({
        outputDir, modelUrl: `http://127.0.0.1:${modelAddress.port}/model`, subprocessFixture: ipcChild, productGuardModule, phase,
      })}`,
    ].join('\n');
    await writeFile(join(profileDir, 'cordis.patch.yml'), `${patch}\n`);
    await cli([...flags, '--dump-config'], `${phase}-dump`);
    const before = allRequests.length;
    await cli([...flags, '--no-open', '--host', '127.0.0.1', '--port', '0'], `${phase}-host`, phase === 'crash' ? 'kill' : 'stop');
    const file = phase === 'crash' ? 'crash-barrier.json' : `${phase}.json`;
    const record = JSON.parse(await readFile(join(outputDir, file), 'utf8')) as { pid: number; calls?: unknown[]; checks?: Record<string, unknown> };
    assert.deepEqual(allRequests.slice(before), record.calls ?? []);
    if (phase !== 'crash') {
      const disposed = JSON.parse(await readFile(join(outputDir, `${phase}-disposed.json`), 'utf8')) as { pid: number };
      assert.equal(disposed.pid, record.pid);
    }
    summary[phase] = record;
    if (phase === 'cold') assert.notEqual(record.pid, (summary.crash as { pid: number }).pid);
  }
} catch (error) {
  summary.infrastructure = { status: 'FAIL', error: String(error), stack: error instanceof Error ? error.stack : undefined };
} finally {
  http.closeAllConnections();
  await new Promise<void>((accept, reject) => http.close(error => error ? reject(error) : accept()));
}
const blockedEgress = (await readFile(egressLog, 'utf8').catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return '';
  throw error;
})).trim().split('\n').filter(Boolean);
summary.network = { status: blockedEgress.length || invalidRequests ? 'FAIL' : 'PASS', blockedEgress, invalidRequests,
  fixtureModelRequests: allRequests.length, requests: allRequests, externalTransportCalls: 0 };
summary.commands = commands;
await save('host-summary.json', summary);
await writeFile(join(home, 'proactive-bot', 'host-latest.txt'), `${relativePath(outputDir)}\n`);
const reported = [summary.live, summary.cold].flatMap(value => Object.entries((value as { checks?: Record<string, { status: string }> } | undefined)?.checks ?? {}));
for (const [key, check] of reported) console.log(`${check.status} ${key}`);
if (summary.infrastructure) console.error(summary.infrastructure);
console.log(`PB00 rc.2 Host receipt: ${relativePath(join(outputDir, 'host-summary.json'))}`);
if (summary.infrastructure || blockedEgress.length || invalidRequests || reported.some(([, check]) => check.status !== 'PASS')) process.exitCode = 1;
