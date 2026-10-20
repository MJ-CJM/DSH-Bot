/** Test-only Host observer; imports the installed product through its activated services. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export const name = 't13-probes';
export const inject = ['loader', 'dshBots', 'dshBotAutomation', 'dshBotAutomationStores', 'dshBotExecutor',
  'agents', 'sessions', 'sessionController', 'workspaceRegistry', 'jobs'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let started = false; let stopping = false;
    const save = (name, value) => writeFile(resolve(config.outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
    const wait = async check => {
      const end = Date.now() + 30000;
      while (!stopping && Date.now() < end) { const value = await check(); if (value) return value; await delay(10); }
      throw new Error('Host probe deadline');
    };
    const task = (async () => {
      await ctx.loader.await();
      if (stopping) return;
      started = true;
      assert.equal(new URL(config.baseURL).hostname, '127.0.0.1');
      await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      const stores = ctx.dshBotAutomationStores;
      const executor = ctx.dshBotExecutor;
      const evidence = [];
      if (config.phase === 'cold') {
        const prior = JSON.parse(await readFile(resolve(config.outputDir, 'first.json'), 'utf8'));
        for (const entry of prior) {
          const row = stores.runs.get(entry.run.id);
          assert.equal(row.status, entry.label === 'crash-reservation' ? 'recovery_needed' : entry.run.status);
          assert.equal(row.sessionId, entry.run.sessionId); assert.equal(row.requestId, entry.run.requestId);
          if (entry.label === 'crash-reservation') {
            assert.equal(row.slotHeld, true);
            assert.deepEqual(await executor.execute(row.id), row);
          } else {
            const inspection = await ctx.sessionController.inspect(row.sessionId);
            assert.ok(inspection.events.some(e => e.type === 'session/title' && e.data.title.startsWith('[Routine]')));
          }
          evidence.push({ label: entry.label, run: row });
        }
      } else {
        async function queued(label) {
          const routine = await stores.routines.create({ botId: 'assistant', title: label, prompt: `T13 ${label}`,
            timeZone: 'UTC', rule: { kind: 'every', everySeconds: 60 } });
          return stores.runs.enqueue({ trigger: 'manual', routineId: routine.id, operationId: randomUUID() });
        }
        async function record(label, row) {
          const inspection = await ctx.sessionController.inspect(row.sessionId);
          const workspace = ctx.workspaceRegistry.get(row.workspaceId);
          assert.equal(inspection.meta.cwd, workspace.path);
          assert.equal(inspection.meta.agentPreset, row.snapshot.presetId);
          assert.ok(workspace.sessionIds.includes(row.sessionId));
          assert.ok(inspection.events.some(e => e.type === 'session/title' && e.data.title.startsWith(`[Routine] ${label} · `)));
          await save(`session-${label}.json`, inspection);
          evidence.push({ label, run: row, group: { id: workspace.id, title: workspace.title, sessionIds: workspace.sessionIds } });
        }
        for (const [label, status] of [['success', 'succeeded'], ['error', 'failed'], ['max-tokens', 'failed'], ['timeout', 'timed_out']]) {
          const row = await queued(label);
          const [finished, duplicate] = await Promise.all([executor.execute(row.id), executor.execute(row.id)]);
          assert.equal(finished.status, status, JSON.stringify(finished)); assert.deepEqual(finished, duplicate);
          assert.equal(finished.slotHeld, false); await record(label, finished);
        }
        const cancel = await queued('cancel');
        const pending = executor.execute(cancel.id);
        await wait(() => {
          const agent = ctx.agents.get(stores.runs.get(cancel.id).sessionId);
          return agent?.session.snapshotEvents().some(e => e.type === 'user/message');
        });
        // Ensure the stalled HTTP request is actually in-flight before cancelling.
        await delay(150);
        assert.equal((await executor.cancel(cancel.id)).status, 'cancelled');
        await record('cancel', await pending);

        const background = await queued('background');
        const result = executor.execute(background.id);
        const agent = await wait(() => ctx.agents.get(stores.runs.get(background.id).sessionId));
        let settle;
        const job = ctx.jobs.start({ owner: agent.id, kind: 't13', label: 'controlled background',
          run: () => ({ done: new Promise(resolve => { settle = resolve; }), cancel: () => settle({ status: 'killed' }) }) });
        const joined = ctx.jobs.wait(job, 10000, agent.id);
        await wait(() => agent.session.snapshotEvents().some(e => e.type === 'turn/end'));
        await delay(100);
        assert.equal(stores.runs.get(background.id).status, 'running', 'first completed turn cannot pass a held job');
        const message = createUserMessage({ content: [{ type: 'text', text: 'T13 background result is now available' }],
          source: { kind: 't13-notice', form: 'notice', summary: 'background result' } });
        agent.followup(message);
        settle({ status: 'completed', result: 'background result' }); await joined;
        const finished = await result;
        assert.equal(finished.status, 'succeeded'); assert.equal(finished.execution.turns.length, 2);
        await record('background', finished);

        const crash = await stores.runs.reserve((await queued('crash-reservation')).id);
        evidence.push({ label: 'crash-reservation', run: crash });
      }
      await save(`${config.phase}.json`, evidence);
      console.log('T13_DONE');
    })().catch(async error => {
      await save(`${config.phase}-fatal.json`, { error: String(error), stack: error.stack }); console.log('T13_FAILED');
    });
    return async () => {
      stopping = true; if (started) await task;
      await save(`${config.phase}-disposed.json`, { disposed: true });
    };
  });
}
