import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { BotMemoryService, type MemoryOperationExecutor } from '../src/host/memory/service.js';
import { createMemoryTools, MEMORY_TOOL_NAMES } from '../src/host/memory/tools.js';
import { openBotStores } from '../src/host/store.js';
import { MEMORY_MAX_BYTES } from '../src/shared/schema.js';

const isolatedHome = fileURLToPath(new URL('../../../.dsh-dev/', import.meta.url));

async function fixture(ctx: Context, root: string) {
  await ctx.plugin(SystemPrompt, {}).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(Storage).await();
  await ctx.plugin(storageJson, { root }).await();
  await ctx.plugin(storageDomain, { backend: 'json' }).await();
  const stores = await openBotStores(ctx);
  for (const id of ['alpha', 'beta']) await stores.bots.create({ id, name: id });
  let owner!: Context;
  await ctx.plugin({
    inject: ['tools', 'systemPrompt'],
    apply(injected: Context) { owner = injected; },
  }).await();
  let sequence = 0;
  const create = (botId: string, options: { execute?: MemoryOperationExecutor; install?: boolean } = {}) => {
    // Only Agent identity/session provenance are fixture values. Scope lookup,
    // tool dispatch/output validation and JSON storage are production services.
    const payload = { id: `memory-agent-${++sequence}`, ctx: owner, session: { id: `memory-session-${sequence}` } };
    const agent = payload as Agent;
    const scope = createScope(owner, agent);
    payload.ctx = scope.ctx;
    const memory = new BotMemoryService(stores.memories, botId, options.execute);
    const definitions = createMemoryTools(memory, agent);
    if (options.install !== false) {
      for (const tool of definitions) agent.ctx.effect(() => agent.ctx.tools.register(tool));
    }
    return { agent, scope, memory, definitions };
  };
  const execute = (agent: Agent | undefined, name: string, args: unknown, signal = new AbortController().signal) => ctx.tools.execute({
    callId: ToolCallId(`memory-call-${++sequence}`), name, arguments: args, signal,
    ...(agent === undefined ? {} : { agent }),
  });
  return { ctx, stores, create, execute };
}

async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  await mkdir(isolatedHome, { recursive: true });
  const root = await mkdtemp(join(isolatedHome, 't06-memory-tools-'));
  const ctx = new Context();
  try { await run(await fixture(ctx, root)); }
  finally {
    try { await ctx.fiber.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

function successful(result: ToolExecutionResult) {
  expect(result.isError, JSON.stringify(result)).toBe(false);
  if (result.isError) throw new Error(result.error.message);
  return result.value;
}

function failure(result: ToolExecutionResult, code?: string) {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  if (!result.isError) throw new Error('Expected a rejected tool call');
  expect(result).not.toHaveProperty('value');
  if (code !== undefined) expect(result.error.info?.code).toBe(code);
  return result.error;
}

describe('Memory tools through published native ToolRuntime and JSON storage', () => {
  it('returns canonical deduplication metadata and a structured secret rejection without echoing the input',
    async () => withFixture(async ({ create, execute, stores }) => {
    const alpha = create('alpha');
    const original = successful(await execute(alpha.agent, 'bot_memory_save', { content: 'Ｆａｃｔ  one', tags: ['one'] })) as { id: string };
    const duplicate = await execute(alpha.agent, 'bot_memory_save', { content: 'Fact\n one', tags: ['two'], pinned: true });
    expect(successful(duplicate)).toEqual({ id: original.id, deduplicated: true });
    expect(duplicate.content).toEqual([{ type: 'text', text: JSON.stringify({ id: original.id, deduplicated: true }) }]);
    const before = stores.memories.listByBot('alpha', { limit: 20 });
    expect(before).toMatchObject([{ id: original.id, tags: ['one', 'two'], pinned: true }]);
    const token = `ghp_${'t'.repeat(36)}`;
    const rejected = await execute(alpha.agent, 'bot_memory_save', { content: `Remember ${token}` });
    expect(failure(rejected, 'memory/rejected').message).toContain('memory/rejected');
    expect(JSON.stringify(rejected)).not.toContain(token);
    expect(stores.memories.listByBot('alpha', { limit: 20 })).toEqual(before);
  }));
  it('isolates save/search/list/forget and renders validated canonical values with trusted session provenance',
    async () => withFixture(async ({ ctx, stores, create, execute }) => {
    const alpha = create('alpha');
    const beta = create('beta');
    for (const tool of ctx.tools.schemas(alpha.agent)) {
      expect(Object.keys(tool.parameters.properties ?? {})).not.toContain('botId');
      expect(Object.keys(tool.parameters.properties ?? {})).not.toContain('source');
    }
    expect(alpha.definitions.find((tool) => tool.name === 'bot_memory_save')?.description).toMatch(/preferences.*durable facts.*one-off.*secrets.*API keys/);
    const beforeSave = Date.now();
    const saved = await execute(alpha.agent, 'bot_memory_save', {
      content: 'The user prefers jasmine tea.', kind: 'preference', tags: ['drink'], pinned: true,
    });
    const value = successful(saved);
    expect(value).toMatchObject({ deduplicated: false });
    const { id } = value as { id: string; deduplicated: boolean };
    expect(typeof id).toBe('string');
    expect(saved.content).toEqual([{ type: 'text', text: JSON.stringify(value) }]);
    const alphaRows = stores.memories.listByBot('alpha', { limit: 20 });
    expect(alphaRows).toHaveLength(1);
    expect(alphaRows[0]).toMatchObject({
      id, botId: 'alpha', content: 'The user prefers jasmine tea.', kind: 'preference', tags: ['drink'], pinned: true,
      source: { sessionId: alpha.agent.session.id, by: 'model' },
    });
    expect(alphaRows[0]?.source?.at).toBeGreaterThanOrEqual(beforeSave);
    expect(alphaRows[0]?.source?.at).toBeLessThanOrEqual(Date.now());

    const { id: betaId } = successful(await execute(beta.agent, 'bot_memory_save', { content: 'The user prefers black tea.' })) as { id: string };
    const betaRows = stores.memories.listByBot('beta', { limit: 20 });
    expect(betaRows[0]).toMatchObject({ id: betaId, kind: 'note', tags: [], pinned: false, source: { sessionId: beta.agent.session.id } });
    for (const [name, args] of [['bot_memory_list', { tag: 'drink', pinned: true }], ['bot_memory_search', { query: 'TEA' }]] as const) {
      const result = await execute(alpha.agent, name, args);
      expect(successful(result)).toEqual(alphaRows);
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(alphaRows) }]);
      expect(JSON.stringify(result)).not.toContain('black tea');
    }
    expect(successful(await execute(alpha.agent, 'bot_memory_list', { pinned: false }))).toEqual([]);
    expect(successful(await execute(beta.agent, 'bot_memory_search', { query: 'jasmine' }))).toEqual([]);
    expect(failure(await execute(alpha.agent, 'bot_memory_forget', { id: betaId })).message).toBe('Memory was not found for this bot');
    expect(stores.memories.listByBot('beta', { limit: 20 })).toEqual(betaRows);
    const deleted = await execute(alpha.agent, 'bot_memory_forget', { id });
    expect(successful(deleted)).toBeNull();
    expect(deleted.content).toEqual([{ type: 'text',
      text: 'Stopped using this memory. Strong forgetting is pending; affected sessions remain blocked.' }]);
    expect(stores.memories.listByBot('alpha', { limit: 20 })).toEqual([]);
    expect(failure(await execute(alpha.agent, 'bot_memory_forget', { id })).message).toBe('Memory was not found for this bot');
  }));

  it('rejects forged identity/provenance and invalid or unknown arguments without changing storage',
    async () => withFixture(async ({ stores, create, execute }) => {
    const alpha = create('alpha');
    const { id } = successful(await execute(alpha.agent, 'bot_memory_save', { content: 'Keep this memory.' })) as { id: string };
    const original = stores.memories.listByBot('alpha', { limit: 20 });
    const invalid: [string, unknown][] = [
      ['bot_memory_save', { content: 'Forged Bot', botId: 'beta' }],
      ['bot_memory_save', { content: 'Forged source', source: { sessionId: 'forged', by: 'user', at: 1 } }],
      ['bot_memory_save', { content: 'Unknown property', unknown: true }],
      ['bot_memory_save', { content: '' }], ['bot_memory_save', { content: '   ' }], ['bot_memory_save', {}],
      ['bot_memory_save', { content: 'Wrong kind', kind: 'secret' }],
      ['bot_memory_save', { content: 'Empty tag', tags: [' '] }],
      ['bot_memory_save', { content: 'Wrong pin type', pinned: 'true' }],
      ['bot_memory_search', { query: 'Keep', botId: 'beta' }], ['bot_memory_search', {}],
      ['bot_memory_search', { query: 1 }], ['bot_memory_search', { query: 'Keep', limit: 0 }],
      ['bot_memory_search', { query: 'Keep', limit: 201 }], ['bot_memory_search', { query: 'Keep', limit: 1.5 }],
      ['bot_memory_list', { botId: 'beta' }], ['bot_memory_list', { source: {} }], ['bot_memory_list', { tag: '' }],
      ['bot_memory_list', { limit: -1 }], ['bot_memory_list', { limit: '2' }], ['bot_memory_list', { pinned: 'true' }],
      ['bot_memory_forget', { id, botId: 'beta' }], ['bot_memory_forget', { id, unknown: true }],
      ['bot_memory_forget', { id: '' }], ['bot_memory_forget', {}],
    ];
    for (const [name, args] of invalid) {
      expect(failure(await execute(alpha.agent, name, args)).message).toMatch(/"code":|^invalid arguments:/);
      expect(stores.memories.listByBot('alpha', { limit: 20 })).toEqual(original);
      expect(stores.memories.listByBot('beta', { limit: 20 })).toEqual([]);
    }
    // Empty search retains the Store's documented unfiltered-list semantics.
    expect(successful(await execute(alpha.agent, 'bot_memory_search', { query: '' }))).toEqual(original);
  }));

  it('accepts exactly 2 KiB and rejects excess UTF-8 bytes before a write', async () => withFixture(async ({ stores, create, execute }) => {
    const alpha = create('alpha');
    const ascii = 'a'.repeat(MEMORY_MAX_BYTES);
    const unicode = `${'界'.repeat(682)}ab`;
    expect(Buffer.byteLength(unicode)).toBe(MEMORY_MAX_BYTES);
    for (const content of [ascii, unicode]) successful(await execute(alpha.agent, 'bot_memory_save', { content }));
    const original = stores.memories.listByBot('alpha', { limit: 20 });
    for (const content of [`${ascii}a`, `${unicode}界`, '🤖'.repeat(513)]) {
      expect(failure(await execute(alpha.agent, 'bot_memory_save', { content })).message).toContain('Memory exceeds 2 KiB');
      expect(stores.memories.listByBot('alpha', { limit: 20 })).toEqual(original);
    }
  }));

  it('applies default and requested result limits to both list and search', async () => withFixture(async ({ stores, create, execute }) => {
    const alpha = create('alpha');
    for (let index = 0; index < 23; index++) {
      await stores.memories.add({ botId: 'alpha', content: `A durable preference ${index}`, tags: ['preference'] });
    }
    for (const [name, base] of [['bot_memory_list', {}], ['bot_memory_search', { query: 'preference' }]] as const) {
      expect(successful(await execute(alpha.agent, name, base))).toHaveLength(20);
      expect(successful(await execute(alpha.agent, name, { ...base, limit: 2 }))).toHaveLength(2);
      expect(successful(await execute(alpha.agent, name, { ...base, limit: 200 }))).toHaveLength(23);
    }
  }));

  it('rejects cancellation before dispatch and after queue admission without saving', async () => withFixture(async ({ stores, create, execute }) => {
    const alpha = create('alpha');
    failure(await execute(alpha.agent, 'bot_memory_save', { content: 'Already cancelled' }, AbortSignal.abort()), 'ABORTED_BEFORE_DISPATCH');
    expect(stores.memories.listByBot('alpha', { limit: 20 })).toEqual([]);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const queued = create('alpha', { execute: async (operation) => { entered(); await wait; return operation(); } });
    const controller = new AbortController();
    const pending = execute(queued.agent, 'bot_memory_save', { content: 'Cancelled while waiting' }, controller.signal);
    await started;
    controller.abort();
    release();
    expect(failure(await pending).message).toMatch(/abort/i);
    expect(stores.memories.listByBot('alpha', { limit: 20 })).toEqual([]);
  }));

  it('checks the owning Agent even if a definition is registered in another scope, and disposes each scope independently',
    async () => withFixture(async ({ ctx, stores, create, execute }) => {
    const alpha = create('alpha');
    const beta = create('beta');
    const misplaced = create('beta', { install: false });
    for (const tool of alpha.definitions) misplaced.agent.ctx.effect(() => misplaced.agent.ctx.tools.register(tool));
    expect(failure(await execute(misplaced.agent, 'bot_memory_save', { content: 'Attempt through the wrong owner' })).message)
      .toBe('Memory tool belongs to another agent');
    failure(await execute(undefined, 'bot_memory_save', { content: 'No Agent scope' }), 'UNKNOWN_TOOL');
    expect(stores.memories.listByBot('alpha', { limit: 20 })).toEqual([]);
    expect(stores.memories.listByBot('beta', { limit: 20 })).toEqual([]);
    expect(ctx.tools.schemas()).toEqual([]);
    expect(ctx.tools.schemas(alpha.agent).map((tool) => tool.name).sort()).toEqual([...MEMORY_TOOL_NAMES].sort());
    await alpha.scope.dispose();
    await alpha.scope.dispose();
    expect(ctx.tools.schemas(alpha.agent)).toEqual([]);
    failure(await execute(alpha.agent, 'bot_memory_save', { content: 'After unload' }), 'UNKNOWN_TOOL');
    expect(ctx.tools.schemas(beta.agent).map((tool) => tool.name).sort()).toEqual([...MEMORY_TOOL_NAMES].sort());
    successful(await execute(beta.agent, 'bot_memory_save', { content: 'Still active in Beta' }));
    expect(stores.memories.listByBot('alpha', { limit: 20 })).toEqual([]);
    expect(stores.memories.listByBot('beta', { limit: 20 })).toHaveLength(1);
  }));
});
