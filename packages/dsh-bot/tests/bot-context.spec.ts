import { Context } from '@deepseek-ai/cordis';
import { type Agent, type ModelSelection, type ModelSelectionRef, installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm';
import { bindScopeParent, createScope, scopeChainOf, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-user-approval';
import { describe, expect, it, vi } from 'vitest';
import * as botContext from '../src/host/bot-context.js';
import { workerReservations } from '../src/host/groups/worker-tool.js';
import { Config as RegistryConfig } from '../lib/host/registry.js';
import { registerStandardBotManage } from '../src/host/tools/bot-manage.js';
import { botCreateSchema, botSchema } from '../lib/shared/schema.js';

async function fixture() {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {}).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  const records = new Map(['alpha', 'beta'].map((id) => [id, botSchema.parse({
    ...botCreateSchema.parse({ id, name: id, tools: { deny: id === 'alpha' ? ['inherited_tool'] : [] },
      memory: { enabled: false, injectLimit: 20 } }),
    createdAt: 1, updatedAt: 1, schemaVersion: 1,
  })]));
  const presetBot = vi.fn((id: string) => {
    const bot = records.get(id);
    if (!bot) throw new Error(`Unknown Bot: ${id}`);
    return structuredClone(bot);
  });
  const catalogs = new Map<string, string[]>([['bot-provider', ['bot-model']]]);
  const listModels = vi.fn(async (provider: string) => (catalogs.get(provider) ?? []).map((id) => ({ id, provider, name: id })));
  ctx.provide('llm', {
    listProviders: () => [...catalogs.keys()].map((id) => ({ id, name: id })), listModels,
  } as unknown as Context['llm']);
  const list = vi.fn(async () => structuredClone([...records.values()]));
  const ensureHome = vi.fn(async (id: string) => ({ path: `/fixture/dsh-bot/bots/${id}/home` }));
  ctx.provide('dshBots', { presetBot, list, ensureHome, config: RegistryConfig({}),
    personaSnapshot: (id: string, createdAt: number) => records.get(id)?.createdAt === createdAt ? records.get(id)?.persona : undefined,
    subscribePersonaChanges: () => () => {},
  } as unknown as Context['dshBots']);
  const requestApproval = vi.fn(async (_request: { agent: Agent; toolName: string }) => 'rejected' as const);
  ctx.provide('approval', { request: requestApproval } as unknown as Context['approval']);
  const liveAgents = new Map<string, Agent>();
  ctx.provide('agents', { get: (id: string) => liveAgents.get(id) } as unknown as Context['agents']);
  const presetNames = new Map<object, string>();
  ctx.provide('agentPresets', {
    composedPreset: (context: Context) => scopeChainOf(scopeOf(context)).map((key) => presetNames.get(key)).find(Boolean),
  } as unknown as Context['agentPresets']);
  const modelStates = new WeakMap<object, { pending: ModelSelection | null }>();
  ctx.provide('sessionProjections', {
    stateOf: (session: object) => modelStates.get(session),
  } as unknown as Context['sessionProjections']);
  let owner!: Context;
  await ctx.plugin({
    inject: ['tools', 'systemPrompt', 'dshBots', 'agents', 'agentPresets'],
    apply(injected: Context) { owner = injected; },
  }).await();

  const preset = async (botId: string) => {
    const key = {};
    presetNames.set(key, `bot-${botId}`);
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
  const plainPreset = (id: 'standard' | 'minimal') => {
    const key = {};
    presetNames.set(key, id);
    return { key, scope: createScope(owner, key) };
  };
  const standardManage = async () => {
    const plugin = owner.plugin({
      inject: ['tools', 'dshBots', 'agents', 'agentPresets'], apply: registerStandardBotManage,
    });
    await plugin.await();
    return plugin;
  };
  // These are event payload fixtures, not a model/session runtime. Scope routing,
  // restriction resolution and effect disposal use the actual published APIs.
  let sequence = 0;
  const agent = (parent?: object, cwd = '/fixture/dsh-bot/bots') => {
    const modelState: { header?: { config: ModelSelection }; pending: ModelSelection | null } = { pending: null };
    const session = { id: SessionId(`fixture-session-${++sequence}`), header: { cwd }, requestHeader: () => modelState.header };
    modelStates.set(session, modelState);
    const payload = { id: `fixture-${++sequence}`, ctx, session };
    const subject = payload as Agent;
    let parentBinding = parent ? bindScopeParent(subject, parent) : undefined;
    const scope = createScope(owner, subject);
    payload.ctx = scope.ctx;
    liveAgents.set(session.id, subject);
    scope.ctx.effect(() => () => { liveAgents.delete(session.id); });
    return {
      subject, scope, modelState,
      announce: () => ctx.serial(scopeTarget(subject, subject), 'agent/created', { agent: subject, source: 'startup' }),
      select: (next: object) => {
        if (parentBinding) parentBinding.rebind(next);
        else parentBinding = bindScopeParent(subject, next);
        const id = presetNames.get(next);
        if (!id) throw new Error('Missing fixture preset name');
        return ctx.serial('agent-preset/selected', session.id, id);
      },
    };
  };
  const manage = (subject: Agent, args: unknown = { action: 'create', input: { id: 'new-bot', name: 'New Bot' } }) => ctx.tools.execute({
    callId: ToolCallId(`manage-${++sequence}`), name: 'bot_manage', arguments: args,
    agent: subject, signal: new AbortController().signal,
  });
  return { ctx, records, presetBot, preset, plainPreset, standardManage, agent, catalogs, listModels, list, ensureHome, requestApproval, manage,
    close: () => ctx.fiber.dispose() };
}

async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const value = await fixture();
  try { await run(value); } finally { await value.close(); }
}

describe('Bot preset context using the published scope and tool services', () => {
  it('joins a connector start racing preset unload and releases the late child', async () => withFixture(async f => {
    let finish!: (release: () => Promise<void>) => void;
    const childClosed = vi.fn(async () => {});
    const attach = vi.fn(async () => new Promise<() => Promise<void>>(resolve => { finish = resolve; }));
    const remove = f.ctx.provide('dshBotConnectors', { attach } as unknown as Context['dshBotConnectors']);
    const preset = await f.preset('beta'); const agent = f.agent(preset.key);
    const announce = agent.announce(); const rejected = expect(announce).rejects.toMatchObject({ code: 'bot/unavailable' });
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    let disposed = false; const closing = preset.plugin.dispose().then(() => { disposed = true; });
    await Promise.resolve(); expect(disposed).toBe(false);
    finish(childClosed); await closing; await rejected;
    expect(childClosed).toHaveBeenCalledOnce(); expect(botContext.getBotBinding(agent.subject)).toBeUndefined(); remove();
  }));
  it('adds concise English private home and workspace guidance per Agent even when memory is disabled', async () => withFixture(async ({ ctx, preset, agent, ensureHome }) => {
    const alpha = await preset('alpha');
    const first = agent(alpha.key);
    const second = agent(alpha.key, '/fixture/user-workspace');
    await first.announce();
    await second.announce();
    const text = async (subject: Agent) => (await ctx.systemPrompt.assemble({ scope: subject, agent: subject })).sections
      .find((section) => section.name === 'dsh-bot:home')?.text;
    for (const subject of [first.subject, second.subject]) {
      const guidance = await text(subject);
      expect(guidance).toContain('Your private working directory is "/fixture/dsh-bot/bots/alpha/home"; put your files there.');
      expect(guidance).toContain('Bots share this root without isolation');
      expect(guidance).toContain('writes outside it follow native permissions and approval');
      expect(guidance).not.toMatch(/\p{Script=Han}/u);
    }
    expect(await text(first.subject)).toContain('Your cwd is the shared Bots root "/fixture/dsh-bot/bots".');
    expect(await text(second.subject)).toContain('Your cwd is "/fixture/user-workspace"; the shared Bots root is "/fixture/dsh-bot/bots".');
    expect(await text(second.subject)).not.toContain('Your cwd is the shared Bots root');
    expect(ensureHome).toHaveBeenCalledTimes(2);
    await first.scope.dispose();
    expect(await text(first.subject)).toBeUndefined();
    expect(await text(second.subject)).toContain('/fixture/dsh-bot/bots/alpha/home');
    await alpha.plugin.dispose();
    expect(await text(second.subject)).toBeUndefined();
  }));

  it('degrades a failed private home to path-free guidance without blocking session initialization', async () => withFixture(async ({ ctx, preset, agent, ensureHome }) => {
    ensureHome.mockRejectedValueOnce(new Error('Cannot access private path'));
    const alpha = await preset('alpha');
    const first = agent(alpha.key);
    await expect(first.announce()).resolves.toBeUndefined();
    const text = (await ctx.systemPrompt.assemble({ scope: first.subject, agent: first.subject })).sections
      .find((section) => section.name === 'dsh-bot:home')?.text;
    expect(text).toBe('Private directory unavailable; use the current workspace under native permissions and approval.');
    expect(text).not.toContain('/fixture');
    expect(botContext.getBotBinding(first.subject)).toEqual({ botId: 'alpha', botCreatedAt: 1 });
  }));
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
    expect(botContext.getBotBinding(first.subject)).toEqual({ botId: 'alpha', botCreatedAt: 1 });
    expect(botContext.getBotBinding(second.subject)).toEqual({ botId: 'alpha', botCreatedAt: 1 });
    expect(botContext.getBotBinding(other.subject)).toEqual({ botId: 'beta', botCreatedAt: 1 });
    expect(botContext.getBotBinding(plain.subject)).toBeUndefined();
    expect(Object.isFrozen(botContext.getBotBinding(first.subject))).toBe(true);
  }));

  it('registers bot_manage for every Bot even with memory disabled, only inside its Agent scope', async () => withFixture(async ({
    ctx, preset, agent, manage, list, requestApproval,
  }) => {
    for (const id of ['alpha', 'beta']) {
      const composition = await preset(id);
      const session = agent(composition.key);
      expect(ctx.tools.get('bot_manage', composition.key)).toBeUndefined();
      await session.announce();
      expect(ctx.tools.get('bot_manage', session.subject)).toBeDefined();
      expect(await manage(session.subject, { action: 'list' })).toMatchObject({ isError: false, value: { action: 'list' } });
      expect(ctx.tools.schemas(session.subject).some((tool) => tool.name.startsWith('memory_'))).toBe(false);
    }
    const plain = agent();
    await plain.announce();
    expect(ctx.tools.get('bot_manage', plain.subject)).toBeUndefined();
    expect(ctx.tools.get('bot_manage')).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(2);
    expect(requestApproval).not.toHaveBeenCalled();
  }));

  it('omits denied bot_manage tools and approval hooks while retaining each preset generation policy', async () => withFixture(async ({
    ctx, records, preset, agent, manage, requestApproval,
  }) => {
    const record = records.get('alpha');
    if (!record) throw new Error('Missing alpha fixture');
    record.tools.deny.push('bot_manage');
    const old = await preset('alpha');
    const restrictions = vi.spyOn(ctx.tools, 'restrict');
    const registrations = vi.spyOn(ctx.tools, 'register');
    const before = agent(old.key);
    await before.announce();
    // rc.2 restrict cannot hide a same-layer definition. Denial must omit the
    // local registration entirely, regardless of the creation-listener order.
    expect(registrations.mock.calls.some(([tool]) => tool.name === 'bot_manage')).toBe(false);
    expect(restrictions.mock.calls.map(([filter]) => filter)).toEqual([{ deny: ['inherited_tool'] }]);
    record.tools.deny = ['inherited_tool'];
    const current = await preset('alpha');
    const retained = agent(old.key);
    const fresh = agent(current.key);
    await retained.announce();
    await fresh.announce();
    for (const session of [before, retained]) {
      expect(botContext.getBotBinding(session.subject)).toEqual({ botId: 'alpha', botCreatedAt: 1 });
      expect(ctx.tools.get('bot_manage', session.subject)).toBeUndefined();
      expect(ctx.tools.get('inherited_tool', session.subject)).toBeUndefined();
      expect(ctx.tools.schemas(session.subject).map((tool) => tool.name)).not.toContain('bot_manage');
      expect(await manage(session.subject)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } });
    }
    expect(requestApproval).not.toHaveBeenCalled();
    expect(ctx.tools.get('bot_manage', fresh.subject)).toBeDefined();
    expect(await manage(fresh.subject)).toMatchObject({ isError: true, error: { message: 'the user rejected tool "bot_manage"' } });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0]?.[0].agent).toBe(fresh.subject);
    expect(requestApproval.mock.calls[0]?.[0].toolName).toBe('bot_manage');
    restrictions.mockRestore();
    registrations.mockRestore();
  }));

  it('removes both bot_manage and its approval hook on Agent or preset unload without affecting siblings', async () => withFixture(async ({
    ctx, preset, agent, manage, requestApproval,
  }) => {
    const alpha = await preset('alpha');
    const beta = await preset('beta');
    const first = agent(alpha.key);
    const second = agent(alpha.key);
    const other = agent(beta.key);
    for (const session of [first, second, other]) await session.announce();
    await manage(first.subject);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    await first.scope.dispose();
    await first.scope.dispose();
    expect(ctx.tools.get('bot_manage', first.subject)).toBeUndefined();
    expect(await manage(first.subject)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    await manage(second.subject);
    expect(requestApproval).toHaveBeenCalledTimes(2);

    await alpha.plugin.dispose();
    await alpha.plugin.dispose();
    expect(ctx.tools.get('bot_manage', second.subject)).toBeUndefined();
    expect(await manage(second.subject)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } });
    const afterUnload = agent(alpha.key);
    await afterUnload.announce();
    expect(ctx.tools.get('bot_manage', afterUnload.subject)).toBeUndefined();
    expect(await manage(afterUnload.subject)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } });
    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(ctx.tools.get('bot_manage', other.subject)).toBeDefined();
    await manage(other.subject);
    expect(requestApproval).toHaveBeenCalledTimes(3);
    await second.scope.dispose();
    expect(requestApproval).toHaveBeenCalledTimes(3);
  }));

  it('moves management across retained Bot generations, denied Bots and minimal without stale ownership', async () => withFixture(async ({
    ctx, records, preset, plainPreset, agent, manage, requestApproval,
  }) => {
    const denied = records.get('beta');
    if (!denied) throw new Error('Missing beta fixture');
    denied.tools.deny = ['bot_manage'];
    const old = await preset('alpha');
    const blocked = await preset('beta');
    const current = await preset('alpha');
    const minimal = plainPreset('minimal');
    const changing = agent(old.key);
    const retained = agent(old.key);
    await changing.announce();
    await retained.announce();
    await manage(changing.subject);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    await changing.select(blocked.key);
    expect(ctx.tools.get('bot_manage', changing.subject)).toBeUndefined();
    expect(await manage(changing.subject)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(ctx.tools.get('bot_manage', retained.subject)).toBeDefined();

    await changing.select(current.key);
    expect(ctx.tools.schemas(changing.subject).filter((tool) => tool.name === 'bot_manage')).toHaveLength(1);
    await old.plugin.dispose();
    expect(ctx.tools.get('bot_manage', retained.subject)).toBeUndefined();
    expect(ctx.tools.get('bot_manage', changing.subject)).toBeDefined();
    await manage(changing.subject);
    expect(requestApproval).toHaveBeenCalledTimes(2);

    await changing.select(minimal.key);
    expect(ctx.tools.get('bot_manage', changing.subject)).toBeUndefined();
    expect(await manage(changing.subject)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } });
    expect(requestApproval).toHaveBeenCalledTimes(2);
    await changing.select(current.key);
    expect(ctx.tools.schemas(changing.subject).filter((tool) => tool.name === 'bot_manage')).toHaveLength(1);
    await manage(changing.subject);
    expect(requestApproval).toHaveBeenCalledTimes(3);
  }));

  it.each(['standard-first', 'bot-first'] as const)('transfers management between standard and Bot with %s listener order', async (order) => withFixture(async ({
    ctx, preset, plainPreset, standardManage, agent, manage, requestApproval,
  }) => {
    const standard = plainPreset('standard');
    const minimal = plainPreset('minimal');
    const standardPlugin = order === 'standard-first' ? await standardManage() : undefined;
    const bot = await preset('alpha');
    const standardOwner = standardPlugin ?? await standardManage();
    const changing = agent(standard.key);
    const retained = agent(bot.key);
    await changing.announce();
    await retained.announce();
    for (const key of [bot.key, standard.key]) {
      await changing.select(key);
      expect(ctx.tools.schemas(changing.subject).filter((tool) => tool.name === 'bot_manage')).toHaveLength(1);
      expect(await manage(changing.subject)).toMatchObject({ isError: true, error: { message: 'the user rejected tool "bot_manage"' } });
    }
    expect(requestApproval).toHaveBeenCalledTimes(2);
    await bot.plugin.dispose();
    expect(ctx.tools.get('bot_manage', retained.subject)).toBeUndefined();
    expect(ctx.tools.get('bot_manage', changing.subject)).toBeDefined();
    await manage(changing.subject);
    expect(requestApproval).toHaveBeenCalledTimes(3);
    await changing.select(minimal.key);
    expect(ctx.tools.get('bot_manage', changing.subject)).toBeUndefined();
    expect(await manage(changing.subject)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } });
    expect(requestApproval).toHaveBeenCalledTimes(3);
    await standardOwner.dispose();
    expect(ctx.tools.get('bot_manage', changing.subject)).toBeUndefined();
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
    expect(botContext.getBotBinding(second.subject)).toEqual({ botId: 'alpha', botCreatedAt: 1 });
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

  it('does not register late Agent effects when the plugin unloads during model validation', async () => withFixture(async ({
    ctx, records, preset, agent, listModels, manage, requestApproval,
  }) => {
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
    expect(ctx.tools.get('bot_manage', session.subject)).toBeUndefined();
    release();
    await rejected;
    expect(botContext.getBotBinding(session.subject)).toBeUndefined();
    expect(await manage(session.subject)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } });
    expect(requestApproval).not.toHaveBeenCalled();
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

describe('group override model precedence', () => {
  it.each([true, false])('applies a reserved group override only when its child lineage matches (%s)', async matches => withFixture(async ({ ctx, records, preset, agent }) => {
    const alpha = records.get('alpha'); if (!alpha) throw new Error('Missing alpha');
    alpha.model = { provider: 'bot-provider', model: 'bot-model', reasoningEffort: 'high' };
    const composition = await preset('alpha'), session = agent(composition.key);
    Object.assign(session.subject.session.header, { parentSession: matches ? 'group-root' : undefined, agentPreset: 'bot-alpha' });
    const selection = { provider: 'group-provider', model: 'group-model' };
    workerReservations.set(session.subject.session.id, { rootId: 'group-root', presetId: 'bot-alpha', childId: session.subject.session.id,
      turnId: 'turn', deliveryId: 'delivery', audience: [], modelSelection: selection, isActive: () => true });
    const inherited: ModelSelectionRef = { current: selection, assembled: undefined };
    session.scope.ctx.effect(() => installModelSelection(session.scope.ctx, inherited));
    try {
      await session.announce();
      const assembly = await session.scope.ctx.systemPrompt.assemble({ scope: session.subject, agent: session.subject });
      expect(assembly.variables).toMatchObject(matches ? selection : { provider: 'bot-provider', model: 'bot-model' });
      const request = await ctx.waterfall(scopeTarget(session.subject, session.subject), 'agent/request', {
        agent: session.subject, turn: 1, step: 1, signal: new AbortController().signal,
      }, async () => ({ ...selection, reasoningEffort: ReasoningEffortId('high') }));
      expect(request).toEqual(matches ? selection : alpha.model);
    } finally { workerReservations.delete(session.subject.session.id); }
  }));
});
