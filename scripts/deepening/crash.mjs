import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from './b3-runner.mjs';
import { mockProfilePatch } from './mock-profile.mjs';
import { crashChild } from './crash-protocol.mjs';
const root = process.cwd(), args = process.argv.slice(2);
assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
assert.deepEqual([args[0], args[2], args[4]], ['--window', '--repeat', '--mock-only']);
assert.equal(args.length, 5); assert.equal(args[3], '3');
const window = args[1], memory = ['payload', 'op-projection', 'forget-barrier', 'migration-cutover', 'forget-rollback'];
assert.ok(['harness', ...memory, 'surface-flush', 'mcp-cleanup', 'copy-pointer', 'main-schedule'].includes(window));
const windows = window === 'main-schedule' ? ['main-create', 'main-flush', 'schedule-delivery'] : [window];
const dir = resolve('.dsh-dev/deepening', `b7-crash-${window}-${Date.now()}`); await mkdir(dir, { recursive: true });
const results = [];
for (const point of windows) for (let iteration = 1; iteration <= 3; iteration++) {
  const base = resolve(dir, `${point}-${iteration}`); await mkdir(base, { recursive: true });
  const nonce = randomUUID(), row = { window: point, iteration, nonce };
  if (point === 'harness' || memory.includes(point)) {
    const data = resolve(base, 'runtime'); await mkdir(data);
    const env = { PATH: process.env.PATH, HOME: resolve(base, 'environment-home'), DSH_HOME: resolve(data, 'home'),
      DP_MOCK_PORT: '0', DP_NETWORK_RECEIPT: resolve(data, 'network-denials.jsonl') };
    const script = resolve('packages/dsh-bot/tests/deepening/crash-runtime.mjs');
    row.runtime = await crashChild({ command: process.execPath, args: [script, point, 'crash', data, nonce],
      env, dir: data, phase: 'crash', nonce, window: point });
    if (row.runtime.status === 'PASS') row.runtimeRecovery = await crashChild({ command: process.execPath,
      args: [script, point, 'recover', data, nonce], env, dir: data, phase: 'recover', nonce, window: point });
  }
  if (point !== 'harness') {
    const data = resolve(base, 'host'); await mkdir(data);
    const run = await runner(data, 0, 'DP_B7', { timeoutMs: 45000 });
    try {
      const profile = 'b7-crash';
      await run.command(['--version'], 'version');
      await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
      await run.command(['plugin', '--profile', profile, 'add', resolve('packages/dsh-bot')], 'install');
      const patchFile = resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml');
      const patch = phase => mockProfilePatch(data, 'packages/dsh-bot/tests/deepening/crash-profile.mjs',
        { window: point, phase, outputDir: data, nonce });
      const cli = ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'];
      await writeFile(patchFile, patch('crash'));
      row.host = await crashChild({ command: resolve(root, 'scripts/dsh'), args: cli, env: run.env,
        dir: data, phase: 'crash', nonce, window: point, live: true });
      if (row.host.status === 'PASS') {
        await writeFile(patchFile, patch('recover'));
        row.hostRecovery = await crashChild({ command: resolve(root, 'scripts/dsh'), args: cli, env: run.env,
          dir: data, phase: 'recover', nonce, window: point, live: true });
        if (row.hostRecovery.status === 'PASS') {
          const recovered = JSON.parse(await readFile(resolve(data, 'recovery.json')));
          assert.notEqual(recovered.pid, row.host.pid); row.detail = recovered;
        }
      }
    } catch (error) { row.host = { status: 'FAIL', error: String(error) }; }
    finally { run.stop(); await writeFile(resolve(data, 'setup-commands.json'), JSON.stringify(run.commands, null, 2)); }
  }
  const required = point === 'harness' ? [row.runtime, row.runtimeRecovery] : [row.host, row.hostRecovery];
  row.status = required.every(value => value?.status === 'PASS') ? 'PASS'
    : required.some(value => value?.status?.includes('environment')) ? 'FAIL (environment)' : 'FAIL';
  results.push(row); await writeFile(resolve(base, 'summary.json'), JSON.stringify(row, null, 2));
  console.log(JSON.stringify({ window: point, iteration, status: row.status, runtime: row.runtimeRecovery?.status }));
}
const status = results.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL';
await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status, window, results, realModelRequests: 0 }, null, 2));
console.log(JSON.stringify({ status, window, dir })); if (status !== 'PASS') process.exitCode = 1;
