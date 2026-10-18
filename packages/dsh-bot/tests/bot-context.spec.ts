import { Context } from '@deepseek-ai/cordis';
import { type Agent, type ModelSelection, type ModelSelectionRef, installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { describe, expect, it, vi } from 'vitest';
import * as botContext from '../lib/host/bot-context.js';
import { botCreateSchema, botSchema } from '../lib/shared/schema.js';

async function fixture() {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {}).await();
  await ctx.plugin(ToolRuntime).await();
  const records = new Map(['alpha', 'beta'].map((id) => [id, botSchema.parse({
    ...botCreateSchema.parse({ id, name: id, tools: { deny: id === 'alpha' ? ['inherited_tool'] : [] } }),
    createdAt: 1, updatedAt: 1, schemaVersion: 1,
  })]));
  const presetBot = vi.fn((id: string) => {
    const bot = records.get(id);
    if (!bot) throw new Error(`Unknown Bot: ${id}`);
    return bot;
  });
  const catalogs = new Map<string, string[]>([['bot-provider', ['bot-model']]]);
  const listModels = vi.fn(async (provider: string) => (catalogs.get(provider) ?? []).map((id) => ({ id, provider, name: id })));
  ctx.provide('llm', {
    listProviders: () => [...catalogs.keys()].map((id) => ({ id, name: id })), listModels,
  } as unknown as Context['llm']);
  ctx.provide('dshBots', { presetBot } as unknown as Context['dshBots']);
  const modelStates = new WeakMap<object, { pending: ModelSelection | null }>();
  ctx.provide('sessionProjections', {
    stateOf: (session: object) => modelStates.get(session),
  } as unknown as Context['sessionProjections']);
  let owner!: Context;
  await ctx.plugin({
    inject: ['tools', 'systemPrompt', 'dshBots'],
    apply(injected: Context) { owner = injected; },
  }).await();

  const preset = async (botId: string) => {
    const key = {};
    const scope = createScope(owner, key);
    scope.ctx.effect(() => scope.ctx.tools.register(defineTool({
      name: 'inherited_tool', description: 'Inherited fixture tool', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'fixture',
    })));
    const plugin = scope.ctx.plugin(botContext, { botId });
    await plugin.await();
    return { key, scope, plugin };
  };
  // These are event payload fixtures, not a model/session runtime. Scope routing,
  // restriction resolution and effect disposal use the actual published APIs.
  let sequence = 0;
  const agent = (parent?: object) => {
    const modelState: { header?: { config: ModelSelection }; pending: ModelSelection | null } = { pending: null };
    const session = { requestHeader: () => modelState.header };
    modelStates.set(session, modelState);
    const payload = { id: `fixture-${++sequence}`, ctx, session };
    const subject = payload as Agent;
    const scope = createScope(owner, subject, parent ? { parent } : undefined);
    payload.ctx = scope.ctx;
    return {
      subject, scope, modelState,
      announce: () => ctx.serial(scopeTarget(subject, subject), 'agent/created', { agent: subject, source: 'startup' }),
    };
  };
  return { ctx, records, presetBot, preset, agent, catalogs, listModels, close: () => ctx.fiber.dispose() };
}

async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const value = await fixture();
  try { await run(value); } finally { await value.close(); }
}

describe('Bot preset context using the published scope and tool services', () => {
  it('validates a required Bot id', () => {
    expect(botContext.Config({ botId: 'alpha' })).toEqual({ botId: 'alpha' });
    for (const value of [{}, { botId: '' }, { botId: 'A' }, { botId: '../alpha' }]) {
      expect(() => botContext.Config(value as never)).toThrow();
    }
  });

  it('hides inherited tools for both Bot sessions while leaving other scopes visible', async () => withFixture(async ({ ctx, preset, agent }) => {
    const alpha = await preset('alpha');
    const beta = await preset('beta');
    const first = agent(alpha.key);
    const second = agent(alpha.key);
    const other = agent(beta.key);
    const plain = agent();
    for (const session of [first, second, other, plain]) await session.announce();

    expect(ctx.tools.get('inherited_tool', alpha.key)).toBeDefined();
    expect(ctx.tools.get('inherited_tool', first.subject)).toBeUndefined();
    expect(ctx.tools.get('inherited_tool', second.subject)).toBeUndefined();
    expect(ctx.tools.get('inherited_tool', other.subject)).toBeDefined();
    expect(ctx.tools.schemas()).toEqual([]);
    expect(botContext.getBotBinding(first.subject)).toEqual({ botId: 'alpha' });
    expect(botContext.getBotBinding(second.subject)).toEqual({ botId: 'alpha' });
    expect(botContext.getBotBinding(other.subject)).toEqual({ botId: 'beta' });
    expect(botContext.getBotBinding(plain.subject)).toBeUndefined();
    expect(Object.isFrozen(botContext.getBotBinding(first.subject))).toBe(true);
  }));

  it('captures policy once per preset generation and keeps live agents stable', async () => withFixture(async ({ ctx, records, presetBot, preset, agent }) => {
    const old = await preset('alpha');
    const before = agent(old.key);
    await before.announce();
    const alpha = records.get('alpha');
    if (!alpha) throw new Error('Missing alpha fixture');
    alpha.tools.deny.length = 0;
    const current = await preset('alpha');
    const retained = agent(old.key);
    const fresh = agent(current.key);
    await retained.announce();
    await fresh.announce();
    expect(presetBot).toHaveBeenCalledTimes(2);
    expect(ctx.tools.get('inherited_tool', before.subject)).toBeUndefined();
    expect(ctx.tools.get('inherited_tool', retained.subject)).toBeUndefined();
    expect(ctx.tools.get('inherited_tool', fresh.subject)).toBeDefined();
  }));

  it('cleans agent bindings and restrictions independently and removes the preset listener', async () => withFixture(async ({ ctx, preset, agent }) => {
    const alpha = await preset('alpha');
    const first = agent(alpha.key);
    const second = agent(alpha.key);
    await first.announce();
    await second.announce();
    await first.scope.dispose();
    await first.scope.dispose();
    expect(botContext.getBotBinding(first.subject)).toBeUndefined();
    expect(ctx.tools.get('inherited_tool', first.subject)).toBeDefined();
    expect(botContext.getBotBinding(second.subject)).toEqual({ botId: 'alpha' });
    expect(ctx.tools.get('inherited_tool', second.subject)).toBeUndefined();

    await alpha.plugin.dispose();
    expect(botContext.getBotBinding(second.subject)).toBeUndefined();
    expect(ctx.tools.get('inherited_tool', second.subject)).toBeDefined();
    const afterUnload = agent(alpha.key);
    await afterUnload.announce();
    expect(botContext.getBotBinding(afterUnload.subject)).toBeUndefined();
    expect(ctx.tools.get('inherited_tool', afterUnload.subject)).toBeDefined();
    await second.scope.dispose();
    expect(botContext.getBotBinding(second.subject)).toBeUndefined();
  }));

  it.each(['missing_tool', 'run_code'])('rejects an unapplied deny policy for %s', async (tool) => withFixture(async ({ ctx, records, preset, agent }) => {
    const alpha = records.get('alpha');
    if (!alpha) throw new Error('Missing alpha fixture');
    alpha.tools.deny = [tool];
    const composition = await preset('alpha');
    const session = agent(composition.key);
    await expect(session.announce()).rejects.toThrow(tool);
    expect(botContext.getBotBinding(session.subject)).toBeUndefined();
    expect(ctx.tools.get('inherited_tool', session.subject)).toBeDefined();
  }));

  it('rejects tools registered in the same agent layer instead of hiding inherited tools', async () => withFixture(async ({ records, preset, agent }) => {
    const alpha = records.get('alpha');
    if (!alpha) throw new Error('Missing alpha fixture');
    alpha.tools.deny = ['agent_only_tool'];
    const composition = await preset('alpha');
    const session = agent(composition.key);
    session.scope.ctx.effect(() => session.scope.ctx.tools.register(defineTool({
      name: 'agent_only_tool', description: 'Agent-local fixture tool', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'fixture',
    })));
    await expect(session.announce()).rejects.toThrow('agent_only_tool');
    expect(botContext.getBotBinding(session.subject)).toBeUndefined();
  }));

  it.each(['provider', 'model', 'catalog'] as const)('rejects unavailable %s instead of inheriting the Host model', async (failure) => withFixture(async ({ records, preset, agent, catalogs, listModels }) => {
    const record = records.get('alpha');
    if (!record) throw new Error('Missing fixture');
    record.model = { provider: 'bot-provider', model: 'bot-model' };
    const composition = await preset('alpha');
    if (failure === 'provider') catalogs.clear();
    if (failure === 'model') catalogs.set('bot-provider', ['different-model']);
    if (failure === 'catalog') listModels.mockRejectedValueOnce(new Error('catalog offline'));
    const session = agent(composition.key);
    await expect(session.announce()).rejects.toMatchObject({
      code: 'bot/preset-failed', message: expect.stringContaining("Bot 'alpha' model 'bot-provider/bot-model' is unavailable"),
    });
    expect(botContext.getBotBinding(session.subject)).toBeUndefined();
  }));

  it('does not register late Agent effects when the plugin unloads during model validation', async () => withFixture(async ({ records, preset, agent, listModels }) => {
    const record = records.get('alpha');
    if (!record) throw new Error('Missing fixture');
    record.model = { provider: 'bot-provider', model: 'bot-model' };
    const composition = await preset('alpha');
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    listModels.mockImplementationOnce(async () => { await pending; return [{ id: 'bot-model', name: 'Bot', provider: 'bot-provider' }]; });
    const session = agent(composition.key);
    const announced = session.announce();
    const rejected = expect(announced).rejects.toMatchObject({ code: 'bot/unavailable' });
    await composition.plugin.dispose();
    release();
    await rejected;
    expect(botContext.getBotBinding(session.subject)).toBeUndefined();
  }));

  it.each(['assembly', 'request'] as const)('does not apply an in-flight %s override after plugin unload', async (phase) => withFixture(async ({ ctx, records, preset, agent, listModels }) => {
    const record = records.get('alpha');
    if (!record) throw new Error('Missing fixture');
    record.model = { provider: 'bot-provider', model: 'bot-model' };
    const composition = await preset('alpha');
    const session = agent(composition.key);
    session.scope.ctx.effect(() => installModelSelection(session.scope.ctx, {
      current: { provider: 'host-provider', model: 'host-model' }, assembled: undefined,
    }));
    await session.announce();
    const assemble = () => session.scope.ctx.systemPrompt.assemble({ scope: session.subject, agent: session.subject });
    if (phase === 'request') await assemble();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    listModels.mockImplementationOnce(async () => {
      entered(); await pending;
      return [{ id: 'bot-model', name: 'Bot', provider: 'bot-provider' }];
    });
    const operation = phase === 'assembly' ? assemble().then((result) => result.variables)
      : ctx.waterfall(scopeTarget(session.subject, session.subject), 'agent/request', {
        agent: session.subject, turn: 1, step: 1, signal: new AbortController().signal,
      }, async () => ({ provider: 'seed', model: 'seed' }));
    await started;
    await composition.plugin.dispose();
    release();
    expect(await operation).toMatchObject({ provider: 'host-provider', model: 'host-model' });
    expect(botContext.getBotBinding(session.subject)).toBeUndefined();
  }));

  it('preserves other contributors and removes all Agent effects on plugin unload', async () => withFixture(async ({ ctx, records, preset, agent, catalogs }) => {
    const record = records.get('alpha');
    if (!record) throw new Error('Missing fixture');
    record.model = { provider: 'bot-provider', model: 'bot-model' };
    const composition = await preset('alpha');
    const session = agent(composition.key);
    const inherited: ModelSelectionRef = {
      current: { provider: 'host-provider', model: 'host-model' }, assembled: undefined,
    };
    session.scope.ctx.effect(() => installModelSelection(session.scope.ctx, inherited));
    const sections = [{ name: 'other:section', text: 'Other plugin prompt text' }];
    const contexts = [{ name: 'other:context', text: 'Other plugin context' }];
    const tools = [{ name: 'other_tool', description: 'Other plugin tool', parameters: { type: 'object' as const, properties: {} } }];
    session.scope.ctx.effect(() => session.scope.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next();
      return { ...assembly, sections, contexts, tools,
        variables: { ...assembly.variables, otherVariable: 'keep-me' }, extension: { contributor: 'other' } };
    }));
    await session.announce();
    const assemble = () => session.scope.ctx.systemPrompt.assemble({ scope: session.subject, agent: session.subject });
    const assembly = await assemble();
    expect(assembly.sections).toBe(sections);
    expect(assembly.contexts).toBe(contexts);
    expect(assembly.tools).toBe(tools);
    expect(assembly).toMatchObject({ variables: { provider: 'bot-provider', model: 'bot-model', otherVariable: 'keep-me' }, extension: { contributor: 'other' } });
    const request = () => ctx.waterfall(scopeTarget(session.subject, session.subject), 'agent/request', {
      agent: session.subject, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ provider: 'seed', model: 'seed', maxTokens: 333 }));
    expect(await request()).toEqual({ provider: 'bot-provider', model: 'bot-model', maxTokens: 333 });
    catalogs.clear();
    await expect(request()).rejects.toMatchObject({ code: 'bot/preset-failed' });
    await composition.plugin.dispose();
    expect(botContext.getBotBinding(session.subject)).toBeUndefined();
    expect(ctx.tools.get('inherited_tool', session.subject)).toBeDefined();
    expect(await assemble()).toMatchObject({ sections, contexts, tools, variables: { provider: 'host-provider', model: 'host-model', otherVariable: 'keep-me' } });
    expect(await request()).toEqual({ provider: 'host-provider', model: 'host-model', maxTokens: 333 });
    await session.scope.dispose();
  }));

  it.each([undefined, 'high'])('provides a fresh session default with effort %s', async (effort) => withFixture(async ({ ctx, records, preset, agent }) => {
    const alpha = records.get('alpha');
    if (!alpha) throw new Error('Missing alpha fixture');
    alpha.model = { provider: 'bot-provider', model: 'bot-model', ...(effort ? { reasoningEffort: effort } : {}) };
    const composition = await preset('alpha');
    const session = agent(composition.key);
    const inherited: ModelSelectionRef = {
      current: { provider: 'host-provider', model: 'host-model', reasoningEffort: ReasoningEffortId('low') },
      assembled: undefined,
    };
    session.scope.ctx.effect(() => installModelSelection(session.scope.ctx, inherited));
    await session.announce();
    // A later Store edit does not alter this retained generation's default.
    alpha.model.model = 'edited-model';
    const assembly = await session.scope.ctx.systemPrompt.assemble({ scope: session.subject, agent: session.subject });
    expect(assembly.variables).toMatchObject({ provider: 'bot-provider', model: 'bot-model' });
    const request = await ctx.waterfall(scopeTarget(session.subject, session.subject), 'agent/request', {
      agent: session.subject, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ provider: 'seed-provider', model: 'seed-model', maxTokens: 123 }));
    expect(request).toEqual({ provider: 'bot-provider', model: 'bot-model', maxTokens: 123,
      ...(effort ? { reasoningEffort: effort } : {}),
    });
    expect(inherited.current).toEqual({ provider: 'host-provider', model: 'host-model', reasoningEffort: 'low' });
    await session.scope.dispose();
    const after = await ctx.waterfall(scopeTarget(session.subject, session.subject), 'agent/request', {
      agent: session.subject, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ provider: 'seed-provider', model: 'seed-model' }));
    expect(after).toEqual({ provider: 'seed-provider', model: 'seed-model' });
  }));

  it('leaves Host model inheritance untouched when Bot model is absent', async () => withFixture(async ({ ctx, preset, agent }) => {
    const composition = await preset('beta');
    const session = agent(composition.key);
    const inherited: ModelSelectionRef = {
      current: { provider: 'host-provider', model: 'host-model', reasoningEffort: ReasoningEffortId('low') },
      assembled: undefined,
    };
    session.scope.ctx.effect(() => installModelSelection(session.scope.ctx, inherited));
    await session.announce();
    const assembly = await session.scope.ctx.systemPrompt.assemble({ scope: session.subject, agent: session.subject });
    expect(assembly.variables).toMatchObject({ provider: 'host-provider', model: 'host-model' });
    const request = await ctx.waterfall(scopeTarget(session.subject, session.subject), 'agent/request', {
      agent: session.subject, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ provider: 'seed-provider', model: 'seed-model' }));
    expect(request).toEqual({ provider: 'host-provider', model: 'host-model', reasoningEffort: 'low' });
  }));

  it.each(['pending', 'history'] as const)('preserves the session %s model over the Bot default', async (state) => withFixture(async ({ ctx, records, preset, agent }) => {
    const alpha = records.get('alpha');
    if (!alpha) throw new Error('Missing alpha fixture');
    alpha.model = { provider: 'bot-provider', model: 'bot-model', reasoningEffort: 'high' };
    const composition = await preset('alpha');
    const session = agent(composition.key);
    const selection = { provider: 'session-provider', model: 'session-model', reasoningEffort: ReasoningEffortId('low') };
    if (state === 'pending') session.modelState.pending = selection;
    else session.modelState.header = { config: selection };
    const inherited: ModelSelectionRef = { current: selection, assembled: undefined };
    session.scope.ctx.effect(() => installModelSelection(session.scope.ctx, inherited));
    await session.announce();
    const assembly = await session.scope.ctx.systemPrompt.assemble({ scope: session.subject, agent: session.subject });
    expect(assembly.variables).toMatchObject({ provider: 'session-provider', model: 'session-model' });
    const request = await ctx.waterfall(scopeTarget(session.subject, session.subject), 'agent/request', {
      agent: session.subject, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ provider: 'seed-provider', model: 'seed-model' }));
    expect(request).toEqual(selection);
  }));

  it('defers a selection made after assembly until the next assembly boundary', async () => withFixture(async ({ ctx, records, preset, agent }) => {
    const alpha = records.get('alpha');
    if (!alpha) throw new Error('Missing alpha fixture');
    alpha.model = { provider: 'bot-provider', model: 'bot-model' };
    const composition = await preset('alpha');
    const session = agent(composition.key);
    const inherited: ModelSelectionRef = {
      current: { provider: 'host-provider', model: 'host-model' }, assembled: undefined,
    };
    session.scope.ctx.effect(() => installModelSelection(session.scope.ctx, inherited));
    await session.announce();
    await session.scope.ctx.systemPrompt.assemble({ scope: session.subject, agent: session.subject });
    const selection = { provider: 'session-provider', model: 'session-model' };
    session.modelState.pending = selection;
    inherited.current = selection;
    const request = () => ctx.waterfall(scopeTarget(session.subject, session.subject), 'agent/request', {
      agent: session.subject, turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ provider: 'seed-provider', model: 'seed-model' }));
    expect(await request()).toEqual({ provider: 'bot-provider', model: 'bot-model' });
    const nextAssembly = await session.scope.ctx.systemPrompt.assemble({ scope: session.subject, agent: session.subject });
    expect(nextAssembly.variables).toMatchObject(selection);
    expect(await request()).toEqual(selection);
  }));
});
