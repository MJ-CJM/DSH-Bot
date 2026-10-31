import { describe, expect, it } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import { cleanHistory } from '../../src/host/memory/history.js';
import { fixture, input, canary } from './fixtures.js';
describe('I16 native history maintenance', () => {
  it('preserves session ID, handles non-monotonic order and repeats without duplicate replacements', async () => {
    const f = await fixture();
    try {
      const agent = await f.harness.create(SessionId('b4-history'), { provider: 'dp-fixture', model: 'mock' });
      agent.session.append('user/message', input(canary), { surfaceOp: 'append' });
      const io = { flush: async () => true, readSurface: async () => agent.session.deriveMessages(), rawReadPolicyVerified: false };
      expect(await cleanHistory(agent, io)).toEqual(['raw-read-policy']);
      const count = agent.session.snapshotEvents().length;
      await cleanHistory(agent, io);
      expect(agent.session.snapshotEvents()).toHaveLength(count);
      expect(agent.session.id).toBe('b4-history');
      expect(JSON.stringify(agent.session.deriveMessages())).not.toContain(canary);
      expect(JSON.stringify(agent.session.snapshotEvents())).toContain(canary);
      expect(f.adapter.requests).toHaveLength(0);
    } finally { await f.close(); }
  });
  it('reports failed flush and preserves human Inbox entries', async () => {
    const f = await fixture();
    try {
      const agent = await f.harness.create(SessionId('b4-flush'), { provider: 'dp-fixture', model: 'mock' });
      agent.inbox.append('next-turn', input('HUMAN_INPUT_PRESERVED'));
      expect(await cleanHistory(agent, { flush: async () => false, readSurface: async () => [], rawReadPolicyVerified: false }))
        .toEqual(['flush']);
      expect(agent.inbox.nextTurn).toHaveLength(1);
    } finally { await f.close(); }
  });
});
