import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { EgressTarget } from '../../src/shared/data-flow.js';
import { prepareAutomaticShare } from '../../src/host/memory/auto-share.js';
import { flowEnvelopeSchema } from '../../src/shared/managed-flow.js';
import { pairs } from './b6b-cases.js';
import { flowFixture, alpha, beta } from './managed-flow-fixture.js';

const receipts: unknown[] = [];
afterAll(async () => {
  const dir = resolve('../../.dsh-dev/deepening/b6b-unit'); await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'redteam.json'), JSON.stringify({ evidenceLevel: 'UNIT', source: 'synthetic',
    attacks: 60, controls: 60, realModelRequests: 0, receipts }, null, 2));
});
function target(outlet: string): EgressTarget {
  if (outlet === 'notify-send' || outlet === 'connector') return { kind: 'external', destination: `synthetic:${outlet}` };
  if (outlet.startsWith('group')) return { kind: 'group', groupId: 'synthetic-group', groupCreatedAt: 1, members: [alpha, beta] };
  return outlet === 'auto-share' ? { kind: 'shared' } : { kind: 'bot', bot: beta };
}
describe('I41–I47 durable outlet policy pairs (UNIT, real JSON; not native Host transport)', () => {
  it.each(pairs)('$id $outlet rejects $attack and preserves its legal control', async row => {
    const x = await flowFixture();
    try {
      const destination = target(row.outlet), signal = new AbortController(), send = vi.fn(async () => 'DELIVERED');
      const envelope = x.flow.draft(row.outlet, alpha, 'clean', row.id, destination, 'SYNTHETIC_CONTROL');
      const external = destination.kind === 'external';
      const grant = external ? x.flow.checker.grants.issue(envelope.binding, envelope.content) : undefined;
      if (row.outlet === 'auto-share') {
        expect(() => prepareAutomaticShare({ isTrusted: true }, {})).toThrow();
      } else {
        const id = await x.flow.admit(envelope, grant, signal.signal);
        await x.flow.dispatch(id, send, signal.signal);
        expect(send).toHaveBeenCalledTimes(1); expect(x.flow.get(id).state).toBe('delivered');
      }
      send.mockClear();
      const attack = x.flow.draft(row.outlet, alpha, row.attack === 'private' ? 'private' : 'clean',
        `${row.id}:attack`, destination, 'PRIVATE_CANARY_B6B');
      let blocked = false;
      try {
        if (row.outlet === 'auto-share') prepareAutomaticShare(attack, {});
        else if (row.attack === 'private') await x.flow.admit(attack);
        else if (row.attack === 'secret') await x.flow.admit({ ...attack, label: { ...attack.label, restrictions: ['secret'] } });
        else if (row.attack === 'unknown') await x.flow.admit({ ...attack,
          label: { ...attack.label, sourceVersions: [randomUUID()] } });
        else {
          const permission = external ? x.flow.checker.grants.issue(attack.binding, attack.content) : undefined;
          const id = await x.flow.admit(attack, permission);
          if (row.attack === 'birth') x.current.set('alpha', 999);
          if (row.attack === 'epoch') await x.f.kernel.commit({ opId: randomUUID(), kind: 'forget', subjectIds: [x.sharedId],
            expectedRevision: x.f.kernel.seq, forgetEpoch: x.f.kernel.epoch + 1 });
          if (row.attack === 'payload') await x.flow.validate(id, `${attack.content}APPENDED_CANARY`);
          await x.flow.dispatch(id, send);
        }
      } catch { blocked = true; }
      expect(blocked).toBe(true); expect(send).not.toHaveBeenCalled();
      expect(flowEnvelopeSchema.safeParse({ ...attack, trusted: true }).success).toBe(false);
      receipts.push({ ...row, attack: 'PASS', control: row.controlExpectation === 'delivered' ? 'PASS' : row.controlExpectation,
        transportCalls: send.mock.calls.length, canaryLeaks: 0, unauthorizedPublishes: 0 });
    } finally { await x.close(); }
  });
  it('persists cancellation, unknown outcomes and erasure across cold reopen without replay', async () => {
    const x = await flowFixture();
    try {
      const envelope = x.flow.draft('message', alpha, 'clean', 'unknown', { kind: 'bot', bot: beta }, 'BODY_CANARY');
      const id = await x.flow.admit(envelope), send = vi.fn(async () => { throw new Error('transport uncertain'); });
      await expect(x.flow.dispatch(id, send)).rejects.toThrow('uncertain'); expect(x.flow.get(id).state).toBe('unknown');
      await x.reopen(); expect(x.flow.get(id).state).toBe('unknown');
      await expect(x.flow.dispatch(id, send)).rejects.toThrow(); expect(send).toHaveBeenCalledTimes(1);
      await x.f.kernel.commit({ opId: randomUUID(), kind: 'forget', subjectIds: [x.sharedId],
        expectedRevision: x.f.kernel.seq, forgetEpoch: x.f.kernel.epoch + 1 });
      expect(x.flow.get(id)).toEqual({ id, state: 'unknown' }); await x.reopen();
      expect(JSON.stringify(x.flow.get(id))).not.toContain('BODY_CANARY');
    } finally { await x.close(); }
  });
  it('rechecks cancellation and new session contamination at dispatch without calling transport', async () => {
    const x = await flowFixture();
    try {
      const envelope = x.flow.draft('message', alpha, 'clean', 'queued', { kind: 'bot', bot: beta }, 'BODY');
      const id = await x.flow.admit(envelope), send = vi.fn(async () => true), signal = new AbortController(); signal.abort();
      await expect(x.flow.dispatch(id, send, signal.signal)).rejects.toThrow(); expect(x.flow.get(id).state).toBe('cancelled');
      const next = await x.flow.admit(envelope);
      await x.flow.inherit('clean', x.flow.label('private'));
      await expect(x.flow.dispatch(next, send)).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
    } finally { await x.close(); }
  });
  it('aborts and joins an in-flight outlet on unload while retaining an unknown receipt', async () => {
    const x = await flowFixture();
    try {
      const envelope = x.flow.draft('message', alpha, 'clean', 'unload', { kind: 'bot', bot: beta }, 'BODY');
      const id = await x.flow.admit(envelope);
      let entered!: () => void; const ready = new Promise<void>(accept => { entered = accept; });
      const pending = x.flow.dispatch(id, (_envelope, signal) => new Promise<never>((_accept, reject) => {
        entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      const outcome = expect(pending).rejects.toThrow('stopped');
      await ready; await x.flow.close(); await outcome; expect(x.flow.get(id).state).toBe('unknown');
      await expect(x.flow.admit(envelope)).rejects.toThrow('stopped');
    } finally { await x.close(); }
  });

});
