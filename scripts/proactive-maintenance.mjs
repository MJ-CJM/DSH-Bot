import assert from 'node:assert/strict';
import { backup, DatabaseSync } from 'node:sqlite';
import { lstat, mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './proactive/worker.mjs';

function inventory(db) {
  const meta = db.prepare('SELECT schema_version, installation, store, seq FROM pb_meta WHERE singleton=1').get();
  assert.ok(meta && Number(meta.schema_version) >= 1 && Number(meta.schema_version) <= 9, 'Unsupported schema');
  const states = db.prepare("SELECT json_extract(payload,'$.state') AS state, count(*) AS count FROM pb_work GROUP BY state ORDER BY state").all();
  return { meta, states, integrity: db.prepare('PRAGMA integrity_check').get().integrity_check };
}

/** Stopped-store rehearsal. A consistent backup is private and ephemeral: it
 * cannot outlive the ownership lock and become an untracked copy after forget.
 * This tool does not migrate the original, send requests or restore old grants. */
export async function rehearseMigration(entry, statePath, scratchRoot) {
  const root = await realpath(resolve('.'));
  const state = await realpath(resolve(statePath));
  const scratch = join(state, '.maintenance-rehearsal');
  // scratchRoot is retained for older callers, but snapshots are store-owned.
  void scratchRoot;
  for (const path of [state, scratch, resolve(entry)]) {
    const rel = relative(root, path);
    assert.ok(rel && !rel.startsWith('..') && !rel.startsWith('/'), 'Paths must remain inside this repository');
  }
  const stat = await lstat(state);
  assert.ok(stat.isDirectory() && (stat.mode & 0o077) === 0, 'Private state directory required');
  for (const file of ['core.sqlite', 'ownership.sqlite']) {
    const item = await lstat(join(state, file));
    assert.ok(item.isFile() && !item.isSymbolicLink() && item.nlink === 1, 'Unsafe database path');
  }
  const lock = new DatabaseSync(join(state, 'ownership.sqlite'));
  let temporary;
  let worker;
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    // Refuse an interrupted prior rehearsal until normal coordinator startup cleans it.
    await mkdir(scratch, { mode: 0o700 });
    assert.equal(await realpath(scratch), scratch, 'Symlink scratch path refused');
    temporary = await mkdtemp(join(scratch, 'migration-'));
    const db = new DatabaseSync(join(state, 'core.sqlite'), { readOnly: true });
    let before;
    try {
      before = inventory(db);
      assert.equal(before.integrity, 'ok');
      await backup(db, join(temporary, 'core.sqlite'));
    } finally { db.close(); }
    worker = launch(resolve(entry), temporary);
    const boot = await worker.send({ kind: 'hello', installationId: before.meta.installation, expectedStoreId: before.meta.store });
    assert.equal(boot.kind, 'hello', 'Candidate could not migrate the snapshot');
    await worker.stop(); worker = undefined;
    const copy = new DatabaseSync(join(temporary, 'core.sqlite'), { readOnly: true });
    let after;
    try { after = inventory(copy); } finally { copy.close(); }
    assert.equal(after.integrity, 'ok');
    assert.equal(after.meta.store, before.meta.store);
    assert.equal(after.meta.seq, before.meta.seq);
    const original = new DatabaseSync(join(state, 'core.sqlite'), { readOnly: true });
    try { assert.deepEqual(inventory(original), before, 'Original changed during rehearsal'); }
    finally { original.close(); }
    return { mode: 'dry-run', before, after, originalUnchanged: true, backupRemoved: true };
  } finally {
    if (worker) await worker.stop('SIGKILL');
    // Cleanup precedes lock release, including failures. Never retain forgotten bodies.
    try { if (temporary) { await rm(temporary, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); } }
    finally { lock.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [entry, state] = process.argv.slice(2);
  assert.ok(entry && state, 'Usage: node scripts/proactive-maintenance.mjs <candidate/main.mjs> <stopped-state-directory>');
  assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
  console.log(JSON.stringify(await rehearseMigration(entry, state, resolve('.dsh-dev/migration-rehearsals')), null, 2));
}
