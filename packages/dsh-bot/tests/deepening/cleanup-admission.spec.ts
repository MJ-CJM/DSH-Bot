import { describe, expect, it } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import { MemoryAdmission } from '../../src/host/memory/admission.js';
import { contaminatedHeads } from '../../src/host/memory/history-proof.js';
import { fixture, input } from './fixtures.js';
import { v2Fixture } from './v2-fixtures.js';
import { ForgetPreviews } from '../../src/host/memory/forget-preview.js';
import { ForgetRunner } from '../../src/host/memory/forget-runner.js';

describe('B4 production cleanup admission and provenance', () => {
  it('captures the complete native request with zero adapter calls, while ordinary calls and tools remain blocked', async () => {
    const f = await fixture(), v = await v2Fixture();
    try {
      const row = await v.alpha.save({ content: 'UNIQUE_TARGET' });
      const agent = await f.harness.create(SessionId('b4-audit'), { provider: 'dp-fixture', model: 'mock' });
      const admission = new MemoryAdmission(f.ctx); admission.start(v.kernel); admission.protect(agent);
      const previews = new ForgetPreviews(v.kernel, async () => ({ sessionIds: [], historyNodes: 0, summaries: 0,
        copies: 0, pendingMessages: 0, conservative: true, rootInstructions: false, stamp: 1 }));
      const prepared = await f.ctx.llm.prepareCall({ provider: 'dp-fixture', model: 'mock' });
      const stale = prepared.stream({ ...prepared.config, sessionId: agent.session.id, messages: [input('STALE_TARGET')] });
      const p = await previews.create({ memoryId: row.id, mode: 'version' });
      const runner = new ForgetRunner(v.kernel, previews, { drain: async () => {}, history: async () => [],
        copies: async () => {}, verifyInventory: async () => [] });
      const stopped = await runner.choose({ previewRevision: p.previewRevision, choice: 'stop' });
      const request = await admission.verifyRequest(agent);
      expect(request.sessionId).toBe(agent.session.id); expect(request.messages).toEqual(agent.session.deriveMessages());
      expect(request).toHaveProperty('toolHistory'); expect(f.adapter.requests).toHaveLength(0);
      const human = input('ORDINARY_BLOCKED');
      agent.followup(human); await agent.whenIdle();
      expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([human.id]);
      const steering = input('STEERING_PRESERVED'); agent.inbox.append('next-step', steering);
      agent.followup(input('SECOND_BLOCKED')); await agent.whenIdle();
      expect(agent.inbox.nextTurn[0]?.id).toBe(human.id);
      expect(agent.inbox.nextTurn).toHaveLength(2);
      expect(agent.inbox.nextStep.map(message => message.id)).toEqual([steering.id]);
      agent.inbox.clear();
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const off = agent.ctx.on('agent/pre-step', async (payload, next) => {
        entered(); await gate; payload.signal.throwIfAborted(); return next();
      }, { prepend: true });
      const cancelled = input('CANCELLED_BEFORE_COMMIT'); agent.followup(cancelled); await waiting;
      agent.cancel({ kind: 'hook', reason: 'Synthetic cancellation before admission' }, { keepInbox: true });
      release(); await agent.whenIdle(); off();
      expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([cancelled.id]);
      // Test-only explicit input cancellation, after proving durable preservation. Production never clears human input.
      agent.inbox.clear();
      expect(f.adapter.requests).toHaveLength(0);
      expect(() => admission.assertToolAllowed({ name: 'read', agent, callId: 'outside' })).toThrow();
      await admission.cleanupRead(agent, 'read-once', async () => {
        expect(() => admission.assertToolAllowed({ name: 'mcp__bot_memory_graph__read_graph', agent, callId: 'read-once' }))
          .not.toThrow();
        expect(() => admission.assertToolAllowed({ name: 'bash', agent, callId: 'read-once' })).toThrow();
      });
      expect(() => admission.assertToolAllowed({ name: 'mcp__bot_memory_graph__read_graph', agent, callId: 'read-once' })).toThrow();
      await runner.resume(stopped.id);
      expect(v.kernel.blocked).toBe(false);
      await expect((async () => { for await (const _ of stale) {} })()).rejects.toThrow(/epoch|surface/i);
      expect(f.adapter.requests).toHaveLength(0);
      expect(() => admission.assertToolAllowed({ name: 'bash', agent, callId: 'after-release' })).toThrow(/restricted/i);
      await admission.close();
    } finally { await f.close(); await v.close(); }
  });
  it('records only a genuinely contaminated system head, separating dynamic context from legacy sections', async () => {
    const f = await fixture(), v = await v2Fixture();
    try {
      const row = await v.alpha.save({ content: 'TARGET_SYSTEM_CONTENT' });
      const agent = await f.harness.create(SessionId('b4-head-source'), { provider: 'dp-fixture', model: 'mock' });
      const preview = { targets: [row.id] } as Parameters<typeof contaminatedHeads>[1];
      agent.ctx.effect(() => agent.ctx.systemPrompt.context({ name: 'dynamic', order: 300, text: 'TARGET_SYSTEM_CONTENT', required: true }));
      agent.followup(input('safe')); await agent.whenIdle();
      expect(contaminatedHeads(v.kernel, preview, [agent])).toEqual([]);
      agent.ctx.effect(() => agent.ctx.systemPrompt.section({ name: 'legacy', order: 301, text: 'TARGET_SYSTEM_CONTENT' }));
      agent.followup(input('safe')); await agent.whenIdle();
      expect(contaminatedHeads(v.kernel, preview, [agent])).toEqual([agent.session.id]);
    } finally { await f.close(); await v.close(); }
  });
});
