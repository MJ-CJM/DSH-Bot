import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import type { KvUnit } from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import { describe, expect, it, vi } from 'vitest';
import { openBotStores } from '../src/host/store.js';
import { automationDomain, openAutomationStores, quotaDate } from '../src/host/automation/store.js';
import type { AutomationOptions } from '../src/host/automation/store.js';
import { AutomationError } from '../src/host/automation/errors.js';
import { Config, configSchema } from '../src/host/automation/config.js';
import { botCreateSchema, botSchema } from '../src/shared/schema.js';
import { routineRecordSchema, runRecordSchema, runStatusSchema } from '../src/shared/automation.js';
import type { RoutineCreate, RunRecord } from '../src/shared/automation.js';

const home = fileURLToPath(new URL('../../../.dsh-dev/p2/t12/', import.meta.url));
const epoch = Date.parse('2026-10-20T12:00:00Z');
const target = botSchema.parse({ ...botCreateSchema.parse({ id: 'alpha', name: 'Alpha' }), schemaVersion: 1, createdAt: 1, updatedAt: 1 });
const input: RoutineCreate = { botId: 'alpha', title: 'Routine', prompt: 'Task', rule: { kind: 'every', everySeconds: 60 }, timeZone: 'UTC' };
const options = (extra: Partial<AutomationOptions> = {}): AutomationOptions => ({
  assertOwner() {}, ownerId: 'test-owner', resolveBot: (id) => ({ bot: { ...target, id }, presetId: `test-${id}` }),
  now: () => epoch, config: { quotaTimeZone: 'UTC' }, ...extra,
});
async function facility(action: (ctx: Context, root: string, unit: () => KvUnit) => Promise<void>) {
  await mkdir(home, { recursive: true });
  const root = await mkdtemp(join(home, 'store-'));
  const ctx = new Context();
  try {
    await ctx.plugin(Storage).await();
    await ctx.plugin(storageJson, { root }).await();
    await ctx.plugin(storageDomain, { backend: 'json' }).await();
    const kv = ctx.storage.backend.get('json').kv;
    if (!kv) throw new Error('Missing public KV');
    let current!: KvUnit; const open = kv.open.bind(kv);
    vi.spyOn(kv, 'open').mockImplementation(async (descriptor) => { current = await open(descriptor); return current; });
    await action(ctx, root, () => current);
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
}
async function manual(stores: Awaited<ReturnType<typeof openAutomationStores>>, id?: string) {
  const r = id ? stores.routines.get(id) : await stores.routines.create(input);
  return stores.runs.enqueue({ trigger: 'manual', routineId: r.id, operationId: randomUUID() });
}
async function stopped(stores: Awaited<ReturnType<typeof openAutomationStores>>, run: RunRecord) {
  return stores.runs.transition(run.id, 'failed', run.revision, { errorCode: 'test/failure' }, true);
}

describe('automation domain on real published JSON backend', () => {
  it('initializes an independent v1 domain and preserves all P1 bytes through downgrade/reopen', async () => facility(async (ctx, root) => {
    const p1 = await openBotStores(ctx);
    const bot = await p1.bots.create({ id: 'alpha', name: 'P1 preserved' });
    const memory = await p1.memories.add({ botId: 'alpha', content: 'keep' });
    await p1.bots.saveBotsWorkspaceId('workspace-old');
    await p1.activities.record({ sessionId: 'session-old', botId: 'alpha', role: 'assistant', text: 'reply', at: epoch });
    const bytes = await readFile(join(root, 'dsh_bot.json'));
    const stores = await openAutomationStores(ctx, options());
    expect(stores.routines.list()).toEqual([]);
    expect(stores.runs.control()).toEqual({ schemaVersion: 1, quotaTimeZone: 'UTC', counts: [] });
    const r = await stores.routines.create(input);
    await stores.runs.reserve((await manual(stores, r.id)).id);
    await stores.close(); await p1.close();
    const oldVersion = await openBotStores(ctx);
    expect(oldVersion.bots.get('alpha')).toEqual(bot);
    expect(oldVersion.memories.listByBot('alpha', { limit: 10 })).toEqual([memory]);
    expect(oldVersion.activities.list().sessions).toHaveLength(1);
    expect(oldVersion.bots.botsWorkspaceId()).toBe('workspace-old');
    const resumed = await openAutomationStores(ctx, options());
    expect(resumed.routines.get(r.id)).toEqual(r);
    expect(resumed.runs.list()[0]?.status).toBe('recovery_needed');
    expect(await readFile(join(root, 'dsh_bot.json'))).toEqual(bytes);
    const disk = JSON.parse(await readFile(join(root, 'dsh_bot_automation.json'), 'utf8'));
    expect(JSON.stringify(disk)).toContain('recovery_needed');
    expect(automationDomain.name).toBe('dsh_bot_automation');
  }));

  it('normalizes five rules using public factories and rejects invalid calendar/cron/rule inputs', async () => facility(async (ctx) => {
    const stores = await openAutomationStores(ctx, options());
    const rules: RoutineCreate['rule'][] = [ { kind: 'at', at: epoch + 60000 }, { kind: 'every', everySeconds: 60 },
      { kind: 'daily', time: '09:00:00' }, { kind: 'weekly', time: '09:00:00', weekdays: [7, 1] }, { kind: 'cron', expression: '0 9 * * *' } ];
    for (const rule of rules) {
      const r = await stores.routines.create({ ...input, rule });
      expect(r.nextRunAt).toBeGreaterThan(epoch);
      expect(routineRecordSchema.safeParse(r).success).toBe(true);
    }
    for (const fields of [{ rule: { kind: 'at', at: epoch } }, { rule: { kind: 'every', everySeconds: 59 } },
      { rule: { kind: 'cron', expression: '* * * * * *' } }, { rule: { kind: 'cron', expression: '99 * * * *' } },
      { timeZone: 'Invalid/Zone' }, { rule: { kind: 'daily', time: '24:00:00' } },
      { rule: { kind: 'weekly', time: '09:00:00', weekdays: [1, 1] } }, { createdAt: 1 }, { title: '  ' }]) {
      await expect(stores.routines.create({ ...input, ...fields } as RoutineCreate)).rejects.toMatchObject({ code: 'automation/invalid' });
    }
    expect(stores.routines.list()).toHaveLength(5);
  }));

  it('uses revision CAS, immutable identity, normalized timing revision and soft deletion', async () => facility(async (ctx) => {
    const stores = await openAutomationStores(ctx, options());
    const r = await stores.routines.create(input);
    const changed = await stores.routines.update(r.id, { title: 'New', prompt: 'new task' }, r.revision);
    expect(changed.ruleRevision).toBe(1);
    await expect(stores.routines.update(r.id, { title: 'Stale' }, r.revision)).rejects.toMatchObject({ code: 'automation/conflict' });
    for (const patch of [{ botId: 'beta' }, { revision: 5 }, { title: undefined }, {}]) {
      await expect(stores.routines.update(r.id, patch as never, changed.revision)).rejects.toMatchObject({ code: 'automation/invalid' });
    }
    const edited = await stores.routines.update(r.id, { rule: { kind: 'every', everySeconds: 120 } }, changed.revision);
    expect(edited.ruleRevision).toBe(2);
    const deleted = await stores.routines.remove(r.id, edited.revision);
    expect(deleted).toMatchObject({ enabled: false, deletedAt: epoch });
    expect(stores.routines.list()).toEqual([]);
    expect(stores.routines.list({ includeDeleted: true })).toEqual([deleted]);
    expect(await stores.routines.remove(r.id, edited.revision)).toEqual(deleted);
    await expect(manual(stores, r.id)).rejects.toMatchObject({ code: 'automation/not-found' });
    expect((await stores.routines.create(input)).id).not.toBe(r.id);
  }));

  it('returns detached copies and deduplicates concurrent same-key requests/reservations', async () => facility(async (ctx) => {
    const stores = await openAutomationStores(ctx, options());
    const r = await stores.routines.create(input);
    const request = { trigger: 'manual' as const, routineId: r.id, operationId: randomUUID() };
    const rows = await Promise.all(Array.from({ length: 20 }, () => stores.runs.enqueue(request)));
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    const id = rows[0]?.id ?? '';
    const returned = rows[0]; if (!returned) throw new Error('Missing run');
    returned.snapshot.prompt = 'mutated';
    expect(stores.runs.get(id).snapshot.prompt).toBe('Task');
    const receipts = await Promise.all(Array.from({ length: 20 }, () => stores.runs.reserve(id)));
    expect(receipts.every((r) => r.sessionId === receipts[0]?.sessionId && r.requestId === receipts[0]?.requestId)).toBe(true);
    expect(stores.runs.control().counts).toEqual([{ botId: 'alpha', date: '2026-10-20', count: 1 }]);
    expect(stores.runs.list()).toHaveLength(1);
    await stores.close();
    const reopened = await openAutomationStores(ctx, options());
    const retried = await reopened.runs.enqueue(request);
    expect(retried).toMatchObject({ id, status: 'recovery_needed', slotHeld: true, quotaCharged: true });
    expect((await reopened.runs.reserve(id)).status).toBe('recovery_needed');
    expect(reopened.runs.control().counts[0]?.count).toBe(1);
  }));

  it('persists occurrence decisions and repairs cursor failure without replaying or reverting a new rule', async () => facility(async (ctx, _root, unit) => {
    let now = epoch;
    const stores = await openAutomationStores(ctx, options({ now: () => now }));
    const r = await stores.routines.create(input); now += 60000;
    const request = { trigger: 'scheduled' as const, routineId: r.id, ruleRevision: r.ruleRevision, scheduledAt: now, nextRunAt: now + 60000 };
    const original = unit().putRecord.bind(unit());
    const io = new Error('cursor interrupted');
    const fault = vi.spyOn(unit(), 'putRecord').mockImplementation(async (...args) => {
      if (args[0] === 'routines') throw io;
      return original(...args);
    });
    await expect(stores.runs.enqueue(request)).rejects.toMatchObject({ code: 'automation/unavailable', cause: io });
    expect(stores.runs.list()).toHaveLength(1);
    expect(stores.routines.get(r.id).nextRunAt).toBe(now);
    fault.mockRestore(); await stores.close();
    const reopened = await openAutomationStores(ctx, options({ now: () => now }));
    const existing = await reopened.runs.enqueue(request);
    expect(reopened.routines.get(r.id)).toMatchObject({ nextRunAt: now + 60000, lastDecisionKey: existing.dedupeKey });
    const current = reopened.routines.get(r.id);
    const newRule = await reopened.routines.update(r.id, { rule: { kind: 'every', everySeconds: 120 } }, current.revision);
    expect((await reopened.runs.enqueue(request)).id).toBe(existing.id);
    expect(reopened.routines.get(r.id)).toEqual(newRule);
    expect(reopened.runs.list()).toHaveLength(1);
  }));

  it.each(['queue', 'reservation', 'projection'])('recovers the %s write failure without double charging', async (boundary) => facility(async (ctx, root, unit) => {
    const stores = await openAutomationStores(ctx, options());
    const r = await stores.routines.create(input);
    const request = { trigger: 'manual' as const, routineId: r.id, operationId: randomUUID() };
    const queued = boundary === 'queue' ? undefined : await stores.runs.enqueue(request);
    const original = unit().putRecord.bind(unit()); let fired = false;
    const fault = vi.spyOn(unit(), 'putRecord').mockImplementation(async (...args) => {
      if (!fired && args[0] === (boundary === 'projection' ? 'control' : 'runs')) { fired = true; throw new Error('injected I/O'); }
      return original(...args);
    });
    await expect(queued ? stores.runs.reserve(queued.id) : stores.runs.enqueue(request)).rejects.toMatchObject({ code: 'automation/unavailable' });
    expect(fired).toBe(true); fault.mockRestore();
    const disk = await readFile(join(root, 'dsh_bot_automation.json'), 'utf8');
    if (boundary === 'projection') expect(disk).toContain('"quotaCharged": true');
    await stores.close();
    const reopened = await openAutomationStores(ctx, options());
    const recovered = await reopened.runs.enqueue(request);
    const reserved = await reopened.runs.reserve(recovered.id);
    expect(reserved.status).toBe(boundary === 'projection' ? 'recovery_needed' : 'running');
    expect(reopened.runs.list()).toHaveLength(1);
    expect(reopened.runs.control().counts[0]?.count).toBe(1);
  }));

  it('enforces non-overlap, bounded queue, shared slots, terminal confirmation and nine statuses', async () => facility(async (ctx) => {
    const stores = await openAutomationStores(ctx, options({ config: { quotaTimeZone: 'UTC', maxConcurrentRuns: 1, maxQueuedRuns: 2 } }));
    const first = await manual(stores);
    let running = await stores.runs.reserve(first.id);
    const overlap = await manual(stores, first.routineId);
    expect(await stores.runs.reserve(overlap.id)).toMatchObject({ status: 'skipped', skipReason: 'overlap', quotaCharged: false });
    const second = await manual(stores); await manual(stores);
    await expect(manual(stores)).rejects.toMatchObject({ code: 'automation/busy' });
    await expect(stores.runs.reserve(second.id)).rejects.toMatchObject({ code: 'automation/busy' });
    running = await stores.runs.transition(running.id, 'waiting_approval', running.revision);
    await expect(stores.runs.transition(running.id, 'succeeded', running.revision)).rejects.toMatchObject({ code: 'automation/conflict' });
    running = await stores.runs.transition(running.id, 'running', running.revision, { step: 'executing' });
    const succeeded = await stores.runs.transition(running.id, 'succeeded', running.revision, {}, true);
    expect(succeeded.slotHeld).toBe(false);
    await expect(stores.runs.transition(succeeded.id, 'running', succeeded.revision)).rejects.toMatchObject({ code: 'automation/conflict' });
    const timed = await stores.runs.reserve(second.id);
    expect(await stores.runs.transition(timed.id, 'timed_out', timed.revision, {}, true)).toMatchObject({ status: 'timed_out', quotaCharged: true });
    expect(runStatusSchema.options).toEqual(['queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'timed_out', 'skipped', 'recovery_needed']);
  }));

  it('counts failed/cancelled reservations, enforces per-Bot daily quota and clock/zone policy', async () => facility(async (ctx) => {
    let now = epoch;
    const opts = options({ now: () => now, config: { quotaTimeZone: 'UTC', maxRunsPerBotPerDay: 1 } });
    const stores = await openAutomationStores(ctx, opts);
    const charged = await stores.runs.reserve((await manual(stores)).id); await stopped(stores, charged);
    const waiting = await manual(stores);
    await expect(stores.runs.reserve(waiting.id)).rejects.toMatchObject({ code: 'automation/quota' });
    now += 86400000;
    const day2 = await stores.runs.reserve(waiting.id); await stopped(stores, day2);
    const queued = await manual(stores); now -= 86400000;
    await expect(stores.runs.reserve(queued.id)).rejects.toMatchObject({ code: 'automation/clock' });
    const beta = await stores.routines.create({ ...input, botId: 'beta' });
    now += 86400000;
    expect((await stores.runs.reserve((await manual(stores, beta.id)).id)).quotaCharged).toBe(true);
    await stores.close();
    await expect(openAutomationStores(ctx, { ...opts, config: { quotaTimeZone: 'Asia/Shanghai' } })).rejects.toMatchObject({ code: 'automation/clock' });
    const pinned = await openAutomationStores(ctx, { ...opts, config: {} });
    expect(pinned.runs.control().quotaTimeZone).toBe('UTC');
    expect(pinned.runs.control().counts).toHaveLength(3);
    expect(quotaDate(Date.parse('2026-10-20T00:00:00Z'), 'America/Los_Angeles')).toBe('2026-10-19');
  }));

  it('pauses/deletes future work while preserving admitted snapshots and rejects Bot reincarnation', async () => facility(async (ctx) => {
    let now = epoch; let incarnation = 1;
    const stores = await openAutomationStores(ctx, options({ now: () => now, resolveBot: (id) => ({ bot: { ...target, id, createdAt: incarnation }, presetId: 'actual-preset' }) }));
    const r = await stores.routines.create(input);
    const running = await stores.runs.reserve((await manual(stores, r.id)).id);
    const queued = await manual(stores, r.id);
    const paused = await stores.routines.update(r.id, { enabled: false, prompt: 'New prompt' }, r.revision);
    expect(stores.runs.get(running.id).snapshot).toMatchObject({ prompt: 'Task', presetId: 'actual-preset' });
    expect(stores.runs.get(running.id).status).toBe('running');
    now += 86400000;
    const resumed = await stores.routines.update(r.id, { enabled: true }, paused.revision);
    expect(resumed.nextRunAt).toBe(now + 60000);
    await stores.routines.remove(r.id, resumed.revision);
    expect(await stores.runs.reserve(queued.id)).toMatchObject({ status: 'cancelled', quotaCharged: false });
    const fresh = await stores.routines.create(input); incarnation++;
    await expect(manual(stores, fresh.id)).rejects.toMatchObject({ code: 'automation/conflict' });
    expect(stores.runs.get(running.id).slotHeld).toBe(true);
  }));

  it('supports delegate operation identity and immutable persisted report receipts', async () => facility(async (ctx, _root, unit) => {
    const stores = await openAutomationStores(ctx, options());
    const request = { trigger: 'delegate' as const, botId: 'beta', operationId: randomUUID(), title: 'Delegate', prompt: 'Task',
      originSessionId: 'origin-session', originBotId: 'alpha', originBotCreatedAt: 1 };
    const queued = await stores.runs.enqueue(request);
    await expect(stores.runs.enqueue({ ...request, botId: 'alpha' })).rejects.toMatchObject({ code: 'automation/conflict' });
    const active = await stores.runs.reserve(queued.id);
    const message = createUserMessage({ content: [{ type: 'text', text: 'Summary' }],
      source: { kind: 'dsh-bot-delegate', form: 'notice', summary: 'Summary', runId: active.id, sourceSessionId: active.sessionId } });
    const report = { state: 'pending' as const, originSessionId: 'origin-session', messageId: message.id, message, attempts: 0 };
    const fault = vi.spyOn(unit(), 'putRecord').mockRejectedValueOnce(new Error('terminal write failed'));
    await expect(stores.runs.transition(active.id, 'succeeded', active.revision, { report }, true)).rejects.toMatchObject({ code: 'automation/unavailable' });
    expect(stores.runs.get(active.id)).toEqual(active); fault.mockRestore();
    const done = await stores.runs.transition(active.id, 'succeeded', active.revision, { report }, true);
    await expect(stores.runs.updateReport(done.id, { ...report, messageId: randomUUID(), message: { ...message, id: randomUUID() } }, done.revision)).rejects.toMatchObject({ code: 'automation/invalid' });
    const sent = await stores.runs.updateReport(done.id, { ...report, state: 'sent', attempts: 1, durableAt: epoch }, done.revision);
    await expect(stores.runs.updateReport(done.id, report, sent.revision)).rejects.toMatchObject({ code: 'automation/conflict' });
    await stores.close(); const reopened = await openAutomationStores(ctx, options());
    expect(reopened.runs.get(done.id)).toEqual(sent);
  }));

  it.each(['routines', 'runs', 'control', 'key', 'dedupe', 'cron'])('rejects corrupt persisted %s without rewriting the file', async (kind) => facility(async (ctx, root) => {
    const stores = await openAutomationStores(ctx, options());
    const r = await stores.routines.create(input); const queued = await manual(stores, r.id);
    await stores.close();
    const domain = await ctx.storageDomain.open(automationDomain);
    if (kind === 'routines') await domain.table('routines').put(r.id, { ...r, title: 42 } as never);
    if (kind === 'runs') await domain.table('runs').put(queued.id, { ...queued, status: 'invented' } as never);
    if (kind === 'control') await domain.table('control').put('quota', { schemaVersion: 2 } as never);
    if (kind === 'key') await domain.table('routines').put(randomUUID(), r);
    if (kind === 'dedupe') await domain.table('runs').put(queued.id, { ...queued, dedupeKey: 'wrong' });
    if (kind === 'cron') await domain.table('routines').put(r.id, { ...r, rule: { kind: 'cron', expression: 'bad cron' } });
    await domain.close();
    const bytes = await readFile(join(root, 'dsh_bot_automation.json'));
    await expect(openAutomationStores(ctx, options())).rejects.toBeInstanceOf(AutomationError);
    expect(await readFile(join(root, 'dsh_bot_automation.json'))).toEqual(bytes);
  }));

  it('gates ownership before opening/writing and drains queued writes on repeated close/unload', async () => facility(async (ctx, _root, unit) => {
    let owned = false;
    const opts = options({ assertOwner: () => { if (!owned) throw new AutomationError('automation/read-only', 'No lease'); } });
    await expect(openAutomationStores(ctx, opts)).rejects.toMatchObject({ code: 'automation/read-only' });
    owned = true;
    let stores!: Awaited<ReturnType<typeof openAutomationStores>>;
    const plugin = ctx.plugin({ inject: ['storageDomain'], async apply(scope: Context) { stores = await openAutomationStores(scope, opts); } });
    await plugin.await();
    await expect(openAutomationStores(ctx, opts)).rejects.toMatchObject({ code: 'automation/unavailable' });
    owned = false;
    await expect(stores.routines.create(input)).rejects.toMatchObject({ code: 'automation/read-only' });
    owned = true;
    let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
    const original = unit().putRecord.bind(unit());
    const fault = vi.spyOn(unit(), 'putRecord').mockImplementationOnce(async (...args) => { await barrier; return original(...args); });
    const pending = stores.routines.create(input);
    await Promise.resolve();
    const closed = stores.close(); const twice = stores.close(); release();
    await Promise.all([pending, closed, twice]); fault.mockRestore(); await plugin.dispose();
    await expect(stores.routines.create(input)).rejects.toMatchObject({ code: 'automation/unavailable' });
    expect(() => stores.routines.list()).toThrow(AutomationError);
    const reopened = await openAutomationStores(ctx, opts);
    expect(reopened.routines.list()).toHaveLength(1);
  }));

  it('keeps paused edits paused, allows explicit manual runs, and resumes expired at without moving it', async () => facility(async (ctx) => {
    let now = epoch;
    const stores = await openAutomationStores(ctx, options({ now: () => now }));
    const r = await stores.routines.create({ ...input, enabled: false });
    const edited = await stores.routines.update(r.id, { title: 'Still paused' }, r.revision);
    expect(edited.enabled).toBe(false); expect(edited.nextRunAt).toBeUndefined();
    const active = await stores.runs.reserve((await manual(stores, r.id)).id);
    expect(active.status).toBe('running'); await stopped(stores, active);
    const at = await stores.routines.create({ ...input, enabled: false, rule: { kind: 'at', at: now + 60000 } });
    now += 120000;
    const resumed = await stores.routines.update(at.id, { enabled: true }, at.revision);
    expect(resumed.rule).toEqual(at.rule); expect(resumed.nextRunAt).toBeUndefined();
  }));

  it('cancels unadmitted scheduled work on pause and preserves skipped occurrence dedupe', async () => facility(async (ctx) => {
    let now = epoch;
    const stores = await openAutomationStores(ctx, options({ now: () => now }));
    const r = await stores.routines.create(input); now += 60000;
    const queued = await stores.runs.enqueue({ trigger: 'scheduled', routineId: r.id, ruleRevision: 1, scheduledAt: now, nextRunAt: now + 60000 });
    const current = stores.routines.get(r.id);
    const paused = await stores.routines.update(r.id, { enabled: false }, current.revision);
    expect(await stores.runs.reserve(queued.id)).toMatchObject({ status: 'cancelled', quotaCharged: false });
    const enabled = await stores.routines.update(r.id, { enabled: true }, paused.revision); now += 60000;
    const request = { trigger: 'scheduled' as const, routineId: r.id, ruleRevision: enabled.ruleRevision, scheduledAt: now, nextRunAt: now + 60000, skipReason: 'misfire' };
    const skipped = await stores.runs.enqueue(request);
    expect(skipped).toMatchObject({ status: 'skipped', quotaCharged: false });
    expect(await stores.runs.enqueue(request)).toEqual(skipped);
    expect(stores.runs.control().counts).toEqual([]);
  }));

  it('rebuilds a missing control projection from retained charged runs, keeping its original time zone', async () => facility(async (ctx) => {
    const stores = await openAutomationStores(ctx, options({ config: { quotaTimeZone: 'Asia/Shanghai' } }));
    const reserved = await stores.runs.reserve((await manual(stores)).id); await stopped(stores, reserved); await stores.close();
    const domain = await ctx.storageDomain.open(automationDomain); await domain.table('control').delete('quota'); await domain.close();
    const reopened = await openAutomationStores(ctx, options({ config: {} }));
    expect(reopened.runs.control()).toMatchObject({ quotaTimeZone: 'Asia/Shanghai', counts: [{ botId: 'alpha', date: '2026-10-20', count: 1 }] });
  }));

  it('rejects duplicate persisted keys and unsupported domain versions', async () => facility(async (ctx, root) => {
    const stores = await openAutomationStores(ctx, options());
    const queued = await manual(stores); await stores.close();
    const domain = await ctx.storageDomain.open(automationDomain);
    const duplicate = { ...queued, id: randomUUID() }; await domain.table('runs').put(duplicate.id, duplicate); await domain.close();
    const bytes = await readFile(join(root, 'dsh_bot_automation.json'));
    await expect(openAutomationStores(ctx, options())).rejects.toMatchObject({ code: 'automation/unavailable' });
    expect(await readFile(join(root, 'dsh_bot_automation.json'))).toEqual(bytes);
    const repair = await ctx.storageDomain.open(automationDomain); await repair.table('runs').delete(duplicate.id); await repair.close();
    // A different version must reject rather than migrate the authoritative file.
    const future = { ...automationDomain, version: 2 };
    await expect(ctx.storageDomain.open(future)).rejects.toThrow();
    const valid = await openAutomationStores(ctx, options()); expect(valid.runs.list()).toHaveLength(1);
  }));

  it('serializes concurrent CAS edits and keeps cursor pages stable for equal timestamps', async () => facility(async (ctx) => {
    const stores = await openAutomationStores(ctx, options());
    const r = await stores.routines.create(input);
    const edits = await Promise.allSettled([stores.routines.update(r.id, { title: 'One' }, 1), stores.routines.update(r.id, { title: 'Two' }, 1)]);
    expect(edits.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await Promise.all(Array.from({ length: 5 }, () => manual(stores, r.id)));
    const first = stores.runs.list({ limit: 2 }); const last = first[1]; if (!last) throw new Error('Missing cursor');
    const rest = stores.runs.list({ before: { requestedAt: last.requestedAt, id: last.id } });
    expect(new Set([...first, ...rest].map((r) => r.id)).size).toBe(5);
    expect(stores.runs.list({ botId: 'beta' })).toEqual([]);
  }));

  it('validates adopted Config defaults and rejects malformed reservation shapes', () => {
    expect(configSchema.parse({})).toMatchObject({ maxConcurrentRuns: 2, maxRunsPerBotPerDay: 20, maxQueuedRuns: 64,
      runTimeoutMs: 900000, catchUpMaxAgeMs: 86400000, sweepIntervalMs: 60000, delegateMaxDepth: 1 });
    expect(Reflect.apply(Config, undefined, [{}])).toMatchObject({ maxConcurrentRuns: 2, maxRunsPerBotPerDay: 20 });
    for (const invalid of [{ maxConcurrentRuns: 0 }, { quotaTimeZone: 'bad' }, { delegateMaxDepth: 2 }, { maxQueuedRuns: 1.5 }]) {
      expect(configSchema.safeParse(invalid).success).toBe(false);
    }
    expect(runRecordSchema.safeParse({ status: 'reserved' }).success).toBe(false);
  });

  it('rebuilds dedupe/quota/recovery in a fresh Node process with only published backend APIs', async () => facility(async (_ctx, root) => {
    const worker = fileURLToPath(new URL('./automation-restart.mjs', import.meta.url));
    const first = spawnSync(process.execPath, [worker, root, 'write'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: fileURLToPath(new URL('../../../.dsh-dev/', import.meta.url)) } });
    expect(first.status, first.stderr).toBe(0);
    const second = spawnSync(process.execPath, [worker, root, 'read'], { encoding: 'utf8' });
    expect(second.status, second.stderr).toBe(0);
    const initial = JSON.parse(first.stdout.trim()); const reopened = JSON.parse(second.stdout.trim());
    expect(reopened).toEqual({ id: initial.id, sessionId: initial.sessionId, requestId: initial.requestId,
      count: 1, total: 1, status: 'recovery_needed' });
  }));
});
