import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import * as deepSeekApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key';
import { type MockLlmServer, startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import { PERSONA_PREFIX_SECTION, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { describe, expect, it, vi } from 'vitest';
import * as botContext from '../lib/host/bot-context.js';
import { BotMemoryService } from '../lib/host/memory/service.js';
import { Config as RegistryConfig } from '../lib/host/registry.js';
import { openBotStores } from '../lib/host/store.js';

const isolatedHome = fileURLToPath(new URL('../../../.dsh-dev/', import.meta.url));
const memoryToolNames = ['memory_forget', 'memory_list', 'memory_save', 'memory_search'];
const routineToolNames = ['routine_create', 'routine_delete', 'routine_list', 'routine_run_now', 'routine_update'];
const botToolNames = ['bot_delegate', 'bot_manage', ...memoryToolNames, ...routineToolNames].sort();
const botIds = ['alpha', 'beta', 'disabled', 'readonly'];

/** Real JSON storage, production AgentLoop/Tools/SystemPrompt and public scope APIs. */
async function withRuntime(run: (value: Awaited<ReturnType<typeof runtime>>) => Promise<void>) {
  await mkdir(isolatedHome, { recursive: true });
  const root = await mkdtemp(join(isolatedHome, 't06-memory-loop-'));
  const ctx = new Context();
  try { await run(await runtime(ctx, root)); }
  finally {
    try { await ctx.fiber.dispose(); }
    finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function runtime(ctx: Context, root: string) {
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } });
  await ctx.plugin(Storage).await();
  await ctx.plugin(storageJson, { root }).await();
  await ctx.plugin(storageDomain, { backend: 'json' }).await();
  const stores = await openBotStores(ctx);
  for (const id of botIds) {
    await stores.bots.create({ id, name: id, memory: { enabled: id !== 'disabled', injectLimit: 20 },
      tools: { deny: id === 'readonly' ? ['memory_save'] : [] } });
  }
  // The registry-facing fixture is deliberately small. Memory operations use
  // the production service and Store, with no in-memory persistence substitute.
  const memoryFor = vi.fn((botId: string) => new BotMemoryService(stores.memories, botId));
  ctx.provide('dshBots', {
    config: RegistryConfig({}),
    presetBot: (botId: string) => stores.bots.get(botId),
    memoryFor,
  } as unknown as Context['dshBots']);
  let owner!: Context;
  await ctx.plugin({
    inject: ['agents', 'tools', 'systemPrompt', 'dshBots'],
    apply(injected: Context) { owner = injected; },
  }).await();
  const harness = await mountAgentLoopTestHarness(ctx);
  const presets = new Map<string, { key: object; ctx: Context; plugin: ReturnType<Context['plugin']> }>();
  for (const id of botIds) {
    const key = {};
    const scope = createScope(owner, key);
    const plugin = scope.ctx.plugin(botContext, { botId: id });
    await plugin.await();
    presets.set(id, { key, ctx: scope.ctx, plugin });
  }
  let sequence = 0;
  const create = async (botId: string) => {
    const preset = presets.get(botId);
    if (!preset) throw new Error(`Unknown fixture Bot: ${botId}`);
    // The narrow harness.create API has no setup callback. Use the public
    // AgentRegistry factory supplied by that harness to bind the preset before
    // publication, exactly at the documented creation setup boundary.
    return owner.agents.create({
      sessionId: SessionId(`t06-${botId}-${++sequence}`),
      agentOptions: { provider: 'deepseek-official', model: 'memory-mock', maxTokens: 128 },
      setup(agentCtx) {
        const key = scopeOf(agentCtx);
        if (!key) throw new Error('Production Agent has no scope');
        bindScopeParent(key, preset.key);
      },
    });
  };
  const assemble = (agent: Agent) => ctx.systemPrompt.assemble({ agent, scope: agent });
  const memoryText = async (agent: Agent) => (await assemble(agent)).sections
    .find((section) => section.name === 'dsh-bot:memory')?.text;
  const execute = (agent: Agent, name: string, args: unknown) => ctx.tools.execute({
    callId: ToolCallId(`memory-call-${++sequence}`), name, arguments: args, agent,
    signal: new AbortController().signal,
  });
  return { ctx, stores, harness, memoryFor, presets, create, assemble, memoryText, execute };
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
  await agent.whenIdle();
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
    type: 'turn/end', data: { reason: { kind: 'completed' } },
  });
}

function wireSystem(body: unknown): unknown {
  if (!body || typeof body !== 'object' || !('system' in body)) throw new Error('Mock request has no system prompt');
  return body.system;
}

describe('Bot memory through the production Agent loop and local Messages mock', () => {
  it('executes memory_save from an HTTP model response and injects it only into a new Agent', async () => withRuntime(async ({
    ctx, stores, create, memoryText,
  }) => {
    const fact = 'T06_WIRE_MEMORY: The user explicitly prefers answers in Simplified Chinese.';
    let mock!: MockLlmServer;
    await ctx.effect(async () => {
      mock = await startMockLlmServer({
        host: '127.0.0.1', port: 0, randomSeed: 6,
        sequence: ['tool_call_success', 'tool_call_success', 'success', 'success', 'success'],
        apiKey: 't06-local-mock-key', successText: 'T06_MEMORY_LOOP_OK',
        toolName: 'memory_save',
        toolArguments: JSON.stringify({ content: fact, kind: 'preference', tags: ['language'], pinned: true }),
      });
      return () => mock.close();
    });
    vi.stubEnv('DSH_BOT_T06_MOCK_KEY', 't06-local-mock-key');
    await ctx.plugin(deepSeekApiKey, {
      baseURL: `${mock.baseURL}/v1`, apiKeyEnv: 'DSH_BOT_T06_MOCK_KEY',
      thinking: 'disabled', streamIdleTimeoutMs: 2_000,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    }).await();

    const first = await create('alpha');
    const originalSnapshot = await memoryText(first.agent);
    await send(first.agent, 'Please remember my explicit preference for Simplified Chinese.');

    expect(mock.requests.map((request) => [request.path, request.behavior, request.outcome])).toEqual([
      ['/v1/messages', 'tool_call_success', 'completed'], ['/v1/messages', 'tool_call_success', 'completed'],
      ['/v1/messages', 'success', 'completed'],
    ]);
    const saved = stores.memories.listByBot('alpha', { limit: 20 });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ content: fact, kind: 'preference', tags: ['language'], pinned: true,
      source: { sessionId: first.agent.session.id, by: 'model', at: expect.any(Number) } });
    const result = first.agent.session.snapshotEvents().find((event) => event.type === 'tool/result');
    expect(result).toBeDefined();
    if (result?.type !== 'tool/result') throw new Error('Production loop did not record a tool result');
    expect(result.data.message.isError).toBeFalsy();
    expect(JSON.stringify(result.data.message.content)).toContain(saved[0]?.id);
    const toolResults = first.agent.session.snapshotEvents().filter((event) => event.type === 'tool/result');
    expect(toolResults).toHaveLength(2);
    expect(JSON.stringify(toolResults[0])).toContain('deduplicated\\":false');
    expect(JSON.stringify(toolResults[1])).toContain('deduplicated\\":true');
    expect(await memoryText(first.agent)).toBe(originalSnapshot);
    expect(wireSystem(mock.requests[1]?.body)).toEqual(wireSystem(mock.requests[0]?.body));

    const next = await create('alpha');
    expect(await memoryText(next.agent)).toContain(fact);
    await send(next.agent, 'A new session should already know my preference.');
    expect(JSON.stringify(wireSystem(mock.requests[3]?.body))).toContain(fact);
    await send(first.agent, 'Continue the original session with its existing prompt snapshot.');
    expect(wireSystem(mock.requests[4]?.body)).toEqual(wireSystem(mock.requests[0]?.body));
    expect(mock.requests).toHaveLength(5);
    expect(mock.requests.every((request) => request.outcome === 'completed')).toBe(true);
    expect(stores.memories.listByBot('beta', { limit: 20 })).toEqual([]);
  }), 15_000);

  it('isolates Agent tools and snapshots, skips disabled Bots, and releases owned registrations', async () => withRuntime(async ({
    ctx, stores, harness, memoryFor, presets, create, memoryText, execute,
  }) => {
    const alphaMemory = await stores.memories.add({ botId: 'alpha', content: 'Alpha private long-term fact.' });
    await stores.memories.add({ botId: 'beta', content: 'Beta private long-term fact.' });
    const first = await create('alpha');
    const second = await create('alpha');
    const beta = await create('beta');
    const disabled = await create('disabled');
    const readonly = await create('readonly');
    const plain = await harness.create(SessionId('t06-plain'));
    for (const agent of [first.agent, second.agent, beta.agent]) {
      expect(ctx.tools.schemas(agent).map((tool) => tool.name).sort()).toEqual(botToolNames);
      for (const tool of ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('memory_'))) expect(JSON.stringify(tool.parameters)).not.toContain('botId');
    }
    expect(ctx.tools.schemas()).toEqual([]);
    expect(ctx.tools.schemas(disabled.agent).map((tool) => tool.name).sort()).toEqual(['bot_delegate', 'bot_manage', ...routineToolNames].sort());
    expect(ctx.tools.schemas(plain)).toEqual([]);
    for (const agent of [disabled.agent, plain]) expect(await memoryText(agent)).toBeUndefined();
    expect(memoryFor.mock.calls.map(([id]) => id)).not.toContain('disabled');
    expect(ctx.tools.schemas(readonly.agent).map((tool) => tool.name).sort())
      .toEqual(botToolNames.filter((name) => name !== 'memory_save'));
    expect((await execute(readonly.agent, 'memory_save', { content: 'Must not be stored.' })).isError).toBe(true);
    expect(stores.memories.listByBot('readonly', { limit: 20 })).toEqual([]);
    expect(await memoryText(first.agent)).toContain('Alpha private');
    expect(await memoryText(first.agent)).not.toContain('Beta private');
    expect(await memoryText(beta.agent)).toContain('Beta private');
    expect(await memoryText(beta.agent)).not.toContain('Alpha private');
    const listing = await execute(beta.agent, 'memory_list', {});
    expect(listing.isError).toBe(false);
    expect(JSON.stringify(listing.value)).toContain('Beta private');
    expect(JSON.stringify(listing.value)).not.toContain('Alpha private');
    const forget = await execute(beta.agent, 'memory_forget', { id: alphaMemory.id });
    expect(forget.isError).toBe(true);
    expect(stores.memories.listByBot('alpha', { limit: 20 })).toHaveLength(1);

    await first.dispose();
    expect(botContext.getBotBinding(first.agent)).toBeUndefined();
    expect(ctx.tools.schemas(first.agent)).toEqual([]);
    expect(await memoryText(first.agent)).toBeUndefined();
    expect(ctx.tools.schemas(second.agent).map((tool) => tool.name).sort()).toEqual(botToolNames);
    await presets.get('alpha')?.plugin.dispose();
    expect(botContext.getBotBinding(second.agent)).toBeUndefined();
    expect(ctx.tools.schemas(second.agent)).toEqual([]);
    expect(await memoryText(second.agent)).toBeUndefined();
    expect(ctx.tools.schemas(beta.agent).map((tool) => tool.name).sort()).toEqual(botToolNames);
    expect(await memoryText(beta.agent)).toContain('Beta private');
  }));

  it('orders literal memory after persona and before tool guidance, respecting complete prompts', async () => withRuntime(async ({
    ctx, stores, presets, create, assemble, execute,
  }) => {
    const literal = 'The saved template is {{not_a_registered_variable}}.';
    for (const botId of ['alpha', 'beta']) {
      await stores.memories.add({ botId, content: literal });
      const preset = presets.get(botId);
      if (!preset) throw new Error('Missing fixture preset');
      // These are the same public section semantics used by dsh-persona; this
      // test does not import the first-party plugin's implementation internals.
      preset.ctx.effect(() => preset.ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: `${botId} persona`, complete: botId === 'beta',
      }));
      preset.ctx.effect(() => preset.ctx.systemPrompt.section({
        name: 'fixture:tool-guidance', order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
        text: 'Fixture tool guidance.',
      }));
    }
    const normal = await create('alpha');
    const assembly = await assemble(normal.agent);
    const names = assembly.sections.map((section) => section.name);
    expect(names.indexOf(PERSONA_PREFIX_SECTION)).toBeLessThan(names.indexOf('dsh-bot:memory'));
    expect(names.indexOf('dsh-bot:memory')).toBeLessThan(names.indexOf('fixture:tool-guidance'));
    expect(renderPrompt(assembly)).toContain(literal);
    expect(assembly.sections.find((section) => section.name === 'dsh-bot:memory'))
      .toMatchObject({ interpolate: false });

    const complete = await create('beta');
    const completeAssembly = await assemble(complete.agent);
    // Upstream complete:true intentionally suppresses every other section.
    // Memory remains accessible through tools without overriding that policy.
    expect(completeAssembly.sections).toEqual([{ name: PERSONA_PREFIX_SECTION, text: 'beta persona' }]);
    expect(renderPrompt(completeAssembly)).toBe('beta persona');
    expect(ctx.tools.schemas(complete.agent).map((tool) => tool.name).sort()).toEqual(botToolNames);
    const listing = await execute(complete.agent, 'memory_list', {});
    expect(listing.isError).toBe(false);
    expect(JSON.stringify(listing.value)).toContain(literal);
  }));
});
