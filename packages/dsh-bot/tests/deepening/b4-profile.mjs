import '../../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LoopbackAdapter, canary } from './loopback-adapter.mjs';
import { verifyClean, verifyCold } from './b4-proof.mjs';
import { exerciseBeforeForget, exerciseAfterForget } from './b4-scenarios.mjs';

export const name = 'dp-b4-probe';
export const inject = ['loader', 'llm', 'agents', 'dshBots', 'sessionController', 'sessions', 'sessionQuery', 'sessionPersistence'];
const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
class ActiveAdapter extends LoopbackAdapter {
  hold = false;
  async *stream(options) {
    for await (const chunk of super.stream(options)) {
      if (this.hold) await new Promise((_, reject) => {
        if (options.signal?.aborted) reject(new Error('aborted fixture'));
        else options.signal?.addEventListener('abort', () => reject(new Error('aborted fixture')), { once: true });
      });
      yield chunk;
    }
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    assert.equal(ctx.llm.listProviders().length, 0);
    const adapter = new ActiveAdapter(config.endpoint), off = ctx.llm.registerAdapter(['dp-loopback'], adapter);
    const save = data => writeFile(resolve(config.outputDir, 'receipts', `${config.scenario}-${config.phase}.json`), JSON.stringify(data, null, 2));
    const running = (async () => {
      await ctx.loader.await(); const registry = ctx.dshBots;
      await registry.waitUntilReady();
      const deadline = Date.now() + 45000;
      while (!registry.memoryForget) { if (Date.now() > deadline) throw new Error('Forget readiness'); await delay(20); }
      const first = config.phase === 'first';
      if (first) for (const id of ['alpha', 'beta', 'gamma']) await registry.create({ id, name: id, template: 'minimal',
        model: { provider: 'dp-loopback', model: 'fixture' }, persona: { prefix: `B4_${id}`, complete: false } });
      const ids = [];
      for (const id of ['alpha', 'beta', 'gamma']) ids.push((await registry.openConversation(id)).sessionId);
      const agents = [];
      for (const id of ids) { const result = await ctx.sessionController.resolveAgent(id); assert.ok(result.agent); agents.push(result.agent); }
      if (!first) {
        const old = JSON.parse(await readFile(resolve(config.outputDir, 'receipts', `${config.scenario}-first.json`)));
        if (old.cleanup.phase !== 'stopped') await registry.memoryForget.runner.resume(old.cleanup.id);
        await verifyCold({ ctx, registry, ids, old, agents, adapter, message, canary, save }); return;
      }
      const rows = [];
      for (const id of ['alpha', 'beta', 'gamma']) rows.push(await registry.memoryFor(id).save({
        content: id === 'alpha' ? `${canary}_alpha` : `CLEAN_MEMORY_${id}` }));
      let fixtureExecutions = 0;
      for (const agent of agents) {
        agent.ctx.effect(() => agent.ctx.tools.register(defineTool({ name: 'dp_fixture', description: 'Synthetic tool', parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: async () => { fixtureExecutions++; return canary; } })));
        adapter.mode = config.scenario === 'tool-pair' ? 'tool' : 'canary';
        agent.followup(message(`BASELINE ${canary}`)); await agent.whenIdle();
      }
      assert.ok(adapter.count >= 3);
      const beforeRequests = adapter.count;
      const state = { ctx, config, registry, adapter, agents, ids, rows, message, canary, toolBodies: () => fixtureExecutions };
      await exerciseBeforeForget(state);
      let preview = sPreview(state) ?? await registry.memoryForget.preview('alpha', {
        memoryId: rows[0].id, mode: ['related-duplicate', 'derived-lineage'].includes(config.scenario) ? 'related' : 'version' });
      if (config.scenario.startsWith('preview-')) {
        if (config.scenario === 'preview-log-cas') await registry.memoryFor('beta').save({ content: 'CHANGED' });
        else if (config.scenario === 'preview-inbox-cas') agents[0].inbox.append('next-turn', message('HUMAN_PENDING'));
        else {
          const bot = await registry.get('alpha'), graph = ctx.get('dshBotReferenceMemory');
          await graph.request({ action: 'configure', bot: { botId: bot.id, botCreatedAt: bot.createdAt }, mode: 'internal', expectedRevision: 0 });
        }
        await assert.rejects(registry.memoryForget.choose({ previewRevision: preview.previewRevision, choice: 'clean' }), /preview|revision/i);
        assert.equal(registry.memoryKernel.epoch, 0);
        preview = await registry.memoryForget.preview('alpha', { memoryId: rows[0].id, mode: 'version' });
      }
      const restore = [];
      if (config.scenario === 'copy-unavailable') {
        const graph = ctx.get('dshBotReferenceMemory'), original = graph.forgetCleanup;
        graph.forgetCleanup = async () => { throw new Error('Synthetic offline copy'); };
        restore.push(() => { graph.forgetCleanup = original; });
      }
      if (config.scenario === 'flush-failure') {
        const original = ctx.sessions.flush;
        ctx.sessions.flush = async () => false;
        restore.push(() => { ctx.sessions.flush = original; });
      }
      // Test-only transport of the exact native request captured by production admission, before barrier release.
      const verify = registry.memoryAdmission.verifyRequest.bind(registry.memoryAdmission);
      registry.memoryAdmission.verifyRequest = async agent => {
        const request = await verify(agent);
        assert.ok(!JSON.stringify(request).includes(canary), 'Complete pre-release request contains target');
        assert.equal(registry.memoryKernel.blocked, true);
        assert.equal(registry.memoryAdmission.inFlight, 0);
        adapter.hold = false; adapter.mode = 'text';
        for await (const _ of adapter.stream(request)) {} // loopback only; request is not reconstructed or edited
        return request;
      };
      const cleanup = state.preChosen?.cleanup ?? await registry.memoryForget.choose({ previewRevision: preview.previewRevision,
        choice: config.scenario === 'stop-only' ? 'stop' : 'clean' });
      for (const fn of restore.reverse()) fn();
      assert.equal(cleanup.stopped, true);
      assert.equal(registry.memoryKernel.blocked, !cleanup.strong);
      assert.ok(!registry.memoryKernel.snapshot.versions.has(rows[0].id));
      const count = adapter.count;
      await exerciseAfterForget(state, cleanup);
      let cleanRequests = 0;
      if (cleanup.strong) cleanRequests = await verifyClean(state);
      else {
        for (const agent of agents) await assert.rejects(async () => {
          for await (const _ of agent.ctx.llm.stream({ provider: 'dp-loopback', model: 'fixture',
            sessionId: agent.session.id, messages: agent.session.deriveMessages(), toolHistory: agent.session.toolHistory() })) {}
        }, /blocked|epoch|surface/i);
        assert.equal(adapter.count, count, 'Blocked request reached adapter');
      }
      if (cleanup.phase !== 'stopped' && config.scenario !== 'approval-wait') for (const agent of agents) {
        const surface = await ctx.sessionQuery.readSurface(agent.session.id);
        // Native system head may remain. All user/tool/assistant historical nodes were replaced.
        assert.ok(!JSON.stringify(agent.session.deriveMessages().slice(1)).includes(canary));
        assert.ok(surface);
      }
      if (config.scenario === 'unload-guard') {
        await registry.memoryAdmission.close();
        await assert.rejects(async () => {
          for await (const _ of agents[0].ctx.llm.stream({ provider: 'dp-loopback', model: 'fixture',
            sessionId: agents[0].session.id, messages: [message(canary)] })) {}
        }, /blocked|epoch|surface/i);
      }
      await save({ ids, preview, cleanup, baselineRequests: beforeRequests, blockedRequests: 0, cleanRequests,
        nativeSystemHeader: cleanup.reasons.includes('system-head') ? 'BLOCKED (legacy target)' : 'CLEAN', realModelRequests: 0 });
    })().then(() => console.log('DP_B4_DONE')).catch(async error => {
      await mkdir(dirname(resolve(config.outputDir, 'failure.json')), { recursive: true });
      await writeFile(resolve(config.outputDir, `${config.scenario}-${config.phase}-failure.json`),
        JSON.stringify({ error: String(error), stack: error.stack }, null, 2)); console.log('DP_B4_FAILED');
    });
    return async () => { await running; off(); };
  });
}
function sPreview(state) { return state.preChosen?.preview; }
