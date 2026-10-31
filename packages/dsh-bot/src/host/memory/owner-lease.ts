import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve, join, parse } from 'node:path';
import { constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, lstat } from 'node:fs/promises';
import { z } from 'zod';

const recordSchema = z.strictObject({ token: z.uuid(), pid: z.number().int().positive(), host: z.string(), createdAt: z.number() });
export async function ensureLeaseDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  let part = parse(absolute).root;
  for (const name of absolute.slice(part.length).split('/').filter(Boolean)) {
    part = join(part, name);
    try { await mkdir(part, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const stat = await lstat(part);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Memory owner path must not contain symlinks');
  }
  return absolute;
}
/** Immutable successor chain: competing stale-owner recoveries create the same next path.
 * Never unlink a lock; that could unlink a newly acquired owner's lock. Live/unknown owners always refuse.
 */
export async function acquireMemoryOwner(directory: string) {
  const root = await ensureLeaseDirectory(directory);
  let path = join(root, 'owner.json');
  const record = recordSchema.parse({ token: randomUUID(), pid: process.pid, host: hostname(), createdAt: Date.now() });
  for (let attempts = 0; attempts < 10000; attempts++) {
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      let released = false;
      let closing: Promise<void> | undefined;
      const releasePath = join(root, `released-${record.token}`);
      const nextPath = join(root, `after-${record.token}.json`);
      const assertOwner = () => {
        if (released || realpathSync(root) !== root || existsSync(releasePath) || existsSync(nextPath) || lstatSync(path).isSymbolicLink() ||
          recordSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).token !== record.token) throw new Error('Memory owner lease lost');
      };
      return { token: record.token, assertOwner, close() { closing ??= (async () => {
        assertOwner();
        const file = await open(releasePath, 'wx', 0o600);
        try { await file.writeFile(record.token); await file.sync(); } finally { await file.close(); }
        released = true;
      })(); return closing; } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Invalid owner symlink');
      const previous = recordSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (previous.host !== hostname()) throw new Error('Memory writer identity unknown');
      const releasedPath = join(root, `released-${previous.token}`);
      let released = false;
      try {
        if ((await lstat(releasedPath)).isSymbolicLink()) throw new Error('Invalid owner release symlink');
        released = (await readFile(releasedPath, 'utf8')) === previous.token;
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (!released) {
        try { process.kill(previous.pid, 0); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') { path = join(root, `after-${previous.token}.json`); continue; } }
        throw new Error('Memory owner is alive or cannot be verified');
      }
      path = join(root, `after-${previous.token}.json`);
    }
  }
  throw new Error('Memory owner chain limit reached');
}
