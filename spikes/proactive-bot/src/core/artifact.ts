import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { build, type Metafile } from 'esbuild'
import ts from 'typescript'

export const upstreamUrl = 'https://github.com/deepseek-ai/dsh-superagent-prototype.git'
export const upstreamSha = '8c32a9dc5d72c033816c6a8110b37f40cf94fba4'
export const spikePath = 'spikes/proactive-bot'

export function workspaceRoot(): string {
  let directory = process.cwd()
  while (!existsSync(join(directory, spikePath, 'vendor/superagent/LICENSE'))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error('Run the PB00 harness from the DSH-Bot checkout')
    directory = parent
  }
  return directory
}

export function hash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function json(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
}

function staticClosure(source: string, entry: string) {
  const files = new Set<string>()
  const dependencies = new Map<string, Set<string>>()
  function scan(file: string): void {
    if (files.has(file)) return
    files.add(file)
    const parsed = ts.createSourceFile(file, readFileSync(join(source, file), 'utf8'), ts.ScriptTarget.Latest, true)
    function visit(node: ts.Node): void {
      let specifier: ts.Node | undefined
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) specifier = node.moduleSpecifier
      if (ts.isExportDeclaration(node) && !node.isTypeOnly) specifier = node.moduleSpecifier
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0]
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const name = specifier.text
        if (name.startsWith('.')) scan(relative(source, resolve(source, dirname(file), name)))
        else {
          const importers = dependencies.get(name) ?? new Set<string>()
          importers.add(file)
          dependencies.set(name, importers)
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(parsed, visit)
  }
  scan(entry)
  return {
    files: [...files].sort(),
    dependencies: Object.fromEntries([...dependencies.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, importedBy]) => [name, [...importedBy].sort()])),
  }
}

export function verifyUpstream() {
  const root = workspaceRoot()
  const source = join(root, '.dsh-dev/proactive-bot/upstream')
  const commit = git(source, 'rev-parse', 'HEAD')
  const status = git(source, 'status', '--porcelain', '--untracked-files=all')
  const url = git(source, 'remote', 'get-url', 'origin')
  if (commit !== upstreamSha || status || url !== upstreamUrl) {
    throw new Error(`Unexpected upstream snapshot: ${JSON.stringify({ commit, status, url })}`)
  }
  const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
    name: string; version: string; private: boolean; license: string; exports: unknown
    dependencies: Record<string, string>; devDependencies: Record<string, string>
  }
  const vendor = join(root, spikePath, 'vendor/superagent')
  const vendoredFiles = ['LICENSE', ...readdirSync(join(vendor, 'src/core')).sort().map(file => `src/core/${file}`)]
  const core = staticClosure(source, 'src/core/index.ts')
  if (vendoredFiles.length !== core.files.length + 1 || core.files.some(file => !vendoredFiles.includes(file))) {
    throw new Error('Vendored core files do not match the pinned core closure')
  }
  const hashes = Object.fromEntries(vendoredFiles.map(file => {
    const actual = hash(join(vendor, file))
    if (actual !== hash(join(source, file))) throw new Error(`Vendored source changed: ${file}`)
    return [file, actual]
  }))
  return {
    root, source, metadata, commit, url, status,
    acquiredAt: git(source, 'reflog', '--date=iso-strict', '--format=%gd', '-1').replace(/^HEAD@\{|\}$/g, ''),
    upstreamPackageSha256: hash(join(source, 'package.json')),
    upstreamLockSha256: hash(join(source, 'pnpm-lock.yaml')),
    rootClosure: staticClosure(source, 'src/index.ts'),
    storeClosure: staticClosure(source, 'src/app/store.ts'),
    vendor: { exactCopies: hashes, patch: 'none', scope: 'core TS closure and MIT license' },
  }
}

function emittedInputs(metadata: Metafile, file: string): string[] {
  return Object.entries(metadata.outputs).filter(([path]) => basename(path) === file)
    .flatMap(([, output]) => Object.entries(output.inputs).filter(([, contribution]) => contribution.bytesInOutput > 0).map(([path]) => path))
}

export async function prepareStoreArtifact(outputDir: string) {
  mkdirSync(outputDir, { recursive: true })
  const baseline = verifyUpstream()
  const bundleDir = join(realpathSync(outputDir), 'coordinator')
  mkdirSync(bundleDir, { recursive: true })
  const artifact = join(bundleDir, 'coordinator-core.mjs')
  // Upstream migration imports prompt defaults. Its module loader checks the package
  // identity before reading the bundled skill files, even for a fresh database.
  json(join(bundleDir, 'package.json'), { name: baseline.metadata.name, type: 'module', private: true, license: baseline.metadata.license })
  for (const path of ['LICENSE', 'prompts', 'skills']) cpSync(join(baseline.source, path), join(bundleDir, path), { recursive: true })
  // Keep the official Store and migration byte-identical at input. Bundle from the fixed source;
  // remove unreferenced worker/Source code and put the required data schema code in one ESM file.
  const compiled = await build({
    absWorkingDir: baseline.root,
    stdin: { contents: [
      "export * from './src/core/index.ts'",
      "export { Store, SCHEMA_VERSION } from './src/app/store.ts'",
      "export { Effects } from './src/app/effects.ts'",
      "export { Outbox as DurableOutbox } from './src/app/outbox.ts'",
      "export { settingsPolicy, assessmentOutcome } from './src/policy.ts'",
      "export { KV } from './src/kv.ts'",
    ].join('\n'), resolveDir: baseline.source, sourcefile: 'coordinator-core-entry.ts' },
    nodePaths: [join(baseline.root, spikePath, 'node_modules')],
    platform: 'node',
    target: 'node22.19',
    format: 'esm',
    bundle: true,
    metafile: true,
    outfile: artifact,
  })
  const externals = Object.entries(compiled.metafile.outputs).filter(([path]) => basename(path) === basename(artifact))
    .flatMap(([, output]) => output.imports.filter(item => item.external).map(item => item.path))
  if (externals.some(name => !name.startsWith('node:'))) throw new Error(`Coordinator has undeclared runtime dependencies: ${externals.join(', ')}`)
  const inputs = emittedInputs(compiled.metafile, basename(artifact))
  const files = inputs.filter(file => file.startsWith('.dsh-dev/proactive-bot/upstream/'))
    .map(file => [relative(baseline.source, join(baseline.root, file)), hash(join(baseline.root, file))])
  const metadata = {
    file: basename(artifact), sha256: hash(artifact), upstreamSha,
    sources: Object.fromEntries(files), externals,
    resources: Object.fromEntries(['LICENSE', ...['prompts', 'skills'].flatMap(directory =>
      readdirSync(join(bundleDir, directory), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
        .map(entry => relative(bundleDir, join(entry.parentPath, entry.name))))]
      .sort().map(file => [file, hash(join(bundleDir, file))])),
    emittedPackagePaths: inputs.filter(file => !file.startsWith('.dsh-dev/proactive-bot/upstream/')),
    node: process.version, nodeAbi: process.versions.modules, napi: process.versions.napi, sqlite: process.versions.sqlite,
    platform: process.platform, architecture: process.arch,
  }
  json(join(outputDir, 'coordinator-artifact.json'), metadata)
  json(join(outputDir, 'upstream-manifest.json'), {
    url: baseline.url, commit: baseline.commit, acquiredAt: baseline.acquiredAt,
    license: baseline.metadata.license, private: baseline.metadata.private, exports: baseline.metadata.exports,
    packageSha256: baseline.upstreamPackageSha256, lockSha256: baseline.upstreamLockSha256, clean: !baseline.status,
    rootClosure: baseline.rootClosure, storeClosure: baseline.storeClosure, vendor: baseline.vendor,
  })
  return { artifact, metadata }
}
