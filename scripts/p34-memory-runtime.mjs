#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { captureManagement } from '../packages/dsh-bot/scripts/management-browser.mjs';
const root = process.cwd(),
  home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { startMockLlmServer } = await import(require.resolve('@deepseek-ai/dsh-llm-mock-server'));
const mock = await startMockLlmServer({
  host: '127.0.0.1',
  port: 0,
  sequence: ['tool_call_success', 'success'],
  toolName: 'mcp__bot_memory_graph__search_nodes',
  toolArguments: '{"query":"oolong"}',
  repeatLast: true,
  successText: 'P34_MEMORY_FAKE_REPLY',
});
const runDir = process.env.DSH_BOT_E2E_DIR ? resolve(process.env.DSH_BOT_E2E_DIR) : resolve(home, 'p34-u09-11', `runtime-${Date.now()}-${process.pid}`);
await mkdir(runDir, { recursive: true });
await writeFile(resolve(home, 'p34-u09-11/latest-runtime.txt'), `${runDir}\n`);
const profile = `p34-memory-${Date.now()}-${process.pid}`;
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  USER: process.env.USER,
  SHELL: process.env.SHELL,
  DSH_HOME: home,
  DSH_AGENTS_HOME: resolve(runDir, 'agents-home'),
  DSH_TELEMETRY_DISABLED: '1',
  XDG_STATE_HOME: resolve(runDir, 'state'),
  NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'),
  TMPDIR: resolve(home, 'tmp'),
  pnpm_config_store_dir: resolve(home, 'pnpm-store'),
  pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
  P34_MODEL_KEY: 'synthetic-loopback',
  P34_MEMORY_ALPHA_SECRET: 'synthetic-alpha',
  P34_MEMORY_BETA_SECRET: 'synthetic-beta',
  DEEPSEEK_API_KEY: '',
};
const children = new Set(),
  commands = [],
  modelPhases = [];
const save = (file, value) => writeFile(resolve(runDir, file), JSON.stringify(value, null, 2));
async function command(executable, args, name, live = false) {
  const child = spawn(resolve(root, `scripts/${executable}`), args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '',
    closed = false;
  const done = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      closed = true;
      children.delete(child);
      accept(code);
    });
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output += chunk;
      if (live)
        for (const line of String(chunk).split('\n'))
          if (/GROUP_CLOSE|P34_MEMORY_/.test(line)) console.log(`${name}: ${line}`);
    });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  try {
    if (live) {
      const until = Date.now() + 150000;
      while (!closed && Date.now() < until && !/P34_MEMORY_(READY|FAILED)/.test(output)) await delay(100);
      if (name === 'first-host' && output.includes('P34_MEMORY_READY')) {
        let result;
        try {
          const url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1];
          assert.ok(url);
          result = await captureManagement(url, runDir, env);
        } catch (error) {
          result = {
            status: 'FAIL',
            reason: String(error).slice(0, 250) + '\n...\n' + String(error).slice(-1800),
          };
        }
        await save('browser.json', result);
      }
      await writeFile(resolve(runDir, `${name.startsWith('first') ? 'first' : 'cold'}-finish`), 'finish');
      while (!closed && Date.now() < until && !/P34_MEMORY_(DONE|FAILED)/.test(output)) await delay(100);
      child.kill('SIGTERM');
    }
    const code = await done;
    await writeFile(resolve(runDir, `${name}.log`), output.replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]'));
    commands.push({ executable, args, name, code });
    assert.equal(code, 0, `see ${name}.log`);
    if (live) {
      assert.match(output, /P34_MEMORY_DONE/, `see ${name}.log`);
      assert.equal(
        JSON.parse(await readFile(resolve(runDir, `${name.startsWith('first') ? 'first' : 'cold'}-disposed.json`)))
          .status,
        'PASS',
      );
    }
    console.log(`${name}: PASS`);
  } finally {
    clearTimeout(timer);
    if (!closed) child.kill('SIGKILL');
  }
}
try {
  await command('dsh', ['--version'], 'version');
  if (!process.env.DSH_BOT_E2E_PACKAGE) await command('pnpm', ['-C', 'packages/dsh-bot', 'pack', '--pack-destination', runDir], 'pack-bot');
  const version = JSON.parse(await readFile(resolve(root, 'packages/dsh-bot/package.json'))).version;
  const botArchive = process.env.DSH_BOT_E2E_PACKAGE ?? resolve(runDir, `dsh-bot-${version}.tgz`);
  await command('dsh', ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await command('dsh', ['plugin', '--profile', profile, 'add', botArchive], 'install-bot');
  for (const file of ['host/reference-memory/service.js', 'host/workspace/service.js', 'client.js']) {
    assert.deepEqual(
      await readFile(resolve(home, 'profiles', profile, 'node_modules/dsh-bot/lib', file)),
      await readFile(resolve(root, 'packages/dsh-bot/lib', file)),
    );
  }
  await save('installed.json', {
    archiveSha256: createHash('sha256')
      .update(await readFile(botArchive))
      .digest('hex'),
    installedBytesMatch: true,
  });
  for (const phase of ['first', 'cold']) {
    const patch = [
      '- id: storage-json',
      '  config:',
      `    root: ${JSON.stringify(resolve(runDir, 'storages'))}`,
      '- id: session-persistence-jsonl',
      '  config:',
      `    root: ${JSON.stringify(resolve(runDir, 'sessions'))}`,
      '- id: credentials-local',
      '  config:',
      `    path: ${JSON.stringify(resolve(runDir, 'synthetic-credentials.yaml'))}`,
      '    watch: false',
      '- id: dsh-bot',
      '  config:',
      '    seedExamples: false',
      `    dataDir: ${JSON.stringify(resolve(runDir, 'bots-data'))}`,
      '    groupContextMaxBytes: 1024',
      '- id: agent-default-model',
      '  config:',
      '    provider: deepseek-official',
      '    model: deepseek-flash',
      '    reasoningEffort: off',
      '- id: llm-deepseek',
      '  config:',
      '    apiKeyEnv: P34_MODEL_KEY',
      `    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}`,
      '    thinking: disabled',
      '    reasoningEffort: off',
      '    maxTokens: 128',
      ...[
        'llm-deepseek-account',
        'llm-pi-ai',
        'session-title-llm',
        'llm-retry',
        'session-log-deepseek',
        'session-telemetry-otel',
        'desktop-product-telemetry',
      ].flatMap((id) => [`- id: ${id}`, '  disabled: true']),
      '- insert:',
      '    - id: p34-memory-probes',
      `      name: ${JSON.stringify(resolve(root, 'packages/dsh-bot/tests/integration-memory-profile.mjs'))}`,
      '      config:',
      `        outputDir: ${JSON.stringify(runDir)}`,
      `        phase: ${phase}`,
    ].join('\n');
    await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
    await command('dsh', ['--profile', profile, '--dump-config'], `${phase}-dump`);
    await command(
      'dsh',
      ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'],
      `${phase}-host`,
      true,
    );
    modelPhases.push({ phase, cumulativeMockRequests: mock.requests.length });
  }
  assert.equal(mock.requests.length, 3);
  assert.ok(mock.requests.every((r) => JSON.stringify(r.body).includes('P34_MEMORY_MODEL_ONLY')));
  assert.ok(JSON.stringify(mock.requests[1].body).includes('Alpha likes oolong tea'));
  assert.ok(!JSON.stringify(mock.requests[2].body).includes('mcp__bot_memory_graph__'));
  assert.ok(JSON.stringify(mock.requests[2].body).includes('memory_save'));

  await save('summary.json', {
    status: 'PASS',
    runDir,
    profile,
    modelRequests: mock.requests.length,
    toolResultUsedInNextRequest: true,
    realModelRequests: 0,
    browser: JSON.parse(await readFile(resolve(runDir, 'browser.json'))).status,
  });
  console.log(JSON.stringify({ status: 'PASS', runDir }));
} catch (error) {
  await save('failure.json', { error: String(error), stack: error.stack });
  console.log(JSON.stringify({ status: 'FAIL', runDir, error: String(error) }));
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGKILL');
  await save('mock-metadata.json', {
    count: mock.requests.length,
    phases: modelPhases,
    requests: mock.requests.map((r) => ({
      path: r.path,
      outcome: r.outcome,
      behavior: r.behavior,
      worker: JSON.stringify(r.body).includes('P34_MEMORY_ONLY'),
    })),
  });
  await mock.close();
  await save('commands.json', commands);
}
