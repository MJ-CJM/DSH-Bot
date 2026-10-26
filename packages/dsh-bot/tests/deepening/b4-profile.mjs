import '../../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LoopbackAdapter, canary } from './loopback-adapter.mjs';
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
        assert.deepEqual(ids, old.ids); assert.equal(registry.memoryKernel.blocked, true);
        const before = adapter.count;
        for (const agent of agents) { agent.followup(message('COLD_BLOCKED')); await agent.whenIdle(); }
        assert.equal(adapter.count, before); assert.equal(adapter.count, 0);
        for (const agent of agents) {
          const raw = await ctx.sessionPersistence.open(agent.session.id, 'read');
          try { assert.ok(JSON.stringify(await raw.read()).includes(canary)); } finally { await raw.close(); }
        }
        await save({ ids, blockedRequests: 0, rawLogsStillContainCanary: true,
          cleanup: registry.memoryForget.runner.statuses()[0] }); return;
      }
      const rows = [];
      for (const id of ['alpha', 'beta', 'gamma']) rows.push(await registry.memoryFor(id).save({ content: `${canary}_${id}` }));
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
      const cleanup = state.preChosen?.cleanup ?? await registry.memoryForget.choose({ previewRevision: preview.previewRevision,
        choice: config.scenario === 'stop-only' ? 'stop' : 'clean' });
      for (const fn of restore.reverse()) fn();
      assert.equal(cleanup.stopped, true); assert.equal(cleanup.strong, false); assert.equal(registry.memoryKernel.blocked, true);
      assert.ok(!registry.memoryKernel.snapshot.versions.has(rows[0].id));
      const count = adapter.count;
      await exerciseAfterForget(state, cleanup);
      for (const agent of agents) { agent.followup(message('BLOCKED_REQUEST')); await agent.whenIdle(); }
      assert.equal(adapter.count, count, 'Blocked request reached adapter');
      if (cleanup.phase !== 'stopped' && config.scenario !== 'approval-wait') for (const agent of agents) {
        const surface = await ctx.sessionQuery.readSurface(agent.session.id);
        // Native system head may remain. All user/tool/assistant historical nodes were replaced.
        assert.ok(!JSON.stringify(agent.session.deriveMessages().slice(1)).includes(canary));
        assert.ok(surface);
      }
      await save({ ids, preview, cleanup, baselineRequests: beforeRequests, blockedRequests: adapter.count - count,
        nativeSystemHeader: 'BLOCKED (known rc.2 grammar limit)', realModelRequests: 0 });
    })().then(() => console.log('DP_B4_DONE')).catch(async error => {
      await mkdir(dirname(resolve(config.outputDir, 'failure.json')), { recursive: true });
      await writeFile(resolve(config.outputDir, `${config.scenario}-${config.phase}-failure.json`),
        JSON.stringify({ error: String(error), stack: error.stack }, null, 2)); console.log('DP_B4_FAILED');
    });
    return async () => { await running; off(); };
  });
}
function sPreview(state) { return state.preChosen?.preview; }
