import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { hash, spikePath, workspaceRoot } from './artifact.ts'
import type { Coordinator } from './fixtures.ts'

interface WorkerReceipt {
  pid: number
  result?: string
  barrier?: string
  rows?: Record<string, number>
  offset?: number
  exists?: boolean
  error?: { code?: string; errcode?: number; message: string }
}

export async function verifyProcesses(outputDir: string, artifact: string, { Store }: Coordinator) {
  const root = workspaceRoot()
  const worker = join(dirname(artifact), 'sqlite-worker.cjs')
  const dbDir = resolve(outputDir, 'writer')
  mkdirSync(dbDir, { recursive: true })
  const db = join(dbDir, 'core.sqlite')
  await build({
    absWorkingDir: root, entryPoints: [join(root, spikePath, 'src/core/sqlite-worker.ts')],
    outfile: worker, bundle: true, platform: 'node', format: 'cjs', target: 'node22.19',
  })
  const initial = new Store(db)
  initial.db.exec('CREATE TABLE source_checkpoint (offset INTEGER NOT NULL); INSERT INTO source_checkpoint VALUES (0)')
  initial.close()
  const env = { PATH: dirname(process.execPath), LANG: 'C' }
  const direct = (action: string, eventId?: string): WorkerReceipt => {
    const result = spawnSync(process.execPath, [worker, action, db, ...eventId ? [eventId] : []], {
      cwd: dbDir, env, encoding: 'utf8', timeout: 5_000,
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`)
    return JSON.parse(result.stdout) as WorkerReceipt
  }
  async function atBarrier<T>(action: string, eventId: string, probe: (
    receipt: WorkerReceipt, kill: () => Promise<{ status: number | null; signal: NodeJS.Signals | null }>
  ) => Promise<T>) {
    const child = spawn(process.execPath, [worker, action, db, eventId], { cwd: dbDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('close', (status, signal) => resolve({ status, signal }))
    })
    let timer: NodeJS.Timeout | undefined
    try {
      const barrier = await new Promise<WorkerReceipt>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Writer never reached crash barrier: ${stderr}`)), 5_000)
        lines.once('line', line => {
          try { resolve(JSON.parse(line) as WorkerReceipt) } catch (error) { reject(error) }
        })
        child.once('error', reject)
        void exited.then(result => reject(new Error(`Writer exited before crash barrier: ${JSON.stringify(result)} ${stderr}`)))
      })
      assert.equal(barrier.pid, child.pid)
      return await probe(barrier, async () => {
        assert(child.kill('SIGKILL'))
        const exit = await exited
        assert.equal(exit.signal, 'SIGKILL')
        return exit
      })
    } finally {
      clearTimeout(timer)
      lines.close()
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  }

  function holdAndKill(action: 'uncommitted' | 'committed', eventId: string) {
    return atBarrier(action, eventId, async (barrier, kill) => {
      assert.equal(barrier.barrier, action === 'committed' ? 'after-outer-release-before-dispatch' : 'before-outer-release')
      const contender = direct('inspect', eventId)
      assert.notEqual(contender.pid, barrier.pid)
      assert.equal(contender.error?.code, 'ELOCKED')
      const sqliteContender = direct('sqlite-contender')
      if (action === 'uncommitted') assert.equal(sqliteContender.error?.errcode, 5, 'SQLite must hold a real write lock')
      else assert.equal(sqliteContender.result, 'acquired-sqlite-write-lock', 'SQLite releases the transaction lock after commit')
      const exit = await kill()
      let reopened = direct('inspect', eventId)
      const rejectedImmediately = reopened.error?.code === 'ELOCKED'
      for (let attempt = 0; reopened.error?.code === 'ELOCKED' && attempt < 24; attempt++) {
        await delay(125)
        reopened = direct('inspect', eventId)
      }
      assert.equal(reopened.result, 'opened')
      assert.notEqual(reopened.pid, barrier.pid)
      return { barrier, contender, sqliteContender, exit, rejectedImmediately, reopened }
    })
  }

  const rollback = await holdAndKill('uncommitted', 'kill-before-commit')
  assert.equal(rollback.barrier.offset, 1)
  assert.equal(rollback.barrier.rows?.effect, 1)
  assert.equal(rollback.reopened.offset, 0)
  assert.equal(rollback.reopened.exists, false)
  assert.equal(rollback.reopened.rows?.effect, 0)
  const committed = await holdAndKill('committed', 'kill-after-commit')
  assert.equal(committed.barrier.offset, 1)
  assert.equal(committed.reopened.offset, 1)
  assert.equal(committed.reopened.exists, true)
  assert.equal(committed.reopened.rows?.effect, 1)
  const leaseGap = await atBarrier('lease-pause', '', async (owner, kill) => {
    assert.equal(owner.barrier, 'lease-heartbeat-paused')
    // proper-lockfile's first mtime probe can round up by one second.
    await delay(3_250)
    const contender = direct('inspect')
    assert.equal(contender.result, 'opened')
    assert.notEqual(contender.pid, owner.pid)
    process.kill(owner.pid, 0)
    return { owner, contender, formerOwnerStillAlive: true, exit: await kill() }
  })
  const sidecarLock = await atBarrier('kernel-hold', '', async (owner, kill) => {
    assert.equal(owner.barrier, 'kernel-writer-locked')
    assert(process.kill(owner.pid, 'SIGSTOP'))
    await delay(3_250)
    const contender = direct('kernel-contender')
    assert.equal(contender.error?.errcode, 5)
    const exit = await kill()
    const reopened = direct('kernel-contender')
    assert.equal(reopened.result, 'acquired-sqlite-write-lock')
    assert.notEqual(reopened.pid, owner.pid)
    return { owner, stopSignal: 'SIGSTOP', contender, exit, reopened }
  })
  return {
    file: 'writer/core.sqlite', worker: { file: 'coordinator/sqlite-worker.cjs', sha256: hash(worker) },
    lock: { driver: 'proper-lockfile@4.1.2', fixtureStaleMs: 2000, upstreamRuntimeStaleMs: 30000 },
    rollback, committed, leaseGap, sidecarLock, externalDispatches: 0,
  }
}
