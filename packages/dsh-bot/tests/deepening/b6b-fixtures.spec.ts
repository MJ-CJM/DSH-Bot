import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

const adapterPath = './b6b-adapter.mjs';
const { B6bAdapter, registerIsolatedAdapter } = await import(adapterPath);

describe('B6b adapter bootstrap with real npm rc.2 LlmRuntime (UNIT)', () => {
  it('checks isolation before registering itself, then withdraws its route on disposal', async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(LlmRuntime).await();
      expect(ctx.llm.listProviders()).toEqual([]);
      const off = registerIsolatedAdapter(ctx.llm, new B6bAdapter());
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['dp-b6b']);
      await off();
      expect(ctx.llm.listProviders()).toEqual([]);
    } finally { await ctx.fiber.dispose(); }
  });
  it('rejects a pre-existing provider and never adds the synthetic route', async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(LlmRuntime).await();
      const off = ctx.llm.registerAdapter(['synthetic-unexpected'], new B6bAdapter());
      expect(() => registerIsolatedAdapter(ctx.llm, new B6bAdapter())).toThrow('zero pre-existing provider');
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['synthetic-unexpected']);
      await off();
      expect(ctx.llm.listProviders()).toEqual([]);
    } finally { await ctx.fiber.dispose(); }
  });
});
