/** Run from the repository root. Uses only local profile, storage and mock HTTP. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';

const root = process.cwd();
const home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
const runDir = resolve(home, 'p2/t14', `${Date.now()}-${process.pid}`);
await mkdir(runDir, { recursive: true });
await writeFile(resolve(home, 'p2/t14/latest-run.txt'), `${runDir}\n`);
const profile = `t14-${Date.now()}-${process.pid}`;
const mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: ['success', 'success', 'success', 'success'], chunkDelayMs: 30,
  successText: 'T14_LOOPBACK_COMPLETED', randomSeed: 11 });
const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(runDir, 'agents-home'),
  DSH_TELEMETRY_DISABLED: '1', XDG_STATE_HOME: resolve(home, 'state'), NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'),
  TMPDIR: resolve(home, 'tmp'), pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
  DSH_BOT_T14_MOCK_KEY: 't14-local-fixture', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: `${mock.baseURL}/v1` };
const redact = (text: string) => stripVTControlCharacters(text).replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[REDACTED]')
  .replace(/((?:authorization|set-cookie|cookie)\s*[:=])[^\r\n]+/gi, '$1 [REDACTED]');
const children = new Set<ReturnType<typeof spawn>>();
const exits: unknown[] = [];
async function command(executable: 'dsh' | 'pnpm', args: string[], name: string, live = false, crash = false) {
  const child = spawn(resolve(root, `scripts/${executable}`), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = ''; let closed = false; let exitSignal: NodeJS.Signals | null = null;
  const done = new Promise<number | null>((accept, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { exitSignal = signal; closed = true; children.delete(child); accept(code); });
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output += chunk.toString(); });
  const kill = setTimeout(() => child.kill('SIGKILL'), 240000);
  try {
    if (live) {
      const until = Date.now() + 210000;
      let paused = false;
      while (!closed && Date.now() < until && !/T14_(DONE|FAILED)/.test(output)) {
        if (!paused && /T14_PAUSE_READY/.test(output)) {
          paused = true;
          const receipt = JSON.parse(await readFile(resolve(runDir, 'pause-ready.json'), 'utf8'));
          const before = mock.requests.length;
          process.kill(receipt.pid, 'SIGSTOP');
          console.log('T14_PROCESS_STOP_65S');
          try { await delay(65000); assert.equal(mock.requests.length, before); }
          finally { process.kill(receipt.pid, 'SIGCONT'); }
          await writeFile(resolve(runDir, 'pause-process.json'), JSON.stringify({ pid: receipt.pid, durationMs: 65000, requestsBefore: before, requestsWhileStopped: mock.requests.length }));
        }
        await delay(100);
      }
      child.kill(crash && /T14_DONE/.test(output) ? 'SIGKILL' : 'SIGTERM');
    }
    const code = await done;
    await writeFile(resolve(runDir, `${name}.log`), redact(output));
    exits.push({ executable, args, name, code, signal: exitSignal });
    assert.equal(code, crash ? null : 0, `see ${name}.log`);
    if (crash) assert.equal(exitSignal, 'SIGKILL');
    if (live) assert.match(output, /T14_DONE/, `see ${name}.log and phase JSON`);
    return output;
  } finally { clearTimeout(kill); if (!closed) child.kill('SIGKILL'); }
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
  await command('dsh', ['--version'], 'version');
  await command('dsh', ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await command('dsh', ['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'install-p1');
  for (const phase of ['first', 'cold']) {
    if (phase === 'cold') {
      console.log('T14_OFFLINE_WAIT_125S');
      await delay(125000);
    }
    const patch = [
      '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'storages'))}`,
      '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'sessions'))}`,
      '- id: dsh-bot', '  config:', '    seedExamples: true', '    automation:', '      runTimeoutMs: 10000', '      executorPollMs: 25', '      stopGraceMs: 1000', `    dataDir: ${JSON.stringify(resolve(runDir, 'bots-data'))}`,
      '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-flash', '    reasoningEffort: off',
      '- id: llm-deepseek', '  config:', '    apiKeyEnv: DSH_BOT_T14_MOCK_KEY', `    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}`,
      '    thinking: disabled', '    reasoningEffort: off', '    maxTokens: 128',
      ...['llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry']
        .flatMap(id => [`- id: ${id}`, '  disabled: true']),
      '- insert:', '    - id: t14-probes', `      name: ${JSON.stringify(resolve(root, 'packages/dsh-bot/tests', 'dispatcher-profile-host.mjs'))}`, '      config:', `        outputDir: ${JSON.stringify(runDir)}`, `        phase: ${phase}`, `        baseURL: ${JSON.stringify(mock.baseURL)}`,
    ].join('\n');
    await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
    await command('dsh', ['--profile', profile, '--dump-config'], `${phase}-dump`);
    await command('dsh', ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], `${phase}-host`, true);
    {
      const disposed = JSON.parse(await readFile(resolve(runDir, `${phase}-disposed.json`), 'utf8'));
      assert.equal(disposed.disposed, true);
    }
  }
  assert.equal(mock.requests.length, 4, 'every60, paused run_now, restart latest, process resume');
  assert.ok(mock.requests.every(row => row.path === '/v1/messages'));
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
