import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { json, prepareStoreArtifact, verifyUpstream } from './artifact.ts'
import type { Coordinator } from './fixtures.ts'
import { replayMemory } from './memory.ts'
import { verifyProcesses } from './processes.ts'
import { probeRootImport } from './root-import.ts'
import { runSemantics } from './semantics.ts'
import { atomicAndColdReopen, incompatibleAndDiskFull } from './sqlite.ts'

export interface CoreAssertion { id: string; pass: boolean; detail: string; evidence?: string }

export async function runCore(outputDir: string): Promise<CoreAssertion[]> {
  mkdirSync(outputDir, { recursive: true })
  const assertions: CoreAssertion[] = []
  async function run<T>(id: string, detail: string, evidence: string, work: () => T | Promise<T>): Promise<T | undefined> {
    try {
      const result = await work()
      if (result !== undefined) json(join(outputDir, evidence), result)
      assertions.push({ id, pass: true, detail, evidence })
      return result
    } catch (error) {
      json(join(outputDir, evidence.replace(/\.json$/, '-error.json')), {
        error: error instanceof Error ? error.stack : String(error),
      })
      assertions.push({ id, pass: false, detail: error instanceof Error ? error.message : String(error), evidence: evidence.replace(/\.json$/, '-error.json') })
    }
  }

  const baseline = await run('A01-pinned-upstream', 'Verified the fixed official Git snapshot, MIT license and static runtime import closures.',
    'upstream-baseline.json', verifyUpstream)
  if (baseline) {
    await run('A02-public-root-control', 'The upstream package root loads with its alpha lock and adds process registrations; select the bounded coordinator.',
      'root-control.json', () => {
        const receipt = probeRootImport(outputDir, baseline)
        assert.equal(receipt.exit, 0)
        assert(receipt.outcome?.ok, receipt.outcome?.error)
        assert(receipt.outcome.exports?.includes('Engine'))
        assert(receipt.outcome.exports?.includes('MemoryRepositories'))
        assert.deepEqual(receipt.outcome.attempted, [])
        for (const stable of ['cwd', 'path', 'env', 'envKeys']) assert(!receipt.outcome.changed.includes(stable))
        assert(receipt.outcome.addedListeners.length > 0)
        assert.deepEqual(receipt.outcome.addedListeners, receipt.lockfileControl.outcome?.addedListeners)
        return {
          entry: 'dsh-superagent', rootClosure: baseline.rootClosure.files.length,
          standaloneImport: 'PASS', isolatedRuntime: 'FAIL(CAPABILITY)', selected: 'bounded-core-coordinator',
          addedListeners: receipt.outcome.addedListeners, addedGlobals: receipt.outcome.addedGlobals, receipt: 'root-import.json',
        }
      })
  }
  await run('B01-memory-engine-replay', 'Repeated event and accept dedupe, serialized per-Thread Eval, follow-up positive/negative and four decisions.',
    'memory-replay.json', replayMemory)
  const bundle = await run('A03-coordinator-bundle', 'Built exact SQLite and core into an isolated ESM artifact with verified local prompt/skill resources.',
    'coordinator-build.json', () => prepareStoreArtifact(outputDir))
  if (!bundle) {
    assertions.push({ id: 'B02-B04-C-blocked', pass: false, detail: 'Coordinator build unavailable. SQLite/process/semantics fixtures could not run.' })
    return assertions
  }
  const coordinator = await run('A04-coordinator-load', 'Loaded the coordinator artifact and verified the official Store, durable effects and Engine API.',
    'coordinator-load.json', async () => {
      const exports = await import(pathToFileURL(bundle.artifact).href) as Coordinator
      assert.equal(typeof exports.Store, 'function')
      assert.equal(typeof exports.Effects, 'function')
      assert.equal(typeof exports.Engine, 'function')
      assert.equal(exports.SCHEMA_VERSION, 11)
      return { exports, schema: exports.SCHEMA_VERSION }
    })
  if (!coordinator) {
    assertions.push({ id: 'B02-B04-C-blocked', pass: false, detail: 'Coordinator load failed. SQLite/process/semantics fixtures could not run.' })
    return assertions
  }
  await run('B02-sqlite-atomic-and-cold-reopen', 'Official Store, Effects and Outbox rolled back together; post-commit substitutes observed persisted records.',
    'sqlite-atomic.json', () => atomicAndColdReopen(outputDir, coordinator.exports))
  await run('B03-sqlite-disk-and-schema-failures', 'Rejected incompatible/broken schemas and rolled back real SQLITE_FULL; upstream masked the root error code.',
    'sqlite-faults.json', () => incompatibleAndDiskFull(outputDir, coordinator.exports))
  await run('B04-writer-contention-kill-and-fencing', 'New PIDs verified before/after-commit SIGKILL; expired lockfile can admit a second live writer, separate SQLite lock held until process death.',
    'sqlite-processes.json', () => verifyProcesses(outputDir, bundle.artifact, coordinator.exports))
  const semantics = await run('C00-semantics-fixture', 'Ran pinned Engine and policy semantics with substitute ports.',
    'semantics.json', () => runSemantics(bundle.artifact))
  assertions.push(...semantics?.assertions.map(result => ({
    id: result.id, pass: result.status === 'PASS', detail: result.detail, evidence: 'semantics.json',
  })) ?? [])
  return assertions
}
