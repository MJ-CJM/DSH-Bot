import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as workflow from './proactive-workflow-profile.mjs';
import { installSubmissionFault, faultPoints } from '../../../scripts/proactive/fault-points.mjs';

export const name = 'proactive-fault-fixture';
export const inject = workflow.inject;

/** Synthetic owner action only. Uses the packaged service and existing loopback fixture. */
export function apply(ctx, config) {
  const match = /^proactive-fault-(F08|F09|F10|F13A|F13B)-(control|inject|recover)-([a-f0-9]{32})(-budget)?$/.exec(config.suite);
  assert.ok(match, 'Exact fault phase and nonce required');
  const [, point, phase, nonce, budget] = match;
  assert.ok(faultPoints[point]);
  if (budget) ctx.effect(() => ctx.on('llm/stream', async function* (options, next) {
    for await (const chunk of next()) {
      if (options.provider === 'dp-loopback' && chunk.type === 'finish')
        yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } };
      yield chunk;
    }
  }));
  workflow.apply(ctx, { ...config, suite: 'proactive-workflow' });
  ctx.effect(() => {
    const stop = new AbortController();
    let release;
    const run = (async () => {
      await ctx.loader.await();
      const deadline = Date.now() + 25000;
      let ready;
      do {
        ready = await readFile(join(config.outputDir, 'workflow-ready.json'), 'utf8').then(JSON.parse).catch(() => undefined);
        if (ready?.pid === process.pid) break;
        assert.ok(Date.now() < deadline, 'Workflow readiness timeout');
        await delay(25, undefined, { signal: stop.signal });
      } while (!stop.signal.aborted);
      const service = ctx.get('dshBotProactive');
      assert.ok(service);
      if (phase !== 'recover') {
        release = await installSubmissionFault({ service, dir: config.outputDir, nonce, point, signal: stop.signal });
        const bot = await ctx.dshBots.get('fixture-ci');
        const owner = { botId: bot.id, botCreatedAt: bot.createdAt };
        const row = (await service.suggestions(owner)).find(item => item.title.includes('accept-case'));
        assert.ok(row, 'One fixed CI suggestion must be available');
        let responsibility;
        if (budget) {
          const changed = await service.changeResponsibility({ commandId: randomUUID(), mutation: {
            kind: 'create', id: `fault-budget-${point.toLowerCase()}`, owner,
            draft: { name: 'Fault recovery token budget', mode: 'suggest',
              source: { id: row.sourceId, generation: 1, repository: 'fixture/demo', branch: 'main' },
              action: 'inspect-ci-result', conditions: { jobs: ['accept-case'] },
              target: { bot: owner, botUpdatedAt: bot.updatedAt, provider: 'dp-loopback', model: 'fixture' },
              limits: { dailyRequests: 2, dailyTokens: 65536, taskTokens: 32768 },
              acceptance: { goal: 'Inspect the exact CI fact', deliverables: ['Evidence summary'], checks: [{ id: 'source', title: 'Same source', kind: 'both' }] },
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
          } });
          assert.equal(changed.kind, 'applied');
          responsibility = { id: changed.responsibility.id, revision: changed.responsibility.revision };
        }
        await writeFile(join(config.outputDir, 'fault-profile-ready.json'), JSON.stringify({ point, phase, nonce, pid: process.pid }));
        const reply = await service.accept(randomUUID(), { decisionId: row.id, expectedRevision: row.revision,
          sourceId: row.sourceId, policyVersion: row.policyVersion, approved: true,
          target: { bot: owner, botUpdatedAt: bot.updatedAt, provider: 'dp-loopback', model: 'fixture' },
          ...(responsibility ? { responsibility } : {}) });
        assert.equal(reply.kind, 'receipt');
      }
      while (!stop.signal.aborted) {
        const work = await service.workList();
        const row = work.find(item => item.title.includes('accept-case'));
        if (row && ['delivered', 'unknown', 'failed', 'denied'].includes(row.state)) {
          const responsibility = row.responsibility
            ? (await service.responsibilities(row.target.bot)).find(item => item.responsibility.id === row.responsibility.id) : undefined;
          await writeFile(join(config.outputDir, `fault-${phase}-result.json`), JSON.stringify({
            point, phase, nonce, pid: process.pid, work: row, status: await service.status(),
            ...(responsibility ? { responsibility } : {}),
          }, null, 2));
          return;
        }
        assert.ok(Date.now() < deadline, 'Fault run did not reach a terminal receipt');
        await delay(50, undefined, { signal: stop.signal });
      }
    })().catch(async error => {
      if (stop.signal.aborted) return;
      await writeFile(join(config.outputDir, 'fault-error.txt'), String(error.stack ?? error));
      console.error('PROACTIVE_FAULT_FAILED');
    });
    return async () => { stop.abort(); release?.(); await run; };
  });
}
