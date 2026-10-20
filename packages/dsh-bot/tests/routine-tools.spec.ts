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
import { describe, expect, it } from 'vitest';
import * as botContext from '../lib/host/bot-context.js';
import { Config as RegistryConfig } from '../lib/host/registry.js';
import { openAutomationStores } from '../lib/host/automation/store.js';
import { registerAutomationGuard } from '../lib/host/delegate/guard.js';
import { botCreateSchema, botSchema } from '../lib/shared/schema.js';

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const home = fileURLToPath(new URL('../../../.dsh-dev/p2/t16/', import.meta.url));
  await mkdir(home, { recursive: true }); const root = await mkdtemp(join(home, 'delegate-')); const ctx = new Context();
  try { await test(await setup(ctx, root)); } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
}
async function setup(ctx: Context, root: string) {
  await ctx.plugin(SystemPrompt, {}).await(); await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  await ctx.plugin(Storage).await(); await ctx.plugin(storageJson, { root }).await(); await ctx.plugin(storageDomain, { backend: 'json' }).await();
  const bots = new Map(['alpha', 'beta', 'denied'].map(id => [id, botSchema.parse({
    ...botCreateSchema.parse({ id, name: id, tools: { deny: id === 'denied' ? ['routine_create', 'routine_list', 'routine_update', 'routine_delete', 'routine_run_now'] : [] }, memory: { enabled: false, injectLimit: 20 } }),
    createdAt: 1, updatedAt: 1, schemaVersion: 1,
  })]));
  const get = async (id: string) => { const bot = bots.get(id); if (!bot) throw new Error('missing'); return structuredClone(bot); };
  ctx.provide('dshBots', { config: RegistryConfig({}), presetBot: (id: string) => bots.get(id), get,
    ensureHome: async () => ({ path: join(root, 'bots/alpha/home') }) } as unknown as Context['dshBots']);
  ctx.provide('llm', {} as Context['llm']); ctx.provide('agents', {} as Context['agents']);
  const resolveBot = async (id: string) => ({ bot: await get(id), presetId: `bot-${id}` });
  const stores = await openAutomationStores(ctx, { ownerId: 'test-owner', assertOwner() {}, resolveBot });
  ctx.provide('dshBotAutomationStores', stores);
  ctx.provide('dshBotDispatcher', { runNow: (id: string, operationId: string) => stores.runs.enqueue({ trigger: 'manual', routineId: id, operationId }) } as Context['dshBotDispatcher']);
  registerAutomationGuard(ctx, stores.runs);
  let owner!: Context;
  await ctx.plugin({ inject: ['tools', 'systemPrompt', 'dshBots', 'agents', 'llm', 'dshBotAutomationStores', 'dshBotDispatcher'],
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
  const execute = (agent: Agent, args: unknown, callId = randomUUID(), name = 'routine_list') => ctx.tools.execute({
    agent, name, arguments: args, callId: ToolCallId(callId), signal: new AbortController().signal,
  });
  return { ctx, bots, stores, create, execute };
}
const input = { botId: 'beta', title: 'Daily review', prompt: 'Review the project', rule: { kind: 'every' as const, everySeconds: 60 }, timeZone: 'UTC', enabled: false };
describe('formal routine tools with real ToolRuntime, native approval and JSON persistence', () => {
  it('rejects all four writes before mutation or run creation; list needs no approval', async () => fixture(async f => {
    const agent = (await f.create()).agent;
    const routine = await f.stores.routines.create(input);
    const approvals: unknown[] = [];
    f.ctx.on('approval/request', async request => { approvals.push(request.displayReason); return 'rejected'; });
    const calls = [
      ['routine_create', { input }],
      ['routine_update', { id: routine.id, patch: { prompt: 'Complete changed task' }, expectedRevision: routine.revision }],
      ['routine_delete', { id: routine.id, expectedRevision: routine.revision }],
      ['routine_run_now', { id: routine.id }],
    ] as const;
    for (const [name, args] of calls) expect((await f.execute(agent, args, randomUUID(), name)).isError).toBe(true);
    expect(approvals).toHaveLength(4); expect(JSON.stringify(approvals)).toContain('Complete changed task');
    expect(JSON.stringify(approvals)).toContain('完整目标');
    expect(f.stores.routines.list()).toEqual([routine]); expect(f.stores.runs.list()).toEqual([]);
    expect((await f.execute(agent, {})).isError).toBe(false); expect(approvals).toHaveLength(4);
  }));
  it('creates, lists, CAS edits, runs once per invocation and deletes while preserving history', async () => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const origin = await f.create();
    expect((await f.execute(origin.agent, { input }, randomUUID(), 'routine_create')).isError).toBe(false);
    const record = f.stores.routines.list()[0]; if (!record) throw new Error('Missing routine');
    expect(record.createdBy).toEqual({ kind: 'model', sessionId: origin.session.id });
    const update = { id: record.id, patch: { title: 'Edited' }, expectedRevision: record.revision };
    expect((await f.execute(origin.agent, update, randomUUID(), 'routine_update')).isError).toBe(false);
    expect((await f.execute(origin.agent, update, randomUUID(), 'routine_update')).isError).toBe(true);
    const callId = randomUUID();
    for (let i = 0; i < 2; i++) expect((await f.execute(origin.agent, { id: record.id }, callId, 'routine_run_now')).isError).toBe(false);
    expect(f.stores.runs.list()).toHaveLength(1);
    expect((await f.execute(origin.agent, { id: record.id, expectedRevision: record.revision }, randomUUID(), 'routine_delete')).isError).toBe(true);
    expect((await f.execute(origin.agent, { id: record.id, expectedRevision: f.stores.routines.get(record.id).revision }, randomUUID(), 'routine_delete')).isError).toBe(false);
    expect(f.stores.routines.list()).toEqual([]); expect(f.stores.runs.list()).toHaveLength(1);
  }));
  it('rejects invalid rules, forged arguments, stale identities; obeys local deny and unload', async () => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const origin = await f.create();
    for (const args of [{ input: { ...input, rule: { kind: 'every', everySeconds: 59 } } }, { input, action: 'routine_list' }, { input, originBotId: 'beta' }]) {
      expect((await f.execute(origin.agent, args, randomUUID(), 'routine_create')).isError).toBe(true);
    }
    const denied = await f.create('denied');
    for (const name of ['create', 'list', 'update', 'delete', 'run_now']) expect(f.ctx.tools.get(`routine_${name}`, denied.agent)).toBeUndefined();
    const bot = f.bots.get('alpha'); if (!bot) throw new Error('Missing Bot');
    f.bots.set('alpha', { ...bot, createdAt: 2, updatedAt: 2 });
    expect((await f.execute(origin.agent, { input }, randomUUID(), 'routine_create')).isError).toBe(true);
    await origin.plugin.dispose(); expect(f.ctx.tools.get('routine_create', origin.agent)).toBeUndefined();
    expect(f.stores.routines.list()).toEqual([]);
  }));
  it('blocks background and report-triggered writes while permitting list', async () => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const routine = await f.stores.routines.create(input);
    const run = await f.stores.runs.enqueue({ trigger: 'manual', routineId: routine.id, operationId: randomUUID() });
    const background = await f.create('beta', run.sessionId);
    expect((await f.execute(background.agent, { input }, randomUUID(), 'routine_create')).isError).toBe(true);
    expect((await f.execute(background.agent, {})).isError).toBe(false);
    const origin = await f.create();
    origin.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Report' }], source: { kind: 'dsh-bot-delegate', form: 'notice', summary: 'Report', runId: run.id, sourceSessionId: run.sessionId } }), { surfaceOp: 'append' });
    expect((await f.execute(origin.agent, { id: routine.id }, randomUUID(), 'routine_run_now')).isError).toBe(true);
    expect(f.stores.runs.list()).toHaveLength(1);
  }));
});
