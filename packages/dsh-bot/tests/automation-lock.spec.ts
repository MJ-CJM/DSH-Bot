import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { acquireHostLease, processIdentity } from '../src/host/automation/lock.js';

const home = fileURLToPath(new URL('../../../.dsh-dev/p2/t13/', import.meta.url));
async function facility(test: (root: string) => Promise<void>) {
  await mkdir(home, { recursive: true }); const root = await mkdtemp(join(home, 'lock-'));
  try { await test(root); } finally { await rm(root, { recursive: true, force: true }); }
}
describe('Host ownership and stale reclamation', () => {
  it('records OS process start identity, rejects live owner, releases idempotently and reacquires', async () => facility(async root => {
    const lease = await acquireHostLease(root);
    expect(lease.identity).toMatchObject({ pid: process.pid, hostname: hostname() });
    expect(lease.identity?.startedAt).toBeTruthy();
    expect((await acquireHostLease(root)).reason).toBe(processIdentity(process.pid) ? 'active-owner' : 'unknown-owner');
    lease.assertOwner();
    await Promise.all([lease.release(), lease.release()]);
    expect(() => lease.assertOwner()).toThrow();
    const next = await acquireHostLease(root); expect(next.writable).toBe(true); await next.release();
  }));
  it.each(['absent', 'reused', 'foreign', 'unknown', 'corrupt'] as const)('handles %s identity without a TTL', async kind => facility(async root => {
    const owner = { pid: 999999, startedAt: 'old-process', hostname: kind === 'foreign' ? 'other-host' : hostname(),
      token: randomUUID(), released: false };
    await writeFile(join(root, 'owner.json'), kind === 'corrupt' ? '{' : JSON.stringify(owner));
    const before = await readFile(join(root, 'owner.json'), 'utf8');
    const lease = await acquireHostLease(root, pid => pid === process.pid ? 'self'
      : kind === 'absent' ? null : kind === 'reused' ? 'new-process' : undefined);
    expect(lease.writable).toBe(['absent', 'reused'].includes(kind));
    expect(await readFile(join(root, 'owner.json'), 'utf8')).toBe(before);
    if (lease.writable) await lease.release();
  }));
  it('independent processes race for one owner, SIGKILL stale owner is reclaimed by exactly one contender', async () => facility(async root => {
    const children: ReturnType<typeof fork>[] = [];
    const worker = async () => {
      const child = fork(fileURLToPath(new URL('./automation-lock-worker.mjs', import.meta.url)), [root],
        { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      children.push(child);
      const exit = new Promise(resolve => child.once('exit', resolve));
      const result = await new Promise<{ writable: boolean }>((resolve, reject) => {
        child.once('message', data => resolve(data as { writable: boolean }));
        child.once('error', reject);
        child.once('exit', code => { if (code) reject(new Error(`Worker exited ${code}`)); });
      });
      return { child, result, exit };
    };
    try {
      const first = await Promise.all([worker(), worker(), worker()]);
      expect(first.filter(w => w.result.writable)).toHaveLength(1);
      const owner = first.find(w => w.result.writable);
      if (!owner) throw new Error('No owner');
      owner.child.kill('SIGKILL'); await owner.exit;
      const next = await Promise.all([worker(), worker(), worker()]);
      expect(next.filter(w => w.result.writable)).toHaveLength(1);
      const nextOwner = next.find(w => w.result.writable);
      if (!nextOwner) throw new Error('No successor owner');
      nextOwner.child.send('release'); await nextOwner.exit;
    } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  }), 15000);
});
