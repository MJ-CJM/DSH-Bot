import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm';
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
import { openAutomationStores } from '../lib/host/automation/store.js';
import { registerAutomationGuard } from '../lib/host/delegate/guard.js';
import { DelegateReporter, reportMessage, type ReportTarget } from '../lib/host/delegate/reporter.js';
import { delegateOperationId } from '../lib/host/delegate/tool.js';
import { dshReportRuntime } from '../lib/host/delegate/runtime.js';
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
    ensureHome: async () => ({ path: join(root, 'bots/alpha/home') }) } as unknown as Context['dshBots']);
  ctx.provide('llm', {} as Context['llm']); ctx.provide('agents', {} as Context['agents']);
  const resolveBot = async (id: string) => ({ bot: await get(id), presetId: `bot-${id}` });
  const stores = await openAutomationStores(ctx, { resolveBot });
  ctx.provide('dshBotAutomationStores', stores);
  ctx.provide('dshBotSubmitter', { submit: (request: Parameters<typeof stores.runs.enqueue>[0]) => stores.runs.enqueue(request) } as Context['dshBotSubmitter']);
  registerAutomationGuard(ctx, stores.runs);
  let owner!: Context;
  await ctx.plugin({ inject: ['tools', 'systemPrompt', 'dshBots', 'agents', 'llm', 'dshBotAutomationStores', 'dshBotSubmitter'],
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
  const terminal = async (status: 'succeeded' | 'failed' = 'succeeded', summary = 'Target final response') => {
    const queued = await stores.runs.enqueue({ trigger: 'delegate', botId: 'beta', operationId: randomUUID(), title: 'Task', prompt: 'Task only',
      originBotId: 'alpha', originBotCreatedAt: 1, originSessionId: 'origin' });
    const reserved = await stores.runs.reserve(queued.id);
    return stores.runs.transition(reserved.id, status, reserved.revision, { summary }, true);
  };
  return { ctx, bots, stores, create, execute, terminal };
}
const args = { targetBotId: 'beta', task: 'Task only', title: 'Research' };

describe('bot_delegate with published tools, approval, Bot binding and JSON store', () => {
  it('denied approval leaves no run; approval shows target and full task in both languages', async () => fixture(async f => {
    const origin = await f.create(); const approvals: unknown[] = [];
    f.ctx.on('approval/request', async request => { approvals.push({ reason: request.reason, displayReason: request.displayReason }); return 'rejected'; });
    const result = await f.execute(origin.agent, args);
    expect(result.isError).toBe(true); expect(f.stores.runs.list()).toEqual([]);
    expect(approvals).toHaveLength(1); expect(JSON.stringify(approvals)).toContain('Task only');
    const audit = origin.session.snapshotEvents().filter(e => e.type.startsWith('approval/'));
    expect(audit.map(e => e.type)).toEqual(['approval/asked', 'approval/decided']);
    expect(JSON.stringify(approvals)).toContain('委派给'); expect(JSON.stringify(approvals)).toContain('beta');
  }));
  it('returns queued IDs immediately, binds provenance, sends only task and dedupes a repeated invocation', async () => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const origin = await f.create();
    origin.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'PARENT_PRIVATE_HISTORY' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    const callId = randomUUID(); const first = await f.execute(origin.agent, args, callId);
    const second = await f.execute(origin.agent, args, callId);
    expect(first.isError, JSON.stringify(first)).toBe(false); expect(second).toMatchObject({ value: first.isError ? undefined : first.value });
    const run = f.stores.runs.list()[0]; if (!run) throw new Error('Missing run');
    expect(run).toMatchObject({ status: 'queued', depth: 1, originBotId: 'alpha', originBotCreatedAt: 1,
      originSessionId: origin.session.id, snapshot: { prompt: 'Task only', presetId: 'bot-beta' } });
    expect(JSON.stringify(run)).not.toContain('PARENT_PRIVATE_HISTORY'); expect(f.stores.runs.list()).toHaveLength(1);
    origin.session.append('step/start', { turn: 0, step: 1 });
    await f.execute(origin.agent, args, callId); expect(f.stores.runs.list()).toHaveLength(2);
  }));
  it('supports self delegation; rejects forged identity, unknown target, stale binding and denied local tool', async () => fixture(async f => {
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
    expect(f.stores.runs.list()).toHaveLength(1);
  }));
  it('blocks background sessions and report-induced turns', async () => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const run = await f.terminal();
    const target = await f.create('beta', run.sessionId);
    expect((await f.execute(target.agent, args)).isError).toBe(true);
    const origin = await f.create();
    const notice = reportMessage(run, 4000);
    origin.session.append('user/message', { ...notice, id: MessageId(notice.id) }, { surfaceOp: 'append' });
    expect((await f.execute(origin.agent, args)).isError).toBe(true);
    origin.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'A new human task' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    expect((await f.execute(origin.agent, args)).isError).toBe(false);
    await origin.plugin.dispose(); expect(f.ctx.tools.get('bot_delegate', origin.agent)).toBeUndefined();
  }));
  it('operation identity includes session, persisted step and root call', () => {
    const id = delegateOperationId('s', 'c', 2, 'root');
    expect(delegateOperationId('s', 'c', 2, 'root')).toBe(id);
    expect(delegateOperationId('s', 'c', 3, 'root')).not.toBe(id);
    expect(delegateOperationId('t', 'c', 2, 'root')).not.toBe(id);
  });
  it.each(['alpha', 'beta'])('cancels a queued delegate if %s is replaced before reservation', async id => fixture(async f => {
    f.ctx.on('approval/request', async () => 'allowed-once'); const origin = await f.create();
    await f.execute(origin.agent, args);
    const run = f.stores.runs.list()[0]; if (!run) throw new Error('Missing run');
    const bot = f.bots.get(id); if (!bot) throw new Error('Missing bot');
    f.bots.set(id, { ...bot, createdAt: 2, updatedAt: 2 });
    expect(await f.stores.runs.reserve(run.id)).toMatchObject({ status: 'cancelled', errorCode: 'delegate/identity-unavailable' });
  }));
});

describe('durable delegate outbox', () => {
  function target(state: { evidence: 'absent' | 'pending' | 'committed'; flush?: boolean }): ReportTarget {
    return { validate: vi.fn(async () => {}), evidence: () => state.evidence,
      followup: vi.fn(() => { state.evidence = 'pending'; }), flush: vi.fn(async () => state.flush !== false) };
  }
  it.each(['succeeded', 'failed'] as const)('delivers one %s report and does not retry on notifications or recreation', async status => fixture(async f => {
    const run = await f.terminal(status); const state = { evidence: 'absent' as const }; const recipient = target(state);
    const runtime = { resolve: vi.fn(async () => recipient) };
    const reporter = new DelegateReporter(f.ctx, f.stores, runtime, () => {});
    await Promise.all([reporter.tick(), reporter.tick()]);
    expect(f.stores.runs.get(run.id).report).toMatchObject({ state: 'sent', attempts: 1 });
    expect(recipient.followup).toHaveBeenCalledTimes(1); await reporter.close();
    const again = new DelegateReporter(f.ctx, f.stores, runtime, () => {}); await again.tick(); await again.close();
    expect(recipient.followup).toHaveBeenCalledTimes(1);
  }));
  it.each(['absent', 'pending', 'committed'] as const)('reconciles a crash after persisted attempt with %s evidence without resending', async evidence => fixture(async f => {
    let run = await f.terminal(); const message = reportMessage(run, 4000);
    run = await f.stores.runs.updateReport(run.id, { state: 'pending', originSessionId: 'origin', message, messageId: message.id, attempts: 1 }, run.revision);
    const recipient = target({ evidence }); const reporter = new DelegateReporter(f.ctx, f.stores, { resolve: async () => recipient }, () => {});
    await reporter.tick(); await reporter.close();
    expect(recipient.followup).not.toHaveBeenCalled();
    expect(f.stores.runs.get(run.id).report?.state).toBe(evidence === 'committed' ? 'sent' : 'blocked');
  }));
  it('restarts an unattempted pending message using its original id', async () => fixture(async f => {
    let run = await f.terminal(); const message = reportMessage(run, 4000);
    run = await f.stores.runs.updateReport(run.id, { state: 'pending', originSessionId: 'origin', message, messageId: message.id, attempts: 0 }, run.revision);
    const recipient = target({ evidence: 'absent' }); const reporter = new DelegateReporter(f.ctx, f.stores, { resolve: async () => recipient }, () => {});
    await reporter.tick(); await reporter.close(); expect(recipient.followup).toHaveBeenCalledWith(message);
  }));
  it('blocks unreachable origins and unconfirmed flush, preserving fixed message and diagnostic without raw errors', async () => fixture(async f => {
    const run = await f.terminal(); const reporter = new DelegateReporter(f.ctx, f.stores, { resolve: async () => { throw new Error('private diagnostic'); } }, () => {});
    await reporter.tick(); await reporter.close();
    expect(f.stores.runs.get(run.id).report).toMatchObject({ state: 'blocked', attempts: 0 });
    expect(JSON.stringify(f.stores.runs.get(run.id).report)).not.toContain('private diagnostic');
    const other = await f.terminal(); const recipient = target({ evidence: 'absent', flush: false });
    const second = new DelegateReporter(f.ctx, f.stores, { resolve: async () => recipient }, () => {});
    await second.tick(); await second.close(); expect(f.stores.runs.get(other.id).report).toMatchObject({ state: 'blocked', attempts: 1 });
  }));
  it('screens before truncating, limits Unicode safely and emits status without task/title/history', async () => fixture(async f => {
    const run = await f.terminal();
    const secret = `sk-${'x'.repeat(30)}`;
    const message = reportMessage({ ...run, summary: `${'safe'.repeat(3000)} ${secret}` }, 10);
    expect(message.content[0]?.text).toContain('[redacted]'); expect(JSON.stringify(message)).not.toContain(secret);
    const limited = reportMessage({ ...run, summary: '😀'.repeat(8000) }, 8000);
    expect(limited.content[0]?.text.length).toBeLessThanOrEqual(8192); expect(JSON.stringify(limited)).not.toContain('Task only');
  }));
  it('joins unload during resolution and never sends after close', async () => fixture(async f => {
    const run = await f.terminal(); const recipient = target({ evidence: 'absent' });
    let release!: (value: ReportTarget) => void;
    const resolve = vi.fn(() => new Promise<ReportTarget>(accept => { release = accept; }));
    const reporter = new DelegateReporter(f.ctx, f.stores, { resolve }, () => {});
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    const closed = reporter.close(); release(recipient); await closed;
    expect(recipient.followup).not.toHaveBeenCalled(); expect(f.stores.runs.get(run.id).report).toMatchObject({ state: 'pending', attempts: 0 });
  }));
  it.each(['archived', 'deleted', 'rebuilt', 'wrong-binding'])('runtime refuses %s origins', async scenario => fixture(async f => {
    const run = await f.terminal(); const origin = await f.create('beta', 'origin');
    const inspect = vi.fn(async () => { if (scenario === 'deleted') throw new Error('session/not-found'); return {}; });
    const resolveAgent = vi.fn(async () => ({ agent: origin.agent }));
    const context = {
      workspaceRegistry: { archivedSessionIds: scenario === 'archived' ? ['origin'] : [] },
      sessionController: { inspect, resolveAgent },
      agents: { get: () => origin.agent },
    } as unknown as Context;
    const registry = { get: async () => ({ createdAt: scenario === 'rebuilt' ? 2 : 1 }) } as unknown as Context['dshBots'];
    await expect(dshReportRuntime(context, registry).resolve(run)).rejects.toThrow();
    if (scenario !== 'wrong-binding') expect(resolveAgent).not.toHaveBeenCalled();
  }));
});
