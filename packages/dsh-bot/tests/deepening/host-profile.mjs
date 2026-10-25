import '../../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { LoopbackAdapter, canary } from './loopback-adapter.mjs';
export const name = 'dp-b1-probe';
export const inject = ['loader', 'llm', 'agents', 'dshBots', 'dshBotAutomation', 'sessionController',
  'sessions', 'sessionPersistence', 'sessionQuery'];
const message = text => createUserMessage({ content: [{ type: 'text', text }],
  source: { kind: 'dsh-bot-memory-forget', form: 'notice', summary: 'Synthetic memory spike' } });
export function apply(ctx, config) {
  ctx.effect(() => {
    let blocked = false, cleanupOnly = false, denied = 0, stopping = false;
    const allowed = new Set();
    const adapter = new LoopbackAdapter(config.endpoint);
    const releases = [];
    const save = (name, data) => writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(data, null, 2));
    // Install before any cold resolve. All summary calls without ownership fail closed, even when not blocked.
    releases.push(ctx.on('llm/stream', async function* (options, next) {
      if (blocked || !options.sessionId || !allowed.has(options.sessionId)) { denied++; throw Error('DP_BARRIER'); }
      assert.equal(options.provider, 'dp-loopback');
      if (isAgentLoopRequest(options)) assert.equal(Object.isFrozen(options), true);
      yield* next();
    }));
    releases.push(ctx.on('agent/created', ({ agent }) => {
      agent.ctx.effect(() => agent.ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next();
        return blocked && !cleanupOnly ? { kind: 'reject', reason: 'DP_BARRIER' } : decision;
      }));
    }));
    assert.equal(ctx.llm.listProviders().length, 0, 'Real provider must not be registered');
    releases.push(ctx.llm.registerAdapter(['dp-loopback'], adapter));
    const run = (async () => {
      assert.equal(globalThis[Symbol.for('dp.loopback.guard')], true);
      await ctx.loader.await();
      const deadline = Date.now() + 45000;
      while ((await ctx.dshBotAutomation.status()).state !== 'ready') {
        if (stopping || Date.now() > deadline) throw Error(`Host readiness deadline: ${JSON.stringify(await ctx.dshBotAutomation.status())}`);
        await delay(20);
      }
      const first = config.phase === 'first';
      if (first) for (const id of ['alpha', 'beta', 'gamma']) await ctx.dshBots.create({
        id, name: id, template: 'minimal', persona: { prefix: `DP_PERSONA_${id}`, complete: false },
        model: { provider: 'dp-loopback', model: 'fixture' }, memory: { enabled: false, injectLimit: 20 },
      });
      const mains = await Promise.all(['alpha', 'beta', 'gamma'].map(id => ctx.dshBots.openConversation(id)));
      const ids = mains.map(m => m.sessionId);
      for (const id of ids) allowed.add(id);
      const agents = [];
      for (const id of ids) {
        const result = await ctx.sessionController.resolveAgent(id);
        assert.ok(result.agent);
        agents.push(result.agent);
      }
      const agent = agents[0], session = agent.session;
      const send = async text => { agent.followup(message(text)); await agent.whenIdle(); };
      let contextText = first ? canary : 'DYNAMIC_CLEAN';
      const offContext = agent.ctx.effect(() => agent.ctx.systemPrompt.context({
        name: 'dp-memory', order: 300, required: true, interpolate: false, text: () => contextText,
      }));
      if (first) {
        const offStatic = agent.ctx.effect(() => agent.ctx.systemPrompt.section({ name: 'dp-static', order: 300, text: canary }));
        agent.ctx.effect(() => agent.ctx.tools.register(defineTool({ name: 'dp_fixture', description: 'Synthetic canary fixture',
          parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: async () => canary,
        })));
        adapter.mode = 'tool';
        await send(`DP_TOOL_STEP ${canary}`);
        adapter.mode = 'canary';
        await send('DP_ASSISTANT_COPY');
        adapter.mode = 'text';
        await send('DP_BASELINE_REPLAY');
        session.append('user/message', message(`SYNTHETIC_SUMMARY ${canary}`), { surfaceOp: 'append' });
        assert.ok(JSON.stringify(session.deriveMessages()).includes(canary));
        const events = session.snapshotEvents();
        assert.ok(events.some(e => e.type === 'system/message' && JSON.stringify(e.data).includes(canary)));
        assert.ok(events.some(e => e.type === 'user/message' && e.data.source.kind === 'runtime-context'
          && JSON.stringify(e.data).includes(canary)));
        assert.ok(events.some(e => e.type === 'tool/result' && JSON.stringify(e.data.message.content).includes(canary)));
        assert.ok(events.some(e => e.type === 'assistant/message' && JSON.stringify(e.data.message.content).includes(canary)));

        offStatic(); contextText = 'DYNAMIC_CLEAN'; adapter.mode = 'text';
        blocked = true;
        agent.cancel({ kind: 'hook', reason: 'dp-forget' }, { keepInbox: true });
        await agent.whenIdle();
        const replace = async () => agent.runMaintenance(async signal => {
          signal.throwIfAborted();
          const head = session.surface.nodes[0];
          const event = session.snapshotEvents().find(e => e.seq === head);
          const nodes = session.surface.nodes.slice(event?.type === 'system/message' ? 1 : 0);
          assert.ok(toolPairingBalancedBefore(session, nodes[0]));
          assert.ok(toolPairingBalancedAfter(session, nodes.at(-1)));
          session.append('user/message', message('Synthetic history removed'), {
            surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes.at(-1) }, sourceEventSeqs: nodes,
          });
          assert.equal(await ctx.sessions.flush(session), true);
        });
        await replace(); await replace();
        // An idle system/message append passes Surface but corrupts durable turn/step grammar.
        // Let the native loop reproject the disposed static section in a real step; keep final dispatch blocked.
        assert.ok(JSON.stringify(session.deriveMessages()).includes(canary), 'System head is still dirty');
        const cleanupCount = adapter.count;
        cleanupOnly = true;
        await send('DP_REPROJECT_WITHOUT_DISPATCH');
        cleanupOnly = false;
        assert.equal(adapter.count, cleanupCount, 'Cleanup step must dispatch zero adapter requests');
        assert.equal(await ctx.sessions.flush(session), true);
        assert.ok(!JSON.stringify(session.deriveMessages()).includes(canary));
        const surface = await ctx.sessionQuery.readSurface(session.id);
        assert.ok(!JSON.stringify(surface).includes(canary));
        const raw = await ctx.sessionPersistence.open(session.id, 'read');
        try { assert.ok(JSON.stringify(await raw.read()).includes(canary)); } finally { await raw.close(); }
        await save('replacement', { status: 'PASS', sessionId: session.id, flush: true, surface: 'PASS', rawLogContainsCanary: true,
          nativeSystemReprojection: true, adapterRequestsAtVerification: adapter.count, cleanupAdapterRequests: adapter.count - cleanupCount });
        await writeFile(resolve(config.outputDir, 'identity.json'), JSON.stringify({ ids }));
        const before = adapter.count;
        const prepared = await ctx.llm.prepareCall({ provider: 'dp-loopback', model: 'fixture' });
        const lazy = prepared.stream({ ...prepared.config, messages: [message(canary)], sessionId: session.id });
        await assert.rejects(async () => { for await (const _ of lazy) {} }, /DP_BARRIER/);
        await assert.rejects(async () => {
          for await (const _ of ctx.llm.stream({ provider: 'dp-loopback', model: 'fixture', purpose: 'compaction',
            messages: [message(canary)] })) {}
        }, /DP_BARRIER/);
        assert.equal(adapter.count, before);
        blocked = false;
        let retried = false;
        const offRetry = ctx.on('agent/request-error', async () => {
          if (retried) return undefined;
          retried = true; blocked = true; contextText = 'RETRY_CLEAN'; return { kind: 'retry' };
        });
        adapter.mode = 'error';
        await send('DP_RETRY');
        offRetry();
        assert.equal(adapter.count, before + 1);
        assert.ok(denied >= 3);
        blocked = false;
        await save('admission', { status: 'PASS', preparedDenied: true, unknownSummaryDenied: true,
          retryDenied: true, denied, adapterDeltaForRetry: 1 });
      } else {
        const saved = JSON.parse(await readFile(resolve(config.outputDir, 'identity.json')));
        assert.deepEqual(ids, saved.ids);
        assert.ok(!JSON.stringify(session.deriveMessages()).includes(canary));
        await send('DP_COLD_CLEAN');
        assert.equal(await ctx.sessions.flush(session), true);
        await save('cold', { status: 'PASS', ids, request: 'captured at loopback', flush: true });
      }
      offContext();
      await save('result', { status: 'PASS', ids, adapterRequests: adapter.count, denied });
      console.log('DP_B1_DONE');
    })().catch(async error => { await save('failure', { error: String(error), stack: error.stack }); console.log('DP_B1_FAILED'); });
    return async () => { stopping = true; blocked = true; await run; for (const release of releases.reverse()) release(); };
  });
}
