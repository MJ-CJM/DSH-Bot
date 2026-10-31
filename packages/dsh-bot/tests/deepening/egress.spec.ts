import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EgressEnvelope } from '../../src/host/data-flow/egress.js';
import { EgressChecker } from '../../src/host/data-flow/egress.js';
import { OnceGrants } from '../../src/host/data-flow/grants.js';
import { MemoryLineage } from '../../src/host/data-flow/lineage.js';
import { AutoShareQuota } from '../../src/host/memory/quota.js';
import { retireShard } from '../../src/host/memory/shards.js';
import { v2Fixture, command } from './v2-fixtures.js';
import { shared } from './shared-fixtures.js';
const owner = { botId: 'alpha', botCreatedAt: 1 }, beta = { botId: 'beta', botCreatedAt: 2 };
async function fixture(publicSource = false) {
  const f = await v2Fixture();
  const id = publicSource ? await shared(f, 'SHARED_SOURCE') : (await f.alpha.save({ content: 'PRIVATE_SOURCE' })).id;
  const version = f.kernel.snapshot.versions.get(id); if (!version) throw new Error('Missing source');
  const grants = new OnceGrants(f.kernel), checker = new EgressChecker(f.kernel, grants,
    key => key.botId === owner.botId && key.botCreatedAt === 1 || key.botId === beta.botId && key.botCreatedAt === 2);
  const envelope: EgressEnvelope = { content: 'EXACT_OUTPUT', label: new MemoryLineage(f.kernel).label([version.versionId]),
    binding: { userScope: f.kernel.scope.scope.id, bot: owner, invocation: 'session/call', payloadVersion: randomUUID(),
      sourceVersions: [version.versionId], sourceRefs: version.sourceRefs, target: { kind: 'bot', bot: beta },
      epoch: f.kernel.epoch, policyRevision: f.kernel.policyRevision } };
  return { ...f, get kernel() { return f.kernel; }, grants, checker, envelope, id, build: () => ({ opId: randomUUID(), kind: 'cleanup' as const,
    subjectIds: [], expectedRevision: f.kernel.seq, forgetEpoch: f.kernel.epoch }) };
}
describe('I40 checker admission/dispatch contract (concrete outlets are B6b)', () => {
  it('allows shared in-domain delivery, denies external export and private crossover, and accepts an exact one-use grant', async () => {
    const f = await fixture(true);
    try {
      const send = vi.fn(async () => 'sent');
      const ticket = await f.checker.admit(f.envelope, f.build);
      await expect(f.checker.dispatch(ticket, send)).resolves.toBe('sent'); expect(send).toHaveBeenCalledTimes(1);
      await expect(f.checker.dispatch(ticket, send)).rejects.toThrow('used');
      const external = { ...f.envelope, binding: { ...f.envelope.binding, target: { kind: 'external' as const, destination: 'fixture' } } };
      expect(() => f.checker.check(external)).toThrow('authorization');
    } finally { f.checker.close(); await f.close(); }
    const p = await fixture();
    try {
      await expect(p.checker.admit(p.envelope, p.build)).rejects.toThrow('authorization');
      const grant = p.grants.issue(p.envelope.binding, p.envelope.content);
      await expect(p.checker.admit({ ...p.envelope, content: 'PRIVATE_CANARY' }, p.build, grant)).rejects.toThrow('Grant');
      await expect(p.checker.admit(p.envelope, p.build, { ...grant })).rejects.toThrow('Grant');
      const ticket = await p.checker.admit(p.envelope, p.build, grant);
      await expect(p.checker.admit(p.envelope, p.build, grant)).rejects.toThrow('consumed');
      await expect(p.checker.dispatch(ticket, async () => true)).resolves.toBe(true);
      await p.reopen(); expect(p.kernel.snapshot.grantUses.has(grant.id)).toBe(true);
    } finally { p.checker.close(); await p.close(); }
  });
  it.each(['forget', 'revise', 'policy', 'retire', 'target-birth', 'cancel'] as const)(
    'rechecks %s after admission; transport count stays zero', async mutation => {
      const f = await fixture(true);
      try {
        const signal = new AbortController(), send = vi.fn(async () => true);
        const ticket = await f.checker.admit(f.envelope, f.build);
        if (mutation === 'forget') await f.kernel.commit({ opId: randomUUID(), kind: 'forget', subjectIds: [f.id],
          expectedRevision: f.kernel.seq, forgetEpoch: f.kernel.epoch + 1 });
        if (mutation === 'revise') {
          const op = command(f); const v = op.versions[0]; if (!v) throw new Error('Missing fixture version');
          op.subjectIds = [f.id]; op.versions = [{ ...v, memoryId: f.id }]; await f.kernel.commit(op);
        }
        if (mutation === 'policy') { const quota = new AutoShareQuota(f.kernel); await quota.configure({ ...quota.policy, enabled: false }); }
        if (mutation === 'retire') await retireShard(f.kernel, owner);
        if (mutation === 'target-birth') await retireShard(f.kernel, beta);
        if (mutation === 'cancel') signal.abort();
        await expect(f.checker.dispatch(ticket, send, signal.signal)).rejects.toThrow();
        expect(send).toHaveBeenCalledTimes(0); expect(ticket.state).toBe('cancelled');
      } finally { f.checker.close(); await f.close(); }
    });
  it('holds unknown lineage, changed source refs, secret grants and forged Bot births; transport failure is unknown without retry', async () => {
    const f = await fixture();
    try {
      const grant = f.grants.issue(f.envelope.binding, f.envelope.content);
      for (const patch of [
        { label: { ...f.envelope.label, restrictions: ['secret' as const] } },
        { binding: { ...f.envelope.binding, sourceRefs: [{ sessionId: 'forged' }] } },
        { binding: { ...f.envelope.binding, bot: { ...owner, botCreatedAt: 9 } } },
        { binding: { ...f.envelope.binding, sourceVersions: [randomUUID()] } },
      ]) expect(() => f.checker.check({ ...f.envelope, ...patch }, grant)).toThrow();
      const ticket = await f.checker.admit(f.envelope, f.build, grant), send = vi.fn(async () => { throw new Error('unknown transport'); });
      await expect(f.checker.dispatch(ticket, send)).rejects.toThrow('unknown transport'); expect(ticket.state).toBe('unknown');
      await expect(f.checker.dispatch(ticket, send)).rejects.toThrow('used'); expect(send).toHaveBeenCalledTimes(1);
      f.checker.close(); expect(() => f.checker.check(f.envelope)).toThrow('stopped');
      expect(() => f.grants.issue(f.envelope.binding, f.envelope.content)).toThrow('closed');
    } finally { f.checker.close(); await f.close(); }
  });
});
