import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AutomationError } from './errors.js';

const identitySchema = z.strictObject({
  pid: z.number().int().positive(), startedAt: z.string().min(1), hostname: z.string().min(1),
  token: z.uuid(), released: z.boolean(),
});
export type HostIdentity = z.output<typeof identitySchema>;
export type ProcessIdentity = (pid: number) => string | null | undefined;
const unverifiedStart = `unverified:${new Date(Date.now() - process.uptime() * 1000).toISOString()}`;
/** null = proven absent; undefined = unknown. Never use an elapsed heartbeat as evidence. */
export const processIdentity: ProcessIdentity = (pid) => {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? null : undefined; }
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch { return undefined; }
};
export interface HostLease {
  identity?: HostIdentity;
  reason?: 'active-owner' | 'foreign-host' | 'unknown-owner';
  writable: boolean;
  assertOwner(): void;
  release(): Promise<void>;
}
const denied = () => new AutomationError('automation/read-only', 'This Host does not own the automation lock');

/**
 * Immutable generations avoid unlink/reclaim races: each retired owner names ONE
 * successor file, claimed with wx. Two stale readers can never unlink a new owner.
 * Keep the tiny retired records as audit receipts (no unsafe concurrent compaction).
 */
export async function acquireHostLease(directory: string, probe: ProcessIdentity = processIdentity): Promise<HostLease> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // A restricted host can still own a lock and prove a dead PID. Never compare
  // this approximate self timestamp to an OS timestamp to infer PID reuse.
  const startedAt = probe(process.pid) ?? unverifiedStart;
  const identity: HostIdentity = { pid: process.pid, startedAt, hostname: hostname(), token: randomUUID(), released: false };
  const blocked = (reason: HostLease['reason'], owner?: HostIdentity): HostLease => ({
    writable: false, reason, identity: owner, assertOwner() { throw denied(); }, async release() {},
  });
  let path = join(directory, 'owner.json');
  for (;;) {
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(identity)); await file.sync(); } finally { await file.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: HostIdentity;
      try { owner = identitySchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
      catch { return blocked('unknown-owner'); }
      if (owner.hostname !== identity.hostname) return blocked('foreign-host', owner);
      if (!owner.released) {
        const current = probe(owner.pid);
        if (current === undefined) return blocked('unknown-owner', owner);
        if (current !== null && owner.startedAt.startsWith('unverified:')) return blocked('unknown-owner', owner);
        if (current === owner.startedAt) return blocked('active-owner', owner);
      }
      path = join(directory, `after-${owner.token}.json`);
    }
  }
  let released = false;
  let closing: Promise<void> | undefined;
  const lease: HostLease = {
    identity, writable: true,
    assertOwner() {
      if (released) throw denied();
      try {
        const current = identitySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
        if (current.token !== identity.token || current.released) throw denied();
      } catch { lease.writable = false; throw denied(); }
    },
    release() {
      closing ??= (async () => {
        lease.assertOwner();
        const temporary = `${path}.${identity.token}.release`;
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ ...identity, released: true })); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, path);
        released = true; lease.writable = false;
      })();
      return closing;
    },
  };
  return lease;
}
