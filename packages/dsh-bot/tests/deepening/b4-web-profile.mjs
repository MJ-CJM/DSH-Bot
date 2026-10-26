import '../../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { LoopbackAdapter } from './loopback-adapter.mjs';
export const name = 'b4-web-fixture';
export const inject = ['loader', 'dshBots', 'sessionController', 'llm'];
export function apply(ctx, config) {
  ctx.effect(() => {
    assert.equal(ctx.llm.listProviders().length, 0);
    const off = ctx.llm.registerAdapter(['dp-loopback'], new LoopbackAdapter(config.endpoint));
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      const deadline = Date.now() + 30000;
      while (!ctx.dshBots.memoryForget) { assert.ok(Date.now() < deadline); await delay(20); }
      const sessions = {};
      for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) for (const width of [1360, 390]) {
        const id = `${language}-${theme}-${width}`;
        await ctx.dshBots.create({ id, name: id, template: 'minimal',
          model: { provider: 'dp-loopback', model: 'fixture' }, persona: { prefix: 'Synthetic browser fixture.' } });
        const main = await ctx.dshBots.openConversation(id);
        const { agent } = await ctx.sessionController.resolveAgent(main.sessionId);
        assert.ok(agent);
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Synthetic initial turn' }], source: { kind: 'user' } }));
        await agent.whenIdle();
        await ctx.dshBots.memoryFor(id).save({ content: `SYNTHETIC_BROWSER_TARGET_${id}` });
        sessions[id] = main.sessionId;
      }
      if (config.suite === 'root-warning') {
        await mkdir(ctx.dshBots.memoryForget.root, { recursive: true });
        await writeFile(join(ctx.dshBots.memoryForget.root, 'AGENTS.md'), 'Synthetic root instruction fixture.');
      }
      await writeFile(join(config.outputDir, 'web-fixture.json'), JSON.stringify({ sessions }));
      console.log('B4_WEB_READY');
    })().catch(async error => {
      await writeFile(join(config.outputDir, 'web-fixture-error.json'), JSON.stringify({ error: String(error), stack: error.stack }));
      console.log('B4_WEB_FAILED');
    });
    return async () => { await run; off(); };
  });
}
