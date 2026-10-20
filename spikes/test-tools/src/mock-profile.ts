/** Creates a fresh Web profile with an explicit loopback provider. Logs are redacted before persistence. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';

const root = process.cwd();
const home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
const profile = `t02-mock-${Date.now()}`;
const directory = resolve(home, 't02-review', profile);
await mkdir(directory, { recursive: true });
await mkdir(resolve(home, 'tmp'), { recursive: true });
const mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: ['success'], successText: 'T02_ROUTINE_MOCK_OK', randomSeed: 2 });
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
  XDG_STATE_HOME: resolve(home, 'state'), NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'),
  TMPDIR: resolve(home, 'tmp'), pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
  DSH_BOT_MOCK_KEY: 'mock-key', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`,
};
function redact(text: string) {
  return stripVTControlCharacters(text).replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|set-cookie|cookie)\s*[:=])[^\r\n]+/gi, '$1 [REDACTED]');
}
async function cli(args: string[], filename: string, live = false) {
  const child = spawn(resolve(root, 'scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  let closed = false;
  const done = new Promise<number | null>((accept, reject) => {
    child.on('error', reject);
    child.on('close', code => { closed = true; accept(code); });
  });
  // Accumulate in memory, redact the entire log before writing (including split token lines).
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { text += chunk.toString(); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (live) {
      const deadline = Date.now() + 100_000;
      while (!closed && Date.now() < deadline && !/T02_MOCK_(DONE|FAILED)/.test(text)) await new Promise(accept => setTimeout(accept, 100));
      child.kill('SIGTERM');
      timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    }
    const code = await done;
    await writeFile(resolve(directory, filename), redact(text));
    assert.equal(code, 0, `CLI exit; see ${filename}`);
    if (live) assert.match(text, /T02_MOCK_DONE/);
  } finally { if (timer) clearTimeout(timer); if (!closed) child.kill('SIGKILL'); }
}
try {
  await cli(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initial-dump.yml');
  const patch = [
    '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n    reasoningEffort: off',
    `- id: llm-deepseek\n  config:\n    apiKeyEnv: DSH_BOT_MOCK_KEY\n    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}\n    thinking: disabled\n    reasoningEffort: off\n    maxTokens: 128`,
    ...['llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].map(id => `- id: ${id}\n  disabled: true`),
    `- insert:\n    - id: t02-mock-host\n      name: ${JSON.stringify(resolve(root, 'spikes/p1-api/lib/mock-host.js'))}\n      config: ${JSON.stringify({ cwd: root, outputDir: directory, expectedReply: 'T02_ROUTINE_MOCK_OK', baseURL: `${mock.baseURL}/v1` })}`,
  ].join('\n');
  await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), `\n${patch}\n`);
  await cli(['--profile', profile, '--dump-config'], 'dump.yml');
  await cli(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'host.log', true);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0]?.outcome, 'completed');
  const result = { profile, directory, requests: mock.requests.map(({ path, behavior, outcome }) => ({ path, behavior, outcome })),
    session: JSON.parse(await readFile(resolve(directory, 'session-result.json'), 'utf8')) };
  await writeFile(resolve(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally { await mock.close(); }
