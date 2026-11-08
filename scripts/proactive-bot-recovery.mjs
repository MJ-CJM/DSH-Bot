import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launch, scratch } from './proactive/worker.mjs';

const dir = await scratch('recovery');
assert.ok(process.argv[2], 'Pass the extracted new coordinator main.mjs');
const entry = resolve(process.argv[2]);
const store = join(dir, 'store');
await mkdir(store, { mode: 0o700 });
const installationId = randomUUID();
const hello = { kind: 'hello', installationId, expectedStoreId: null };
let child = launch(entry, store);
const rows = [];
try {
  const boot = await child.send(hello);
  assert.equal(boot.kind, 'hello');
  const { storeId } = boot;
  const op = {
    commandId: randomUUID(), actorRef: 'local-host', storeId,
    body: { events: [], expectedCheckpoint: null, generation: 1, kind: 'ingest-batch', nextCheckpoint: 'stable', sourceId: 'fixture' },
  };
  op.payloadDigest = createHash('sha256').update(JSON.stringify(op.body)).digest('hex');
  const committed = await child.send({ kind: 'command', command: op });
  assert.equal(committed.kind, 'receipt');
  const contender = launch(entry, store);
  try { assert.equal((await contender.send({ ...hello, expectedStoreId: storeId })).kind, 'rejected'); }
  finally { await contender.stop(); }
  rows.push('concurrent writer refused');
  await child.stop('SIGKILL');
  const snapshotDir = join(dir, 'backup');
  await mkdir(snapshotDir, { mode: 0o700 });
  // Hold the same lock the worker uses during SQLite's consistent snapshot.
  const lock = new DatabaseSync(join(store, 'ownership.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    const db = new DatabaseSync(join(store, 'core.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      await backup(db, join(snapshotDir, 'core.sqlite'));
    } finally { db.close(); }
  } finally { lock.close(); }
  child = launch(entry, snapshotDir);
  assert.equal((await child.send({ ...hello, expectedStoreId: storeId })).storeId, storeId);
  const duplicate = await child.send({ kind: 'command', command: op });
  assert.equal(duplicate.receipt.status, 'duplicate');
  assert.equal(duplicate.receipt.receiptId, committed.receipt.receiptId);
  assert.deepEqual((await child.send({ kind: 'checkpoint', storeId, sourceId: 'fixture' })).source, { generation: 1, checkpoint: 'stable' });
  rows.push('SIGKILL, SQLite snapshot, restore, cursor and receipt match');
  await child.stop();
  if (process.argv[3]) {
    const previous = launch(resolve(process.argv[3]), snapshotDir);
    try { assert.equal((await previous.send({ ...hello, expectedStoreId: storeId })).kind, 'rejected'); }
    finally { await previous.stop(); }
    rows.push('previous binary rejected upgraded database');
    const oldPath = resolve(process.argv[3]);
    const migrationDir = join(dir, 'upgrade');
    await mkdir(migrationDir, { mode: 0o700 });
    const old = launch(oldPath, migrationDir);
    let oldStoreId, oldReceipt;
    try {
      const opened = await old.send(hello);
      assert.equal(opened.kind, 'hello');
      oldStoreId = opened.storeId;
      oldReceipt = await old.send({ kind: 'command', command: { ...op, storeId: oldStoreId } });
      assert.equal(oldReceipt.receipt.status, 'committed');
    } finally { await old.stop(); }
    const upgraded = launch(entry, migrationDir);
    try {
      assert.equal((await upgraded.send({ ...hello, expectedStoreId: oldStoreId })).storeId, oldStoreId);
      const kept = await upgraded.send({ kind: 'command', command: { ...op, storeId: oldStoreId } });
      assert.equal(kept.receipt.status, 'duplicate');
      assert.equal(kept.receipt.receiptId, oldReceipt.receipt.receiptId);
      assert.equal((await upgraded.send({ kind: 'checkpoint', storeId: oldStoreId, sourceId: 'fixture' })).source.checkpoint, 'stable');
    } finally { await upgraded.stop(); }
    rows.push('previous database upgraded with receipt and cursor intact');
  }
  const db = new DatabaseSync(join(snapshotDir, 'core.sqlite'));
  try { db.exec('UPDATE pb_meta SET schema_version=999'); } finally { db.close(); }
  child = launch(entry, snapshotDir);
  assert.equal((await child.send({ ...hello, expectedStoreId: storeId })).kind, 'rejected');
  rows.push('future schema refused');
  await writeFile(join(dir, 'result.json'), JSON.stringify({ rows, storeId, receipt: committed.receipt }, null, 2));
  console.log(`PASS recovery ${dir}`);
} finally { await child.stop(); }
