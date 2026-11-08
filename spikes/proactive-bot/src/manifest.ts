import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { arch, platform, release } from 'node:os';

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function fileHash(path: string): Promise<string | null> {
  try { return sha256(await readFile(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function treeHashes(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (['node_modules', 'lib', '.git'].includes(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) result[relative(directory, child)] = sha256(await readFile(child));
    }
  }
  await walk(directory);
  return result;
}

export async function baseline(repo: string) {
  function command(file: string, args: string[]) {
    try {
      return { exitCode: 0, output: execFileSync(file, args, {
        cwd: repo, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, DSH_HOME: join(repo, '.dsh-dev') },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() };
    } catch (error) {
      const failure = error as { status?: number; code?: string };
      return { exitCode: failure.status ?? 1, output: failure.code ?? 'command failed' };
    }
  }
  const upstream = join(repo, '.dsh-dev/proactive-bot/upstream');
  const reference = join(repo, '../deepseek-harness');
  return {
    createdAt: new Date().toISOString(),
    repository: {
      head: command('git', ['rev-parse', 'HEAD']),
      branch: command('git', ['branch', '--show-current']),
      dirty: command('git', ['status', '--porcelain=v1']),
      trackedDiffSha256: sha256(command('git', ['diff', '--binary', 'HEAD']).output),
      lockSha256: await fileHash(join(repo, 'pnpm-lock.yaml')),
      spikeLockSha256: await fileHash(join(repo, 'spikes/proactive-bot/pnpm-lock.yaml')),
      fixtureFiles: await treeHashes(join(repo, 'spikes/proactive-bot')),
    },
    upstream: {
      url: 'https://github.com/deepseek-ai/dsh-superagent-prototype',
      head: command('git', ['-C', upstream, 'rev-parse', 'HEAD']),
      dirty: command('git', ['-C', upstream, 'status', '--porcelain=v1']),
      packageSha256: await fileHash(join(upstream, 'package.json')),
      lockSha256: await fileHash(join(upstream, 'pnpm-lock.yaml')),
      licenseSha256: await fileHash(join(upstream, 'LICENSE')),
    },
    reference: {
      head: command('git', ['-C', reference, 'rev-parse', 'HEAD']),
      tag: command('git', ['-C', reference, 'describe', '--tags', '--exact-match']),
    },
    runtime: {
      node: process.version, execPath: process.execPath,
      os: platform(), arch: arch(), release: release(),
      pnpm: command(join(repo, 'scripts/pnpm'), ['--version']),
      defaultDsh: command(join(repo, 'scripts/dsh'), ['--version']),
    },
    evidenceScope: 'UNIT: fixed source, synthetic ports, real SQLite; no Host or real model claim',
  };
}
