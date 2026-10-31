import { describe, expect, it } from 'vitest';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { SessionId } from '@deepseek-ai/dsh-session';
import { MemoryConfirmation } from '../../src/host/memory/confirmation.js';
import { AutoShareQuota } from '../../src/host/memory/quota.js';
import { bindings } from '../../src/host/data-flow/agent-binding.js';
import { v2Fixture } from './v2-fixtures.js';
import { CaptureAdapter, input } from './fixtures.js';
import type { OnceGrant } from '../../src/host/data-flow/grants.js';
const owner = { botId: 'alpha', botCreatedAt: 1 };
async function fixture(policy: 'ask' | 'never' = 'ask') {
  const f = await v2Fixture();
  await mountAgentLoopTestDependencies(f.ctx); await f.ctx.plugin(ApprovalService, { policy }).await();
  const adapter = new CaptureAdapter(); f.ctx.effect(() => f.ctx.llm.registerAdapter(['dp-fixture'], adapter));
  const harness = await mountAgentLoopTestHarness(f.ctx), confirmation = new MemoryConfirmation(f.kernel, () => true);
  f.ctx.effect(() => () => confirmation.close());
  const { id } = await f.alpha.save({ content: 'I live in Shanghai.', tags: ['PRIVATE_CANARY_TAG'] });
  const agent = await harness.create(SessionId('b6-confirm-native'), { provider: 'dp-fixture', model: 'mock' });
  bindings.set(agent, owner); agent.ctx.effect(() => () => { bindings.delete(agent); });
  const invocation = `${agent.session.id}/confirm-call`, controller = new AbortController();
  return { ...f, get kernel() { return f.kernel; }, confirmation, adapter, agent, id, invocation, controller,
    async run(work: () => Promise<unknown>) {
      let error: unknown, finished = false;
      const off = agent.ctx.on('agent/request', async (_payload, next) => {
        try { await work(); } catch (e) { error = e; } finally { finished = true; } return next();
      });
      agent.followup(input('SYNTHETIC_CONFIRM')); await agent.whenIdle(); off();
      expect(finished).toBe(true); return error;
    } };
}
describe('I39 real npm rc.2 approval service in a native open Agent turn', () => {
  it('answers the exact confirmation before a waiting Web bridge and delegates unrelated asks', async () => {
    const f = await fixture();
    const supportPath = './b6a-support.mjs';
    const { syntheticApproval } = await import(supportPath);
    try {
      let bridgeCalls = 0, answers = 0;
      f.ctx.effect(() => f.ctx.on('approval/request', async req => {
        bridgeCalls++;
        if (req.toolName === 'bot_memory_confirm') return new Promise<'allowed-once'>(() => {});
        return 'rejected';
      }));
      syntheticApproval(f.agent, async () => { answers++; return 'allowed-once'; });
      const error = await f.run(async () => {
        const grant = await f.confirmation.request(f.agent, f.id, owner, f.invocation, f.controller.signal);
        await f.confirmation.commit(f.id, owner, f.invocation, grant, f.controller.signal);
        expect(bridgeCalls).toBe(0);
        expect(await f.agent.ctx.get('approval')?.request({ agent: f.agent, toolName: 'unrelated' })).toBe('rejected');
      });
      expect(error).toBeUndefined(); expect(answers).toBe(1); expect(bridgeCalls).toBe(1);
      expect(f.kernel.snapshot.grantUses.size).toBe(1);
    } finally { await f.close(); }
  });
  it('shows exact fields/scope, commits once, excludes private metadata and persists consumption', async () => {
    const f = await fixture();
    try {
      let reason = '', grant: OnceGrant | undefined;
      f.ctx.effect(() => f.ctx.on('approval/request', async req => { reason = req.reason ?? ''; return 'allowed-once'; }));
      const error = await f.run(async () => {
        grant = await f.confirmation.request(f.agent, f.id, owner, f.invocation, f.controller.signal);
        await f.confirmation.commit(f.id, owner, f.invocation, grant, f.controller.signal);
        await expect(f.confirmation.commit(f.id, owner, f.invocation, grant, f.controller.signal)).rejects.toThrow('consumed');
      });
      expect(error).toBeUndefined(); expect(reason).toContain('all Bots'); expect(reason).toContain('I live in Shanghai.');
      expect(reason).not.toContain('PRIVATE_CANARY_TAG');
      const promoted = [...f.kernel.snapshot.versions.values()].filter(v => v.scope === 'shared'); expect(promoted).toHaveLength(1);
      const row = promoted[0]; if (!row || !grant) throw new Error('No grant/promotion');
      expect(f.kernel.domain.table('payloads').get(row.contentRef)).not.toHaveProperty('legacy');
      expect(row.trust).toBe('user_confirmed'); expect(row.sourceRefs.some(r => r.parentVersionId)).toBe(true);
      await f.reopen(); expect(f.kernel.snapshot.grantUses.has(grant.id)).toBe(true);
    } finally { await f.close(); }
  });
  it.each(['rejected', 'unavailable', 'cancelled', 'never'] as const)('native %s creates zero shared commits', async outcome => {
    const f = await fixture(outcome === 'never' ? 'never' : 'ask');
    try {
      let answererCalls = 0;
      f.ctx.effect(() => f.ctx.on('approval/request', async () => { answererCalls++; return outcome === 'never' ? 'allowed-once' : outcome; }));
      const error = await f.run(async () => {
        const grant = await f.confirmation.request(f.agent, f.id, owner, f.invocation, f.controller.signal);
        await f.confirmation.commit(f.id, owner, f.invocation, grant, f.controller.signal);
      });
      expect(String(error)).toContain('not approved'); expect(f.kernel.snapshot.grantUses.size).toBe(0);
      expect([...f.kernel.snapshot.versions.values()].filter(v => v.scope === 'shared')).toHaveLength(0);
      if (outcome === 'never') expect(answererCalls).toBe(0);
    } finally { await f.close(); }
  });
  it.each(['forget', 'policy', 'revise', 'cancel'] as const)('approval followed by %s cannot commit', async change => {
    const f = await fixture();
    try {
      f.ctx.effect(() => f.ctx.on('approval/request', async () => 'allowed-once'));
      const error = await f.run(async () => {
        const grant = await f.confirmation.request(f.agent, f.id, owner, f.invocation, f.controller.signal);
        if (change === 'forget') await f.alpha.forget({ id: f.id });
        if (change === 'policy') { const quota = new AutoShareQuota(f.kernel); await quota.configure({ ...quota.policy, enabled: false }); }
        if (change === 'revise') await f.alpha.update(f.id, { content: 'CHANGED_CONTENT' });
        if (change === 'cancel') f.controller.abort();
        await f.confirmation.commit(f.id, owner, f.invocation, grant, f.controller.signal);
      });
      expect(error).toBeDefined(); expect(f.kernel.snapshot.grantUses.size).toBe(0);
      expect([...f.kernel.snapshot.versions.values()].filter(v => v.scope === 'shared')).toHaveLength(0);
    } finally { await f.close(); }
  });
  it('rejects an expired grant and cancellation with a late allowed answer', async () => {
    const f = await fixture();
    try {
      let now = 1000; const expiring = new MemoryConfirmation(f.kernel, () => true, 10, () => now);
      f.ctx.effect(() => () => expiring.close());
      f.ctx.effect(() => f.ctx.on('approval/request', async () => 'allowed-once'));
      expect(await f.run(async () => {
        const grant = await expiring.request(f.agent, f.id, owner, f.invocation, f.controller.signal);
        now += 10;
        await expect(expiring.commit(f.id, owner, f.invocation, grant, f.controller.signal)).rejects.toThrow('Grant');
      })).toBeUndefined();
      expect(f.kernel.snapshot.grantUses.size).toBe(0);
    } finally { await f.close(); }
    const late = await fixture();
    try {
      let answer: ((v: 'allowed-once') => void) | undefined;
      late.ctx.effect(() => late.ctx.on('approval/request', async () => {
        const pending = new Promise<'allowed-once'>(resolve => { answer = resolve; });
        late.controller.abort(); return pending;
      }));
      const error = await late.run(async () => {
        const grant = await late.confirmation.request(late.agent, late.id, owner, late.invocation, late.controller.signal);
        await late.confirmation.commit(late.id, owner, late.invocation, grant, late.controller.signal);
      });
      answer?.('allowed-once'); expect(error).toBeDefined(); expect(late.kernel.snapshot.grantUses.size).toBe(0);
    } finally { await late.close(); }
  });
  it('withdraws a pending native approval on owner unload and rejects late permission', async () => {
    const f = await fixture();
    try {
      let answer: ((v: 'allowed-once') => void) | undefined;
      f.ctx.effect(() => f.ctx.on('approval/request', async () => {
        const pending = new Promise<'allowed-once'>(resolve => { answer = resolve; });
        f.confirmation.close(); return pending;
      }));
      const error = await f.run(async () => {
        const grant = await f.confirmation.request(f.agent, f.id, owner, f.invocation, f.controller.signal);
        await f.confirmation.commit(f.id, owner, f.invocation, grant, f.controller.signal);
      });
      answer?.('allowed-once'); expect(error).toBeDefined(); expect(f.kernel.snapshot.grantUses.size).toBe(0);
    } finally { await f.close(); }
  });
  it('rejects idle requests and cloned grants without creating an approval', async () => {
    const f = await fixture();
    try {
      await expect(f.confirmation.request(f.agent, f.id, owner, f.invocation, f.controller.signal)).rejects.toThrow('open turn');
      f.ctx.effect(() => f.ctx.on('approval/request', async () => 'allowed-once'));
      expect(await f.run(async () => {
        const grant = await f.confirmation.request(f.agent, f.id, owner, f.invocation, f.controller.signal);
        await expect(f.confirmation.commit(f.id, owner, f.invocation, { ...grant }, f.controller.signal)).rejects.toThrow('Grant');
      })).toBeUndefined();
    } finally { await f.close(); }
  });
});
