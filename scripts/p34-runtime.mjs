#!/usr/bin/env node
import assert from 'node:assert/strict';
import { captureP34 } from '../packages/dsh-bot/scripts/p34-browser.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.cwd(); const home = resolve(root, '.dsh-dev'); assert.equal(process.env.DSH_HOME, home);
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { startMockLlmServer } = await import(require.resolve('@deepseek-ai/dsh-llm-mock-server'));
const mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: ['tool_call_success', 'slow_success'], repeatLast: true, chunkDelayMs: 60,
  toolName: 'bot_notify', toolArguments: JSON.stringify({ policyId: 'local-alpha', text: 'P34_PRODUCT_REPORT' }), successText: 'P34_PRODUCT_COMPLETED' });
const runDir = resolve(home, 'p34-u02-03', `runtime-${Date.now()}-${process.pid}`); await mkdir(runDir, { recursive: true });
await writeFile(resolve(home, 'p34-u02-03/latest-runtime.txt'), `${runDir}\n`);
const profile = `p34-product-${Date.now()}-${process.pid}`;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, SHELL: process.env.SHELL,
  DSH_HOME: home, DSH_AGENTS_HOME: resolve(runDir, 'agents-home'), DSH_TELEMETRY_DISABLED: '1', XDG_STATE_HOME: resolve(runDir, 'state'),
  NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'), TMPDIR: resolve(home, 'tmp'), pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
  P34_ALPHA_TOKEN: `P34_PRODUCT_SENTINEL_${randomUUID()}`, P34_BETA_TOKEN: `P34_PRODUCT_SENTINEL_${randomUUID()}`, P34_MODEL_KEY: 'synthetic-loopback', DEEPSEEK_API_KEY: '' };
const children = new Set(); const commands = [];
async function command(args, name, live = false) {
  const child = spawn(resolve(root, 'scripts/dsh'), args, { cwd: root, env, stdio: ['ignore','pipe','pipe'] }); children.add(child);
  let output = '', closed = false; const done = new Promise((accept, reject) => { child.once('error', reject); child.once('close', code => { closed = true; children.delete(child); accept(code); }); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => output += chunk);
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  try {
    if (live) { const until = Date.now() + 150000; while (!closed && Date.now() < until && !/P34_PRODUCT_(DONE|FAILED)/.test(output)) await delay(100); if (name === 'first-host' && output.includes('P34_PRODUCT_DONE')) {
        const url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1];
        let result;
        try { assert.ok(url); result = await captureP34(url, runDir, env); }
        catch (error) { result = { status: 'FAIL', reason: String(error).slice(0, 250) + '\n...\n' + String(error).slice(-1800) }; }
        await writeFile(resolve(runDir, 'browser.json'), JSON.stringify(result, null, 2));
      }
      child.kill('SIGTERM'); }
    const code = await done; const leak = Object.entries(env).filter(([key]) => key.startsWith('P34_') && key.endsWith('_TOKEN')).some(([, secret]) => output.includes(secret));
    await writeFile(resolve(runDir, `${name}.log`), output.replace(/P34_PRODUCT_SENTINEL_[a-f0-9-]{36}/g, '[SENTINEL_LEAK]'));
    commands.push({ args, name, code, leak }); assert.equal(leak, false); assert.equal(code, 0, `see ${name}.log`); if (live) assert.match(output, /P34_PRODUCT_DONE/, `see ${name}.log`);
    console.log(`${name}: PASS`);
  } finally { clearTimeout(timer); if (!closed) child.kill('SIGKILL'); }
}
async function scan(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink() || e.name === 'node_modules') continue;
    const path = resolve(dir, e.name); if (e.isDirectory()) await scan(path); else {
      const data = await readFile(path, 'utf8'); assert.ok(!/P34_PRODUCT_SENTINEL_[a-f0-9-]{36}/.test(data), `secret in ${path}`);
    }
  }
}
try {
  await command(['--version'], 'version');
  await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await command(['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'install');
  for (const phase of ['first','cold']) {
    const patch = [
      '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'storages'))}`,
      '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'sessions'))}`,
      '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(runDir, 'synthetic-credentials.yaml'))}`, '    watch: false',
      '- id: dsh-bot', '  config:', '    seedExamples: false', `    dataDir: ${JSON.stringify(resolve(runDir, 'bots-data'))}`,
      '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-flash', '    reasoningEffort: off',
      '- id: llm-deepseek', '  config:', '    apiKeyEnv: P34_MODEL_KEY', `    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}`, '    thinking: disabled', '    reasoningEffort: off', '    maxTokens: 128',
      ...['llm-deepseek-account','llm-pi-ai','session-title-llm','llm-retry','session-log-deepseek','session-telemetry-otel','desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
      '- insert:', '    - id: p34-product-probes', `      name: ${JSON.stringify(resolve(root, 'packages/dsh-bot/tests/integration-profile-host.mjs'))}`, '      config:', `        outputDir: ${JSON.stringify(runDir)}`, `        phase: ${phase}`,
    ].join('\n');
    await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
    await command(['--profile', profile, '--dump-config'], `${phase}-dump`);
    await command(['--profile', profile, '--no-open', '--host','127.0.0.1','--port','0'], `${phase}-host`, true);
  }
  await scan(runDir); await scan(resolve(home, 'profiles', profile)); await scan(resolve(root, 'packages/dsh-bot/lib'));
  assert.equal(mock.requests.length, 2);
  await writeFile(resolve(runDir, 'summary.json'), JSON.stringify({ status: 'PASS', profile, runDir, modelRequests: mock.requests.length, modelPaths: mock.requests.map(r => r.path), realModelRequests: 0, browser: JSON.parse(await readFile(resolve(runDir, 'browser.json'), 'utf8')).status }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', runDir, profile }));
} catch (error) { await writeFile(resolve(runDir, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack }, null, 2)); console.log(JSON.stringify({ status: 'FAIL', runDir, error: String(error) })); process.exitCode = 1; }
finally { for (const c of children) c.kill('SIGKILL'); await mock.close(); await writeFile(resolve(runDir, 'commands.json'), JSON.stringify(commands, null, 2)); }
