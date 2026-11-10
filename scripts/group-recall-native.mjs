import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { auditArtifact, auditInstalled, sha256 } from './p34-artifact.mjs';
import { scratch } from './proactive/worker.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args[0] === '--artifact' && (args.length === 2 || (args.length === 4 && args[2] === '--audit'))),
  'Usage: group-recall-native.mjs [--artifact <tgz> [--audit <artifact-manifest.json>]]');
const artifact = args.length ? resolve(args[1]) : undefined;
const auditFile = args[3] ? resolve(args[3]) : undefined;
for (const path of [artifact, auditFile].filter(Boolean)) {
  const local = relative(root, path);
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'Choose a candidate in the repository');
}
const dir = await scratch('group-recall-native');
const sessions = join(dir, 'sessions');
const profile = 'group-recall-native';
const executable = resolve(process.env.DSH_BOT_DSH_BIN ?? '.dsh-dev/native-api-rc2/node_modules/.bin/dsh');
const fixture = resolve('packages/dsh-bot/tests/group-recall-native-profile.mjs');
const env = {
  PATH: process.env.PATH,
  DSH_BOT_DSH_BIN: executable,
  DSH_HOME: join(dir, 'home'),
  HOME: join(dir, 'environment-home'),
  TMPDIR: join(dir, 'tmp'),
  DSH_AGENTS_HOME: join(dir, 'agents-home'),
  XDG_STATE_HOME: join(dir, 'state'),
  DSH_TELEMETRY_DISABLED: '1',
  DP_NETWORK_RECEIPT: join(dir, 'network-denials.jsonl'),
  pnpm_config_offline: 'true',
  pnpm_config_store_dir: resolve(root, '.dsh-dev/pnpm-store'),
  pnpm_config_cache_dir: resolve(root, '.dsh-dev/pnpm-cache'),
};
await Promise.all([env.HOME, env.TMPDIR].map(path => mkdir(path, { recursive: true })));
console.log(dir);

async function run(args, name, host = false) {
  const child = spawn(resolve('scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stopped = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  const exited = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { stopped = true; accept({ code, signal }); });
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    if (host) {
      for (let attempt = 0; attempt < 400 && !stopped && !/RECALL_NATIVE_(READY|FAILED)/.test(output); attempt++) {
        await delay(50);
      }
      assert.ok(output.includes('RECALL_NATIVE_READY'), `See ${join(dir, `${name}.log`)}`);
    } else {
      assert.equal((await exited).code, 0, `See ${join(dir, `${name}.log`)}`);
    }
    return output;
  } finally {
    if (!stopped) child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; }
    finally {
      clearTimeout(timer);
      clearTimeout(force);
      await writeFile(join(dir, `${name}.log`), output.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]'));
    }
  }
}

async function sessionLogHashes(path) {
  const entries = await readdir(path, { withFileTypes: true, recursive: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
  assert.ok(files.length > 0);
  return Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')]));
}

const version = (await run(['--version'], 'version')).trim();
assert.ok((artifact ? ['0.2.1-rc.2', '0.2.2-rc.1'] : ['0.2.1-rc.2']).includes(version), `Unexpected Host version: ${version}`);
const profileFlags = ['--profile', profile];
await run([...profileFlags, '--from-default-profile', 'web', '--dump-config'], 'initialize');
const disabledIndex = join(dir, 'disabled-index.sqlite');
const phases = artifact ? ['product-warm', 'product-cold'] : ['warm', 'cold', 'disabled'];
let warmHashes, installed, forkToolAdvertised;
if (artifact) {
  const audit = auditFile ? JSON.parse(await readFile(auditFile, 'utf8')) : await auditArtifact(root, artifact, dir);
  assert.equal(audit.artifact, relative(root, artifact));
  assert.equal(audit.sha256, sha256(await readFile(artifact)));
  assert.ok(audit.files.some(file => file.file === 'lib/host/groups/recall.js'));
  await run(['plugin', ...profileFlags, 'add', artifact], 'install');
  installed = await auditInstalled(env.DSH_HOME, profile, audit);
  assert.equal(sha256(await readFile(artifact)), installed.artifactSha256);
}
for (const phase of phases) {
  const patch = join(dir, `${phase}.yml`);
  const disabled = Boolean(artifact) || phase === 'disabled';
  await writeFile(patch, [
    '- id: storage-json', '  config:', `    root: ${JSON.stringify(join(dir, 'storage'))}`,
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(sessions)}`,
    '- id: credentials', '  config:', `    path: ${JSON.stringify(join(dir, 'credentials.yml'))}`, '    watch: false',
    '- id: session-query-sqlite', '  config:', `    path: ${JSON.stringify(disabled ? disabledIndex : ':memory:')}`,
    `    openAt: ${disabled ? 'never' : 'first-search'}`,
    ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry',
      'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
    ...(artifact ? [
      '- id: dsh-bot', '  config:', '    seedExamples: false', `    dataDir: ${JSON.stringify(join(dir, 'bots'))}`,
      '- id: agent-default-model', '  config:', '    provider: recall-fixture', '    model: fixture',
    ] : []),
    '- insert:', '    - id: group-recall-native-fixture', `      name: ${JSON.stringify(fixture)}`,
    '      config:', `        outputDir: ${JSON.stringify(dir)}`, `        phase: ${phase}`, `        cliVersion: ${JSON.stringify(version)}`,
  ].join('\n') + '\n');
  await run([...profileFlags, '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'], phase, true);
  const report = JSON.parse(await readFile(join(dir, `${phase}.json`), 'utf8'));
  assert.equal(report.phase, phase);
  if (artifact) {
    assert.equal(report.recallModelStreams + report.recallAgentCreations, 0);
    assert.equal(report.realModelRequests, 0);
    if (phase === 'product-warm') forkToolAdvertised = report.forkToolAdvertised;
  } else {
    assert.equal(report.agentCreations + report.agentRequests + report.modelStreams, 0);
    if (phase === 'warm') warmHashes = await sessionLogHashes(sessions);
    else {
      assert.equal(report.sessionCreations, 0);
      assert.deepEqual(await sessionLogHashes(sessions), warmHashes);
    }
  }
  console.log(`PASS ${phase}: ${report.checks.join(', ')}`);
}
for (const file of [disabledIndex, env.DP_NETWORK_RECEIPT]) {
  await assert.rejects(readFile(file), { code: 'ENOENT' });
}
if (installed) {
  await writeFile(join(dir, 'installed.json'), JSON.stringify({ ...installed, cliVersion: version }, null, 2));
  assert.equal(forkToolAdvertised, false, 'A fork exposed the main-only recall tool');
  console.log(`PASS ${version} installed candidate ${installed.artifactSha256}, zero recall Agent or model requests and no network attempts`);
} else {
  console.log('PASS zero Agent or model requests, no cold Session publication, unchanged Session files, no network attempts');
}
