import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AutoShareQuota } from '../../src/host/memory/quota.js';
import { retireShard } from '../../src/host/memory/shards.js';
import { memoryVersionSchema } from '../../src/shared/memory-v2.js';
import { Config } from '../../src/host/registry-config.js';
import { command, v2Fixture } from './v2-fixtures.js';
import type { Commit } from '../../src/host/memory/op-log.js';

function automatic(f: Awaited<ReturnType<typeof v2Fixture>>, botId = 'alpha', birth = 1) {
  const input = command(f), base = input.versions[0]; if (!base) throw new Error('Missing version');
  const fields = { ...base } as Record<string, unknown>; delete fields.ownerBotKey;
  const owner = { botId, botCreatedAt: birth };
  const version = memoryVersionSchema.parse({ ...fields, scope: 'shared', shard: owner,
    provenance: { channel: 'model', bot: owner }, labels: { ...base.labels, readers: 'shared' } });
  // Synthetic accounting fixture deliberately stays candidate; no trustworthy receipt is manufactured.
  return { ...input, kind: 'accept' as const, versions: [version] };
}
describe('I38 atomic persistent double quota (synthetic accounting, no automatic authority)', () => {
  it('admits 5/100 concurrent attempts, counts across cold recovery and Bot birthday changes, and deduplicates opId', async () => {
    const f = await v2Fixture();
    try {
      let quota = new AutoShareQuota(f.kernel, () => Date.UTC(2026, 9, 27, 4));
      await quota.configure({ enabled: true, botDaily: 5, domainDaily: 20, timeZone: 'Asia/Shanghai' });
      const revision = f.kernel.policyRevision;
      let saved: Commit | undefined;
      const results = await Promise.allSettled(Array.from({ length: 100 }, () => {
        const opId = randomUUID();
        return quota.commit(opId, { botId: 'alpha', botCreatedAt: 1 }, revision, () => {
          const op = { ...automatic(f), opId }; if (!saved) saved = op; return op;
        });
      }));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(5); expect(f.kernel.snapshot.quota.size).toBe(5);
      if (!saved) throw new Error('Missing committed command');
      const same = saved;
      await quota.commit(same.opId, { botId: 'alpha', botCreatedAt: 1 }, revision, () => same);
      expect(f.kernel.snapshot.quota.size).toBe(5);
      await expect(quota.commit(same.opId, { botId: 'alpha', botCreatedAt: 1 }, revision,
        () => ({ ...same, subjectIds: [] }))).rejects.toThrow('reused');
      await f.reopen(); quota = new AutoShareQuota(f.kernel, () => Date.UTC(2026, 9, 27, 1));
      expect(f.kernel.snapshot.quota.size).toBe(5);
      await retireShard(f.kernel, { botId: 'alpha', botCreatedAt: 1 });
      const id = randomUUID();
      await expect(quota.commit(id, { botId: 'alpha', botCreatedAt: 99 }, revision,
        () => ({ ...automatic(f, 'alpha', 99), opId: id }))).rejects.toThrow('quota');
      expect(f.kernel.snapshot.quota.size).toBe(5);
    } finally { await f.close(); }
  });
  it('admits 20/100 across the domain, persists disable, and immediately applies reduced limits', async () => {
    const f = await v2Fixture();
    try {
      const quota = new AutoShareQuota(f.kernel, () => Date.UTC(2026, 9, 27));
      await quota.configure({ enabled: true, botDaily: 5, domainDaily: 20, timeZone: 'UTC' });
      const revision = f.kernel.policyRevision;
      const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => {
        const botId = `bot-${i % 10}`, id = randomUUID();
        return quota.commit(id, { botId, botCreatedAt: 1 }, revision, () => ({ ...automatic(f, botId), opId: id }));
      }));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(20);
      await quota.configure({ ...quota.policy, enabled: false });
      await f.reopen(); const reopened = new AutoShareQuota(f.kernel);
      expect(reopened.status()).toMatchObject({ configured: false, effectiveAutoShare: false });
      const id = randomUUID();
      await expect(reopened.commit(id, { botId: 'alpha', botCreatedAt: 1 }, revision,
        () => ({ ...automatic(f), opId: id }))).rejects.toThrow('policy changed');
      await reopened.configure({ enabled: true, botDaily: 1, domainDaily: 1, timeZone: 'UTC' });
      const current = new AutoShareQuota(f.kernel, () => Date.UTC(2026, 9, 27));
      await expect(current.commit(id, { botId: 'alpha', botCreatedAt: 1 }, f.kernel.policyRevision,
        () => ({ ...automatic(f), opId: id }))).rejects.toThrow('quota');
      expect(f.kernel.snapshot.quota.size).toBe(20);
    } finally { await f.close(); }
  });
  it('handles DST/day rollover and delays timezone change until the existing bucket ends', async () => {
    const f = await v2Fixture(); let now = Date.parse('2026-03-08T08:30:00Z');
    try {
      const quota = new AutoShareQuota(f.kernel, () => now);
      await quota.configure({ enabled: true, botDaily: 1, domainDaily: 2, timeZone: 'America/Los_Angeles' });
      const write = () => { const id = randomUUID(); return quota.commit(id, { botId: 'alpha', botCreatedAt: 1 },
        f.kernel.policyRevision, () => ({ ...automatic(f), opId: id })); };
      await write(); const first = [...f.kernel.snapshot.quota.values()][0]; if (!first) throw new Error('Missing charge');
      expect(first.end - first.bucket).toBe(23 * 3600000);
      await quota.configure({ ...quota.policy, timeZone: 'Asia/Shanghai' });
      now = Date.parse('2026-03-09T06:59:59Z'); await expect(write()).rejects.toThrow('quota');
      now = first.end; await write();
      expect([...f.kernel.snapshot.quota.values()].find(c => c.at === now)?.timeZone).toBe('Asia/Shanghai');
      now = first.bucket; await expect(write()).rejects.toThrow('quota');
    } finally { await f.close(); }
  });
  it('does not charge failed payload writes; reconciles unknown committed ops and never refunds forgetting', async () => {
    const f = await v2Fixture();
    try {
      let quota = new AutoShareQuota(f.kernel, () => Date.UTC(2026, 9, 27));
      await quota.configureHost({ enabled: true, botDaily: 5, domainDaily: 20, timeZone: 'UTC' });
      const revision = f.kernel.policyRevision, payloads = f.kernel.domain.table('payloads');
      const fail = vi.spyOn(payloads, 'put').mockRejectedValueOnce(new Error('synthetic payload failure'));
      let id = randomUUID();
      await expect(quota.commit(id, { botId: 'alpha', botCreatedAt: 1 }, revision,
        () => ({ ...automatic(f), opId: id }))).rejects.toThrow('payload failure'); fail.mockRestore();
      expect(f.kernel.snapshot.quota.size).toBe(0);
      const ops = f.kernel.domain.table('ops'), put = ops.put.bind(ops);
      const unknown = vi.spyOn(ops, 'put').mockImplementationOnce(async (key, value) => {
        await put(key, value); throw new Error('synthetic lost acknowledgment');
      });
      id = randomUUID();
      await expect(quota.commit(id, { botId: 'alpha', botCreatedAt: 1 }, revision,
        () => ({ ...automatic(f), opId: id }))).rejects.toThrow('outcome unknown'); unknown.mockRestore();
      await f.reopen(); quota = new AutoShareQuota(f.kernel);
      expect(f.kernel.snapshot.quota.size).toBe(1);
      const memoryId = f.kernel.domain.table('ops').get(id)?.subjectIds[0]; if (!memoryId) throw new Error('Missing accepted fact');
      await f.kernel.commit({ opId: randomUUID(), kind: 'forget', subjectIds: [memoryId],
        expectedRevision: f.kernel.seq, forgetEpoch: f.kernel.epoch + 1 });
      await f.reopen(); expect(f.kernel.snapshot.quota.size).toBe(1);
      quota = new AutoShareQuota(f.kernel); await quota.configure({ ...quota.policy, enabled: false });
      expect(quota.status().configured).toBe(false); expect(f.kernel.blocked).toBe(true);
    } finally { await f.close(); }
  });
  it('preserves an explicit UI disable across restart and applies changed Host configuration', async () => {
    const f = await v2Fixture();
    try {
      let quota = new AutoShareQuota(f.kernel);
      const config = { enabled: true, botDaily: 5, domainDaily: 20, timeZone: 'Asia/Shanghai' };
      await quota.configureHost(config); await quota.configure({ ...quota.policy, enabled: false });
      await f.reopen(); quota = new AutoShareQuota(f.kernel); const revision = f.kernel.policyRevision;
      await quota.configureHost(config); expect(quota.policy.enabled).toBe(false); expect(f.kernel.policyRevision).toBe(revision);
      await quota.configureHost({ ...config, botDaily: 2 });
      expect(quota.policy).toMatchObject({ enabled: false, botDaily: 2 });
    } finally { await f.close(); }
  });
  it('reopens in a second process, actually deletes/recreates the Bot, and accepts zero further attempts', async () => {
    const base = resolve('../../.dsh-dev/deepening/b6a-process'); await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'quota-'));
    try {
      const execute = promisify(execFile), script = fileURLToPath(new URL('./quota-process.mjs', import.meta.url));
      const env = { PATH: process.env.PATH, HOME: root, DSH_HOME: resolve('../../.dsh-dev') };
      const first = JSON.parse((await execute(process.execPath, [script, 'seed', root], { env })).stdout.trim());
      const cold = JSON.parse((await execute(process.execPath, [script, 'cold', root], { env })).stdout.trim());
      expect(first.pid).not.toBe(cold.pid); expect(first.accepted).toBe(5); expect(cold.accepted).toBe(0);
      expect(cold.charged).toBe(5); expect(cold.birth).toBe(99);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('validates defaults and configuration', () => {
    expect(Config({})).toMatchObject({ autoShareEnabled: true, autoShareBotDaily: 5, autoShareDomainDaily: 20 });
    expect(() => Config({ autoShareBotDaily: 1.5 })).toThrow(); expect(() => Config({ quotaTimeZone: 'INVALID' })).toThrow();
  });
});
