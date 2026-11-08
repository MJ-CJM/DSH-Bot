import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const name = 'pb01-coordinator-check';
export const inject = ['dshBotProactive', 'webServer'];
const commandId = '8d194260-a2e7-4210-b12a-20cac076133a';
const command = {
  kind: 'ingest-batch',
  sourceId: 'pb01-fixture',
  generation: 1,
  expectedCheckpoint: null,
  nextCheckpoint: 'one',
  events: [
    {
      nativeId: 'synthetic-build',
      nativeRevision: '1',
      threadId: 'synthetic-main',
      occurredAt: '2026-11-07T10:00:00.000Z',
      summary: 'Synthetic CI check failed',
    },
  ],
};
export function apply(ctx, config) {
  ctx.effect(() => {
    const stop = new AbortController();
    const work = (async () => {
      const deadline = AbortSignal.any([
        stop.signal,
        AbortSignal.timeout(15000),
      ]);
      let state = await ctx.dshBotProactive.status();
      while (state.state === 'starting') {
        await delay(25, undefined, { signal: deadline });
        state = await ctx.dshBotProactive.status();
      }
      assert.equal(state.state, 'ready');
      assert.equal(state.capabilities.automaticSubagent, false);
      const result = await ctx.dshBotProactive.submit(commandId, command);
      assert.equal(result.kind, 'receipt');
      assert.ok(result.receipt);
      const query = await ctx.dshBotProactive.receipt(commandId);
      assert.equal(query.kind, 'receipt');
      assert.equal(query.receipt.receiptId, result.receipt.receiptId);
      const ci = await ctx.dshBotProactive.observeCi(
        '45c3b386-b560-454f-b3ba-61c8bf42b4f7',
        { repository: 'test/sample', branch: 'main', generation: 1 },
        {
          complete: true,
          before: null,
          after: 'ci-page',
          rows: [
            {
              repository: 'test/sample',
              branch: 'main',
              runId: '42',
              job: 'tests',
              commit: 'a'.repeat(40),
              observedAt: new Date((await stat(config.outputDir)).birthtimeMs).toISOString(),
              attempt: 1,
              conclusion: 'failure',
            },
          ],
        },
      );
      assert.equal(ci.kind, 'receipt');
      assert.equal(ci.receipt.status, result.receipt.status);
      assert.equal((await ctx.dshBotProactive.suggestions()).length, 1);
      assert.deepEqual(
        await ctx.dshBotProactive.ciCheckpoint({
          repository: 'test/sample',
          branch: 'main',
          generation: 1,
        }),
        { generation: 1, checkpoint: 'ci-page' },
      );
      const after = await ctx.dshBotProactive.status();
      assert.equal(after.snapshot.triggerCount, 2);
      assert.equal(after.snapshot.suggestionCount, 1);
      assert.equal(after.snapshot.ticketCount, 0);
      await writeFile(
        join(
          config.outputDir,
          `${result.receipt.status === 'committed' ? 'first' : 'cold'}.json`,
        ),
        JSON.stringify(
          {
            pid: process.pid,
            after,
            receipt: result.receipt,
            ciReceipt: ci.receipt,
          },
          null,
          2,
        ),
      );
      console.log('B4_WEB_READY');
    })().catch(async (error) => {
      await writeFile(join(config.outputDir, 'pb01-error.txt'), String(error));
      console.error('B4_WEB_FAILED');
    });
    return async () => {
      stop.abort();
      await work;
    };
  });
}
