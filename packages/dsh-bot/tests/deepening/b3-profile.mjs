import '../../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { memoryContext } from '../../lib/host/memory/context.js';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { LoopbackAdapter } from './loopback-adapter.mjs';
import { MemoryAdmission } from '../../lib/host/memory/admission.js';

export const name = 'dp-b3-probe';
export const inject = ['loader', 'llm', 'agents', 'sessionController', 'sessions'];
const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
class ProbeAdapter extends LoopbackAdapter {
  hold = false;
  async *stream(options) {
    for await (const chunk of super.stream(options)) {
      if (this.hold) await new Promise((_, reject) => {
        if (options.signal?.aborted) reject(new Error('aborted synthetic stream'));
        else options.signal?.addEventListener('abort', () => reject(new Error('aborted synthetic stream')), { once: true });
      });
      yield chunk;
    }
  }
}
export function apply(ctx, config) {
  let stopping = false;
  const save = (name, data) => writeFile(resolve(config.outputDir, 'receipts', `${config.phase}-${name}.json`), JSON.stringify(data, null, 2));
  const read = async name => JSON.parse(await readFile(resolve(config.outputDir, 'receipts', name), 'utf8'));
  ctx.effect(() => {
    assert.equal(ctx.llm.listProviders().length, 0);
    const adapter = new ProbeAdapter(config.endpoint), off = ctx.llm.registerAdapter(['dp-loopback'], adapter);
    const running = (async () => {
      await ctx.loader.await();
      const deadline = Date.now() + 45000;
      let registry = ctx.get('dshBots');
      while (!registry) {
        if (stopping || Date.now() > deadline) throw new Error('Registry not published'); await delay(20);
        registry = ctx.get('dshBots');
      }
      if (config.phase === 'old-rejected') {
        let reason = '';
        try { await registry.waitUntilReady(); await registry.list(); } catch (error) { reason = String(error); }
        assert.match(reason, /startup failed|not ready|stopping/i);
        assert.equal(adapter.count, 0); await save('old-package', { rejected: true, adapterRequests: 0, reason }); return;
      }
      await registry.waitUntilReady();
      while (!registry.mainSessions) {
        if (stopping || Date.now() > deadline) throw new Error('Main-session readiness timeout'); await delay(20);
      }
      if (['fresh', 'legacy-seed', 'admission'].includes(config.phase)) for (const id of ['alpha', 'beta', 'gamma'])
        await registry.create({ id, name: id, template: 'minimal', persona: { prefix: `B3_${id}`, complete: false },
          model: { provider: 'dp-loopback', model: 'fixture' }, memory: { enabled: true, injectLimit: 20 } });
      if (config.phase === 'legacy-seed') {
        for (const id of ['alpha', 'beta']) await registry.memoryFor(id).save({ content: `LEGACY_${id}`, kind: 'fact' }, { by: 'user', at: 10 });
        const { buildMemoryPrompt } = await import(pathToFileURL(config.legacyPrompt).href);
        const prompts = {};
        for (const id of ['alpha', 'beta']) prompts[id] = buildMemoryPrompt(await registry.memoryFor(id).snapshot(20), 4000);
        await save('context', prompts);
        await save('seed', { bots: (await registry.list()).map(b => ({ id: b.id, createdAt: b.createdAt })), count: 2 }); return;
      }
      const kernel = registry.memoryKernel;
      assert.ok(kernel);
      const migration = kernel.domain.table('migration').get('active'); assert.equal(migration.phase, 'done');
      if (['upgrade', 'forget', 'cold', 'cold-blocked'].includes(config.phase) && config.phase !== 'cold-blocked') {
        const seed = await read('legacy-seed-seed.json');
        assert.deepEqual((await registry.list()).map(b => ({ id: b.id, createdAt: b.createdAt })), seed.bots);
        assert.deepEqual(migration.counts, { source: 2, copied: 2, quarantined: 0 });
        for (const [, v] of kernel.snapshot.versions) assert.equal(v.trust, 'candidate');
        const previous = await read('legacy-seed-context.json');
        for (const id of ['alpha', 'beta']) {
          const bot = (await registry.list()).find(b => b.id === id);
          const text = memoryContext(kernel, { botId: id, botCreatedAt: bot.createdAt }, registry.config, 20)();
          assert.equal(text, previous[id], 'Legacy private context must survive upgrade unchanged');
        }
        assert.equal(await registry.memoryQuarantineCount(), 0);
        await save('context-equivalence', { same: true, bots: ['alpha', 'beta'] });
      }
      await save('migration', { manifest: migration, idMap: [...kernel.domain.table('migration_items').entries()], epoch: kernel.epoch });
      if (config.phase === 'fresh' || config.phase === 'upgrade' || config.phase === 'cold') return;
      const mains = await Promise.all(['alpha', 'beta', 'gamma'].map(id => registry.openConversation(id)));
      const ids = mains.map(m => m.sessionId), agents = [];
      for (const id of ids) { const result = await ctx.sessionController.resolveAgent(id); assert.ok(result.agent); agents.push(result.agent); }
      const agent = agents[0], memory = registry.memoryFor('alpha');
      if (config.phase === 'cold-blocked') {
        const previous = await read('identity.json'); assert.deepEqual(ids, previous.ids);
        assert.ok(kernel.blocked); assert.ok(kernel.epoch > 0);
        agent.followup(message('COLD_BLOCKED')); await agent.whenIdle();
        assert.equal(adapter.count, 0);
        const rows = await memory.list();
        const seed = await readFile(resolve(config.outputDir, 'receipts', 'legacy-seed-seed.json'), 'utf8')
          .then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        assert.deepEqual(rows.map(r => r.content), seed ? ['LEGACY_alpha'] : []);
        await save('blocked', { ids, epoch: kernel.epoch, blocked: kernel.blocked, requests: adapter.count }); return;
      }
      await save('identity.json', { ids });
      const identityPath = resolve(config.outputDir, 'receipts', 'identity.json');
      await writeFile(identityPath, JSON.stringify({ ids }));
      const { id } = await memory.save({ content: 'B3_CONTEXT_ONE {{literal}}' });
      if (config.phase === 'forget') {
        await memory.forget({ id }); assert.ok(kernel.blocked);
        await save('forget', { epoch: kernel.epoch, blocked: true, requests: adapter.count }); return;
      }
      const send = async text => { agent.followup(message(text)); await agent.whenIdle(); };
      await send('BASELINE'); assert.equal(adapter.count, 1);
      let retried = false;
      const retryOff = ctx.on('agent/request-error', async () => {
        if (retried) return undefined; retried = true; await memory.update(id, { content: 'B3_CONTEXT_TWO' });
        return { kind: 'retry' };
      });
      adapter.mode = 'error'; await send('RETRY'); retryOff(); assert.ok(retried); assert.equal(adapter.count, 3);
      const options = { provider: 'dp-loopback', model: 'fixture', sessionId: ids[0], messages: [message('PREPARED')] };
      const consume = async iterable => { for await (const _chunk of iterable) {} };
      const oldStatic = agent.ctx.systemPrompt.section({ name: 'b3-old-static', order: 300, text: 'LEGACY_STATIC_CANARY' });
      const generation = ctx.plugin({ apply(owner) {
        const replacement = new MemoryAdmission(owner); replacement.start(kernel);
        owner.effect(() => () => replacement.close());
      } });
      await generation.await();
      await assert.rejects(() => consume(ctx.llm.stream(options)), /Legacy Bot generation/);
      assert.equal(adapter.count, 3); await generation.dispose(); oldStatic();
      const prepared = await ctx.llm.prepareCall(options), lazy = prepared.stream({ ...options, ...prepared.config });
      adapter.hold = true; agent.followup(message('IN_FLIGHT'));
      while (adapter.count !== 4) { if (Date.now() > deadline) throw new Error('In-flight timeout'); await delay(10); }
      assert.equal(registry.memoryAdmission.inFlight, 1);
      await memory.forget({ id }); await agent.whenIdle(); adapter.hold = false;
      assert.equal(registry.memoryAdmission.inFlight, 0); assert.ok(kernel.blocked);
      await assert.rejects(() => consume(lazy));
      await assert.rejects(() => consume(ctx.llm.stream({ ...options, sessionId: undefined, purpose: 'compaction' })));
      await send('BLOCKED'); assert.equal(adapter.count, 4);
      await registry.close();
      await assert.rejects(() => consume(agent.ctx.get('llm').stream(options)));
      assert.equal(adapter.count, 4);
      await save('admission', { ids, requests: adapter.count, inFlightAfterCancel: 0, epoch: kernel.epoch,
        preparedDenied: true, summaryDenied: true, retainedGuardDenied: true, unrecognizedLiveGenerationDenied: true });
    })().then(() => console.log('DP_B3_DONE')).catch(async error => {
      await save('failure', { error: String(error), stack: error.stack }); console.error('DP_B3_FAILED', error);
    });
    return async () => { stopping = true; await running; off(); };
  });
}
