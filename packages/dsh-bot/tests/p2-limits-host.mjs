/** T17 test-only observer. All execution uses the installed production services. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export const name = 'p2-limits-probe';
export const inject = ['loader', 'dshBots', 'dshBotMemory', 'dshBotAutomation', 'dshBotAutomationStores', 'dshBotDispatcher',
  'dshBotRoutines', 'sessionController', 'workspaceRegistry'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let stopping = false;
    const save = (name, value) => writeFile(resolve(config.outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
    const wait = async check => {
      const until = Date.now() + 90000;
      while (!stopping && Date.now() < until) { const value = await check(); if (value) return value; await delay(25); }
      throw new Error('P2 limits deadline');
    };
    const task = (async () => {
      await ctx.loader.await();
      await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      const stores = ctx.dshBotAutomationStores;
      const routines = ctx.dshBotRoutines;
      async function completed(id) {
        const run = await wait(() => { const r = stores.runs.get(id); return r.status === 'succeeded' && r; });
        const session = await ctx.sessionController.inspect(run.sessionId);
        const workspace = ctx.workspaceRegistry.get(run.workspaceId);
        assert.equal(session.meta.cwd, workspace.path);
        assert.equal(session.meta.agentPreset, run.snapshot.presetId);
        assert.ok(workspace.sessionIds.includes(run.sessionId));
        assert.ok(session.events.some(e => e.type === 'turn/end' && e.data.reason.kind === 'completed'));
        await save(`session-${id}.json`, { run, session });
        return run;
      }
      if (config.phase === 'first') {
        await ctx.dshBots.create({ id: 'limits-bot', name: 'P2 limits fixture' });
        await ctx.dshBotMemory.save('limits-bot', { content: 'P2 retained memory fixture', kind: 'fact', tags: ['p2'] });
        const create = title => routines.create({ botId: 'limits-bot', title, prompt: 'P2_LIMITS',
          rule: { kind: 'every', everySeconds: 60 }, enabled: false, timeZone: 'UTC' });
        const records = await Promise.all(['one', 'two', 'three'].map(create));
        const accepted = await Promise.all(records.map(r => routines.runNow(r.id, randomUUID())));
        await wait(async () => (await (await fetch(`${config.baseURL}/gate-status`)).json()).held === 2);
        const pending = accepted.map(r => stores.runs.get(r.id));
        assert.equal(pending.filter(r => r.slotHeld).length, 2);
        const queued = pending.find(r => r.status === 'queued'); assert.ok(queued);
        await assert.rejects(stores.runs.reserve(queued.id), { code: 'automation/busy' });
        assert.equal(stores.runs.get(queued.id).step, 'queued');
        await save('concurrency.json', { status: 'PASS', maxConcurrentRuns: 2, rejectedCode: 'automation/busy', runs: pending });
        assert.equal((await fetch(`${config.baseURL}/release`, { method: 'POST' })).status, 200);
        const completedRuns = await Promise.all(accepted.map(r => completed(r.id)));
        for (let i = 3; i < 20; i++) {
          const run = await routines.runNow(records[0].id, randomUUID());
          completedRuns.push(await completed(run.id));
        }
        const extra = await routines.runNow(records[0].id, randomUUID());
        await wait(() => stores.runs.get(extra.id).status === 'skipped');
        const rejected = stores.runs.get(extra.id);
        assert.equal(rejected.skipReason, 'quota'); assert.equal(rejected.quotaCharged, false);
        assert.equal(rejected.workspaceId, undefined);
        assert.equal(completedRuns.length, 20);
        assert.equal(stores.runs.control().counts.find(c => c.botId === 'limits-bot').count, 20);
        await save('quota.json', { status: 'PASS', maxRunsPerBotPerDay: 20, completedRuns, rejected, control: stores.runs.control() });
        // These are future records now. The offline driver ages only this disposable fixture after shutdown.
        const future = Date.now() + 3600000;
        const input = { botId: 'researcher', prompt: 'P2_CATCHUP', timeZone: 'UTC' };
        const expired = await routines.create({ ...input, title: 'expired-24h', rule: { kind: 'at', at: future } });
        const within = await routines.create({ ...input, title: 'within-24h', rule: { kind: 'at', at: future } });
        const paused = await routines.create({ ...input, title: 'paused-period', rule: { kind: 'every', everySeconds: 60 }, enabled: false });
        await save('fixtures.json', { expired, within, paused });
      } else {
        const fixtures = JSON.parse(await readFile(resolve(config.outputDir, 'aged-fixtures.json'), 'utf8'));
        await wait(() => stores.runs.list({ routineId: fixtures.within.id }).some(r => r.status === 'succeeded'));
        const expired = stores.runs.list({ routineId: fixtures.expired.id });
        assert.equal(expired.length, 1); assert.equal(expired[0].skipReason, 'catch_up_expired');
        assert.equal(expired[0].quotaCharged, false); assert.equal(expired[0].workspaceId, undefined);
        const within = stores.runs.list({ routineId: fixtures.within.id });
        assert.equal(within.length, 1); await completed(within[0].id);
        assert.ok(within[0].requestedAt - within[0].scheduledAt < 86400000);
        assert.ok(expired[0].requestedAt - expired[0].scheduledAt > 86400000);
        assert.deepEqual(stores.routines.get(fixtures.paused.id), fixtures.paused);
        assert.equal(stores.runs.list({ routineId: fixtures.paused.id }).length, 0);
        const resumed = await routines.update(fixtures.paused.id, { enabled: true }, fixtures.paused.revision);
        assert.ok(resumed.nextRunAt >= resumed.updatedAt + 60000);
        await ctx.dshBotDispatcher.tick();
        assert.equal(stores.runs.list({ routineId: fixtures.paused.id }).length, 0);
        await routines.update(resumed.id, { enabled: false }, resumed.revision);
        await save('catchup.json', { status: 'PASS', fixture: 'offline-aged timestamps, real Host recovery and executor', expired, within, resumed });
        const quota = JSON.parse(await readFile(resolve(config.outputDir, 'quota.json'), 'utf8'));
        for (const run of quota.completedRuns) assert.deepEqual(stores.runs.get(run.id), run);
        const records = stores.routines.list({ botId: 'limits-bot' });
        const extra = await routines.runNow(records[0].id, randomUUID());
        await wait(() => stores.runs.get(extra.id).status === 'skipped');
        assert.equal(stores.runs.get(extra.id).skipReason, 'quota');
        await save('restart.json', { status: 'PASS', retainedRuns: quota.completedRuns.length, quotaStillRejected: stores.runs.get(extra.id) });
      }
      console.log('P2_LIMITS_DONE');
    })().catch(async error => { await save(`${config.phase}-fatal.json`, { error: String(error), stack: error.stack }); console.log('P2_LIMITS_FAILED'); });
    return async () => { stopping = true; await task; await save(`${config.phase}-disposed.json`, { disposed: true }); };
  });
}
