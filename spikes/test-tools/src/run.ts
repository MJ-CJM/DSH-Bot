import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {} from '@deepseek-ai/dsh-fs';
import { Context } from '@deepseek-ai/cordis';
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke';
import { SessionId } from '@deepseek-ai/dsh-session';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const dshHome = resolve(repository, '.dsh-dev');
assert.equal(process.env.DSH_HOME, dshHome, 'Run from the repository root with DSH_HOME="$PWD/.dsh-dev".');
const evidenceDirectory = resolve(dshHome, 't02-test-tools');
await mkdir(evidenceDirectory, { recursive: true });
const results: Record<string, unknown> = {};

const ctx = new Context();
try {
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  const target = await ctx.fs.resolve(resolve(evidenceDirectory, `atomic-${Date.now()}.txt`));
  const created = await ctx.fs.writeText(target, 'first', { kind: 'createIfAbsent' });
  const replaced = await ctx.fs.writeText(target, 'second');
  assert.equal(await readFile(target.targetKey, 'utf8'), 'second');
  assert.equal(created.operation, 'create');
  assert.equal(replaced.operation, 'update');
  results.fsLocalWithoutKoffiHook = { status: 'PASS', platform: process.platform, create: created.operation, replace: replaced.operation, text: 'second' };
  const harness = await mountAgentLoopTestHarness(ctx);
  const agent = await harness.create(SessionId(`t02-spike-${Date.now()}`));
  const message = createUserMessage({
    content: [{ type: 'text', text: 'Local inbox fixture; never submit to a model.' }],
    source: { kind: 'user' },
  });
  agent.inbox.append('next-turn', message);
  assert.equal(agent.inbox.nextTurn.length, 1);
  const claimed = harness.claim(agent, 'next-turn', 1);
  assert.equal(claimed[0]?.id, message.id);
  assert.equal(agent.inbox.nextTurn.length, 0);
  const eventTypes = agent.session.snapshotEvents().map((event) => event.type);
  assert.deepEqual(eventTypes, ['agent/inbox/spliced', 'agent/inbox/spliced']);
  results.agentLoopTestkit = { status: 'PASS', createdProductionAgent: true, claimed: claimed.length, eventTypes, modelRequests: 0 };
} finally {
  await ctx.fiber.dispose();
}

const mock = await startMockLlmServer({
  host: '127.0.0.1',
  port: 0,
  sequence: ['success'],
  successText: 'T02_LOCAL_MOCK_OK',
  randomSeed: 2,
});
try {
  const response = await fetch(`${mock.baseURL}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 't02-mock', stream: true, max_tokens: 50, messages: [{ role: 'user', content: 'local smoke' }] }),
  });
  const stream = await response.text();
  const text = stream.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { delta?: { type?: string; text?: string } })
    .filter((event) => event.delta?.type === 'text_delta')
    .map((event) => event.delta?.text ?? '')
    .join('');
  assert.equal(response.status, 200);
  assert.equal(text, 'T02_LOCAL_MOCK_OK');
  assert.equal(mock.requests.length, 1);
  results.llmMockServer = {
    status: 'PASS', httpStatus: response.status, requests: mock.requests.length,
    path: mock.requests[0]?.path, behavior: mock.requests[0]?.behavior,
    outcome: mock.requests[0]?.outcome, text, modelProviderContacted: false,
  };
} finally {
  await mock.close();
}

const configPath = resolve(evidenceDirectory, 'loader-config.json');
await writeFile(configPath, JSON.stringify([{ name: new URL('./loader-plugin.ts', import.meta.url).href }], null, 2));
const smoke = await runLoaderSmoke({
  label: 'external DSH-Bot loader smoke',
  cwd: evidenceDirectory,
  mode: 'lib',
  binScript: fileURLToPath(new URL('./loader-fixture.ts', import.meta.url)),
  libBinScript: fileURLToPath(new URL('./loader-fixture.ts', import.meta.url)),
  configPath,
  tsconfigPath: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
  env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: resolve(dshHome, 't02-test-tools-agents') },
});
assert.match(smoke.stdout, /T02_LOADER_PLUGIN_LOADED/);
assert.match(smoke.stdout, /T02_LOADER_PLUGIN_DISPOSED/);
assert.match(smoke.stdout, /T02_LOADER_FIXTURE_OK/);
results.loaderSmoke = { status: 'PASS', mode: 'lib', stdout: smoke.stdout.trim(), stderr: smoke.stderr.trim() };
await writeFile(resolve(evidenceDirectory, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
