/** Run from the repository root. Uses only local profile, storage and mock HTTP. */
import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';

const root = process.cwd();
const home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
const runDir = resolve(home, 'p2/t11', `${Date.now()}-${process.pid}`);
await mkdir(runDir, { recursive: true });
await writeFile(resolve(home, 'p2/t11/latest-run.txt'), `${runDir}\n`);
const profile = `t11-${Date.now()}-${process.pid}`;
const mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: ['slow_success', 'slow_success', 'slow_success', 'slow_success'], chunkDelayMs: 80,
  successText: 'T11_LOOPBACK_COMPLETED', randomSeed: 11 });
const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(runDir, 'agents-home'),
  DSH_TELEMETRY_DISABLED: '1', XDG_STATE_HOME: resolve(home, 'state'), NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'),
  TMPDIR: resolve(home, 'tmp'), pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
  DSH_BOT_T11_MOCK_KEY: 't11-local-fixture', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: `${mock.baseURL}/v1` };
const redact = (text: string) => stripVTControlCharacters(text).replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[REDACTED]')
  .replace(/((?:authorization|set-cookie|cookie)\s*[:=])[^\r\n]+/gi, '$1 [REDACTED]');
const children = new Set<ReturnType<typeof spawn>>();
const exits: unknown[] = [];
async function command(executable: 'dsh' | 'pnpm', args: string[], name: string, live = false) {
  const child = spawn(resolve(root, `scripts/${executable}`), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = ''; let closed = false;
  const done = new Promise<number | null>((accept, reject) => {
    child.once('error', reject); child.once('close', code => { closed = true; children.delete(child); accept(code); });
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output += chunk.toString(); });
  const kill = setTimeout(() => child.kill('SIGKILL'), 180000);
  try {
    if (live) {
      const until = Date.now() + 150000;
      while (!closed && Date.now() < until && !/T11_(DONE|FAILED)/.test(output)) await delay(100);
      child.kill('SIGTERM');
    }
    const code = await done;
    await writeFile(resolve(runDir, `${name}.log`), redact(output));
    exits.push({ executable, args, name, code });
    assert.equal(code, 0, `see ${name}.log`);
    if (live) assert.match(output, /T11_DONE/, `see ${name}.log and phase JSON`);
    return output;
  } finally { clearTimeout(kill); if (!closed) child.kill('SIGKILL'); }
}
async function lockTests() {
  const path = resolve(runDir, 'race.lock');
  const workers: ReturnType<typeof fork>[] = [];
  async function worker() {
    const child = fork(resolve(root, 'spikes/p2/lib/lock-worker.js'), [path], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    workers.push(child);
    const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const message = await new Promise<{ owner: boolean; identity?: unknown }>((accept, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('lock worker timeout')); }, 5000);
      child.once('message', value => { clearTimeout(timer); accept(value as { owner: boolean }); });
      child.once('error', reject);
    });
    return { child, message, exit };
  }
  try {
    const raced = await Promise.all([worker(), worker()]);
    assert.equal(raced.filter(item => item.message.owner).length, 1);
    const owner = raced.find(item => item.message.owner);
    assert.ok(owner);
    owner.child.send('release'); await owner.exit;
    const next = await worker(); assert.equal(next.message.owner, true);
    next.child.kill('SIGKILL'); await next.exit;
    const stale = await worker(); assert.equal(stale.message.owner, false); await stale.exit;
    const evidence = { race: raced.map(item => item.message), reacquiredAfterRelease: next.message, staleLockBlocksAfterKill: stale.message,
      policy: 'No automatic stale reclamation; operator verifies all owners stopped before removing lock.' };
    await writeFile(resolve(runDir, 'lock-processes.json'), JSON.stringify(evidence, null, 2));
    return evidence;
  } finally { for (const child of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}
async function hashes(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of await readdir(dir)) {
    const path = resolve(dir, name);
    if ((await stat(path)).isDirectory()) Object.assign(result, await hashes(path));
    else result[relative(runDir, path)] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return result;
}
try {
  await lockTests();
  await command('dsh', ['--version'], 'version');
  await command('pnpm', ['-C', 'spikes/p2', 'pack', '--pack-destination', runDir], 'pack');
  const archive = resolve(runDir, 'dsh-bot-p2-probes-0.0.0.tgz');
  await command('dsh', ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await command('dsh', ['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'install-p1');
  await command('dsh', ['plugin', '--profile', profile, 'add', archive], 'install-tarball');
  const installedRoot = resolve(home, 'profiles', profile, 'node_modules/dsh-bot-p2-probes');
  const installedFiles: Record<string, string> = {};
  for (const name of ['host.js', 'rules.js', 'lock.js']) {
    const bytes = await readFile(resolve(installedRoot, 'lib', name));
    assert.deepEqual(bytes, await readFile(resolve(root, 'spikes/p2/lib', name)));
    installedFiles[name] = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(resolve(runDir, 'installed-package.json'), JSON.stringify({ archive,
    archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), installedRoot, installedFiles }, null, 2));
  for (const phase of ['first', 'cold']) {
    const patch = [
      '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'storages'))}`,
      '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'sessions'))}`,
      '- id: dsh-bot', '  config:', '    seedExamples: true', `    dataDir: ${JSON.stringify(resolve(runDir, 'bots-data'))}`,
      '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-flash', '    reasoningEffort: off',
      '- id: llm-deepseek', '  config:', '    apiKeyEnv: DSH_BOT_T11_MOCK_KEY', `    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}`,
      '    thinking: disabled', '    reasoningEffort: off', '    maxTokens: 128',
      ...['llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry']
        .flatMap(id => [`- id: ${id}`, '  disabled: true']),
      '- id: t11-probes', '  disabled: false', '  config:', `    outputDir: ${JSON.stringify(runDir)}`, `    phase: ${phase}`, `    baseURL: ${JSON.stringify(mock.baseURL)}`,
    ].join('\n');
    await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
    await command('dsh', ['--profile', profile, '--dump-config'], `${phase}-dump`);
    await command('dsh', ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], `${phase}-host`, true);
    const disposed = JSON.parse(await readFile(resolve(runDir, `${phase}-disposed.json`), 'utf8'));
    assert.equal(disposed.disposed, true);
  }
  assert.equal(mock.requests.length, 4, 'target, child, online report, cold report');
  assert.ok(mock.requests.every(row => row.outcome === 'completed'));
  await writeFile(resolve(runDir, 'result.json'), JSON.stringify({ status: 'PASS', runDir, profile, mockRequests: mock.requests.length }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', runDir, profile, mockRequests: mock.requests.length }));
} catch (error) {
  await writeFile(resolve(runDir, 'failure.json'), JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', runDir, error: String(error) }));
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGKILL');
  await writeFile(resolve(runDir, 'commands.json'), JSON.stringify(exits, null, 2));
  await writeFile(resolve(runDir, 'mock.json'), JSON.stringify({ baseURL: mock.baseURL, requests: mock.requests.map(({ path, behavior, outcome }) => ({ path, behavior, outcome })),
    realModelRequests: 0, basis: 'Only enabled provider is explicitly configured to loopback; mock-only environment key.' }, null, 2));
  await mock.close();
  await writeFile(resolve(runDir, 'hashes.json'), JSON.stringify(await hashes(runDir), null, 2));
}
