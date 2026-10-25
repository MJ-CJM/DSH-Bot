#!/usr/bin/env node
// One reviewable local release, native host regression, physical crash windows, separate browser verdict.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { command, auditArtifact, auditInstalled } from './p34-artifact.mjs';
const root = process.cwd(), home = resolve(root, '.dsh-dev'); assert.equal(process.env.DSH_HOME, home);
const dir = resolve(home, 'v032', `${Date.now()}-${process.pid}`); await mkdir(dir, { recursive: true });
await mkdir(resolve(home, 'v032'), { recursive: true }); await writeFile(resolve(home, 'v032/latest-run.txt'), `${dir}\n`);
const artifact = resolve(root, 'dist/dsh-bot-0.3.2.tgz');
const env = Object.fromEntries(['PATH','HOME','USER','SHELL'].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
Object.assign(env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache') });
const result = { status: 'FAIL', runtimeStatus: 'FAIL', realModelRequests: 0, modelRequests: 0, checks: [], browser: { status: 'FAIL', reason: 'NOT_RUN' }, dir };
const save = () => writeFile(resolve(dir, 'summary.json'), JSON.stringify(result, null, 2));
async function check(name, fn) {
  try { const detail = await fn(); result.checks.push({ name, status: 'PASS', ...detail }); console.log(`PASS ${name}`); }
  catch(e) { result.checks.push({ name, status: 'FAIL', reason: String(e) }); console.log(`FAIL ${name}: ${e}`); }
  await save();
}
async function execute(args, label, extra = {}) {
  const r = await command(process.execPath, args, { cwd: root, env: { ...env, ...extra } });
  await writeFile(resolve(dir, `${label}.log`), r.output.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]')); return r;
}
await check('previous_features_install_and_upgrade', async () => {
  await execute(['scripts/p34-e2e', '--host-only'], 'p34');
  const path = (await readFile(resolve(home, 'p34-u12-13/latest-run.txt'), 'utf8')).trim();
  const old = JSON.parse(await readFile(resolve(path, 'summary.json')));
  assert.equal(old.runtimeStatus, 'PASS'); assert.equal(old.realModelRequests, 0); result.modelRequests += old.modelRequests;
  return { evidence: path, checks: old.checks, modelRequests: old.modelRequests };
});
let audit;
await check('artifact', async () => {
  audit = await auditArtifact(root, artifact, dir); assert.equal(audit.version, '0.3.2');
  assert.ok(audit.files.every(f => !/(?:^|\/)(tests|spikes|scripts)(?:\/|$)/.test(f.file)));
  await writeFile(`${artifact}.sha256`, `${audit.sha256}  dsh-bot-0.3.2.tgz\n`);
  return { sha256: audit.sha256, files: audit.files.length };
});
await check('production_message_matrix', async () => {
  assert.ok(audit); const output = resolve(dir, 'messages');
  const execution = await execute(['scripts/b2b-runtime.mjs', 'release'], 'messages', { DSH_BOT_E2E_DIR: output, DSH_BOT_E2E_PACKAGE: artifact, B2B_SCREENSHOTS: '1' });
  assert.equal(execution.code, 0); const summary = JSON.parse(await readFile(resolve(output, 'summary.json')));
  assert.equal(summary.status, 'PASS'); assert.equal(summary.realModelRequests, 0);
  assert.deepEqual(summary.mcpCalls, [{ owner: 'beta', method: 'tools/call', name: 'echo' }]);
  result.modelRequests += summary.requests;
  const browser = JSON.parse(await readFile(resolve(output, 'screenshots.json'))); result.browser = browser;
  return { evidence: output, modelRequests: summary.requests, installed: await auditInstalled(home, summary.profile, audit) };
});
await check('lazy_first_main_only', async () => {
  assert.ok(audit); const output = resolve(dir, 'lazy');
  const execution = await execute(['scripts/b2b-runtime.mjs', 'lazy'], 'lazy', { DSH_BOT_E2E_DIR: output, DSH_BOT_E2E_PACKAGE: artifact });
  assert.equal(execution.code, 0); const summary = JSON.parse(await readFile(resolve(output, 'summary.json')));
  assert.equal(summary.status, 'PASS'); result.modelRequests += summary.requests;
  return { evidence: output, modelRequests: summary.requests, installed: await auditInstalled(home, summary.profile, audit) };
});
for (const window of ['outbox', 'send-flush', 'pending', 'claimed', 'reply-accepted', 'canceled', 'wake-only', 'flush-false', 'store-failure']) await check(`crash_${window}`, async () => {
  assert.ok(audit); const output = resolve(dir, `window-${window}`);
  const execution = await execute(['scripts/b2b-runtime.mjs', 'window'], `window-${window}`, { DSH_BOT_E2E_DIR: output, DSH_BOT_E2E_PACKAGE: artifact, B2B_CRASH_WINDOW: window });
  assert.equal(execution.code, 0); const summary = JSON.parse(await readFile(resolve(output, 'summary.json')));
  assert.equal(summary.status, 'PASS'); assert.equal(summary.realModelRequests, 0); result.modelRequests += summary.requests;
  const recovery = JSON.parse(await readFile(resolve(output, 'cold-recovery.json'))); assert.equal(recovery.status, 'PASS');
  return { evidence: output, modelRequests: summary.requests, installed: await auditInstalled(home, summary.profile, audit) };
});
result.runtimeStatus = result.checks.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL';
result.status = result.runtimeStatus === 'PASS' && result.browser.status === 'PASS' ? 'PASS' : 'FAIL';
await save(); console.log(JSON.stringify({ status: result.status, runtimeStatus: result.runtimeStatus, browser: result.browser.status, dir, modelRequests: result.modelRequests, realModelRequests: 0 }));
if (result.status !== 'PASS') process.exitCode = 1;
