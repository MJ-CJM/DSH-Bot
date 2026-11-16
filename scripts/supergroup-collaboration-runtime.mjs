// Host-only matrix. All paths and model traffic are isolated under this repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webHost } from './deepening/b4-web-host.mjs';
import { sha256 } from './p34-artifact.mjs';

const [mode, artifactArg, ...args] = process.argv.slice(2);
assert.equal(mode, '--mock-only', 'usage: --mock-only frozen.tgz [--rc2 path] [--desktop022 path] [--only rc2|desktop022]');
assert.ok(artifactArg && !artifactArg.startsWith('--'), 'a frozen artifact is required');
const overrides = new Map();
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--rc2', '--desktop022', '--only'].includes(args[index]) && args[index + 1], 'unknown or incomplete argument');
  overrides.set(args[index], args[index + 1]);
}
const root = process.cwd(), isolatedRoot = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, isolatedRoot, 'run from the repository with DSH_HOME="$PWD/.dsh-dev"');
const selected = overrides.get('--only'); assert.ok(!selected || ['rc2', 'desktop022'].includes(selected));
const artifact = resolve(artifactArg), artifactSha256 = sha256(await readFile(artifact));
const out = resolve(isolatedRoot, 'supergroup-collaboration', `${Date.now()}-${process.pid}`);
await mkdir(out, { recursive: true });
console.log(out);
const variants = [
  { id: 'rc2', version: '0.2.1-rc.2', cli: overrides.get('--rc2') ?? process.env.DSH_BOT_RC2_DSH_BIN ?? resolve(isolatedRoot, 'proactive-bot/host-runtime/node_modules/.bin/dsh') },
  { id: 'desktop022', version: '0.2.2-rc.2', cli: overrides.get('--desktop022') ?? process.env.DSH_BOT_DESKTOP022_DSH_BIN ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' },
].filter(variant => !selected || variant.id === selected);
const results = [];
const fixtureConfig = [
  '- id: dsh-bot', '  config:', '    messagingEnabled: true', '    messagePairRequests: 30', '    messagePairTotal: 60', '    proactiveEnabled: false', '    proactiveExecutionEnabled: false',
  '    supergroup:', '      enabled: true', '      maxRequests: 36', '      timeoutMs: 90000',
  '      allowedBotIds: [auto-owner, auto-reviewer, auto-expert]',
];
async function protectedStorage(dir) {
  const storage = resolve(dir, 'storage'), files = ['dsh_bot_main_session.json'];
  for (const section of ['flow_sessions', 'versions', 'payloads']) {
    const entries = await readdir(resolve(storage, 'dsh_bot_memory', section), { recursive: true })
      .catch(error => { if (error.code === 'ENOENT' && section === 'versions') return []; throw error; });
    files.push(...entries.filter(file => file.endsWith('.json')).map(file => `dsh_bot_memory/${section}/${file}`));
  }
  assert.ok(files.some(file => file.includes('/flow_sessions/')) && files.some(file => file.includes('/payloads/')),
    'the fixture contains real persisted session labels and private memory payloads');
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, sha256(await readFile(resolve(storage, file)))])));
}
try {
  for (const variant of variants) {
    const dir = resolve(out, variant.id); await mkdir(dir, { recursive: true });
    process.env.DSH_BOT_DSH_BIN = resolve(variant.cli);
    const versionOutput = execFileSync(resolve(root, 'scripts/dsh'), ['--version'], { encoding: 'utf8', timeout: 30000, cwd: root,
      env: { PATH: process.env.PATH, HOME: dir, DSH_HOME: dir, DSH_BOT_DSH_BIN: process.env.DSH_BOT_DSH_BIN, DSH_TELEMETRY_DISABLED: '1' } }).trim();
    assert.ok(versionOutput.split(/\r?\n/).includes(variant.version), `${variant.id}: expected ${variant.version}, received ${versionOutput}`);
    await writeFile(resolve(dir, 'version.txt'), `${versionOutput}\n`);
    assert.equal(sha256(await readFile(artifact)), artifactSha256, 'the frozen artifact has not changed');
    let host;
    try {
      host = await webHost(dir, 'collaboration', artifact, resolve(root, 'packages/dsh-bot/tests/supergroup-collaboration-profile.mjs'), fixtureConfig);
      const receipt = JSON.parse(await readFile(resolve(dir, 'collaboration.json'), 'utf8'));
      assert.equal(receipt.status, 'PASS'); assert.equal(receipt.realModelRequests, 0); assert.equal(receipt.groups, 0);
      assert.deepEqual(receipt.providerIds, ['dp-loopback']);
      assert.equal(host.requests(), 0, 'no outbound capture or model HTTP requests');
      const denied = await readFile(resolve(dir, 'network-denials.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      assert.equal(denied, '', 'no unexpected outbound attempt');
      results.push({ runtime: variant.id, version: variant.version, status: 'PASS', artifactSha256, receipt: resolve(dir, 'collaboration.json'),
        realModelRequests: 0, browser: 'NOT_RUN', cases: receipt.cases, exchanges: receipt.exchanges });
    } finally { await host?.stop(); host = undefined; }
    const recoveryDir = resolve(dir, 'recovery'); await mkdir(recoveryDir, { recursive: true });
    try {
      host = await webHost(recoveryDir, 'crash', artifact, resolve(root, 'packages/dsh-bot/tests/supergroup-collaboration-profile.mjs'), fixtureConfig);
      const ready = JSON.parse(await readFile(resolve(recoveryDir, 'crash-ready.json'), 'utf8')); assert.equal(ready.status, 'PASS');
      assert.equal(host.requests(), 0);
      await host.crash();
    } finally { await host?.stop(); host = undefined; }
    const patchPath = resolve(recoveryDir, 'home/profiles/b4-browser/cordis.patch.yml');
    const patch = await readFile(patchPath, 'utf8'); assert.match(patch, /suite: crash/);
    await writeFile(patchPath, patch.replace('suite: crash', 'suite: cold'));
    try {
      host = await webHost(recoveryDir, 'cold', artifact, resolve(root, 'packages/dsh-bot/tests/supergroup-collaboration-profile.mjs'), fixtureConfig, { preserveProfile: true });
      const cold = JSON.parse(await readFile(resolve(recoveryDir, 'cold.json'), 'utf8')); assert.equal(cold.status, 'PASS');
      assert.equal(cold.modelRequests, 0); assert.equal(host.requests(), 0);
      const denied = await readFile(resolve(recoveryDir, 'network-denials.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      assert.equal(denied, '', 'recovery never attempts outbound traffic');
      results.at(-1).recovery = cold;
    } finally { await host?.stop(); host = undefined; }
    // Model a pre-upgrade schema only in this stopped synthetic profile. The real
    // Host produced all records; only the new optional work field is removed.
    const workPath = resolve(recoveryDir, 'storage/dsh_bot_supergroup.json');
    const oldDomain = JSON.parse(await readFile(workPath, 'utf8'));
    const previous = JSON.parse(await readFile(resolve(recoveryDir, 'crash-ready.json'), 'utf8'));
    const oldWork = oldDomain.tables.works[previous.workId];
    assert.ok(oldWork?.collaboration && oldWork.state === 'unknown');
    const protectedBefore = await protectedStorage(recoveryDir);
    delete oldWork.collaboration;
    await writeFile(workPath, `${JSON.stringify(oldDomain)}\n`);
    const coldPatch = await readFile(patchPath, 'utf8'); assert.match(coldPatch, /suite: cold/);
    await writeFile(patchPath, coldPatch.replace('suite: cold', 'suite: legacy-cold'));
    await writeFile(resolve(recoveryDir, 'legacy-fixture.json'), `${JSON.stringify({ workId: previous.workId,
      origin: 'native synthetic crash and cold recovery', removedOptionalField: 'collaboration', protectedFiles: protectedBefore }, null, 2)}\n`);
    try {
      host = await webHost(recoveryDir, 'legacy-cold', artifact, resolve(root, 'packages/dsh-bot/tests/supergroup-collaboration-profile.mjs'), fixtureConfig, { preserveProfile: true });
      const legacy = JSON.parse(await readFile(resolve(recoveryDir, 'legacy-cold.json'), 'utf8'));
      assert.equal(legacy.status, 'PASS'); assert.equal(legacy.modelRequests, 0); assert.equal(host.requests(), 0);
      assert.deepEqual(await protectedStorage(recoveryDir), protectedBefore, 'old labels, memory payloads and main bindings are byte-identical after startup');
      assert.deepEqual(JSON.parse(await readFile(workPath, 'utf8')).tables.works[previous.workId], oldWork,
        'the old-format unknown work record is not rewritten by a read-only cold query');
      results.at(-1).legacyCompatibility = { ...legacy, oldWorkUnchanged: true, protectedFilesUnchanged: Object.keys(protectedBefore).length };
    } finally { await host?.stop(); }
  }
  await writeFile(resolve(out, 'summary.json'), `${JSON.stringify({ status: 'PASS', artifact, artifactSha256, results }, null, 2)}\n`);
  console.log(`SUPERGROUP_COLLABORATION_PASS ${results.map(result => result.runtime).join(',')}`);
} catch (error) {
  await writeFile(resolve(out, 'summary.json'), `${JSON.stringify({ status: 'FAIL', artifact, artifactSha256, results, error: String(error.stack) }, null, 2)}\n`);
  throw error;
}
