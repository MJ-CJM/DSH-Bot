import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { bindScopeParent, createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { describe, expect, it, vi } from 'vitest';
import * as botContext from '../lib/host/bot-context.js';
import { Config as RegistryConfig } from '../lib/host/registry.js';
import { executionDomain, openAutomationStores } from '../lib/host/automation/store.js';
import { registerAutomationGuard } from '../lib/host/delegate/guard.js';
import { runRecordSchema, type RunRequest } from '../lib/shared/automation.js';
import { botCreateSchema, botSchema } from '../lib/shared/schema.js';

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const home = fileURLToPath(new URL('../../../.dsh-dev/p2/t15/', import.meta.url));
  await mkdir(home, { recursive: true }); const root = await mkdtemp(join(home, 'delegate-')); const ctx = new Context();
  try { await test(await setup(ctx, root)); } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
}
async function setup(ctx: Context, root: string) {
  await ctx.plugin(SystemPrompt, {}).await(); await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  await ctx.plugin(Storage).await(); await ctx.plugin(storageJson, { root }).await(); await ctx.plugin(storageDomain, { backend: 'json' }).await();
  const bots = new Map(['alpha', 'beta', 'denied'].map(id => [id, botSchema.parse({
    ...botCreateSchema.parse({ id, name: id, tools: { deny: id === 'denied' ? ['bot_delegate'] : [] }, memory: { enabled: false, injectLimit: 20 } }),
    createdAt: 1, updatedAt: 1, schemaVersion: 1,
  })]));
  const get = async (id: string) => { const bot = bots.get(id); if (!bot) throw new Error('missing'); return structuredClone(bot); };
  ctx.provide('dshBots', { config: RegistryConfig({}), presetBot: (id: string) => bots.get(id), get,
    status: async () => [...bots.values()].map(bot => ({ id: bot.id, presetId: `custom-${bot.id}`, preset: { state: 'ok' } })),
    ensureHome: async () => ({ path: join(root, 'bots/alpha/home') }) } as unknown as Context['dshBots']);
  ctx.provide('llm', {} as Context['llm']); ctx.provide('agents', {} as Context['agents']);
  const resolveBot = async (id: string) => ({ bot: await get(id), presetId: `bot-${id}` });
  const stores = await openAutomationStores(ctx, { resolveBot });
  ctx.provide('dshBotAutomationStores', stores);
  const dispose = vi.fn(async () => {});
  let settle!: (value: { output: []; stopReason: 'completed' }) => void;
  const result = new Promise<{ output: []; stopReason: 'completed' }>(accept => { settle = accept; });
  const provider = { inheritsParentContext: false, capabilities: { agentPreset: true, depthLimit: true }, prepareContinuable: async () => ({}) };
  const startActivation = vi.fn(async (_spec: unknown) => ({ childId: SessionId('native-child'), result, dispose }));
  ctx.provide('subagents', { getProvider: () => provider, startActivation } as unknown as Context['subagents']);
  registerAutomationGuard(ctx, stores.runs);
  let owner!: Context;
  await ctx.plugin({ inject: ['tools', 'systemPrompt', 'dshBots', 'agents', 'llm', 'dshBotAutomationStores', 'subagents'],
    apply(value: Context) { owner = value; } }).await();
  const create = async (botId = 'alpha', sessionId = `session-${randomUUID()}`) => {
    const key = {}; const preset = createScope(owner, key); const plugin = preset.ctx.plugin(botContext, { botId }); await plugin.await();
    const id = SessionId(sessionId); const session = Session.create(id, undefined, { version: 4, id, createdAt: Date.now(), isSeeded: false });
    const payload = { id, session, ctx: owner }; const agent = payload as Agent; bindScopeParent(agent, key);
    const scope = createScope(owner, agent); payload.ctx = scope.ctx;
    await ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' });
    session.append('turn/start', { turn: 0 }); session.append('step/start', { turn: 0, step: 0 });
    return { agent, session, scope, plugin };
  };
  const execute = (agent: Agent, args: unknown, callId = randomUUID(), name = 'bot_delegate') => ctx.tools.execute({
    agent, name, arguments: args, callId: ToolCallId(callId), signal: new AbortController().signal,
  });
  return { ctx, bots, stores, create, execute, startActivation, dispose, provider, settle };
}

const args = { targetBotId: 'beta', task: 'Task only', title: 'Research' };

describe('native bot delegation wrapper (native service double, real ToolRuntime/approval)', () => {
  it('denied approval starts nothing and records bilingual full task approval', async () => fixture(async f => {
    const origin = await f.create(); const approvals: unknown[] = [];
    f.ctx.on('approval/request', async request => { approvals.push(request.displayReason); return 'rejected'; });
    expect((await f.execute(origin.agent, args)).isError).toBe(true);
    expect(f.startActivation).not.toHaveBeenCalled(); expect(f.stores.runs.list()).toEqual([]);
    expect(JSON.stringify(approvals)).toContain('Task only'); expect(JSON.stringify(approvals)).toContain('委派给');
    expect(origin.session.snapshotEvents().filter(e => e.type.startsWith('approval/')).map(e => e.type))
      .toEqual(['approval/asked', 'approval/decided']);
  }));
  it('uses exact target preset, native parent delivery and only task; dedupes live invocation', async () => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const origin = await f.create();
    origin.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'PARENT_PRIVATE_HISTORY' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    const callId = randomUUID(); const first = await f.execute(origin.agent, args, callId);
    const second = await f.execute(origin.agent, args, callId);
    expect(first).toMatchObject({ isError: false, value: { childId: 'native-child', status: 'accepted' } });
    expect(second).toMatchObject({ value: first.isError ? undefined : first.value });
    expect(f.startActivation).toHaveBeenCalledOnce(); expect(f.stores.runs.list()).toEqual([]);
    expect(f.startActivation.mock.calls[0]?.[0]).toMatchObject({ provider: 'spawn', delivery: 'parent', label: 'Research',
      request: { parent: origin.agent, agentPreset: 'custom-beta', prompt: [{ type: 'text', text: 'Task only' }] } });
    expect((await f.execute(origin.agent, { ...args, task: 'changed' }, callId)).isError).toBe(true);
    origin.session.append('step/start', { turn: 0, step: 1 });
    await f.execute(origin.agent, args, callId); expect(f.startActivation).toHaveBeenCalledTimes(2);
  }));
  it('supports self delegation; rejects forged identity, missing Bot, stale origin and hidden tool', async () => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const origin = await f.create();
    expect((await f.execute(origin.agent, { ...args, targetBotId: 'alpha' })).isError).toBe(false);
    for (const extra of [{ originBotId: 'beta' }, { originSessionId: 'forged' }, { depth: 0 }, { operationId: randomUUID() }]) {
      expect((await f.execute(origin.agent, { ...args, ...extra })).isError).toBe(true);
    }
    expect((await f.execute(origin.agent, { ...args, targetBotId: 'absent' })).isError).toBe(true);
    const alpha = f.bots.get('alpha'); if (!alpha) throw new Error('Missing bot');
    f.bots.set('alpha', { ...alpha, createdAt: 2, updatedAt: 2 });
    expect((await f.execute(origin.agent, args)).isError).toBe(true);
    const denied = await f.create('denied'); expect(f.ctx.tools.get('bot_delegate', denied.agent)).toBeUndefined();
    expect(f.startActivation).toHaveBeenCalledOnce();
  }));
  it.each(['createdAt', 'updatedAt'] as const)('rejects target %s change during approval', async field => fixture(async f => {
    const origin = await f.create(); f.ctx.on('approval/request', async () => {
      const beta = f.bots.get('beta'); if (!beta) throw new Error('missing');
      f.bots.set('beta', { ...beta, [field]: 2 }); return 'allowed-once';
    });
    expect((await f.execute(origin.agent, args)).isError).toBe(true); expect(f.startActivation).not.toHaveBeenCalled();
  }));
  it.each(['subagent-settled', 'agent-message', 'schedule', 'dsh-bot-delegate'])('blocks %s notices until human input', async kind => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const origin = await f.create();
    // Provenance is Host-owned; test each source without pretending this is native delivery.
    const notice = createUserMessage({ content: [{ type: 'text', text: 'notice' }], source: { kind: 'user' } });
    const sourced = Object.assign({}, notice, { source: { kind } }) as typeof notice;
    origin.session.append('user/message', sourced, { surfaceOp: 'append' });
    for (const ambient of ['agent-instructions', 'runtime-context', 'time-context', 'tmux-context']) {
      origin.session.append('user/message', Object.assign({}, notice, { source: { kind: ambient } }) as typeof notice, { surfaceOp: 'append' });
    }
    expect((await f.execute(origin.agent, args)).isError).toBe(true); expect(f.startActivation).not.toHaveBeenCalled();
    origin.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'human' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    origin.session.append('user/message', Object.assign({}, notice, { source: { kind: 'time-context' } }) as typeof notice, { surfaceOp: 'append' });
    expect((await f.execute(origin.agent, args)).isError).toBe(false);
  }));
  it('refuses inherited-context provider and native start failures without fallback', async () => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const origin = await f.create();
    f.provider.inheritsParentContext = true;
    expect((await f.execute(origin.agent, args)).isError).toBe(true); expect(f.startActivation).not.toHaveBeenCalled();
    f.provider.inheritsParentContext = false; f.startActivation.mockRejectedValue(new Error('native unavailable'));
    expect((await f.execute(origin.agent, args)).isError).toBe(true); expect(f.stores.runs.list()).toEqual([]);
  }));
  it('unload unregisters tool, aborts native signal and disposes outstanding activation', async () => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const origin = await f.create();
    await f.execute(origin.agent, args); await origin.plugin.dispose();
    expect(f.ctx.tools.get('bot_delegate', origin.agent)).toBeUndefined();
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
    const spec = f.startActivation.mock.calls[0]?.[0] as { signal: AbortSignal };
    expect(spec.signal.aborted).toBe(true);
  }));
  it('cancels startup on unload without leaving a child or local run', async () => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const origin = await f.create();
    f.startActivation.mockImplementation(async spec => new Promise((_accept, reject) => {
      (spec as { signal: AbortSignal }).signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const request = f.execute(origin.agent, args);
    await vi.waitFor(() => expect(f.startActivation).toHaveBeenCalledOnce());
    const closed = origin.plugin.dispose();
    expect((await request).isError).toBe(true); await closed;
    expect(f.stores.runs.list()).toEqual([]); expect(f.dispose).not.toHaveBeenCalled();
  }));
  it('keeps historical delegate report readable but rejects new legacy execution', async () => fixture(async f => {
    await f.stores.close();
    const id = randomUUID();
    const legacy = runRecordSchema.parse({ id, schemaVersion: 1, revision: 1, trigger: 'delegate', operationId: randomUUID(),
      dedupeKey: 'historical', botId: 'beta', botCreatedAt: 1, originBotId: 'alpha', originBotCreatedAt: 1,
      originSessionId: 'parent', sessionId: 'old-child', requestId: randomUUID(),
      snapshot: { title: 'Old task', prompt: 'Old task', timeZone: 'UTC', presetId: 'bot-beta', botUpdatedAt: 1 },
      requestedAt: 1, updatedAt: 2, endedAt: 2, status: 'cancelled', step: 'settled', decision: 'run', slotHeld: false, depth: 1,
      report: { state: 'pending', originSessionId: 'parent', attempts: 0 },
    });
    const domain = await f.ctx.storageDomain.open(executionDomain);
    await domain.table('runs').put(id, legacy); await domain.close();
    const reopened = await openAutomationStores(f.ctx, { resolveBot: async () => { throw new Error('must not resolve'); } });
    expect(reopened.runs.get(id)).toEqual(legacy);
    await expect(reopened.runs.enqueue({ trigger: 'delegate' } as unknown as RunRequest)).rejects.toThrow();
    expect(reopened.runs.get(id)).toEqual(legacy); await reopened.close();
  }));
  it('leaves settled teardown to native manager', async () => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const origin = await f.create();
    await f.execute(origin.agent, args); f.settle({ output: [], stopReason: 'completed' });
    await Promise.resolve(); await Promise.resolve(); await origin.plugin.dispose();
    expect(f.dispose).not.toHaveBeenCalled();
  }));
});
