import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export const inject = ['loader', 'dshBots', 'dshBotAutomation'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let started = false;
    const task = (async () => {
      await ctx.loader.await(); started = true;
      let status;
      for (let i = 0; i < 500; i++) {
        status = await ctx.dshBotAutomation.status();
        if (status.state !== 'starting') break;
        await delay(10);
      }
      assert.equal(status.state, 'read_only');
      await assert.rejects(ctx.dshBots.create({ id: 'forbidden', name: 'Forbidden' }));
      for (const domain of ['dsh_bot', 'dsh_bot_automation']) {
        await assert.rejects(access(resolve(config.outputDir, 'storages', `${domain}.json`)), { code: 'ENOENT' });
      }
      await writeFile(resolve(config.outputDir, 'follower.json'), JSON.stringify({ status, businessDomainsOpened: false, writesRejected: true }, null, 2));
      console.log('T13_DONE');
    })().catch(async error => {
      await writeFile(resolve(config.outputDir, 'follower-fatal.json'), JSON.stringify({ error: String(error), stack: error.stack }));
      console.log('T13_FAILED');
    });
    return async () => {
      if (started) await task;
      await writeFile(resolve(config.outputDir, 'follower-disposed.json'), JSON.stringify({ disposed: true }));
    };
  });
}
