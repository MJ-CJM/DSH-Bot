import { describe, expect, it } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import { isAgentLoopRequest, LlmError, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { fixture, input } from './fixtures.js';

async function consume(stream: AsyncIterable<unknown>) { for await (const _chunk of stream) {} }
describe('I02 real LlmRuntime final admission', () => {
  it('checks lazy iteration, prepared calls, and unknown summary ownership without adapter dispatch', async () => {
    const f = await fixture();
    try {
      let epoch = 0, blocked = false, denied = 0;
      f.ctx.effect(() => f.ctx.on('llm/stream', async function* (options, next) {
        if (blocked || !options.sessionId) { denied++; throw Error('DP_ADMISSION_BLOCKED'); }
        yield* next();
      }));
      const options: GenerateOptions = { provider: 'dp-fixture', model: 'mock', messages: [input('safe')],
        sessionId: SessionId('dp-b1-admission') };
      const prepared = await f.ctx.llm.prepareCall(options);
      const lazy = prepared.stream({ ...options, ...prepared.config });
      epoch++; blocked = epoch > 0;
      await expect(consume(lazy)).rejects.toThrow('DP_ADMISSION_BLOCKED');
      await expect(consume(f.ctx.llm.stream({ ...options, sessionId: undefined, purpose: 'compaction' })))
        .rejects.toThrow('DP_ADMISSION_BLOCKED');
      expect(f.adapter.requests).toHaveLength(0);
      expect(denied).toBe(2);
      blocked = false;
      await consume(f.ctx.llm.stream(options));
      expect(f.adapter.requests).toHaveLength(1);
    } finally { await f.close(); }
  });
  it.each([false, true])('refreshes context on native same-step retry; block retry=%s', async (blockRetry) => {
    const f = await fixture();
    try {
      const agent = await f.harness.create(SessionId(`dp-b1-retry-${blockRetry}`), { provider: 'dp-fixture', model: 'mock' });
      let text = 'CONTEXT_V1 {{literal}}', epoch = 0, attempts = 0, denied = 0, preSteps = 0;
      agent.ctx.effect(() => agent.ctx.systemPrompt.context({ name: 'dp-b1-memory', order: 300,
        text: () => text, required: true, interpolate: false }));
      f.ctx.effect(() => f.ctx.on('agent/pre-step', async (_payload, next) => { preSteps++; return next(); }));
      f.ctx.effect(() => f.ctx.on('llm/stream', async function* (options, next) {
        expect(isAgentLoopRequest(options)).toBe(true);
        expect(Object.isFrozen(options)).toBe(true);
        if (epoch) { denied++; throw Error('DP_ADMISSION_BLOCKED'); }
        yield* next();
      }));
      f.adapter.onRequest = () => { if (attempts++ === 0) throw new LlmError('Synthetic transient', 'RATE_LIMIT'); };
      f.ctx.effect(() => f.ctx.on('agent/request-error', async () => {
        if (attempts !== 1 || denied) return undefined;
        text = 'CONTEXT_V2';
        if (blockRetry) epoch++;
        return { kind: 'retry' as const };
      }));
      agent.followup(input('synthetic retry'));
      await agent.whenIdle();
      expect(preSteps).toBe(1);
      expect(f.adapter.requests).toHaveLength(blockRetry ? 1 : 2);
      expect(JSON.stringify(f.adapter.requests[0])).toContain('CONTEXT_V1 {{literal}}');
      if (blockRetry) expect(denied).toBe(1);
      else expect(JSON.stringify(f.adapter.requests[1])).toContain('CONTEXT_V2');
    } finally { await f.close(); }
  });
});
