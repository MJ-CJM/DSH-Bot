import '../../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { LoopbackAdapter } from './loopback-adapter.mjs';
export const name = 'b8-release-probe';
export const inject = ['loader', 'llm', 'sessionController'];
export function apply(ctx, config) {
  let stopping = false;
  ctx.effect(() => {
    assert.equal(ctx.llm.listProviders().length, 0, 'Real providers must be disabled before registering fixture');
    const adapter = new LoopbackAdapter(config.endpoint), off = ctx.llm.registerAdapter(['dp-loopback'], adapter);
    const running = (async () => {
      await ctx.loader.await();
      const deadline = Date.now() + 45000;
      let registry = ctx.get('dshBots');
      while (!registry) {
        if (stopping || Date.now() >= deadline) throw Error('Registry absent'); await delay(20);
        registry = ctx.get('dshBots');
      }
      const save = data => writeFile(resolve(config.outputDir, 'receipts', `${config.phase}.json`), JSON.stringify(data, null, 2));
      if (config.phase === 'fence') {
        let rejection;
        await assert.rejects(() => registry.waitUntilReady(), error => {
          // The real 0.3.2 registry exposes the storage error as a message, without a cause chain.
          // Require its exact domain/table/key/schema diagnostic, not just any rejected startup.
          assert.equal(error.code, 'bot/unavailable');
          assert.equal(error.message, "Bot registry startup failed: domain 'dsh_bot': stored record " +
            "'__dsh_bot_memory_v2_fence__' in table 'memories' does not match its schema");
          rejection = { code: error.code, message: error.message }; return true;
        });
        assert.equal(adapter.count, 0);
        await save({ status: 'PASS', rejected: true, rejection, adapterRequests: 0 }); return;
      }
      await registry.waitUntilReady();
      while (!registry.mainSessions || (config.phase !== 'legacy' && !registry.shadow)) {
        if (stopping || Date.now() >= deadline) throw Error('Services not ready'); await delay(20);
      }
      if (['fresh', 'legacy'].includes(config.phase)) {
        await registry.create({ id: 'alpha', name: 'Synthetic release', template: 'minimal', persona: { prefix: 'Synthetic only.' },
          tools: { deny: [config.phase === 'legacy' ? 'memory_forget' : 'bot_memory_forget'] },
          model: { provider: 'dp-loopback', model: 'fixture' } });
        await registry.memoryFor('alpha').save({ content: 'SYNTHETIC_RELEASE_PINNED', kind: 'preference', pinned: true,
          tags: ['synthetic'] }, { by: 'user', at: 10 });
      }
      const bots = await registry.list(), memories = await registry.memoryFor('alpha').list();
      assert.equal(bots.length, 1); assert.equal(memories.length, 1); assert.equal(memories[0].content, 'SYNTHETIC_RELEASE_PINNED');
      assert.equal(memories[0].pinned, true);
      if (config.phase === 'legacy') {
        await save({ status: 'PASS', bot: bots[0], memories, requests: 0 }); return;
      }
      const { VERSION } = await import(pathToFileURL(resolve(config.installed, 'lib/shared/version.js')).href);
      assert.equal(VERSION, '0.4.1');
      assert.deepEqual(bots[0].tools.deny, ['bot_memory_forget']);
      if (config.phase !== 'fresh') {
        const legacy = JSON.parse(await readFile(resolve(config.outputDir, 'receipts/legacy.json'), 'utf8'));
        assert.equal(bots[0].createdAt, legacy.bot.createdAt);
        const mapping = registry.memoryKernel.domain.table('migration_items').get(legacy.memories[0].id);
        assert.ok(mapping); assert.equal(mapping.memoryId, memories[0].id);
        assert.deepEqual(memories, legacy.memories.map(row => ({ ...row, id: mapping.memoryId })),
          'Legacy fields survive with the explicit persisted v2 ID mapping');
        const migration = registry.memoryKernel.domain.table('migration').get('active');
        assert.equal(migration.phase, 'done'); assert.deepEqual(migration.counts, { source: 1, copied: 1, quarantined: 0 });
      }
      const status = await registry.autoShareStatus();
      assert.equal(status.effectiveAutoShare, false); assert.equal(status.shadow.shadowEnabled, false);
      assert.equal(status.shadow.offlineOrganizeEnabled, false);
      const conversation = await registry.openConversation('alpha');
      const { agent } = await ctx.sessionController.resolveAgent(conversation.sessionId); assert.ok(agent);
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Synthetic release smoke.' }], source: { kind: 'user' } }));
      await agent.whenIdle(); assert.equal(adapter.count, 1);
      const visible = ['bot_memory_save', 'bot_memory_search', 'bot_memory_list'];
      for (const tool of visible) assert.ok(agent.ctx.tools.get(tool, agent), `Missing ${tool}`);
      for (const tool of ['memory_save', 'memory_search', 'memory_list', 'memory_forget']) assert.equal(agent.ctx.tools.get(tool, agent), undefined);
      await save({ status: 'PASS', version: VERSION, requests: adapter.count, statusSnapshot: status, visible, memories,
        sessionId: conversation.sessionId, exactArtifact: config.artifactHash });
    })().then(() => console.log('DP_B8_DONE')).catch(async error => {
      await writeFile(resolve(config.outputDir, 'receipts', `${config.phase}-failure.json`), JSON.stringify({ error: String(error), stack: error.stack }));
      console.error('DP_B8_FAILED', error);
    });
    return async () => { stopping = true; await running; off(); };
  });
}
