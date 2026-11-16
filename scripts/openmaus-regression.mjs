// Runs the real official Host/Browser matrix against explicitly pinned inputs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const index = JSON.parse(await readFile(resolve(root, 'packages/dsh-bot/tests/fixtures/openmaus-feedback.json')));
assert.equal(index.format, 'dsh-bot-sanitized-feedback'); assert.equal(index.version, 1);
const allowed = new Set(['direct', 'first-turn', 'group', 'group-input', 'messages', 'openmaus']);
assert.equal(new Set(index.cases.map(row => row.id)).size, index.cases.length);
for (const row of index.cases) {
  assert.ok(allowed.has(row.suite) && row.assertion.length > 30);
  for (const path of [row.feedback, row.report]) await readFile(resolve(root, path));
}
const rawArgs = process.argv.slice(2);
const includeReview = rawArgs.includes('--include-review');
assert.ok(rawArgs.filter(arg => arg === '--include-review').length <= 1);
const args = rawArgs.filter(arg => arg !== '--include-review');
assert.ok(!args.includes('--suite'), 'Regression suite selection comes from the feedback index');
for (const flag of ['--artifact', '--compat', '--app', '--expected-artifact-sha', '--expected-compat-sha']) assert.ok(args.includes(flag), `Explicit ${flag} required`);
const child = spawn(process.execPath, [resolve(root, 'scripts/official-desktop-compat-validation.mjs'), '--mock-only', ...args,
  '--suite', [...new Set([...index.cases.map(row => row.suite), ...(includeReview ? ['review'] : [])])].join(',')], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
let output = ''; child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
assert.equal(code, 0, 'See isolated runtime receipts');
const dir = output.split('\n').find(line => line.startsWith(resolve(root, '.dsh-dev/official-desktop-rc3/validation') + '/'));
assert.ok(dir, 'Missing runtime receipt directory');
const summary = JSON.parse(await readFile(resolve(dir, 'summary.json'))); assert.equal(summary.status, 'PASS');
if (includeReview) assert.equal(summary.results.find(row => row.suite === 'review')?.status, 'PASS');
const cases = index.cases.map(row => {
  const result = summary.results.find(result => result.suite === row.suite); assert.equal(result?.status, 'PASS', row.id);
  return { ...row, status: 'PASS', runtimeReceipt: result.dir, realModelRequests: 0 };
});
await writeFile(resolve(dir, 'feedback-regression.json'), JSON.stringify({ status: 'PASS', source: 'public feedback reports with synthetic replacements',
  artifactSha256: summary.artifactSha256, compatSha256: summary.compatSha256, cases, nativeUiReview: includeReview ? 'PASS' : 'FAIL (NOT_RUN)', realModelRequests: 0, realModelQuality: 'FAIL (NOT_RUN)' }, null, 2));
console.log(`OPENMAUS_FEEDBACK_PASS ${dir}`);
