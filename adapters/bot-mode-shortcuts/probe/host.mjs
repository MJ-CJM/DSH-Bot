import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve(process.cwd(), 'packages/dsh-bot/package.json'));
const { LlmAdapter, createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));

// Test-only public plugin entry: never writes product sources or registers real models.
export const name = 'bot-mode-shell-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'clientModules'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let release, disposed = false;
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      assert.deepEqual(ctx.llm.listProviders(), []);
      class Adapter extends LlmAdapter {
        async listModels(provider) { return [{ provider, id: 'fixture', name: 'Shell spike synthetic model' }]; }
        async *stream() {
          const text = 'BOT_MODE_SHELL_NATIVE_REPLY';
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text };
          yield { type: 'block-end', index: 0, block: { type: 'text', text } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
      release = ctx.llm.registerAdapter(['dp-loopback'], new Adapter());
      if (!(await ctx.dshBots.status()).some(bot => bot.id === 'shell-native')) await ctx.dshBots.create({ id: 'shell-native', name: 'Shell Native Bot', template: 'minimal',
        model: { provider: 'dp-loopback', model: 'fixture' }, memory: { enabled: false, injectLimit: 20 } });
      let main;
      for (let attempt = 0; !main && attempt < 100; attempt++) {
        try { main = await ctx.dshBots.openConversation('shell-native'); }
        catch (error) { if (!String(error).includes('Main sessions are starting')) throw error; await delay(100); }
      }
      assert.ok(main, 'Synthetic main session must actually finish its native cold-start restoration');
      const { agent } = await ctx.sessionController.resolveAgent(main.sessionId); assert.ok(agent);
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'BOT_MODE_SHELL_SEED' }] }));
      await agent.whenIdle(); await ctx.sessions.flush(agent.session);
      const adapterClientPath = ctx.clientModules.clientPath('@deepseek-ai/dsh-client-shortcuts');
      if (config.expectedShortcutsPath) assert.equal(adapterClientPath, config.expectedShortcutsPath);
      const adapterClient = await readFile(adapterClientPath, 'utf8');
      assert.ok(adapterClient.includes('DSH_BOT_COMMAND_MODE_ADAPTER_RC2_V1'));
      await writeFile(resolve(config.outputDir, 'fixture.json'), JSON.stringify({ sessionId: main.sessionId, realModelRequests: 0, adapterClientPath, adapterClientSha256: createHash('sha256').update(adapterClient).digest('hex'), processExecutable: process.execPath, clientVersion: process.env.DSH_CLIENT_VERSION }));
      if (!disposed) console.log('B4_WEB_READY');
    })().catch(async error => {
      await writeFile(resolve(config.outputDir, 'fixture-error.json'), JSON.stringify({ error: String(error), stack: error.stack }));
      console.log('B4_WEB_FAILED');
    });
    return async () => { disposed = true; await run; release?.(); };
  }, 'bot-mode-shell: synthetic fixture');
}
