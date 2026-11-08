import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { scratch } from './proactive/worker.mjs';

const [packagePath, entryPath, previousPath] = process.argv.slice(2);
assert.ok(packagePath && entryPath && process.argv.length <= 5,
  'Pass the built package, its extracted coordinator entry, and optionally the previous entry');
assert.ok(process.env.DSH_BOT_DSH_BIN, 'Select the isolated rc.2 CLI with DSH_BOT_DSH_BIN');
const artifact = resolve(packagePath);
const entry = resolve(entryPath);
const dir = await scratch('suite');
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const result = {
  packageHash: await sha256(artifact), coordinatorHash: await sha256(entry),
  startedAt: new Date().toISOString(), checks: [],
};
assert.equal(createHash('sha256').update(execFileSync('tar', [
  '-xOf', artifact, 'package/lib/proactive-coordinator/main.mjs',
], { maxBuffer: 16 * 1024 * 1024 })).digest('hex'), result.coordinatorHash, 'Coordinator differs from the selected package');
const stop = new AbortController();
const interrupt = () => stop.abort();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, interrupt);
const checks = [
  ['package', ['scripts/verify-package.mjs', artifact]],
  ['recovery', ['scripts/proactive-bot-recovery.mjs', entry, ...(previousPath ? [resolve(previousPath)] : [])]],
  ['core-smoke', ['scripts/proactive-bot-soak.mjs', entry, '--smoke']],
  ['dispatch-faults', ['scripts/proactive-bot-faults.mjs', artifact]],
  ['result-budget-faults', ['scripts/proactive-bot-faults.mjs', artifact, 'F13A,F13B'], { DSH_BOT_FAULT_RESPONSIBILITY: '1' }],
  ['warm-recovery', ['scripts/proactive-bot-warm-recovery.mjs', artifact]],
  ['general-feedback', ['scripts/proactive-bot-feedback-workflow.mjs', artifact]],
  ['workspace-execution', ['scripts/proactive-bot-workspace.mjs', artifact]],
  ['group-repair', ['scripts/proactive-bot-workspace.mjs', artifact, '--group-repair']],
  ['deferred-notices', ['scripts/proactive-bot-deferred-notices.mjs', artifact]],
  ['responsibilities', ['scripts/proactive-bot-policy.mjs', artifact, '--responsibilities']],
  ['source-governance', ['scripts/proactive-bot-policy.mjs', artifact, '--governance']],
  ...['--repair', '--group-artifact', '--group-follow-up', '--group-follow-up-cold', '--group-follow-up-member-changed',
    '--group-follow-up-revoked', '--group-follow-up-late', '--group-failure', '--notice', '--notice-unknown', '--crash',
  ].map(mode => [mode.slice(2), ['scripts/proactive-bot-workflow.mjs', artifact, mode]]),
  ['browser-matrix', ['scripts/proactive-bot-workflow.mjs', artifact]],
];
console.log(`Verification receipts: ${dir}`);
try {
  let next = 0;
  async function worker() {
    while (!stop.signal.aborted) {
      const check = checks[next++];
      if (!check) return;
      const [name, args, environment] = check;
    const started = Date.now();
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_BOT_FAULT_RESPONSIBILITY: undefined, ...environment } });
    const done = new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept({ code, signal }));
    });
    const terminate = () => child.kill('SIGTERM');
    stop.signal.addEventListener('abort', terminate, { once: true });
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', chunk => { output = (output + chunk).slice(-64 * 1024); });
    try {
      const exit = await done;
      result.checks.push({ name, args, ...(environment ? { environment } : {}), ...exit, durationMs: Date.now() - started });
      await writeFile(join(dir, `${name}.log`), output.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]'));
      console.log(`${exit.code === 0 ? 'PASS' : 'FAIL'} ${name}`);
    } finally {
      stop.signal.removeEventListener('abort', terminate);
    }
    }
  }
  // Each Host uses its own profile and store; bound shared disk load to two.
  await Promise.all([worker(), worker()]);
} finally {
  result.checks.sort((a, b) => checks.findIndex(check => check[0] === a.name) - checks.findIndex(check => check[0] === b.name));
  for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt);
  result.finishedAt = new Date().toISOString();
  result.status = result.checks.length === checks.length && result.checks.every(check => check.code === 0)
    ? 'PASS' : 'FAIL';
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  if (result.status === 'FAIL') process.exitCode = 1;
}
