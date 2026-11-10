import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LoopbackAdapter } from './deepening/loopback-adapter.mjs';
import { installSubmissionFault } from '../../../scripts/proactive/fault-points.mjs';

export const name = 'proactive-warm-recovery-fixture';
export const inject = ['loader', 'dshBots', 'llm'];
export function apply(ctx, config) {
  const match = /^proactive-warm-(F09|F13A)-([a-f0-9]{32})$/.exec(config.suite); assert.ok(match);
  const [, point, nonce] = match;
  ctx.effect(() => {
    assert.equal(ctx.llm.listProviders().length, 0);
    const adapter = new LoopbackAdapter(config.endpoint), releaseAdapter = ctx.llm.registerAdapter(['dp-loopback'], adapter);
    const stop = new AbortController(); let releaseFault;
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      let service;
      const deadline = Date.now() + 45000;
      async function until(read) {
        while (!stop.signal.aborted) {
          let value;
          try { value = await read(); } catch { /* Coordinator temporarily unavailable is the injected condition. */ }
          if (value) return value;
          assert.ok(Date.now() < deadline, 'Warm coordinator recovery timed out');
          await delay(25, undefined, { signal: stop.signal });
        }
        stop.signal.throwIfAborted();
      }
      const initial = await until(async () => {
        service = ctx.get('dshBotProactive'); if (!service) return false;
        const state = await service.status(); return state.state === 'ready' && state;
      });
      const bot = await ctx.dshBots.create({ id: 'warm-fixture', name: 'Warm recovery fixture', template: 'minimal' });
      const owner = { botId: bot.id, botCreatedAt: bot.createdAt }, scope = { repository: 'fixture/warm', branch: 'main', generation: 1 };
      const observe = async (job, before, after) => {
        const reply = await service.observeCi(randomUUID(), scope, { complete: true, before, after, rows: [{
          repository: scope.repository, branch: scope.branch, job, runId: before === null ? '1' : '2', commit: 'c'.repeat(40),
          observedAt: new Date().toISOString(), attempt: 1, conclusion: 'failure',
        }] }); assert.equal(reply.kind, 'receipt');
        const row = (await service.suggestions(owner)).find(row => row.job === job); assert.ok(row); return row;
      };
      const accept = async row => {
        const result = await service.accept(randomUUID(), { decisionId: row.id, expectedRevision: row.revision,
          sourceId: row.sourceId, policyVersion: row.policyVersion, approved: true,
          target: { bot: owner, botUpdatedAt: bot.updatedAt, provider: 'dp-loopback', model: 'fixture' } });
        assert.equal(result.kind, 'receipt');
      };
      const primary = await observe('warm-primary', null, 'warm-v1');
      releaseFault = await installSubmissionFault({ service, dir: config.outputDir, nonce, point, signal: stop.signal });
      await writeFile(join(config.outputDir, 'warm-ready.json'), JSON.stringify({ pid: process.pid, storeId: initial.snapshot.storeId, point, nonce }));
      console.log('B4_WEB_READY');
      await accept(primary);
      const expected = point === 'F13A' ? ['delivered'] : ['unknown', 'denied'];
      const recovered = await until(async () => (await service.workList()).find(row => row.decisionId === primary.id && expected.includes(row.state)));
      if (point === 'F09') {
        assert.equal(recovered.inputId, undefined); assert.equal(recovered.evidence, undefined);
      }
      const restored = await service.status();
      assert.equal(restored.snapshot.storeId, initial.snapshot.storeId);
      const callsBeforeNewEvent = adapter.count;
      assert.equal(callsBeforeNewEvent, point === 'F13A' ? 1 : 0);
      const checkpoint = await service.ciCheckpoint(scope); assert.equal(checkpoint.checkpoint, 'warm-v1');
      const followup = await observe('warm-new-fact', checkpoint.checkpoint, 'warm-v2');
      await accept(followup);
      const delivered = await until(async () => (await service.workList()).find(row => row.decisionId === followup.id && row.state === 'delivered'));
      assert.equal(adapter.count, callsBeforeNewEvent + 1);
      await writeFile(join(config.outputDir, 'warm-result.json'), JSON.stringify({ status: 'PASS', point, nonce,
        pid: process.pid, storeId: restored.snapshot.storeId, recovered, delivered,
        callsBeforeNewEvent, callsAfterNewEvent: adapter.count,
        scope: 'same Host PID, exact child coordinator SIGKILL, loopback model only' }, null, 2));
    })().catch(async error => {
      if (stop.signal.aborted) return;
      await writeFile(join(config.outputDir, 'warm-error.txt'), String(error.stack ?? error));
      console.error('B4_WEB_FAILED');
    });
    return async () => { stop.abort(); releaseFault?.(); await run; releaseAdapter(); };
  });
}
