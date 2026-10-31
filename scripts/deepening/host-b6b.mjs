import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from './b3-runner.mjs';
import { mockProfilePatch } from './mock-profile.mjs';
import { pairs } from '../../packages/dsh-bot/tests/deepening/b6b-cases.ts';
const root = process.cwd(), suite = process.argv[3];
assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
assert.ok(['message-egress', 'group-egress', 'delegate-egress', 'notify-egress', 'mcp-egress', 'auto-share', 'redteam'].includes(suite));
const dir = resolve(root, '.dsh-dev/deepening', `b6b-${suite}-${Date.now()}`);
await mkdir(resolve(dir, 'receipts'), { recursive: true });
const run = await runner(dir, 0, 'DP_B6B', { timeoutMs: suite === 'redteam' ? 720000 : 90000 });
const save = (name, value) => writeFile(resolve(dir, name), `${JSON.stringify(value, null, 2)}\n`);
let cliVersion, phase = 'version';
try {
  const output = await run.command(['--version'], 'version');
  cliVersion = output.split(/\r?\n/).find(s => /^\d+\.\d+\.\d+/.test(s.trim()))?.trim();
  assert.ok(cliVersion);
  await save('manifest.json', { suite, source: 'synthetic', cliVersion, referenceVersion: '0.2.1-rc.2',
    realModelRequests: 0, providerDiscovery: false, inheritedCredentials: false });
  const profile = `b6b-${suite}`;
  phase = 'initialize';
  await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  phase = 'install';
  await run.command(['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'install');
  const patch = mockProfilePatch(dir, 'packages/dsh-bot/tests/deepening/b6b-profile.mjs', { outputDir: dir, suite });
  await writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), patch);
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
  if (suite === 'redteam') {
    const rows = [];
    for (const pair of pairs) for (const variant of ['control', 'attack']) {
      const id = `${pair.id}-${variant}`, old = await readReceipt(id);
      const receipt = old ?? { ...pair, id, variant, status: `${status} (NOT_RUN)`,
        reason: `Host did not finish the actual route: ${phase}/${progress?.phase ?? 'no probe'}`,
        evidenceLevel: 'PARENT_TERMINAL_RECEIPT / NO_TRANSPORT_EVIDENCE', realModelRequests: 0 };
      if (!old) await writeFile(resolve(dir, `receipts/${id}.json`), JSON.stringify(receipt, null, 2), { flag: 'wx' });
      rows.push(receipt);
    }
    await save('native-matrix.json', { status, rows, actualNativeCasesPassed: rows.filter(row => row.status === 'PASS').length });
  }
  // A killed/unstarted probe cannot write its own terminal result. The parent always leaves one.
  if (!result) await save('receipts/result.json', { status, suite, phase, probePhase: progress?.phase,
    origin: 'parent-runner', error: String(error), command: run.commands.at(-1), realModelRequests: 0 });
  await save('summary.json', { status, suite, phase, cliVersion, probePhase: progress?.phase, probeResult: result,
    error: String(error), command: run.commands.at(-1), realModelRequests: 0 });
  console.error(JSON.stringify({ status, suite, phase, dir, error: String(error) })); process.exitCode = 1;
} finally { run.stop(); await save('commands.json', run.commands); }
