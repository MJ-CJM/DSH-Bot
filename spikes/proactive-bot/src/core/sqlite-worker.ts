import { writeSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import lockfile from 'proper-lockfile'
import { engineOptions, event, sqliteError, sqliteState, type Coordinator, type StoreFixture } from './fixtures.ts'

const lockOptions = { stale: 2_000, onCompromised: (error: Error) => { throw error } }

function tell(value: object): void { writeSync(1, `${JSON.stringify({ pid: process.pid, ...value })}\n`) }

function barrier(label: string, evidence: object): never {
  tell({ barrier: label, ...evidence })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  throw new Error('Crash fixture resumed without SIGKILL')
}

async function main(): Promise<void> {
  const [, script, action, path, eventId] = process.argv
  if (!script || !action || !path) throw new Error('Expected worker script, action and database path')
  if (action === 'sqlite-contender' || action === 'kernel-contender' || action === 'kernel-hold') {
    const lease = action !== 'sqlite-contender'
    const db = new DatabaseSync(lease ? join(dirname(path), 'writer-lock.sqlite') : path)
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
      if (action === 'kernel-hold') barrier('kernel-writer-locked', {})
      db.exec('ROLLBACK')
      tell({ result: 'acquired-sqlite-write-lock' })
    } catch (error) {
      tell({ result: 'sqlite-refused-writer', error: sqliteError(error) })
    } finally { db.close() }
    return
  }

  let release: () => void
  try { release = lockfile.lockSync(dirname(path), lockOptions) }
  catch (error) {
    tell({ result: 'lock-refused-writer', error: sqliteError(error) })
    return
  }
  let store: StoreFixture | undefined
  try {
    if (action === 'lease-pause') barrier('lease-heartbeat-paused', {})
    const artifact = pathToFileURL(join(dirname(script), 'coordinator-core.mjs')).href
    const { Engine, Store, Effects } = await import(artifact) as Coordinator
    store = new Store(path)
    const repo = store
    const engine = new Engine(engineOptions(repo))
    const state = () => ({
      rows: sqliteState(repo.db),
      offset: Number(repo.db.prepare('SELECT offset FROM source_checkpoint').get()?.offset),
      exists: eventId ? Boolean(repo.triggers.get(eventId)) : undefined,
    })
    if (action === 'inspect') {
      tell({ result: 'opened', ...state() })
      return
    }
    if (!eventId) throw new Error('Missing crash event ID')
    const effects = new Effects(repo, { claim: () => ({ set: () => {} }) })
    const checkpoint = repo.db.prepare('UPDATE source_checkpoint SET offset=offset+1')
    repo.atomic(() => {
      engine.receive(event(eventId))
      checkpoint.run()
      effects.enqueue('launch', eventId, { ticketId: eventId, assignmentId: eventId })
      if (action === 'uncommitted') barrier('before-outer-release', state())
    })
    if (action === 'committed') barrier('after-outer-release-before-dispatch', state())
    throw new Error(`Unknown action: ${action}`)
  } finally {
    try { store?.close() }
    finally { release() }
  }
}

void main().catch(error => {
  tell({ result: 'worker-error', error: sqliteError(error) })
  process.exitCode = 1
})
