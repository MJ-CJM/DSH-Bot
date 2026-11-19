// Read-only check against this installation's full cold backup; never starts an Agent.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { treeManifest } from './deploy-official-desktop.mjs';
import { auditInstalled } from './p34-artifact.mjs';
import { verifyMessagingIndexRecovery } from './verify-official-desktop-live.mjs';

const run = await realpath(resolve(process.argv[2])); assert.ok(run.startsWith(join(process.cwd(), '.dsh-dev/')));
const json = path => readFile(path, 'utf8').then(JSON.parse);
const prepared = await json(join(run, 'prepared.json')), before = await json(join(run, 'before.json')), installed = await json(join(run, 'installed.json'));
for (const receipt of [prepared, before, installed]) assert.equal(receipt.status, 'PASS');
assert.equal(installed.artifactSha256, prepared.audit.sha256);
const { home, app } = before.paths, backupHome = join(run, 'backup/home');
for (const key of ['app', 'home', 'userData']) assert.equal((await treeManifest(join(run, 'backup', key))).sha256, before.manifests[key].sha256);
assert.equal((await treeManifest(app)).sha256, before.manifests.app.sha256);
await auditInstalled(home, 'desktop', prepared.audit);
assert.deepEqual(await readFile(join(home, 'profiles/desktop/cordis.patch.yml')), await readFile(join(run, 'stage-home/profiles/desktop/cordis.patch.yml')).then(bytes =>
  Buffer.from(bytes.toString().replace('- id: dsh-bot\n  name: dsh-bot\n', '- id: dsh-bot\n  name: dsh-botgroup\n'))));
function decode(bytes) {
  let text;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) text = gunzipSync(bytes).toString();
  else if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfd2fb528) {
    const frames = [];
    while (bytes.length) { const { buffer, engine } = zstdDecompressSync(bytes, { info: true }); assert.ok(engine.bytesWritten > 0);
      frames.push(buffer); bytes = bytes.subarray(engine.bytesWritten); }
    text = Buffer.concat(frames).toString();
  } else text = bytes.toString();
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const previous = new Map(before.manifests.home.entries.map(row => [row.path, row]));
const current = await treeManifest(home), now = new Map(current.entries.map(row => [row.path, row]));
const changed = [], history = [], allowedEvents = new Set(['session/end-seed', 'session/title', 'agent/inbox/spliced', 'turn/start', 'turn/end']);
for (const row of before.manifests.home.entries) if (!row.path.startsWith('profiles/desktop')) assert.ok(now.has(row.path), `Old data removed: ${row.path}`);
for (const row of current.entries) {
  const path = row.path, old = previous.get(path);
  if (path.startsWith('profiles/desktop') || JSON.stringify(row) === JSON.stringify(old)) continue;
  changed.push(path);
  if (/^dsh-bot\/memory-owner\/after-[a-f0-9-]+\.json$/.test(path)) { assert.equal(old, undefined); continue; }
  if (path === 'storages/dsh_bot_memory/layout/extension-fence.json') {
    assert.equal(old, undefined); assert.deepEqual(await json(join(home, path)), { version: 2, record: { phase: 'ready', extensionVersion: 3 } }); continue;
  }
  if (path === 'storages/dsh_bot_memory/projections/snapshot.json') {
    const a = await json(join(backupHome, path)), b = await json(join(home, path));
    assert.equal(b.version, 3); assert.deepEqual({ ...b, version: a.version }, a); continue;
  }
  if (path === 'storages/dsh_bot_messaging.json') {
    verifyMessagingIndexRecovery(await json(join(backupHome, path)), await json(join(home, path))); continue;
  }
  if (/^sessions\/.*\.jsonl(?:\.zstd|\.gz|\.gzip)?$/.test(path)) {
    assert.ok(old, 'Unexpected new session');
    const a = decode(await readFile(join(backupHome, path))), b = decode(await readFile(join(home, path)));
    assert.deepEqual(b.slice(0, a.length), a, 'Existing history changed');
    const extra = b.slice(a.length);
    for (const event of extra) {
      assert.ok(allowedEvents.has(event.type), `Unexpected startup event: ${event.type}`);
      if (event.type === 'agent/inbox/spliced') for (const message of event.data.inserted ?? [])
        assert.equal(message.source?.kind, 'dsh-bot-group-setup', 'Unexpected business input on startup');
    }
    history.push({ path, retained: a.length, appendedTypes: extra.map(event => event.type) }); continue;
  }
  // Native projection cache is derived from the authoritative append-only session above.
  if (/^storages\/session_projcache\/sessions\/[^/]+\.json$/.test(path)) { assert.ok(old); continue; }
  assert.fail(`Unexplained startup mutation: ${path}`);
}
const counts = {};
for (const name of ['dsh_bot', 'dsh_bot_groups', 'dsh_bot_supergroup']) {
  const path = `storages/${name}.json`, a = await json(join(backupHome, path)), b = await json(join(home, path));
  assert.deepEqual(b, a); counts[name] = Object.fromEntries(Object.entries(b.tables).map(([key, rows]) => [key, Object.keys(rows).length]));
}
const report = { status: 'PASS', artifactSha256: prepared.audit.sha256, officialApplicationUnchanged: true, backupIntegrity: true,
  oldRecordsRetained: true, counts, changed, history, newModelRequestEvents: 0, newUserBusinessInputs: 0,
  capabilities: { consolidationDefaultEnabled: false, automaticWakeup: false, realQuality: 'NOT_RUN' } };
await writeFile(join(run, 'live-verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ status: report.status, counts, changedFiles: changed.length, newModelRequestEvents: 0, oldRecordsRetained: true }));
