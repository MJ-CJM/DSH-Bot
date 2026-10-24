#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareIm } from '../spikes/p34/src/prepare-im.ts';
import { captureCollaboration } from '../packages/dsh-bot/scripts/collaboration-browser.mjs';
const root = process.cwd(), home = resolve(root, '.dsh-dev'); assert.equal(process.env.DSH_HOME, home);
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { startMockLlmServer } = await import(require.resolve('@deepseek-ai/dsh-llm-mock-server'));
const mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: ['success'], repeatLast: true, successText: 'P34_TEAM_FAKE_REPLY' });
const runDir = resolve(home, 'p34-u04-05', `runtime-${Date.now()}-${process.pid}`); await mkdir(runDir, { recursive: true });
await writeFile(resolve(home, 'p34-u04-05/latest-runtime.txt'), `${runDir}\n`);
const profile = `p34-collaboration-${Date.now()}-${process.pid}`;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, SHELL: process.env.SHELL, DSH_HOME: home,
  DSH_AGENTS_HOME: resolve(runDir, 'agents-home'), DSH_TELEMETRY_DISABLED: '1', XDG_STATE_HOME: resolve(runDir, 'state'),
  NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'), TMPDIR: resolve(home, 'tmp'), pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'), P34_MODEL_KEY: 'synthetic-loopback', DEEPSEEK_API_KEY: '' };
const children = new Set(), commands = [], modelPhases = [];
const save = (file, value) => writeFile(resolve(runDir, file), JSON.stringify(value, null, 2));
async function command(executable, args, name, live = false) {
  const child = spawn(resolve(root, `scripts/${executable}`), args, { cwd: root, env, stdio: ['ignore','pipe','pipe'] }); children.add(child);
  let output = '', closed = false;
  const done = new Promise((accept, reject) => { child.once('error', reject); child.once('close', code => { closed = true; children.delete(child); accept(code); }); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => output += chunk);
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  try {
    if (live) {
      const until = Date.now() + 150000; while (!closed && Date.now() < until && !/P34_COLLAB_(DONE|FAILED)/.test(output)) await delay(100);
      if (name === 'first-host' && output.includes('P34_COLLAB_DONE')) {
        let result;
        try { const url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1]; assert.ok(url); result = await captureCollaboration(url, runDir, env); }
        catch (error) { result = { status: 'FAIL', reason: String(error).slice(0, 250) + '\n...\n' + String(error).slice(-1800) }; }
        await save('browser.json', result);
      }
      child.kill('SIGTERM');
    }
    const code = await done;
    await writeFile(resolve(runDir, `${name}.log`), output.replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]'));
    commands.push({ executable, args, name, code }); assert.equal(code, 0, `see ${name}.log`);
    if (live) { assert.match(output, /P34_COLLAB_DONE/, `see ${name}.log`); assert.equal(JSON.parse(await readFile(resolve(runDir, `${name.startsWith('first') ? 'first' : 'cold'}-disposed.json`))).status, 'PASS'); }
    console.log(`${name}: PASS`);
  } finally { clearTimeout(timer); if (!closed) child.kill('SIGKILL'); }
}
try {
  await command('dsh', ['--version'], 'version');
  await command('pnpm', ['-C','packages/dsh-bot','pack','--pack-destination', runDir], 'pack-bot');
  const version = JSON.parse(await readFile(resolve(root, 'packages/dsh-bot/package.json'))).version;
  const botArchive = resolve(runDir, `dsh-bot-${version}.tgz`);
  const source = await prepareIm(runDir);
  await command('pnpm', ['-C',source,'pack','--pack-destination',runDir], 'pack-im-locked');
  await command('dsh', ['--profile',profile,'--from-default-profile','web','--dump-config'], 'initialize');
  await command('dsh', ['plugin','--profile',profile,'add',botArchive], 'install-bot');
  await command('dsh', ['plugin','--profile',profile,'add',resolve(runDir,'xmanrui-dsh-im-5.5.0.tgz')], 'install-im');
  for (const file of ['host/collaboration/service.js','host/collaboration/remote.js','host/im/service.js','client.js']) {
    assert.deepEqual(await readFile(resolve(home,'profiles',profile,'node_modules/dsh-bot/lib',file)), await readFile(resolve(root,'packages/dsh-bot/lib',file)));
  }
  await save('installed.json', { archiveSha256: createHash('sha256').update(await readFile(botArchive)).digest('hex'), installedBytesMatch: true });
  for (const phase of ['first','cold']) {
    const patch = [
      '- id: storage-json','  config:',`    root: ${JSON.stringify(resolve(runDir,'storages'))}`,
      '- id: session-persistence-jsonl','  config:',`    root: ${JSON.stringify(resolve(runDir,'sessions'))}`,
      '- id: credentials-local','  config:',`    path: ${JSON.stringify(resolve(runDir,'synthetic-credentials.yaml'))}`,'    watch: false',
      '- id: dsh-bot','  config:','    seedExamples: false',`    dataDir: ${JSON.stringify(resolve(runDir,'bots-data'))}`,
      '- id: agent-default-model','  config:','    provider: deepseek-official','    model: deepseek-flash','    reasoningEffort: off',
      '- id: llm-deepseek','  config:','    apiKeyEnv: P34_MODEL_KEY',`    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}`,'    thinking: disabled','    reasoningEffort: off','    maxTokens: 128',
      ...['llm-deepseek-account','llm-pi-ai','session-title-llm','llm-retry','session-log-deepseek','session-telemetry-otel','desktop-product-telemetry'].flatMap(id => [`- id: ${id}`,'  disabled: true']),
      '- id: xmanrui-dsh-im','  config:',`    dshHome: ${JSON.stringify(resolve(runDir,'im-home'))}`,
      '- insert:','    - id: p34-collaboration-probes',`      name: ${JSON.stringify(resolve(root,'packages/dsh-bot/tests/integration-collaboration-profile.mjs'))}`,'      config:',`        outputDir: ${JSON.stringify(runDir)}`,`        phase: ${phase}`,
    ].join('\n');
    await writeFile(resolve(home,'profiles',profile,'cordis.patch.yml'), `${patch}\n`);
    await command('dsh', ['--profile',profile,'--dump-config'], `${phase}-dump`);
    await command('dsh', ['--profile',profile,'--no-open','--host','127.0.0.1','--port','0'], `${phase}-host`, true);
    modelPhases.push({ phase, cumulativeMockRequests: mock.requests.length });
  }
  assert.ok(mock.requests.length >= 1);
  assert.ok(mock.requests.every(r => /P34_TEAM_FAKE_(MODEL_ONLY|REPLY)/.test(JSON.stringify(r.body))));
  await save('summary.json', { status: 'PASS', runDir, profile, modelRequests: mock.requests.length, modelPhases, onlySyntheticTeamTraffic: true, realModelRequests: 0, imRealAccounts: 0, browser: JSON.parse(await readFile(resolve(runDir,'browser.json'))).status });
  console.log(JSON.stringify({ status: 'PASS', runDir }));
} catch (error) { await save('failure.json', { error: String(error), stack: error.stack }); console.log(JSON.stringify({ status: 'FAIL', runDir, error: String(error) })); process.exitCode = 1; }
finally { for (const child of children) child.kill('SIGKILL'); await save('mock-metadata.json', { count: mock.requests.length, phases: modelPhases, requests: mock.requests.map(r => ({ path: r.path, outcome: r.outcome, syntheticTeamWorker: JSON.stringify(r.body).includes('P34_TEAM_FAKE_MODEL_ONLY'), syntheticParentSettlement: JSON.stringify(r.body).includes('P34_TEAM_FAKE_REPLY') })) }); await mock.close(); await save('commands.json', commands); }
