import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { key, type Candidate } from '../../vendor/superagent/src/core/index.ts'
import { accept, decide, engineOptions, event, sqliteError, sqliteState, type Coordinator, type StoreFixture } from './fixtures.ts'

export async function atomicAndColdReopen(directory: string, coordinator: Coordinator) {
  const { Engine, Store, Effects, DurableOutbox } = coordinator
  const path = join(directory, 'atomic.sqlite')
  const reports: unknown[] = []
  const repo = new Store(path, error => reports.push(sqliteError(error)))
  const reader = new DatabaseSync(path, { readOnly: true })
  const callbacks: string[] = []
  const dispatched: string[] = []
  const candidates: Candidate[] = []
  const effects = new Effects(repo, { claim: () => ({ set: () => {} }) })
  effects.handle('launch', async (payload, key) => {
    assert(reader.prepare('SELECT id FROM ticket WHERE id=?').get(payload.ticketId))
    dispatched.push(`launch:${key}`)
  })
  const outbox = new DurableOutbox({
    store: repo, effects, commands: {}, paused: () => false,
    sources: {
      instance: () => ({ enabled: true }),
      channelAllowed: () => true,
      send: async message => {
        assert(reader.prepare('SELECT id FROM outbox WHERE id=?').get(message.id))
        dispatched.push(`reply:${message.id}`)
        return 'sent'
      },
    },
  })
  const engine = new Engine({
    ...engineOptions(repo), outbox,
    assessor: { request: candidate => candidates.push(candidate) },
    executor: {
      start: (ticket, assignment) => effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id }),
      deliver: () => {}, stop: () => {},
    },
    emit: domainEvent => repo.afterCommit(() => callbacks.push(domainEvent.type)),
  })
  try {
    const fresh = sqliteState(reader)
    const sync = repo.db.prepare('PRAGMA synchronous').get()?.synchronous
    const journal = repo.db.prepare('PRAGMA journal_mode').get()?.journal_mode
    assert.equal(sync, 2)
    assert.equal(journal, 'wal')
    // The cursor is deliberately a spike-owned table. Engine.receive() nests its own SAVEPOINT.
    repo.db.exec('CREATE TABLE source_checkpoint (offset INTEGER NOT NULL); INSERT INTO source_checkpoint VALUES (0)')
    const cursor = () => Number(reader.prepare('SELECT offset FROM source_checkpoint').get()?.offset)
    const initial = event('atomic-intake')
    assert.throws(() => repo.atomic(() => {
      assert.equal(engine.receive(initial), 'stored')
      repo.db.exec('UPDATE source_checkpoint SET offset = 1')
      assert.equal(cursor(), 0)
      assert.deepEqual(sqliteState(reader), fresh)
      throw new Error('fixture cursor abort')
    }), /fixture cursor abort/)
    assert.deepEqual(sqliteState(reader), fresh)
    assert.equal(cursor(), 0)
    assert.deepEqual(callbacks, [])
    let receipt: ReturnType<typeof engine.receive> | undefined
    repo.atomic(() => {
      receipt = engine.receive(initial)
      repo.db.exec('UPDATE source_checkpoint SET offset = 1')
      assert.equal(cursor(), 0)
    })
    assert.equal(receipt, 'stored')
    assert.equal(cursor(), 1)
    assert.equal(engine.receive(initial), 'duplicate')
    assert.deepEqual(callbacks, ['trigger.received'])
    // External cursor commit failure: first process has already durably accepted the event. The
    // second connection replays before advancing its cursor; the engine only writes the event once.
    const externalEvent = event('external-cursor', 'external')
    const externalPath = join(directory, 'external-checkpoint.txt')
    writeFileSync(externalPath, '0')
    assert.equal(engine.receive(externalEvent), 'stored')
    assert.equal(readFileSync(externalPath, 'utf8'), '0')
    const replayRepo = new Store(path)
    try {
      assert.equal(new Engine(engineOptions(replayRepo)).receive(externalEvent), 'duplicate')
      writeFileSync(externalPath, '2')
    } finally { replayRepo.close() }
    engine.evaluateDue()
    const candidate = candidates.find(item => item.triggers.some(trigger => trigger.id === initial.id))
    assert(candidate, 'Expected a candidate for the initial trigger')
    const beforeDecision = sqliteState(reader)
    const callbackCount = callbacks.length
    effects.start()
    assert.throws(() => repo.atomic(() => {
      decide(engine, candidate, accept)
      const pending = sqliteState(repo.db)
      for (const table of ['ticket', 'decision', 'outbox', 'effect'] as const) assert(pending[table] > beforeDecision[table])
      assert.deepEqual(sqliteState(reader), beforeDecision)
      assert.deepEqual(dispatched, [])
      throw new Error('fixture decision abort')
    }), /fixture decision abort/)
    await effects.idle()
    const rolledBack = sqliteState(reader)
    assert.deepEqual(rolledBack, beforeDecision)
    assert.equal(callbacks.length, callbackCount)
    assert.deepEqual(dispatched, [])
    const accepted = repo.atomic(() => {
      const decision = decide(engine, candidate, accept)
      assert.deepEqual(dispatched, [])
      assert.deepEqual(sqliteState(reader), beforeDecision)
      return decision
    })
    const ticketId = accepted.ticketId
    assert(ticketId, 'Expected the committed ticket ID')
    const beforeDispatch = sqliteState(reader)
    assert.equal(beforeDispatch.effect, 2)
    assert.equal(beforeDispatch.outbox, 1)
    await effects.idle()
    assert.equal(dispatched.length, 2)
    assert.deepEqual(reports, [])
    const beforeClose = sqliteState(reader)
    await effects.drain()
    repo.close()
    reader.close()
    const cold = new Store(path)
    try {
      const afterReopen = sqliteState(cold.db)
      assert.deepEqual(afterReopen, beforeClose)
      assert.equal(cold.triggers.get(initial.id)?.id, initial.id)
      assert.equal(cold.decisions.get(accepted.id)?.ticketId, ticketId)
      assert.equal(cold.tickets.get(ticketId)?.assignments.length, 1)
      assert.equal(cold.receipts.get(key('ack', initial.id))?.status, 'sent')
      assert.equal(cold.db.prepare('SELECT offset FROM source_checkpoint').get()?.offset, 1)
      assert.equal(afterReopen.effect, 0)
      return {
        file: 'atomic.sqlite', pragmas: { synchronous: sync, journalMode: journal },
        fresh, beforeDecision, rolledBack, beforeDispatch, beforeClose, afterReopen,
        callbackCountAfterRollback: callbackCount, callbacks, dispatched, dispatchAfterOuterCommit: true,
        cursor: {
          before: 0, insideFailedTransaction: 0, afterRollback: 0, afterCommit: 1, afterReopen: 1,
          externalAfterReplay: Number(readFileSync(externalPath, 'utf8')),
        },
      }
    } finally { cold.close() }
  } finally {
    await effects.drain()
    if (repo.db.isOpen) repo.close()
    if (reader.isOpen) reader.close()
  }
}

function schema(repo: StoreFixture): number {
  return Number(repo.db.prepare("SELECT value FROM kv WHERE key='schema'").get()?.value)
}

export function incompatibleAndDiskFull(directory: string, { Engine, Store, SCHEMA_VERSION }: Coordinator) {
  const versionPath = join(directory, 'schema.sqlite')
  const initialized = new Store(versionPath)
  const writeVersion = (db: DatabaseSync, version: number) => db.prepare("UPDATE kv SET value=? WHERE key='schema'").run(String(version))
  writeVersion(initialized.db, SCHEMA_VERSION + 1)
  initialized.close()
  const rejections: Record<string, ReturnType<typeof sqliteError>> = {}
  const rejectOpen = (label: string, expected: RegExp, version: number) => {
    assert.throws(() => new Store(versionPath), error => {
      rejections[label] = sqliteError(error)
      return expected.test(rejections[label].message)
    })
    const check = new DatabaseSync(versionPath)
    try { assert.equal(Number(check.prepare("SELECT value FROM kv WHERE key='schema'").get()?.value), version) }
    finally { check.close() }
  }
  rejectOpen('tooNew', /Unsupported orchestrator database version 12/, SCHEMA_VERSION + 1)
  const legacy = new DatabaseSync(versionPath)
  writeVersion(legacy, 9)
  legacy.close()
  rejectOpen('tooOld', /predates schema 10/, 9)
  const damaged = new DatabaseSync(versionPath)
  writeVersion(damaged, 10)
  damaged.exec("INSERT INTO kv (key,value) VALUES ('settings','{}'); INSERT INTO ticket (id,value) VALUES ('invalid-old-ticket','{}')")
  damaged.close()
  rejectOpen('failedMigration', /unchanged at schema 10: its migration to schema 11 failed/, 10)
  const repair = new DatabaseSync(versionPath)
  repair.exec("DELETE FROM ticket WHERE id='invalid-old-ticket'")
  repair.close()
  const migrated = new Store(versionPath)
  const afterMigration = schema(migrated)
  assert.equal(afterMigration, SCHEMA_VERSION)
  migrated.close()

  const fullPath = join(directory, 'full.sqlite')
  const repo = new Store(fullPath)
  const before = sqliteState(repo.db)
  let actual: ReturnType<typeof sqliteError> | undefined
  let surfaced: ReturnType<typeof sqliteError> | undefined
  let callbacks = 0
  try {
    const pages = Number(repo.db.prepare('PRAGMA page_count').get()?.page_count)
    repo.db.exec(`PRAGMA max_page_count=${pages}`)
    const engine = new Engine({ ...engineOptions(repo), emit: () => repo.afterCommit(() => { callbacks++ }) })
    assert.throws(() => repo.atomic(() => {
      engine.receive(event('disk-full-first-write'))
      try { repo.db.prepare('INSERT INTO kv (key,value) VALUES (?,?)').run('disk-full-overflow', 'x'.repeat(2 ** 20)) }
      catch (error) { actual = sqliteError(error); throw error }
    }), error => { surfaced = sqliteError(error); return true })
    assert.equal(actual?.errcode, 13, 'SQLite must report SQLITE_FULL')
    assert.deepEqual(sqliteState(repo.db), before)
    assert.equal(callbacks, 0)
  } finally { repo.close() }
  const cold = new Store(fullPath)
  try {
    const coldState = sqliteState(cold.db)
    assert.deepEqual(coldState, before)
    assert.equal(new Engine(engineOptions(cold)).receive(event('disk-full-first-write')), 'stored')
    return { rejections, afterMigration, diskFull: { actual, surfaced, callbacks, before, coldState, retryAfterReopen: 'stored' } }
  } finally { cold.close() }
}
