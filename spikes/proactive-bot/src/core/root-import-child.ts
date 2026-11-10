import childProcess from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { syncBuiltinESMExports } from 'node:module'

const attempted: string[] = []
function deny(target: object, key: string, scope: string) {
  Object.defineProperty(target, key, { configurable: true, writable: true, value: () => {
    const operation = `${scope}.${key}`
    attempted.push(operation)
    throw new Error(`Blocked import-time operation: ${operation}`)
  } })
}
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) deny(childProcess, key, 'child_process')
for (const key of ['writeFile', 'writeFileSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'rename', 'renameSync']) deny(fs, key, 'fs')
for (const key of ['writeFile', 'mkdir', 'rm', 'rename']) deny(fs.promises, key, 'fs.promises')
deny(net.Socket.prototype, 'connect', 'socket')
deny(net.Server.prototype, 'listen', 'server')
deny(globalThis, 'fetch', 'global')
syncBuiltinESMExports()

function observe() {
  const processWithHandles = process as NodeJS.Process & { _getActiveHandles(): object[] }
  return {
    cwd: process.cwd(), path: process.env.PATH,
    env: Object.fromEntries(['PATH', 'LANG', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].map(key => [key, process.env[key]])),
    envKeys: Object.keys(process.env).sort(),
    resources: process.getActiveResourcesInfo().sort(),
    handles: processWithHandles._getActiveHandles().map(value => value.constructor.name).sort(),
    listeners: Object.fromEntries(process.eventNames().map(name => [String(name), process.listenerCount(name)])),
    globals: Object.getOwnPropertyNames(globalThis).sort(),
  }
}

// Both pipes are normally lazily initialized. Normalize that before sampling.
void process.stdout
void process.stderr
const before = observe()
let imported: { ok: boolean; exports?: string[]; error?: string }
try {
  const specifier = process.argv[2] === 'lockfile-control' ? 'proper-lockfile' : 'dsh-superagent'
  const root = await import(specifier) as Record<string, unknown>
  imported = { ok: true, exports: Object.keys(root).sort() }
} catch (error) {
  imported = { ok: false, error: error instanceof Error ? error.stack : String(error) }
}
await new Promise<void>(resolve => setImmediate(resolve))
const after = observe()
const changed = (Object.keys(before) as (keyof typeof before)[]).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
const receipt = {
  ...imported, attempted, before: { ...before, globals: before.globals.length },
  after: { ...after, globals: after.globals.length }, changed,
  addedGlobals: after.globals.filter(name => !before.globals.includes(name)),
  addedListeners: Object.keys(after.listeners).filter(name => !(name in before.listeners)),
}
process.stdout.write(`${JSON.stringify(receipt)}\n`)
