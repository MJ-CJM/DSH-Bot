import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Real DSH Web profile and shipped Client; all data and credentials paths are isolated under .dsh-dev. */
export async function webHost(dir, suite) {
  const root = process.cwd(), commands = [], children = new Set(), profile = 'b4-browser';
  const env = { PATH: process.env.PATH, USER: 'synthetic', SHELL: process.env.SHELL,
    HOME: resolve(dir, 'environment-home'), DSH_HOME: resolve(dir, 'home'), TMPDIR: resolve(dir, 'tmp'),
    DSH_AGENTS_HOME: resolve(dir, 'agents-home'), XDG_STATE_HOME: resolve(dir, 'state'),
    DSH_TELEMETRY_DISABLED: '1', pnpm_config_offline: 'true',
    pnpm_config_store_dir: resolve(root, '.dsh-dev/pnpm-store'), pnpm_config_cache_dir: resolve(root, '.dsh-dev/pnpm-cache') };
  await mkdir(env.HOME, { recursive: true }); await mkdir(env.TMPDIR, { recursive: true });
  let count = 0, startupMs;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(req.url, '/capture'); JSON.parse(body); count++;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  await new Promise((accept, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', accept);
  });
  env.DP_MOCK_PORT = String(server.address().port); env.DP_NETWORK_RECEIPT = resolve(dir, 'network-denials.jsonl');
  const endpoint = `http://127.0.0.1:${server.address().port}/capture`;
  async function command(args, label, live = false) {
    const started = Date.now();
    const child = spawn(resolve(root, 'scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let output = '', closed = false;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output += b; });
    const done = new Promise((accept, reject) => {
      child.on('error', reject); child.on('close', code => { children.delete(child); closed = true; accept(code); });
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), live ? 300000 : 90000);
    const save = async () => {
      const code = await done; clearTimeout(timer);
      await writeFile(resolve(dir, `${label}.log`), output.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]'));
      commands.push({ args, label, code, durationMs: Date.now() - started, startupMs: live ? startupMs : undefined }); return code;
    };
    if (!live) { assert.equal(await save(), 0, `See ${label}.log`); return; }
    child.once('close', () => { void save(); });
    const deadline = Date.now() + 60000;
    while (!closed && !/B4_WEB_(READY|FAILED)/.test(output) && Date.now() < deadline) await delay(50);
    startupMs = Date.now() - started;
    assert.match(output, /B4_WEB_READY/, `Host fixture failed: ${dir}`);
    const url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1];
    assert.ok(url); return url;
  }
  const stop = async () => {
    for (const child of children) child.kill('SIGTERM');
    for (let i = 0; children.size && i < 100; i++) await delay(50);
    for (const child of children) child.kill('SIGKILL');
    server.closeAllConnections(); await new Promise(accept => server.close(accept));
    await writeFile(resolve(dir, 'commands.json'), JSON.stringify(commands, null, 2));
  };
  try {
    await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
    await command(['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'install');
    const patch = [
      '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(dir, 'storage'))}`,
      '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(dir, 'sessions'))}`,
      '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(dir, 'synthetic-credentials.yml'))}`, '    watch: false',
      '- id: dsh-bot', '  config:', '    seedExamples: false', `    dataDir: ${JSON.stringify(resolve(dir, 'bots'))}`,
      '- id: agent-default-model', '  config:', '    provider: dp-loopback', '    model: fixture',
      ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry',
        'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
      '- insert:', '    - id: b4-web-fixture',
      `      name: ${JSON.stringify(resolve(root, 'packages/dsh-bot/tests/deepening/b4-web-profile.mjs'))}`,
      '      config:', `        outputDir: ${JSON.stringify(dir)}`, `        endpoint: ${JSON.stringify(endpoint)}`, `        suite: ${suite}`,
    ].join('\n');
    await writeFile(resolve(env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
    const url = await command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'host', true);
    return { url, env, stop, startupMs, requests: () => count };
  } catch (error) { await stop(); throw error; }
}
