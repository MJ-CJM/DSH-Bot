/** Run from the repository root. Uses only local profile, storage and mock HTTP. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, request } from 'node:http';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';

const root = process.cwd();
const home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
const runDir = process.env.DSH_BOT_E2E_DIR ?? resolve(home, 'p2/t17-limits', `${Date.now()}-${process.pid}`);
await mkdir(runDir, { recursive: true });
if (!process.env.DSH_BOT_E2E_DIR) await writeFile(resolve(home, 'p2/t17-limits/latest-run.txt'), `${runDir}\n`);
const profile = `t17-limits-${Date.now()}-${process.pid}`;
const mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: Array(21).fill('success'),
  chunkDelayMs: 5, successText: 'P2_LIMITS_COMPLETED' });
let held = 0; let released = false; let release!: () => void;
const gate = new Promise<void>(accept => { release = accept; });
const server = createServer(async (incoming, outgoing) => {
  if (incoming.url === '/gate-status') { outgoing.end(JSON.stringify({ held })); return; }
  if (incoming.url === '/release' && incoming.method === 'POST') { released = true; release(); outgoing.end('ok'); return; }
  const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  if (!released) { held++; await gate; }
  const upstream = request(new URL(incoming.url ?? '/', mock.baseURL), { method: incoming.method, headers: incoming.headers }, response => {
    outgoing.writeHead(response.statusCode ?? 500, response.headers); response.pipe(outgoing);
  });
  upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); upstream.end(body);
});
await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const baseURL = `http://127.0.0.1:${address.port}`;
const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(runDir, 'agents-home'),
  DSH_TELEMETRY_DISABLED: '1', XDG_STATE_HOME: resolve(home, 'state'), NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'),
  TMPDIR: resolve(home, 'tmp'), pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
  DSH_BOT_T17_MOCK_KEY: 't17-local-fixture', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: `${baseURL}/v1` };
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
      while (!closed && Date.now() < until && !/P2_LIMITS_(DONE|FAILED)/.test(output)) await delay(100);
      child.kill(crash && /P2_LIMITS_DONE/.test(output) ? 'SIGKILL' : 'SIGTERM');
    }
    const code = await done;
    await writeFile(resolve(runDir, `${name}.log`), redact(output));
    exits.push({ executable, args, name, code, signal: exitSignal });
    assert.equal(code, crash ? null : 0, `see ${name}.log`);
    if (crash) assert.equal(exitSignal, 'SIGKILL');
    if (live) assert.match(output, /P2_LIMITS_DONE/, `see ${name}.log and phase JSON`);
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
  await command('dsh', ['plugin', '--profile', profile, 'add', process.env.DSH_BOT_E2E_PACKAGE ?? resolve(root, 'packages/dsh-bot')], 'install-p1');
  for (const phase of ['first', 'cold']) {
    if (phase === 'cold') {
      const file = resolve(runDir, 'storages/dsh_bot_automation.json');
      const original = await readFile(file, 'utf8');
      await writeFile(resolve(runDir, 'automation-before-aging.json'), original);
      const data = JSON.parse(original);
      const fixtures = JSON.parse(await readFile(resolve(runDir, 'fixtures.json'), 'utf8'));
      const aged: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fixtures)) {
        const row = data.tables.routines[(value as { id: string }).id];
        const at = Date.now() - (key === 'within' ? 23 : 25) * 3600000;
        row.createdAt = at - 60000; row.updatedAt = at - 60000; row.anchorAt = at - 60000;
        if (row.rule.kind === 'at') { row.rule.at = at; row.nextRunAt = at; }
        aged[key] = row;
      }
      await writeFile(file, JSON.stringify(data));
      await writeFile(resolve(runDir, 'aged-fixtures.json'), JSON.stringify(aged, null, 2));
      await writeFile(resolve(runDir, 'p1-backup.json'), await readFile(resolve(runDir, 'storages/dsh_bot.json')));
      // Restore into a different, previously absent backend root. Keep the original intact.
      await cp(resolve(runDir, 'storages'), resolve(runDir, 'restored-storages'), { recursive: true, errorOnExist: true, force: false });
      await command('dsh', ['plugin', '--profile', profile, 'remove', 'dsh-bot'], 'uninstall');
      await command('dsh', ['plugin', '--profile', profile, 'add', process.env.DSH_BOT_E2E_PACKAGE ?? resolve(root, 'packages/dsh-bot')], 'reinstall');
    }
    const patch = [
      '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(runDir, phase === 'cold' ? 'restored-storages' : 'storages'))}`,
      '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'sessions'))}`,
      '- id: dsh-bot', '  config:', '    seedExamples: true', '    automation:', '      runTimeoutMs: 10000', '      executorPollMs: 25', '      stopGraceMs: 1000', `    dataDir: ${JSON.stringify(resolve(runDir, 'bots-data'))}`,
      '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-flash', '    reasoningEffort: off',
      '- id: llm-deepseek', '  config:', '    apiKeyEnv: DSH_BOT_T17_MOCK_KEY', `    baseURL: ${JSON.stringify(`${baseURL}/v1`)}`,
      '    thinking: disabled', '    reasoningEffort: off', '    maxTokens: 128',
      ...['llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry']
        .flatMap(id => [`- id: ${id}`, '  disabled: true']),
      '- insert:', '    - id: t17-limits-probe', `      name: ${JSON.stringify(resolve(root, 'packages/dsh-bot/tests', 'p2-limits-host.mjs'))}`, '      config:', `        outputDir: ${JSON.stringify(runDir)}`, `        phase: ${phase}`, `        baseURL: ${JSON.stringify(baseURL)}`,
    ].join('\n');
    await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
    await command('dsh', ['--profile', profile, '--dump-config'], `${phase}-dump`);
    await command('dsh', ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], `${phase}-host`, true);
    {
      const disposed = JSON.parse(await readFile(resolve(runDir, `${phase}-disposed.json`), 'utf8'));
      assert.equal(disposed.disposed, true);
    }
  }
  assert.equal(mock.requests.length, 21, '20 allowed quota runs and one within-24h catch-up; rejected runs have no requests');
  assert.ok(mock.requests.every(row => row.outcome === 'completed'));
  const before = JSON.parse(await readFile(resolve(runDir, 'p1-backup.json'), 'utf8'));
  const after = JSON.parse(await readFile(resolve(runDir, 'restored-storages/dsh_bot.json'), 'utf8'));
  for (const table of ['bots', 'memories']) assert.deepEqual(after.tables[table], before.tables[table]);
  await writeFile(resolve(runDir, 'p1-preserved.json'), JSON.stringify({ status: 'PASS', tables: ['bots', 'memories'] }));
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
  release(); server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept()));
  await mock.close();
  await writeFile(resolve(runDir, 'hashes.json'), JSON.stringify(await hashes(runDir), null, 2));
}
