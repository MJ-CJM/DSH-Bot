/** Run from repository root with DSH_HOME=$PWD/.dsh-dev. Loopback models only. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { resolve, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';

const root = process.cwd(); const home = resolve(root, '.dsh-dev'); assert.equal(process.env.DSH_HOME, home);
const runDir = process.env.DSH_BOT_E2E_DIR ?? resolve(home, 'p2/r03', `${Date.now()}-${process.pid}`);
await mkdir(runDir, { recursive: true }); if (!process.env.DSH_BOT_E2E_DIR) await writeFile(resolve(home, 'p2/r03/latest-run.txt'), `${runDir}\n`);
const profile = `r03-${Date.now()}-${process.pid}`;
const delegateArgs = JSON.stringify({ targetBotId: 'researcher', task: 'R03_TARGET_TASK', title: 'R03 research' });
const originMock = await startMockLlmServer({ host: '127.0.0.1', port: 0,
  sequence: ['tool_call_success', 'success', 'success'], chunkDelayMs: 30,
  toolName: 'bot_delegate', toolArguments: delegateArgs,
  successText: 'R03_ORIGIN_COMPLETED' });
const targetMock = await startMockLlmServer({ host: '127.0.0.1', port: 0,
  sequence: ['tool_call_success', 'slow_success'], chunkDelayMs: 50, toolName: 'bot_delegate', toolArguments: delegateArgs,
  successText: 'R03_TARGET_COMPLETED' });
const routing: { target: string; body: unknown }[] = [];
const server = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks); const parsed = JSON.parse(body.toString());
  // Inspect only message contents: tool schemas also contain the tool argument names.
  const messages = JSON.stringify(parsed.messages);
  const route = messages.includes('R03_PARENT_PRIVATE_HISTORY') ? 'origin' : messages.includes('R03_TARGET_TASK') ? 'target' : 'cold';
  routing.push({ target: route, body: parsed });
  assert.notEqual(route, 'cold', 'unexpected model request');
  const mock = route === 'origin' ? originMock : targetMock;
  const upstream = request(new URL(incoming.url ?? '/', mock.baseURL), { method: incoming.method, headers: incoming.headers }, response => {
    outgoing.writeHead(response.statusCode ?? 500, response.headers); response.pipe(outgoing);
  });
  upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); upstream.end(body);
});
await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const baseURL = `http://127.0.0.1:${address.port}`;
const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(runDir, 'agents-home'), DSH_TELEMETRY_DISABLED: '1',
  XDG_STATE_HOME: resolve(home, 'state'), NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'), TMPDIR: resolve(home, 'tmp'),
  pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
  DSH_BOT_R03_MOCK_KEY: 'r03-local-fixture', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: `${baseURL}/v1` };
const redact = (text: string) => stripVTControlCharacters(text).replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[REDACTED]')
  .replace(/((?:authorization|set-cookie|cookie)\s*[:=])[^\r\n]+/gi, '$1 [REDACTED]');
const children = new Set<ReturnType<typeof spawn>>(); const exits: unknown[] = [];
async function command(args: string[], name: string, live = false) {
  const child = spawn(resolve(root, 'scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
  let output = ''; let closed = false;
  const done = new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('close', code => { closed = true; children.delete(child); accept(code); }); });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  try {
    if (live) { const until = Date.now() + 150000; while (!closed && Date.now() < until && !/R03_(DONE|FAILED)/.test(output)) await delay(100); child.kill('SIGTERM'); }
    const code = await done; await writeFile(resolve(runDir, `${name}.log`), redact(output)); exits.push({ args, name, code });
    assert.equal(code, 0, `see ${name}.log`); if (live) assert.match(output, /R03_DONE/, `see ${name}.log and phase fatal JSON`);
  } finally { clearTimeout(timer); if (!closed) child.kill('SIGKILL'); }
}
async function hashes(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of await readdir(dir)) { const path = resolve(dir, name); if ((await stat(path)).isDirectory()) Object.assign(result, await hashes(path));
    else result[relative(runDir, path)] = createHash('sha256').update(await readFile(path)).digest('hex'); }
  return result;
}
try {
  await command(['--version'], 'version');
  await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await command(['plugin', '--profile', profile, 'add', process.env.DSH_BOT_E2E_PACKAGE ?? resolve(root, 'packages/dsh-bot')], 'install');
  for (const phase of ['native']) {
    const patch = [
      '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'storages'))}`,
      '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'sessions'))}`,
      '- id: dsh-bot', '  config:', '    seedExamples: true', `    dataDir: ${JSON.stringify(resolve(runDir, 'bots-data'))}`,
      '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-flash', '    reasoningEffort: off',
      '- id: llm-deepseek', '  config:', '    apiKeyEnv: DSH_BOT_R03_MOCK_KEY', `    baseURL: ${JSON.stringify(`${baseURL}/v1`)}`,
      '    thinking: disabled', '    reasoningEffort: off', '    maxTokens: 128',
      ...['llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
      '- insert:', '    - id: r03-probes', `      name: ${JSON.stringify(resolve(root, 'packages/dsh-bot/tests/delegate-profile-host.mjs'))}`,
      '      config:', `        outputDir: ${JSON.stringify(runDir)}`, `        phase: ${phase}`, `        baseURL: ${JSON.stringify(baseURL)}`,
    ].join('\n');
    await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
    await command(['--profile', profile, '--dump-config'], `${phase}-dump`);
    await command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], `${phase}-host`, true);
  }
  assert.ok(originMock.requests.length >= 2); assert.equal(targetMock.requests.length, 2);
  assert.ok(routing.filter(r => r.target === 'target').every(r => JSON.stringify(r.body).includes('R03_TARGET_PERSONA')));
  const targetView = await readFile(resolve(runDir, 'target.json'), 'utf8');
  assert.ok(targetView.includes('automation/depth'), 'native child cannot delegate recursively');
  assert.ok(targetView.includes('approval/policy') && targetView.includes('never'), 'native delegated approval policy');
  assert.ok(routing.filter(r => r.target === 'target').every(r => !JSON.stringify(r.body).includes('R03_PARENT_PRIVATE_HISTORY')));
  await writeFile(resolve(runDir, 'result.json'), JSON.stringify({ status: 'PASS', runDir, profile, mockRequests: routing.length, realModelRequests: 0 }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', runDir, mockRequests: routing.length }));
} catch (error) {
  await writeFile(resolve(runDir, 'failure.json'), JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', runDir, error: String(error) })); process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGKILL');
  await writeFile(resolve(runDir, 'commands.json'), JSON.stringify(exits, null, 2));
  // Bodies contain only deliberate mock fixtures. Never persist authorization headers.
  await writeFile(resolve(runDir, 'mock.json'), JSON.stringify({ baseURL, routing, realModelRequests: 0,
    basis: 'Only enabled provider points to loopback; test-only key; no browser or real provider session.' }, null, 2));
  server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept()));
  await Promise.all([originMock.close(), targetMock.close()]);
  await writeFile(resolve(runDir, 'hashes.json'), JSON.stringify(await hashes(runDir), null, 2));
}
