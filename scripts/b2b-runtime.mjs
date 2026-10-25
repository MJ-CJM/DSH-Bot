#!/usr/bin/env node
// Isolated rc.2 Web Host probe. All model traffic terminates on this loopback SSE fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.cwd(),
  home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
const kind = process.argv[2] ?? 'spike';
assert.ok(['spike', 'host'].includes(kind));
const dir = resolve(home, 'b2b', `${kind}-${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
let script = [],
  count = 0,
  router = false;
const routeCounts = { alpha: 0, beta: 0 };
const requests = [],
  children = new Set(),
  commands = [];
const server = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    if (req.url === '/control') {
      script.push(...body);
      res.end('{}');
      return;
    }
    if (req.url === '/stats') {
      res.end(JSON.stringify(requests));
      return;
    }
    assert.match(req.url, /^\/v1\/messages$/);
    let action = script.shift() ?? { text: 'B2B_MOCK_OK' };
    if (action.route === false) {
      router = false;
      delete action.route;
    } else if (action.route === true) {
      router = true;
      action = {};
    }
    if (router) {
      const wire = JSON.stringify(body),
        owner = wire.includes('B2B_PERSONA_alpha') ? 'alpha' : 'beta';
      const n = ++routeCounts[owner];
      if (owner === 'alpha' && n === 1)
        action = {
          tool: 'bot_message',
          args: {
            action: 'send',
            to: 'beta',
            content: 'B2B_QUESTION',
            mode: 'ask',
          },
        };
      else if (owner === 'beta' && n === 1) {
        const texts = [];
        const collect = (v) => {
          if (typeof v === 'string') texts.push(v);
          else if (Array.isArray(v)) v.forEach(collect);
          else if (v && typeof v === 'object') Object.values(v).forEach(collect);
        };
        collect(body);
        const ask = texts.join('\n').match(/replyTo="([^"]+)"/)?.[1];
        assert.ok(ask);
        action = {
          tool: 'bot_message',
          args: { action: 'reply', replyTo: ask, content: 'B2B_TARGET_ANSWER' },
          delay: 250,
        };
      } else
        action = {
          text:
            owner === 'alpha'
              ? n === 2
                ? 'B2B_A_QUEUED'
                : 'B2B_A_TOLD_USER B2B_TARGET_ANSWER'
              : 'B2B_B_REPLIED',
        };
    }
    const r = { index: ++count, body, action, outcome: 'running' };
    requests.push(r);
    res.on('close', () => {
      if (r.outcome === 'running') r.outcome = 'aborted';
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    send({
      type: 'message_start',
      message: {
        id: `mock-${count}`,
        type: 'message',
        role: 'assistant',
        model: 'mock-model',
        content: [],
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    });
    if (action.stall) return;
    if (action.delay) await delay(action.delay);
    if (action.tool) {
      send({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: `call-${count}`,
          name: action.tool,
          input: {},
        },
      });
      send({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(action.args),
        },
      });
    } else {
      send({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      send({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: action.text ?? 'B2B_MOCK_OK' },
      });
    }
    send({ type: 'content_block_stop', index: 0 });
    send({
      type: 'message_delta',
      delta: {
        stop_reason: action.tool ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: 2 },
    });
    send({ type: 'message_stop' });
    r.outcome = 'completed';
    res.end();
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${server.address().port}`;
const profile = `b2b-${kind}-${Date.now()}-${process.pid}`;
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  USER: process.env.USER,
  SHELL: process.env.SHELL,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  DSH_AGENTS_HOME: resolve(dir, 'agents-home'),
  XDG_STATE_HOME: resolve(dir, 'state'),
  NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'),
  TMPDIR: resolve(home, 'tmp'),
  pnpm_config_store_dir: resolve(home, 'pnpm-store'),
  pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
  B2B_MOCK_KEY: 'synthetic-loopback',
  DEEPSEEK_API_KEY: '',
};
async function command(args, name, live = false) {
  const child = spawn(resolve(root, 'scripts/dsh'), args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '',
    closed = false;
  const done = new Promise((r, j) => {
    child.on('error', j);
    child.on('close', (c) => {
      closed = true;
      children.delete(child);
      r(c);
    });
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (c) => (output += c));
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  try {
    if (live) {
      const until = Date.now() + 100000;
      while (!closed && Date.now() < until && !/B2B_(DONE|FAILED)/.test(output)) await delay(50);
      child.kill(name === 'first-host' && output.includes('B2B_DONE') ? 'SIGKILL' : 'SIGTERM');
    }
    const code = await done;
    await writeFile(resolve(dir, `${name}.log`), output.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]'));
    commands.push({ args, name, code });
    if (!(name === 'first-host' && output.includes('B2B_DONE'))) assert.equal(code, 0, `see ${name}.log`);
    if (live) assert.match(output, /B2B_DONE/, `see ${name}.log`);
    console.log(`${name}: PASS`);
  } finally {
    clearTimeout(timer);
    if (!closed) child.kill('SIGKILL');
  }
}
try {
  await command(['--version'], 'version');
  await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await command(['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'install');
  for (const phase of ['first', 'cold']) {
    const patch = [
      '- id: storage-json',
      '  config:',
      `    root: ${JSON.stringify(resolve(dir, 'storages'))}`,
      '- id: session-persistence-jsonl',
      '  config:',
      `    root: ${JSON.stringify(resolve(dir, 'sessions'))}`,
      '- id: credentials-local',
      '  config:',
      `    path: ${JSON.stringify(resolve(dir, 'synthetic-credentials.yml'))}`,
      '    watch: false',
      '- id: dsh-bot',
      '  config:',
      '    seedExamples: false',
      `    dataDir: ${JSON.stringify(resolve(dir, 'bots'))}`,
      '- id: agent-default-model',
      '  config:',
      '    provider: deepseek-official',
      '    model: deepseek-flash',
      '    reasoningEffort: off',
      '- id: llm-deepseek',
      '  config:',
      '    apiKeyEnv: B2B_MOCK_KEY',
      `    baseURL: ${JSON.stringify(`${mockUrl}/v1`)}`,
      '    thinking: disabled',
      '    reasoningEffort: off',
      '    maxTokens: 256',
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
      '    - id: b2b-probe',
      `      name: ${JSON.stringify(resolve(root, `packages/dsh-bot/tests/b2b-${kind}-profile.mjs`))}`,
      '      config:',
      `        outputDir: ${JSON.stringify(dir)}`,
      `        mockUrl: ${JSON.stringify(mockUrl)}`,
      `        phase: ${phase}`,
    ].join('\n');
    await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
    await command(['--profile', profile, '--dump-config'], `${phase}-dump`);
    await command(
      ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'],
      `${phase}-host`,
      true,
    );
  }
  if (kind === 'host')
    for (const request of requests) {
      const wire = JSON.stringify(request.body);
      const owner = wire.includes('B2B_PERSONA_alpha')
        ? 'alpha'
        : wire.includes('B2B_PERSONA_beta')
          ? 'beta'
          : 'gamma';
      assert.ok(wire.includes(`B2B_PERSONA_${owner}`));
      for (const other of ['alpha', 'beta', 'gamma'].filter((id) => id !== owner))
        assert.ok(!wire.includes(`B2B_PRIVATE_MEMORY_${other}`));
    }
  await writeFile(
    resolve(dir, 'summary.json'),
    JSON.stringify(
      {
        status: 'PASS',
        kind,
        profile,
        requests: requests.length,
        realModelRequests: 0,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: 'PASS', dir }));
} catch (error) {
  await writeFile(
    resolve(dir, 'failure.json'),
    JSON.stringify({ error: String(error), stack: error.stack }, null, 2),
  );
  console.log(JSON.stringify({ status: 'FAIL', dir, error: String(error) }));
  process.exitCode = 1;
} finally {
  for (const c of children) c.kill('SIGKILL');
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await writeFile(resolve(dir, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(resolve(dir, 'commands.json'), JSON.stringify(commands, null, 2));
}
