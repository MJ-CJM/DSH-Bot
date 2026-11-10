import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { hash, json, spikePath, type verifyUpstream } from './artifact.ts'

export function probeRootImport(outputDir: string, baseline: ReturnType<typeof verifyUpstream>) {
  const stage = join(baseline.root, '.dsh-dev/proactive-bot/upstream-root-probe')
  mkdirSync(stage, { recursive: true })
  const copies = ['src', 'prompts', 'skills', 'locale', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsdown.config.ts']
  for (const path of copies) {
    if (!existsSync(join(stage, path))) cpSync(join(baseline.source, path), join(stage, path), { recursive: true })
  }
  const sourceFiles = ['src', 'prompts', 'skills', 'locale'].flatMap(directory =>
    readdirSync(join(baseline.source, directory), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
      .map(entry => relative(baseline.source, join(entry.parentPath, entry.name))))
  for (const path of [...copies.filter(path => path.includes('.')), ...sourceFiles]) {
    if (hash(join(stage, path)) !== hash(join(baseline.source, path))) throw new Error(`Root probe source drift: ${path}`)
  }
  const isolatedWorkspace = join(stage, 'pnpm-workspace.yaml')
  if (!existsSync(isolatedWorkspace)) writeFileSync(isolatedWorkspace, 'packages: []\n')
  if (readFileSync(isolatedWorkspace, 'utf8') !== 'packages: []\n') throw new Error('Unexpected root probe workspace settings')
  const steps = []
  for (const [name, args, indicator] of [
    ['install', ['install', '--ignore-scripts', '--frozen-lockfile', '--store-dir', join(baseline.root, '.dsh-dev/proactive-bot/pnpm-store'), '--config.manage-package-manager-versions=false'], 'node_modules/tsdown/package.json'],
    ['build', ['run', 'build'], 'lib/index.js'],
  ] as const) {
    const log = join(stage, `${name}.log`)
    const cached = name === 'install' && existsSync(join(stage, indicator)) && existsSync(log)
    if (!cached) {
      const result = spawnSync(join(baseline.root, 'scripts/pnpm'), ['-C', stage, ...args], {
        encoding: 'utf8', timeout: 300_000, cwd: baseline.root,
      })
      writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? ''))
      if (result.status !== 0) throw new Error(`Upstream root probe ${name} failed (${String(result.status)}); see ${log}`)
    }
    steps.push({ name, args, cached, logSha256: hash(log) })
  }
  const childPath = join(stage, 'pb00-root-import.mjs')
  const childTs = join(baseline.root, spikePath, 'src/core/root-import-child.ts')
  writeFileSync(childPath, ts.transpileModule(readFileSync(childTs, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
  }).outputText)
  const cwd = resolve(outputDir, 'root-import-cwd')
  mkdirSync(cwd, { recursive: true })
  const importOnly = (...args: string[]) => {
    const result = spawnSync(process.execPath, [childPath, ...args], {
      cwd, encoding: 'utf8', timeout: 10_000,
      env: { PATH: dirname(process.execPath), LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(cwd, 'unused-gitconfig') },
    })
    const outcome = result.stdout?.trim() ? JSON.parse(result.stdout) as {
      ok: boolean; exports?: string[]; attempted: string[]; changed: string[]; addedListeners: string[]; addedGlobals: string[]; error?: string
    } : undefined
    return { exit: result.status, error: result.error?.message, stderr: result.stderr, outcome }
  }
  const receipt = {
    steps, node: process.execPath, entrySha256: hash(join(stage, 'lib/index.js')),
    ...importOnly(), lockfileControl: importOnly('lockfile-control'),
    scope: 'Explicit fs/child process/socket/fetch guards plus sampled process state. This is not an OS-level sandbox.',
    alphaDependencies: Object.fromEntries(Object.entries(baseline.metadata.devDependencies).filter(([, version]) => version.includes('alpha'))),
  }
  json(join(outputDir, 'root-import.json'), receipt)
  return receipt
}
