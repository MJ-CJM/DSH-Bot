import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';

const artifact = resolve(process.argv[2] ?? '.dsh-dev/avatar-fix-20261109/candidate-1/dsh-bot-0.6.5.tgz');
const fixture = resolve('packages/dsh-bot/tests/v066-reload-profile.mjs');
const recovery = process.argv[3] === '--recovery';
const volatile = process.argv[3] === '--volatile';
const suite = recovery ? 'v066-recovery' : volatile ? 'v066-volatile' : 'v066-reload';
const flags = ['- id: dsh-bot', '  config:', `    proactiveEnabled: ${recovery}`, `    proactiveExecutionEnabled: ${recovery}`,
  ...(recovery ? ['    proactiveProvider: dp-loopback', '    proactiveModel: fixture',
    '    proactiveMaintenanceIntervalMs: 10000', '    proactiveNotificationPolicy: v066-recovery-notice',
    '    proactiveNoticeConfig: {mergeWindowMs: 0, maxBatchItems: 8, maxPending: 1000}'] : []),
  `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`];
const dir = await scratch(suite);
const read = name => readFile(join(dir, name), 'utf8').then(JSON.parse);
const save = (name, value) => writeFile(join(dir, name), JSON.stringify(value, null, 2));
console.log(dir);

async function waitFor(name) {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const error = await read('fixture-error.json').catch(() => undefined);
    if (error) throw new Error(error.stack);
    const evidence = await read(name).catch(() => undefined);
    if (evidence) return evidence;
    await delay(100);
  }
  throw new Error(`Missing ${name} in ${dir}`);
}

function healthy(evidence) {
  const [asked, decided] = evidence.approval;
  return evidence.requests.length === 5 && evidence.requests.every(request => request.memory && request.persona && request.home)
    && evidence.turns.length === 3 && evidence.turns.every(reason => reason.kind === 'completed') && evidence.replies === 3
    && evidence.tools.bot_memory_list && evidence.tools.bot_notify && !evidence.tools.v066_denied_fixture
    && JSON.stringify(evidence.toolResults).includes('Data export blocked')
    && asked?.type === 'approval/asked' && asked.data.toolName === 'bot_notify'
    && decided?.type === 'approval/decided' && decided.data.id === asked.data.id && decided.data.outcome === 'rejected';
}
async function testRecovery() {
  const host = await webHost(dir, suite, artifact, fixture, flags);
  try {
    await waitFor('recovery-before.json');
    await save('enable.json', { enable: true });
    const result = await waitFor('recovery-result.json');
    assert.equal(result.afterEnable.modelCalls, result.beforeDisable.modelCalls);
    assert.equal(result.afterEnable.notificationRecords, 0);
    assert.equal(result.afterEnable.directExecution, false);
    assert.deepEqual(result.afterEnable.autoCandidates, result.beforeDisable.autoCandidates);
    assert.equal(result.afterEnable.autoMode, 'auto');
    assert.equal(result.afterEnable.work.find(work => work.state === 'denied')?.revision, 1);
    assert.equal(result.afterEnable.work.find(work => work.state === 'delivered')?.notice, 'suppressed');
    assert.equal(result.stateBeforeRetry, 'disabled');
    assert.equal(result.staleRetry, 'updated');
    assert.equal(result.stateAfterRetry, 'ready');
    console.log(`Recovery baseline observed; old work, notice and stale retry evidence: ${dir}`);
  } finally {
    await host.stop();
  }
}

async function testLifecycle() {
  let host;
  try {
    host = await webHost(dir, volatile ? 'v066-volatile-bootstrap' : suite, artifact, fixture, flags);
    if (volatile) {
      // ConfigEditor can override a row inherited from a bundle. A row
      // inserted in the profile override itself cannot be patched in place.
      await host.stop();
      const env = host.env;
      host = undefined;
      const profilePatch = join(env.DSH_HOME, 'profiles', 'b4-browser', 'cordis.patch.yml');
      const original = await readFile(profilePatch, 'utf8');
      const insert = original.lastIndexOf('- insert:\n    - id: b4-web-fixture\n');
      assert.ok(insert > 0);
      const fixtureBundle = join(dir, 'fixture-bundle');
      await mkdir(fixtureBundle);
      await writeFile(join(fixtureBundle, 'package.json'), JSON.stringify({
        name: 'v066-reload-probe', version: '0.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
      }));
      await writeFile(join(fixtureBundle, 'cordis.patch.yml'), original.slice(insert).replace('v066-volatile-bootstrap', suite));
      await writeFile(profilePatch, original.slice(0, insert));
      const install = await promisify(execFile)(resolve('scripts/dsh'), ['plugin', '--profile', 'b4-browser', 'add', fixtureBundle], {
        env, timeout: 90000,
      });
      await writeFile(join(dir, 'install-fixture.log'), install.stdout + install.stderr);
      host = await webHost(dir, suite, artifact, fixture, flags, { preserveProfile: true });
    }
    const before = await waitFor('before.json');
    assert.equal(healthy(before), true, JSON.stringify(before));
    assert.equal(before.mainSessionId, before.sessionId);
    assert.equal(before.toolBodies, 0);
    assert.equal(before.externalSends, 0);
    await save('enable.json', { enable: true });
    const warm = await waitFor('warm.json');
    assert.equal(warm.mainSessionId, before.sessionId);
    assert.equal(warm.activityVisible, true);
    assert.equal(warm.memoryKernelReplaced, !volatile);
    assert.equal(warm.enableModelCalls, 0);
    assert.equal(warm.directExecution, false);
    assert.equal(warm.sameLiveAgent, true);
    assert.equal(warm.toolBodies, 0);
    assert.equal(warm.externalSends, 0);
    if (volatile) {
      assert.equal(warm.bootId, before.bootId);
      assert.deepEqual(warm.flagsBefore, { enabled: false, executionEnabled: true });
      assert.deepEqual(warm.flagsAfter, { enabled: true, executionEnabled: false });
      assert.deepEqual(warm.volatileEvents, [{
        paths: [['fixtureEnabled'], ['fixtureExecutionEnabled']], flags: warm.flagsAfter,
      }]);
    } else {
      assert.equal(warm.selectError?.code, 'agent-preset/locked');
      assert.equal(warm.requests.length, 0);
      assert.match(warm.turns[0].error?.message, /dsh_bot_memory.*closed/);
    }
    await host.stop();
    host = undefined;

    host = await webHost(dir, suite, artifact, fixture, flags, { preserveProfile: true });
    const cold = await waitFor('cold.json');
    assert.equal(cold.mainSessionId, before.sessionId);
    assert.notEqual(cold.bootId, before.bootId);
    if (volatile) assert.deepEqual(cold.fixtureFlags, warm.flagsAfter);
    const result = { warmHealthy: healthy(warm), coldHealthy: healthy(cold), before, warm, cold };
    await save('result.json', result);
    assert.equal(result.warmHealthy, volatile, JSON.stringify(warm));
    assert.equal(result.coldHealthy, true, JSON.stringify(cold));
    assert.equal(cold.toolBodies, 0);
    assert.equal(cold.externalSends, 0);
    console.log(`Warm lifecycle ${result.warmHealthy ? 'PASS' : 'FAIL'}; controlled restart PASS`);
  } finally {
    await host?.stop();
  }
}

if (recovery) await testRecovery();
else await testLifecycle();
