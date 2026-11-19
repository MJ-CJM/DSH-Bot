import { describe, expect, it, vi } from 'vitest';
import { flowFixture, alpha, beta } from './managed-flow-fixture.js';
import { ExportAuthorizationRequired } from '../../src/host/data-flow/egress.js';

describe('owner review of private group output', () => {
  const target = { kind: 'group' as const, groupId: 'group', groupCreatedAt: 1, members: [alpha, beta] };
  it('holds a completed private reply across restart; one exact approval sends once without changing memory readers', async () => {
    const x = await flowFixture();
    try {
      const envelope = x.flow.draft('group-result', alpha, 'private', 'delivery:result', target, 'EXACT_PRIVATE_REPLY');
      await expect(x.flow.admit(envelope)).rejects.toBeInstanceOf(ExportAuthorizationRequired);
      const id = await x.flow.holdForReview(envelope), send = vi.fn(async () => true);
      await expect(x.flow.dispatch(id, send)).rejects.toThrow('held'); expect(send).not.toHaveBeenCalled();
      await x.reopen();
      const review = x.flow.review(id);
      await expect(x.flow.approveReview(id, '0'.repeat(64))).rejects.toThrow('changed');
      const admitted = await x.flow.approveReview(id, review.digest);
      await x.flow.dispatch(admitted, send); expect(send).toHaveBeenCalledTimes(1);
      await expect(x.flow.approveReview(id, review.digest)).rejects.toThrow('unavailable');
      await expect(x.flow.dispatch(admitted, send)).rejects.toThrow('held');
      expect(x.f.kernel.snapshot.versions.get(x.privateId)?.labels.readers).toEqual([alpha]);
      expect(x.flow.label('private').readers).toEqual([alpha]);
      await expect(x.flow.admit({ ...envelope, content: 'A_DIFFERENT_REPLY' })).rejects.toBeInstanceOf(ExportAuthorizationRequired);
    } finally { await x.close(); }
  });
  it('rejects without sending and removes the held body', async () => {
    const x = await flowFixture();
    try {
      const id = await x.flow.holdForReview(x.flow.draft('group-result', alpha, 'private', 'result', target, 'PRIVATE'));
      await x.flow.rejectReview(id); expect(x.flow.get(id).envelope).toBeUndefined();
      expect(() => x.flow.review(id)).toThrow('unavailable');
    } finally { await x.close(); }
  });
  it.each(['forget', 'revise', 'target', 'cancel', 'secret'] as const)('blocks stale %s before review or dispatch', async mutation => {
    const x = await flowFixture();
    try {
      const envelope = x.flow.draft('group-result', alpha, 'private', 'result', target, 'PRIVATE');
      if (mutation === 'secret') {
        await expect(x.flow.holdForReview({ ...envelope, label: { ...envelope.label, restrictions: [...envelope.label.restrictions, 'secret'] } })).rejects.toThrow('Restricted');
        return;
      }
      const id = await x.flow.holdForReview(envelope), review = x.flow.review(id), signal = new AbortController();
      if (mutation === 'forget') await x.f.kernel.commit({ opId: crypto.randomUUID(), kind: 'forget', subjectIds: [x.privateId], expectedRevision: x.f.kernel.seq, forgetEpoch: x.f.kernel.epoch + 1 });
      if (mutation === 'revise') await x.f.alpha.update(x.privateId, { content: 'CHANGED' });
      if (mutation === 'target') x.current.set('beta', 99);
      if (mutation === 'cancel') signal.abort();
      await expect(x.flow.approveReview(id, review.digest, signal.signal)).rejects.toThrow();
    } finally { await x.close(); }
  });
  it('never retries an uncertain append or reuses approval after restart', async () => {
    const x = await flowFixture();
    try {
      const id = await x.flow.holdForReview(x.flow.draft('group-result', alpha, 'private', 'result', target, 'PRIVATE'));
      const admitted = await x.flow.approveReview(id, x.flow.review(id).digest);
      const send = vi.fn(async () => { throw new Error('transport lost'); });
      await expect(x.flow.dispatch(admitted, send)).rejects.toThrow('transport lost');
      await x.reopen();
      await expect(x.flow.dispatch(admitted, send)).rejects.toThrow('held');
      expect(send).toHaveBeenCalledTimes(1); expect(x.flow.get(admitted).state).toBe('unknown');
    } finally { await x.close(); }
  });
});
