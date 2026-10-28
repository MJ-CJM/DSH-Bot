import { spawn } from 'node:child_process';
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd(), dir = resolve(root, '.dsh-dev/deepening/b8-screens');
assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev')); await mkdir(dir, { recursive: true });
const suites = ['memory-list', 'memory-conflicts', 'forget', 'root-warning', 'auto-share'];
const runs = [];
for (const suite of suites) {
  const child = spawn(process.execPath, ['scripts/deepening/e2e.mjs', '--suite', suite, '--mock-only'], {
    cwd: root, env: { ...process.env, DP_RELEASE_SCREENSHOTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
  await writeFile(resolve(dir, `${suite}-${Date.now()}.log`), output);
  const line = output.trim().split('\n').findLast(line => line.startsWith('{') && line.includes('"dir"'));
  let receipt;
  if (line) {
    const { dir: evidence } = JSON.parse(line); assert.ok(evidence.startsWith(resolve(root, '.dsh-dev/deepening/')));
    receipt = JSON.parse(await readFile(resolve(evidence, 'summary.json')));
    for (const item of receipt.results ?? []) {
      const file = `v04-${suite}-${item.language}-${item.theme}-${item.width === 390 ? 'narrow' : 'wide'}-${item.state}.png`;
      await copyFile(resolve(evidence, item.file), resolve(dir, file)); item.releaseFile = file;
    }
    runs.push({ suite, code, evidence, ...receipt });
  } else runs.push({ suite, code, status: 'FAIL(NOT_RUN)', error: output });
}
const summary = { status: runs.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL', runs,
  realModelRequests: 0, artifact: 'dist/dsh-bot-0.4.0.tgz', dir };
await writeFile(resolve(dir, `summary-${Date.now()}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary)); if (summary.status !== 'PASS') process.exitCode = 1;
