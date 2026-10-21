import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { describe, expect, it, vi } from 'vitest';
import { openAutomationStores } from '../src/host/automation/store.js';
import { configSchema } from '../src/host/automation/config.js';
import { RunExecutor, type ExecutorRuntime, runTitle } from '../src/host/automation/executor.js';
import { inspectBarrier, type Observation } from '../src/host/automation/barrier.js';
import type { RunRecord } from '../src/shared/automation.js';
import { botCreateSchema, botSchema } from '../src/shared/schema.js';

const home = fileURLToPath(new URL('../../../.dsh-dev/p2/t13/', import.meta.url));
const bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'alpha', name: 'Alpha' }), createdAt: 1, updatedAt: 2, schemaVersion: 1 });
const events = (requestId: string, reason = 'completed') => [
  { type: 'turn/start', data: { turn: 0 } }, { type: 'step/start', data: { turn: 0, step: 0 } },
  { type: 'user/message', data: { id: randomUUID(), source: { kind: 'user', rpcId: requestId } } },
  { type: 'assistant/message', data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'Done' }] } } },
  { type: 'turn/end', data: { turn: 0, reason: { kind: reason } } },
].map((e, seq) => ({ ...e, seq, time: Date.now() })) as SessionEvent[];

async function facility(test: (f: {
  ctx: Context; stores: Awaited<ReturnType<typeof openAutomationStores>>; run: RunRecord;
  runtime: ExecutorRuntime; observation: Observation; calls: string[]; executor: RunExecutor;
}) => Promise<void>) {
  await mkdir(home, { recursive: true }); const root = await mkdtemp(join(home, 'executor-'));
  const ctx = new Context();
  try {
    await ctx.plugin(Storage).await(); await ctx.plugin(storageJson, { root }).await();
    await ctx.plugin(storageDomain, { backend: 'json' }).await();
    const resolveBot = async () => ({ bot, presetId: 'actual-current-preset' });
    const stores = await openAutomationStores(ctx, { resolveBot });
    const run = await stores.runs.enqueue({ trigger: 'manual', nativeScheduleId: 'schedule-test', operationId: randomUUID(), botId: bot.id, botCreatedAt: bot.createdAt, title: 'Report', prompt: 'Task', timeZone: 'UTC' });
    const calls: string[] = [];
    const observation: Observation = { events: [], idle: true, inboxEmpty: true, jobs: [], children: [] };
    const runtime: ExecutorRuntime = {
      resolveBot, async workspace() { calls.push('workspace'); return { workspaceId: 'bots', path: '/bots' }; },
      async create(r) { calls.push('create'); expect(stores.runs.get(r.id).admittedAt).toBeDefined(); return { sessionId: 'session-actual-receipt' }; },
      async verify(r) { calls.push('verify'); expect(stores.runs.get(r.id).sessionId).toBe(r.sessionId); },
      async rename(_r, title) { calls.push('rename'); expect(title).toMatch(/^\[Run now\] Report · .* UTC$/); },
      async prompt(r) { calls.push('prompt'); observation.events = events(r.requestId); },
      async observe() { return structuredClone(observation); },
      async stop() { calls.push('stop'); observation.idle = true; observation.inboxEmpty = true; observation.jobs = []; observation.children = []; },
      async flush() { calls.push('flush'); return true; },
    };
    const executor = new RunExecutor(ctx, stores.runs, runtime, () => {}, { runTimeoutMs: 1000, executorPollMs: 10, stopGraceMs: 100 });
    await test({ ctx, stores, run, runtime, observation, calls, executor });
    await executor.close();
    await stores.close();
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
}
describe('RunExecutor with real durable automation stores', () => {
  it('ignores retired policy settings from a 0.2.0 Host configuration', () => {
    expect(configSchema.parse({ maxConcurrentRuns: 2, maxRunsPerBotPerDay: 20, quotaTimeZone: 'UTC', catchUpMaxAgeMs: 86400000 }))
      .toEqual({ runTimeoutMs: 900000, executorPollMs: 250, stopGraceMs: 5000 });
  });
  it('reserves once, persists actual create ID and joins concurrent execution, then does not replay', async () => facility(async f => {
    const [a, b] = await Promise.all([f.executor.execute(f.run.id), f.executor.execute(f.run.id)]);
    expect(a).toEqual(b); expect(a).toMatchObject({ status: 'succeeded', sessionId: 'session-actual-receipt', inputTurn: 0, slotHeld: false, summary: 'Done' });
    expect(a.inputMessageId).toBeDefined();
    expect(f.calls).toEqual(['workspace', 'create', 'verify', 'rename', 'flush', 'prompt', 'flush']);
    await f.executor.execute(a.id); expect(f.calls.filter(c => c === 'prompt')).toHaveLength(1);
    expect(f.stores.runs.list()).toHaveLength(1);
  }));
  it.each(['error', 'max-tokens', 'blocked', 'aborted'])('maps linked turn %s without promoting it to success', async reason => facility(async f => {
    f.runtime.prompt = async r => { f.observation.events = events(r.requestId, reason); };
    expect((await f.executor.execute(f.run.id)).status).toBe(reason === 'aborted' ? 'cancelled' : 'failed');
  }));
  it('keeps running through owned job, descendant, Inbox, then a late follow-up turn', async () => facility(async f => {
    f.observation.jobs = [{ id: 'job-owned', status: 'running' }];
    f.observation.children = [{ id: 'child', activity: 'running' }];
    const pending = f.executor.execute(f.run.id);
    await delay(60); expect(f.stores.runs.get(f.run.id).status).toBe('running');
    f.observation.jobs = [{ id: 'job-owned', status: 'completed' }];
    await delay(30); expect(f.stores.runs.get(f.run.id).status).toBe('running');
    f.observation.children = [{ id: 'child', activity: 'inactive' }]; f.observation.inboxEmpty = false;
    await delay(30); expect(f.stores.runs.get(f.run.id).status).toBe('running');
    f.observation.inboxEmpty = true;
    expect((await pending).status).toBe('succeeded');
  }));
  it('accepted alone times out and confirms stop before releasing execution state', async () => facility(async f => {
    f.runtime.prompt = async () => {};
    const result = await f.executor.execute(f.run.id);
    expect(result).toMatchObject({ status: 'timed_out', slotHeld: false });
    expect(f.calls).toContain('stop');
  }));
  it('cancel and unload drain active work; queued cancellation creates no session', async () => facility(async f => {
    f.runtime.prompt = async () => { f.observation.idle = false; };
    const pending = f.executor.execute(f.run.id); await vi.waitFor(() => expect(f.observation.idle).toBe(false));
    expect((await f.executor.cancel(f.run.id)).status).toBe('cancelled'); await pending;
    await f.executor.close(); await f.executor.close();
    await expect(f.executor.execute(f.run.id)).rejects.toMatchObject({ code: 'automation/unavailable' });
    const queued = await f.stores.runs.enqueue({ trigger: 'manual', nativeScheduleId: 'schedule-test', operationId: randomUUID(), botId: bot.id, botCreatedAt: bot.createdAt, title: 'Report', prompt: 'Task', timeZone: 'UTC' });
    expect((await f.executor.cancel(queued.id)).admittedAt).toBeUndefined();
  }));
  it('unknown descendants or an uncooperative stop preserve recovery occupancy', async () => facility(async f => {
    f.observation.children = [{ id: 'unknown', activity: 'unknown' }];
    f.runtime.stop = async () => {};
    const result = await f.executor.execute(f.run.id);
    expect(result).toMatchObject({ status: 'recovery_needed', slotHeld: true });
    expect(f.executor.safeToRelease).toBe(false);
    expect(await f.executor.execute(result.id)).toEqual(result);
  }));
  it('creation still pending at cancellation cannot create a second session or admit a late prompt', async () => facility(async f => {
    let finish!: () => void;
    f.runtime.create = async () => { await new Promise<void>(r => { finish = r; }); return { sessionId: 'late' }; };
    const pending = f.executor.execute(f.run.id); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect((await f.executor.cancel(f.run.id)).status).toBe('recovery_needed');
    finish(); await pending; await delay(20); expect(f.calls).not.toContain('prompt');
  }));
  it('false flush never reports success or releases an unconfirmed slot', async () => facility(async f => {
    f.runtime.flush = async () => false;
    expect((await f.executor.execute(f.run.id)).status).toBe('recovery_needed');
    expect(f.calls).not.toContain('prompt');
  }));
  it('placement failure stops before prompt; changing Bot generation also refuses prompt', async () => facility(async f => {
    f.runtime.verify = async () => { throw new Error('Workspace attach mismatch'); };
    expect((await f.executor.execute(f.run.id)).status).toBe('failed');
    expect(f.calls).not.toContain('prompt');
    const next = await f.stores.runs.enqueue({ trigger: 'manual', nativeScheduleId: 'schedule-test', operationId: randomUUID(), botId: bot.id, botCreatedAt: bot.createdAt, title: 'Report', prompt: 'Task', timeZone: 'UTC' });
    f.runtime.verify = async () => {};
    let reads = 0;
    f.runtime.resolveBot = async () => ({ bot: { ...bot, updatedAt: ++reads === 1 ? 2 : 3 }, presetId: 'actual-current-preset' });
    expect((await f.executor.execute(next.id)).status).toBe('failed');
    expect(f.calls).not.toContain('prompt');
  }));
  it('unload during an active turn drains cancellation before store close and prevents further execution', async () => facility(async f => {
    f.runtime.prompt = async () => { f.observation.idle = false; };
    const pending = f.executor.execute(f.run.id);
    await vi.waitFor(() => expect(f.observation.idle).toBe(false));
    await f.executor.close();
    expect(await pending).toMatchObject({ status: 'cancelled', errorCode: 'executor/unloaded' });
    expect(f.executor.safeToRelease).toBe(true);
  }));
  it('tracks waiting approvals and returns to running after an audit decision', async () => facility(async f => {
    f.runtime.prompt = async r => {
      f.observation.events = [...events(r.requestId).slice(0, 3),
        { type: 'approval/asked', seq: 3, time: Date.now(), data: { id: 'approval-test', toolName: 'test' } }] as SessionEvent[];
      f.observation.idle = false;
    };
    const pending = f.executor.execute(f.run.id);
    await vi.waitFor(() => expect(f.stores.runs.get(f.run.id).status).toBe('waiting_approval'));
    f.observation.events = [...f.observation.events,
      { type: 'approval/decided', seq: 4, time: Date.now(), data: { id: 'approval-test', outcome: 'allowed-once' } },
      ...events(f.run.requestId).slice(3).map((event, i) => ({ ...event, seq: i + 5 }))] as SessionEvent[];
    f.observation.idle = true;
    expect((await pending).status).toBe('succeeded');
  }));
  it('an interrupted recovered turn stays recovery_needed even after stop succeeds', async () => facility(async f => {
    f.runtime.prompt = async r => { f.observation.events = events(r.requestId, 'interrupted'); };
    expect(await f.executor.execute(f.run.id)).toMatchObject({ status: 'recovery_needed', slotHeld: true });
  }));
  it('does not mistake a foreign request or empty completed turn for execution', async () => facility(async f => {
    expect(inspectBarrier({ ...f.observation, events: events('foreign') }, f.run).outcome).toBeUndefined();
    expect(inspectBarrier({ ...f.observation, events: events(f.run.requestId).filter(e => e.type !== 'step/start') }, f.run).outcome).toBeUndefined();
    expect(runTitle({ ...f.run, requestedAt: Date.parse('2026-10-20T12:34Z') })).toBe('[Run now] Report · 2026-10-20 12:34 UTC');
  }));
});
