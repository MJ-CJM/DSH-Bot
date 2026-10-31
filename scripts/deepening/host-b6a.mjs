import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from './b3-runner.mjs';
const root = process.cwd(), suite = process.argv[3];
assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
assert.ok(['trusted-ingress', 'confirm'].includes(suite));
const dir = resolve(root, '.dsh-dev/deepening', `b6a-${suite}-${Date.now()}`);
await mkdir(resolve(dir, 'receipts'), { recursive: true });
const run = await runner(dir, 0, 'DP_B6A');
const save = (name, value) => writeFile(resolve(dir, name), `${JSON.stringify(value, null, 2)}\n`);
let cliVersion, phase = 'version';
try {
  const output = await run.command(['--version'], 'version');
  cliVersion = output.split(/\r?\n/).find(s => /^\d+\.\d+\.\d+/.test(s.trim()))?.trim();
  assert.ok(cliVersion);
  await save('manifest.json', { suite, source: 'synthetic', cliVersion, referenceVersion: '0.2.1-rc.2',
    realModelRequests: 0, providerDiscovery: false, inheritedCredentials: false });
  const profile = `b6a-${suite}`;
  phase = 'initialize';
  await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  phase = 'install';
  await run.command(['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'install');
  const patch = [
    '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(dir, 'storage'))}`,
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(dir, 'sessions'))}`,
    '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(dir, 'synthetic-credentials.yml'))}`, '    watch: false',
    '- id: dsh-bot', '  config:', '    seedExamples: false', '    messagingEnabled: false',
    `    dataDir: ${JSON.stringify(resolve(dir, 'bots'))}`,
    '- id: agent-default-model', '  config:', '    provider: dp-b6a', '    model: fixture',
    '- id: user-approval', '  config:', '    policy: ask',
    ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry',
      'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
    '- insert:', '    - id: dp-b6a-probe',
    `      name: ${JSON.stringify(resolve(root, 'packages/dsh-bot/tests/deepening/b6a-profile.mjs'))}`,
    '      config:', `        outputDir: ${JSON.stringify(dir)}`, `        suite: ${suite}`,
  ].join('\n');
  await writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
  phase = 'host';
  await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'host', true);
  const result = JSON.parse(await readFile(resolve(dir, 'receipts/result.json')));
  await save('summary.json', { ...result, cliVersion, exactRc2Host: 'FAIL (NOT_RUN: wrapper CLI is rc.3)' });
  if (result.status !== 'PASS') process.exitCode = 1;
  console.log(JSON.stringify({ ...result, dir, cliVersion }));
} catch (error) {
  const logs = await Promise.all(run.commands.map(c => readFile(resolve(dir, `${c.name}.log`), 'utf8').catch(() => '')));
  const environment = /EPERM|EACCES|Operation not permitted|Permission denied/.test(`${error}\n${logs.join('\n')}`);
  const status = environment ? 'FAIL (environment)' : 'FAIL';
  const readReceipt = name => readFile(resolve(dir, `receipts/${name}.json`), 'utf8').then(JSON.parse).catch(() => undefined);
  const progress = await readReceipt('progress'), result = await readReceipt('result');
  // A killed/unstarted probe cannot write its own terminal result. The parent always leaves one.
  if (!result) await save('receipts/result.json', { status, suite, phase, probePhase: progress?.phase,
    origin: 'parent-runner', error: String(error), command: run.commands.at(-1), realModelRequests: 0 });
  await save('summary.json', { status, suite, phase, cliVersion, probePhase: progress?.phase, probeResult: result,
    error: String(error), command: run.commands.at(-1), realModelRequests: 0 });
  console.error(JSON.stringify({ status, suite, phase, dir, error: String(error) })); process.exitCode = 1;
} finally { run.stop(); await save('commands.json', run.commands); }
