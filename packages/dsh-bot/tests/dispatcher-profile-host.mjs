/** Test-only observer of the installed production Dispatcher and RunExecutor. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export const name = 't14-probes';
export const inject = ['loader', 'dshBots', 'dshBotAutomation', 'dshBotAutomationStores', 'dshBotDispatcher',
  'dshBotRoutines', 'agents', 'sessions', 'sessionController', 'workspaceRegistry'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let stopping = false;
    const save = (name, value) => writeFile(resolve(config.outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
    const wait = async (check, timeout = 80000) => {
      const end = Date.now() + timeout;
      while (!stopping && Date.now() < end) { const value = await check(); if (value) return value; await delay(25); }
      throw new Error('Host dispatcher probe deadline');
    };
    const task = (async () => {
      await ctx.loader.await();
      if (stopping) return;
      assert.equal(new URL(config.baseURL).hostname, '127.0.0.1');
      await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      const stores = ctx.dshBotAutomationStores;
      const evidence = [];
      async function finished(routineId, count) {
        await wait(() => stores.runs.list({ routineId }).filter(r => r.status === 'succeeded').length === count);
        const run = stores.runs.list({ routineId }).find(r => r.status === 'succeeded');
        const inspection = await ctx.sessionController.inspect(run.sessionId);
        const workspace = ctx.workspaceRegistry.get(run.workspaceId);
        assert.equal(inspection.meta.cwd, workspace.path);
        assert.equal(inspection.meta.agentPreset, run.snapshot.presetId);
        assert.ok(workspace.sessionIds.includes(run.sessionId));
        assert.ok(inspection.events.some(e => e.type === 'turn/end' && e.data.reason.kind === 'completed'));
        assert.ok(inspection.events.some(e => e.type === 'session/title' && e.data.title.startsWith('[Routine]')));
        await save(`session-${run.id}.json`, inspection);
        evidence.push({ run, workspace: { id: workspace.id, title: workspace.title, sessionIds: workspace.sessionIds } });
        return run;
      }
      if (config.phase === 'first') {
        const routine = await ctx.dshBotRoutines.create({ botId: 'assistant', title: 'T14 every60', prompt: 'Reply with the mock completion text.',
          timeZone: 'UTC', rule: { kind: 'every', everySeconds: 60 } });
        await save('created.json', routine);
        const run = await finished(routine.id, 1);
        assert.equal(run.scheduledAt, routine.nextRunAt);
        assert.ok(run.startedAt >= routine.createdAt + 60000, 'real 60 seconds elapsed');
        const current = stores.routines.get(routine.id);
        const paused = await ctx.dshBotRoutines.update(routine.id, { enabled: false }, current.revision);
        const started = Date.now();
        console.log('T14_DISABLED_OBSERVATION');
        await delay(Math.max(0, current.nextRunAt - Date.now()) + 1500);
        assert.equal(stores.runs.list({ routineId: routine.id }).length, 1);
        await save('disabled.json', { paused, started, observedUntil: Date.now(), passedDueAt: current.nextRunAt, runs: 1 });
        const operation = randomUUID();
        const [manual, duplicate] = await Promise.all([
          ctx.dshBotRoutines.runNow(routine.id, operation), ctx.dshBotRoutines.runNow(routine.id, operation),
        ]);
        assert.equal(manual.id, duplicate.id);
        await finished(routine.id, 2);
        assert.deepEqual(stores.routines.get(routine.id), paused);
        const enabled = await ctx.dshBotRoutines.update(routine.id, { enabled: true }, paused.revision);
        await save('restart-target.json', enabled);
        await save('first.json', evidence);
      } else {
        const saved = JSON.parse(await readFile(resolve(config.outputDir, 'restart-target.json'), 'utf8'));
        const first = JSON.parse(await readFile(resolve(config.outputDir, 'first.json'), 'utf8'));
        for (const entry of first) {
          assert.deepEqual(stores.runs.get(entry.run.id), entry.run);
        }
        const caught = await finished(saved.id, 3);
        assert.equal(caught.trigger, 'scheduled');
        assert.ok(caught.scheduledAt >= saved.nextRunAt + 60000, 'at least two missed due points compressed');
        assert.ok(caught.requestedAt - caught.scheduledAt < 60000);
        assert.ok(caught.requestedAt - caught.scheduledAt <= 86400000);
        assert.equal(stores.runs.list({ routineId: saved.id }).length, 3);
        assert.equal(stores.routines.get(saved.id).anchorAt, saved.anchorAt);
        await save('cold-before-pause.json', evidence);
        await save('pause-ready.json', { pid: process.pid, nextRunAt: stores.routines.get(saved.id).nextRunAt });
        console.log('T14_PAUSE_READY');
        const resumed = await finished(saved.id, 4);
        assert.ok(resumed.scheduledAt > caught.scheduledAt);
        const current = stores.routines.get(saved.id);
        await ctx.dshBotRoutines.update(saved.id, { enabled: false }, current.revision);
        await save('cold.json', evidence);
      }
      console.log('T14_DONE');
    })().catch(async error => {
      await save(`${config.phase}-fatal.json`, { error: String(error), stack: error.stack }); console.log('T14_FAILED');
    });
    return async () => { stopping = true; await task; await save(`${config.phase}-disposed.json`, { disposed: true }); };
  });
}
