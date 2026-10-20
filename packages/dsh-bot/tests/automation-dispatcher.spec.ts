import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { describe, expect, it } from 'vitest';
import { Dispatcher, type DispatcherClock } from '../src/host/automation/dispatcher.js';
import { openAutomationStores } from '../src/host/automation/store.js';
import { dueOccurrence } from '../src/host/automation/rules.js';
import { configSchema, type Config } from '../src/host/automation/config.js';
import { botCreateSchema, botSchema } from '../src/shared/schema.js';
import type { RoutineCreate, RunRecord } from '../src/shared/automation.js';

const epoch = Date.parse('2026-10-20T12:00:00Z');
const input: RoutineCreate = { botId: 'alpha', title: 'Routine', prompt: 'Task', rule: { kind: 'every', everySeconds: 60 }, timeZone: 'UTC' };
class Clock implements DispatcherClock {
  time = epoch;
  timers = new Map<() => void, number>();
  now = () => this.time;
  setTimer(callback: () => void, ms: number) { this.timers.set(callback, this.time + ms); return () => { this.timers.delete(callback); }; }
  jump(ms: number) { this.time += ms; }
  fire() {
    for (const [callback, at] of [...this.timers]) if (at <= this.time && this.timers.delete(callback)) callback();
  }
}
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing test evidence');
  return value;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await delay(2); }
  throw new Error('Dispatcher test deadline');
}
async function fixture(action: (f: {
  stores: Awaited<ReturnType<typeof openAutomationStores>>; clock: Clock; dispatcher: Dispatcher;
  started: RunRecord[]; errors: unknown[]; finish: (id: string) => Promise<void>;
  reopen: () => Promise<Awaited<ReturnType<typeof openAutomationStores>>>;
}) => Promise<void>, config: Partial<Config> = {}) {
  const home = fileURLToPath(new URL('../../../.dsh-dev/p2/t14/', import.meta.url));
  await mkdir(home, { recursive: true }); const root = await mkdtemp(join(home, 'dispatcher-'));
  const ctx = new Context(); const clock = new Clock(); const errors: unknown[] = []; const started: RunRecord[] = [];
  const held = new Map<string, (run: RunRecord) => void>();
  let dispatcher: Dispatcher | undefined;
  try {
    await ctx.plugin(Storage).await(); await ctx.plugin(storageJson, { root }).await(); await ctx.plugin(storageDomain, { backend: 'json' }).await();
    const options = { ownerId: 'test-owner', assertOwner() {}, now: clock.now, config: { quotaTimeZone: 'UTC', ...config },
      resolveBot: (id: string) => ({ bot: botSchema.parse({ ...botCreateSchema.parse({ id, name: id }), createdAt: 1, updatedAt: 1, schemaVersion: 1 }), presetId: `bot-${id}` }) };
    const stores = await openAutomationStores(ctx, options);
    const executor = { async execute(id: string) {
      const run = await stores.runs.reserve(id);
      if (run.status !== 'running') return run;
      started.push(run);
      return new Promise<RunRecord>(resolve => held.set(id, resolve));
    } };
    dispatcher = new Dispatcher(ctx, stores, executor, options.assertOwner, options.config, clock, error => errors.push(error));
    const current = dispatcher;
    await action({ stores, dispatcher, clock, errors, started,
      finish: async id => {
        const run = stores.runs.get(id);
        const terminal = await stores.runs.transition(id, 'failed', run.revision, { errorCode: 'test/done' }, true);
        held.get(id)?.(terminal); held.delete(id);
      },
      reopen: async () => { await current.close(); await stores.close(); return openAutomationStores(ctx, options); },
    });
  } finally { await dispatcher?.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
}

describe('Host Dispatcher with virtual wall clock and real JSON stores', () => {
  it('uses the earliest timer, consumes once under reentry, and removes every timer/subscription on close', async () => fixture(async f => {
    const routine = await f.stores.routines.create(input);
    await f.dispatcher.tick();
    expect([...f.clock.timers.values()]).toEqual([epoch + 60000, epoch + 60000]);
    f.clock.jump(60000); f.clock.fire();
    await Promise.all(Array.from({ length: 10 }, () => f.dispatcher.tick()));
    await until(() => f.started.length === 1);
    expect(f.started[0]).toMatchObject({ trigger: 'scheduled', scheduledAt: epoch + 60000 });
    expect(f.stores.routines.get(routine.id).nextRunAt).toBe(epoch + 120000);
    await f.finish(required(f.started[0]).id); await f.dispatcher.close();
    expect(f.clock.timers.size).toBe(0);
    f.clock.jump(60000); await f.stores.routines.create(input); f.clock.fire();
    expect(f.started).toHaveLength(1);
    await expect(f.dispatcher.runNow(routine.id, randomUUID())).rejects.toMatchObject({ code: 'automation/unavailable' });
  }));

  it('compresses forward sleep/jump to the latest per routine, never rewinds or replays on backward jumps', async () => fixture(async f => {
    const a = await f.stores.routines.create(input); const b = await f.stores.routines.create(input);
    f.clock.jump(25 * 3600000 + 17000); f.clock.fire(); await f.dispatcher.tick();
    await until(() => f.started.length === 2);
    expect(f.started.map(r => r.scheduledAt)).toEqual([epoch + 25 * 3600000, epoch + 25 * 3600000]);
    for (const r of f.started) await f.finish(r.id);
    const cursors = [a, b].map(r => f.stores.routines.get(r.id).nextRunAt);
    f.clock.jump(-3600000); await f.dispatcher.tick();
    expect(f.stores.runs.list()).toHaveLength(2);
    expect([a, b].map(r => f.stores.routines.get(r.id).nextRunAt)).toEqual(cursors);
  }));

  it('exhausts at, skips catch-up older than 24h, accepts the boundary, and honors skip misfire policy', async () => fixture(async f => {
    const expired = await f.stores.routines.create({ ...input, rule: { kind: 'at', at: epoch + 1000 } });
    const boundary = await f.stores.routines.create({ ...input, rule: { kind: 'at', at: epoch + 2000 } });
    const skip = await f.stores.routines.create({ ...input, misfirePolicy: 'skip' });
    f.clock.jump(86400000 + 2000); await f.dispatcher.tick();
    await until(() => f.started.length === 1);
    expect(f.started[0]?.routineId).toBe(boundary.id);
    expect(f.stores.runs.list({ routineId: expired.id })[0]).toMatchObject({ status: 'skipped', skipReason: 'catch_up_expired', quotaCharged: false });
    expect(f.stores.routines.get(expired.id).nextRunAt).toBeUndefined();
    expect(f.stores.runs.list({ routineId: skip.id })[0]).toMatchObject({ status: 'skipped', skipReason: 'misfire' });
  }));

  it('allows idempotent run_now while paused without changing anchor/cursor and never catches up the pause interval', async () => fixture(async f => {
    const r = await f.stores.routines.create(input);
    const paused = await f.stores.routines.update(r.id, { enabled: false }, r.revision);
    f.clock.jump(3600000); await f.dispatcher.tick();
    expect(f.stores.runs.list()).toHaveLength(0);
    const operation = randomUUID();
    const [a, b] = await Promise.all([f.dispatcher.runNow(r.id, operation), f.dispatcher.runNow(r.id, operation)]);
    expect(a.id).toBe(b.id); await until(() => f.started.length === 1);
    expect(f.stores.routines.get(r.id)).toEqual(paused);
    await f.finish(a.id);
    const resumed = await f.stores.routines.update(r.id, { enabled: true }, paused.revision);
    expect(resumed.nextRunAt).toBe(f.clock.time + 60000);
    await f.dispatcher.tick(); expect(f.started).toHaveLength(1);
    const before = f.stores.routines.get(r.id);
    const manual = await f.dispatcher.runNow(r.id, randomUUID()); await until(() => f.started.length === 2);
    expect(f.stores.routines.get(r.id)).toEqual(before); await f.finish(manual.id);
    const expired = await f.stores.routines.create({ ...input, enabled: false, rule: { kind: 'at', at: f.clock.time + 1000 } });
    f.clock.jump(2000);
    const at = await f.stores.routines.update(expired.id, { enabled: true }, expired.revision);
    expect(at.nextRunAt).toBeUndefined();
  }));

  it('skips overlap, keeps only the latest queued scheduled occurrence, and drains the shared FIFO pool', async () => fixture(async f => {
    const active = await f.stores.routines.create(input);
    const manual = await f.dispatcher.runNow(active.id, randomUUID()); await until(() => f.started.length === 1);
    const waiting = await f.stores.routines.create(input);
    f.clock.jump(60000); await f.dispatcher.tick();
    expect(f.stores.runs.list({ routineId: active.id }).some(r => r.skipReason === 'overlap')).toBe(true);
    const first = required(f.stores.runs.list({ routineId: waiting.id })[0]);
    expect(first.status).toBe('queued');
    f.clock.jump(120000); await f.dispatcher.tick();
    expect(f.stores.runs.get(first.id)).toMatchObject({ status: 'skipped', skipReason: 'superseded' });
    const pending = f.stores.runs.pending().filter(r => r.routineId === waiting.id);
    expect(pending).toHaveLength(1); expect(pending[0]?.scheduledAt).toBe(epoch + 180000);
    await f.finish(manual.id);
    await until(() => f.started.length === 2);
    expect(f.started[1]?.id).toBe(pending[0]?.id);
  }, { maxConcurrentRuns: 1 }));

  it('cancels unadmitted work on pause/edit/delete and preserves already running work', async () => fixture(async f => {
    const a = await f.stores.routines.create(input);
    await f.dispatcher.runNow(a.id, randomUUID()); await until(() => f.started.length === 1);
    for (const mode of ['pause', 'edit', 'delete']) {
      const r = await f.stores.routines.create(input);
      f.clock.jump(60000); await f.dispatcher.tick();
      const run = required(f.stores.runs.list({ routineId: r.id })[0]);
      const current = f.stores.routines.get(r.id);
      if (mode === 'delete') await f.stores.routines.remove(r.id, current.revision);
      else await f.stores.routines.update(r.id, mode === 'pause' ? { enabled: false } : { rule: { kind: 'every', everySeconds: 120 } }, current.revision);
      await f.dispatcher.tick();
      expect(f.stores.runs.get(run.id).status).toBe('cancelled');
    }
    const current = f.stores.routines.get(a.id);
    await f.stores.routines.remove(a.id, current.revision); await f.dispatcher.tick();
    expect(f.stores.runs.get(required(f.started[0]).id).status).toBe('running');
  }, { maxConcurrentRuns: 1 }));

  it('enforces bounded queue and records queue_full for scheduled work without charging it', async () => fixture(async f => {
    const r = await f.stores.routines.create(input);
    await f.dispatcher.runNow(r.id, randomUUID()); await until(() => f.started.length === 1);
    const waiting = await f.stores.routines.create({ ...input, enabled: false });
    await f.dispatcher.runNow(waiting.id, randomUUID());
    await expect(f.dispatcher.runNow(waiting.id, randomUUID())).rejects.toMatchObject({ code: 'automation/busy' });
    const scheduled = await f.stores.routines.create(input);
    f.clock.jump(60000); await f.dispatcher.tick();
    expect(f.stores.runs.list({ routineId: scheduled.id })[0]).toMatchObject({ status: 'skipped', skipReason: 'queue_full', quotaCharged: false });
  }, { maxConcurrentRuns: 1, maxQueuedRuns: 1 }));

  it('shares quotas across scheduled/manual/delegate, failure never refunds, midnight follows fixed timezone', async () => fixture(async f => {
    f.clock.time = Date.parse('2026-10-20T23:58:00Z');
    const r = await f.stores.routines.create(input);
    const manual = await f.dispatcher.runNow(r.id, randomUUID()); await until(() => f.started.length === 1); await f.finish(manual.id);
    f.clock.jump(60000); await f.dispatcher.tick(); await until(() => f.started.length === 2); await f.finish(required(f.started[1]).id);
    const delegated = await f.dispatcher.submit({ trigger: 'delegate', botId: 'alpha', title: 'delegated', prompt: 'Task',
      originBotId: 'beta', originBotCreatedAt: 1, originSessionId: 'session-origin', operationId: randomUUID() });
    await until(() => f.stores.runs.get(delegated.id).status === 'skipped');
    expect(f.stores.runs.get(delegated.id).skipReason).toBe('quota');
    f.clock.jump(60000); await f.dispatcher.tick(); await until(() => f.started.length === 3);
    expect(f.started[2]?.quotaDate).toBe('2026-10-21');
    expect(f.stores.runs.control().counts).toEqual([{ botId: 'alpha', date: '2026-10-20', count: 2 }, { botId: 'alpha', date: '2026-10-21', count: 1 }]);
  }, { maxRunsPerBotPerDay: 2 }));

  it('holds ambiguous recovery slots across restart, and refuses a backward quota day', async () => fixture(async f => {
    const r = await f.stores.routines.create({ ...input, enabled: false });
    const a = await f.dispatcher.runNow(r.id, randomUUID()); await until(() => f.started.length === 1); await f.finish(a.id);
    f.clock.jump(-86400000);
    const b = await f.dispatcher.runNow(r.id, randomUUID());
    await until(() => f.errors.length > 0);
    expect(f.errors[0]).toMatchObject({ code: 'automation/clock' });
    expect(f.stores.runs.get(b.id).quotaCharged).toBe(false);
    f.clock.jump(86400000); await f.dispatcher.tick(); await until(() => f.started.length === 2);
    const reopened = await f.reopen();
    expect(reopened.runs.get(b.id)).toMatchObject({ status: 'recovery_needed', slotHeld: true });
    expect(reopened.runs.control().counts[0]?.count).toBe(2);
  }));

  it('uses a 60s fallback for a forward wall-clock jump even when the earliest timer was far away', async () => fixture(async f => {
    const r = await f.stores.routines.create({ ...input, rule: { kind: 'at', at: epoch + 86400000 } });
    await f.dispatcher.tick();
    const fallback = required([...f.clock.timers].find(([, at]) => at === epoch + 60000));
    f.clock.jump(86400000 + 1000);
    // Only the monotonic periodic wakeup fires, modelling a wall clock adjustment.
    f.clock.timers.delete(fallback[0]); fallback[0]();
    await until(() => f.started.length === 1);
    expect(f.started[0]?.routineId).toBe(r.id);
  }));

  it('default guardrails are 2 / 20 / 64 / 24h / 60s with the system quota timezone', () => {
    expect(configSchema.parse({})).toMatchObject({ maxConcurrentRuns: 2, maxRunsPerBotPerDay: 20, maxQueuedRuns: 64,
      catchUpMaxAgeMs: 86400000, sweepIntervalMs: 60000, quotaTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  it('default global concurrency is two and queued manual work starts in acceptance order when a slot frees', async () => fixture(async f => {
    const runs: RunRecord[] = [];
    for (let i = 0; i < 4; i++) {
      f.clock.jump(1);
      const routine = await f.stores.routines.create({ ...input, enabled: false });
      runs.push(await f.dispatcher.runNow(routine.id, randomUUID()));
    }
    await until(() => f.started.length === 2);
    expect(f.stores.runs.pending().filter(r => r.slotHeld)).toHaveLength(2);
    expect(f.started.map(r => r.id)).toEqual(runs.slice(0, 2).map(r => r.id));
    await f.finish(required(runs[0]).id);
    await until(() => f.started.length === 3);
    expect(f.started[2]?.id).toBe(runs[2]?.id);
    await f.finish(required(runs[1]).id);
    await until(() => f.started.length === 4);
    expect(f.started[3]?.id).toBe(runs[3]?.id);
  }));

  it('uses quota timezone instead of routine timezone, and a quota-exhausted bot cannot block another bot', async () => fixture(async f => {
    f.clock.time = Date.parse('2026-10-20T23:59:00Z');
    const alpha = await f.stores.routines.create({ ...input, enabled: false, timeZone: 'Asia/Tokyo' });
    const first = await f.dispatcher.runNow(alpha.id, randomUUID());
    await until(() => f.started.length === 1); await f.finish(first.id);
    f.clock.jump(120000); // UTC changed day, Los Angeles did not.
    const exhausted = await f.dispatcher.runNow(alpha.id, randomUUID());
    const beta = await f.stores.routines.create({ ...input, botId: 'beta', enabled: false });
    await f.dispatcher.runNow(beta.id, randomUUID());
    await until(() => f.stores.runs.get(exhausted.id).status === 'skipped' && f.started.length === 2);
    expect(f.started[1]).toMatchObject({ botId: 'beta', quotaDate: '2026-10-20', quotaTimeZone: 'America/Los_Angeles' });
    f.clock.time = Date.parse('2026-10-21T07:00:00Z');
    await f.dispatcher.runNow(alpha.id, randomUUID()); await until(() => f.started.length === 3);
    expect(f.started[2]?.quotaDate).toBe('2026-10-21');
  }, { quotaTimeZone: 'America/Los_Angeles', maxRunsPerBotPerDay: 1 }));

  it('daily/weekly skip DST gaps and fire only the earlier overlap; cron preserves Vixie DOM/DOW semantics', async () => fixture(async f => {
    f.clock.time = Date.parse('2026-03-07T08:00:00Z');
    const daily = await f.stores.routines.create({ ...input, rule: { kind: 'daily', time: '02:30:00' }, timeZone: 'America/New_York' });
    expect(new Date(required(daily.nextRunAt)).toISOString()).toBe('2026-03-09T06:30:00.000Z');
    const weekly = await f.stores.routines.create({ ...input, rule: { kind: 'weekly', time: '02:30:00', weekdays: [7] }, timeZone: 'America/New_York' });
    expect(new Date(required(weekly.nextRunAt)).toISOString()).toBe('2026-03-15T06:30:00.000Z');
    f.clock.time = Date.parse('2026-10-31T08:00:00Z');
    for (const rule of [{ kind: 'daily' as const, time: '01:30:00' }, { kind: 'weekly' as const, time: '01:30:00', weekdays: [7] },
      { kind: 'cron' as const, expression: '30 1 * * *' }]) {
      const r = await f.stores.routines.create({ ...input, rule, timeZone: 'America/New_York' });
      expect(new Date(required(r.nextRunAt)).toISOString()).toBe('2026-11-01T05:30:00.000Z');
      const occurrence = required(dueOccurrence(r, Date.parse('2026-11-01T06:45:00Z')));
      expect(new Date(occurrence.scheduledAt).toISOString()).toBe('2026-11-01T05:30:00.000Z');
      expect(occurrence.nextRunAt).toBeGreaterThan(Date.parse('2026-11-02T00:00:00Z'));
    }
    f.clock.time = Date.parse('2026-01-30T00:00:00Z');
    const cron = await f.stores.routines.create({ ...input, rule: { kind: 'cron', expression: '0 9 1 * 1' } });
    const occurrence = required(dueOccurrence(cron, Date.parse('2026-02-02T12:00:00Z')));
    expect(new Date(occurrence.scheduledAt).toISOString()).toBe('2026-02-02T09:00:00.000Z');
    expect(new Date(required(occurrence.nextRunAt)).toISOString()).toBe('2026-02-09T09:00:00.000Z');
    const minute = await f.stores.routines.create({ ...input, rule: { kind: 'cron', expression: '*/15 * * * *' } });
    expect(dueOccurrence(minute, Date.parse('2027-01-01T00:07:00Z'))).toEqual({
      scheduledAt: Date.parse('2027-01-01T00:00:00Z'), nextRunAt: Date.parse('2027-01-01T00:15:00Z'),
    });
  }));
});
