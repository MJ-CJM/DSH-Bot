import { randomUUID } from 'node:crypto';
import { type FileHandle, open, readFile, unlink } from 'node:fs/promises';

/** Local, fail-closed ownership only. Never reclaim an existing/stale lock automatically. */
export async function acquireLock(path: string) {
  const identity = { pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), token: randomUUID() };
  let file: FileHandle;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  try { await file.writeFile(JSON.stringify(identity)); await file.sync(); }
  finally { await file.close(); }
  let released = false;
  return { identity, async release() {
    if (released) return;
    // No contender can replace a lock: automatic stale reclamation is deliberately absent.
    const current = JSON.parse(await readFile(path, 'utf8')) as { token: string };
    if (current.token !== identity.token) throw new Error('Lock ownership changed; refusing unlink');
    await unlink(path);
    released = true;
  } };
}
