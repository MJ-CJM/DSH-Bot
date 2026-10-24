import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export const name = 'release-upgrade-probe';
export const inject = ['loader', 'dshBots', 'dshBotAutomation'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const run = (async () => {
      await ctx.loader.await();
      await ctx.dshBots.waitUntilReady();
      const deadline = Date.now() + 30000;
      while ((await ctx.dshBotAutomation.status()).state !== 'ready') {
        assert.ok(Date.now() < deadline, 'Host composition did not become ready');
        await delay(25);
      }
      if (config.phase === 'old') {
        await ctx.dshBots.create({ id: 'upgrade-bot', name: 'Synthetic upgrade Bot', template: 'minimal',
          persona: { prefix: 'Synthetic upgrade fixture; no model prompts.' } });
        await ctx.dshBots.memoryFor('upgrade-bot').save({ content: 'Keep this synthetic pinned preference.',
          kind: 'preference', tags: ['upgrade'], pinned: true }, { by: 'user', at: Date.now() });
      }
      const main = await ctx.dshBots.openConversation('upgrade-bot');
      const bots = await ctx.dshBots.list();
      const memories = await ctx.dshBots.memoryFor('upgrade-bot').list();
      const snapshot = { bots, memories, main };
      if (config.phase === 'new') {
        assert.deepEqual(snapshot, JSON.parse(await readFile(resolve(config.outputDir, 'old-state.json'))));
      }
      await writeFile(resolve(config.outputDir, `${config.phase}-state.json`), JSON.stringify(snapshot, null, 2));
      console.log('P34_UPGRADE_READY');
    })().catch(async error => {
      await writeFile(resolve(config.outputDir, `${config.phase}-error.json`), JSON.stringify({ error: String(error) }));
      console.log('P34_UPGRADE_FAILED');
    });
    return async () => { await run; };
  });
}
