import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export const name = 'release-reinstall-probe';
export const inject = ['loader', 'dshBots'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const run = (async () => {
      await ctx.loader.await();
      await ctx.dshBots.waitUntilReady();
      const bots = await ctx.dshBots.list();
      assert.deepEqual(bots.map(bot => bot.id).sort(), ['alpha', 'beta']);
      await writeFile(resolve(config.outputDir, 'reinstalled-host.json'), JSON.stringify({
        status: 'PASS', bots: bots.map(bot => ({ id: bot.id, createdAt: bot.createdAt })),
      }, null, 2));
      console.log('P34_RELEASE_REINSTALL_READY');
    })().catch(async error => {
      await writeFile(resolve(config.outputDir, 'reinstall-error.json'), JSON.stringify({ error: String(error) }));
      console.log('P34_RELEASE_REINSTALL_FAILED');
    });
    return async () => { await run; };
  });
}
