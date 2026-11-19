import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Adapter as GroupAdapter } from './supergroup-runtime-profile.mjs';
export const name = 'continuous-agent-chain-fixture';
export const inject = ['loader', 'llm', 'dshBots', 'agents', 'sessions', 'sessionController', 'dshBotMemory'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let remembered = false, materialUsed = false, generations = 0, requests = 0;
    class Adapter extends GroupAdapter {
      async *stream(options) {
        requests++;
        const text = options.messages.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text));
        const prompt = text.find(t => t.startsWith('Summarize at most one'));
        if (prompt) {
          assert.equal(options.tools?.length ?? 0, 0); generations++;
          const sources = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
          const result = JSON.stringify({ content: 'CHAIN_ADOPTED project port 7319', sourceIds: sources.map(s => s.id) });
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: result };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: result } };
          yield { type: 'finish', reason: { kind: 'stop' } }; return;
        }
        if (options.sessionId !== this.mainId && JSON.stringify(options).includes('CHAIN_FILE_EVIDENCE project port 7319')) materialUsed = true;
        const agent = ctx.agents.get(options.sessionId);
        const last = agent?.session.snapshotEvents().findLast(e => e.type === 'user/message' && e.data.source.kind === 'user');
        if (options.sessionId === this.mainId && JSON.stringify(last?.data.content).includes('CHAIN_NEXT_TASK')) {
          assert.ok(JSON.stringify(options).includes('CHAIN_ADOPTED project port 7319'), 'next request must receive adopted memory'); remembered = true;
        }
        yield* super.stream(options);
      }
    }
    const adapter = new Adapter(); adapter.ctx = ctx;
    const off = ctx.llm.registerAdapter(['dp-b6b'], adapter), lifetime = new AbortController();
    const timer = setTimeout(() => lifetime.abort(new Error('Chain deadline')), 90000);
    const save = (file, value) => writeFile(join(config.outputDir, file), JSON.stringify(value, null, 2));
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      assert.deepEqual(ctx.llm.listProviders().map(p => typeof p === 'string' ? p : p.id), ['dp-b6b']);
      while (!ctx.dshBots.supergroup) { lifetime.signal.throwIfAborted(); await delay(20, undefined, { signal: lifetime.signal }); }
      const service = ctx.dshBots.supergroup;
      let checkpoint, main;
      const completed = async marker => {
        for (;;) {
          lifetime.signal.throwIfAborted();
          const events = main.session.snapshotEvents();
          const terminal = events.at(-1);
          if (terminal?.type === 'turn/end' && terminal.data.reason.kind === 'error') throw new Error(JSON.stringify(terminal.data.reason));
          const at = events.findLastIndex(e => e.type === 'user/message' && e.data.source.kind === 'user' && JSON.stringify(e.data.content).includes(marker));
          if (at >= 0 && events.slice(at + 1).some(e => e.type === 'turn/end')) { await main.whenIdle(); return; }
          await delay(20, undefined, { signal: lifetime.signal });
        }
      };
      if (config.suite === 'chain-warm') {
        for (const id of ['sg-owner', 'sg-alpha', 'sg-beta', 'sg-gamma'])
          await ctx.dshBots.create({ id, name: id, template: 'minimal', model: { provider: 'dp-b6b', model: 'fixture' }, memory: { enabled: true, injectLimit: 20 } });
        adapter.mainId = (await ctx.dshBots.openConversation('sg-owner')).sessionId;
        main = ctx.agents.get(adapter.mainId); assert.ok(main);
        await ctx.sessionController.prompt({ sessionId: main.id, requestId: 'chain-start', mode: 'queue',
          content: [{ type: 'text', text: 'SG_COMPLEX: compare the supplied proposal. I will provide the port evidence in a later continuation.' }] }, lifetime.signal);
        await completed('SG_COMPLEX');
        const input = main.session.snapshotEvents().findLast(e => e.type === 'user/message' && e.data.source.kind === 'user');
        const view = await service.forSession({ sessionId: main.id, messageId: input.data.id });
        assert.equal(view.work.state, 'completed'); assert.ok(view.group);
        // This is an explicit owner pause between iterations, not a fabricated native approval blocker.
        assert.equal(main.status, 'idle');
        checkpoint = { status: 'PASS', workId: view.work.id, mainId: main.id, messageId: input.data.id,
          group: view.work.group, phase: 'owner-awaits-additional-material', warmRequests: requests };
        await ctx.sessions.flush(main.session);
        for (const session of [view.group.group.rootSessionId]) { const agent = ctx.agents.get(session); if (agent) await ctx.sessions.flush(agent.session); }
        await save('chain-checkpoint.json', checkpoint); console.log('B4_WEB_READY'); return;
      }
      checkpoint = JSON.parse(await readFile(join(config.outputDir, 'chain-checkpoint.json')));
      adapter.mainId = checkpoint.mainId;
      await ctx.sessionController.resolveAgent(adapter.mainId); main = ctx.agents.get(adapter.mainId); assert.ok(main);
      const recovered = await service.forSession({ sessionId: main.id, messageId: checkpoint.messageId });
      assert.equal(recovered.work.id, checkpoint.workId); assert.equal(recovered.work.state, 'completed'); assert.equal(requests, 0);
      const support = await service.taskSupport(checkpoint.workId);
      const materialInput = { workId: checkpoint.workId, expectedRevision: support.revision, operationId: randomUUID(), question: 'Refine the existing proposal using the exact port evidence',
        source: { kind: 'file', name: 'port-evidence.md', text: 'CHAIN_FILE_EVIDENCE project port 7319' } };
      const withMaterial = await service.addMaterial(materialInput);
      assert.equal(withMaterial.materials.length, 1); assert.equal((await service.addMaterial(materialInput)).materials.length, 1);
      const resume = { workId: checkpoint.workId, expectedRevision: withMaterial.revision, operationId: randomUUID(), blockerIds: [],
        text: 'SG_CONTINUE: refine the original proposal using the added port evidence.' };
      await service.resumeWork(resume); await completed('SG_CONTINUE');
      const latest = main.session.snapshotEvents().findLast(e => e.type === 'user/message' && e.data.source.kind === 'user');
      const continued = await service.forSession({ sessionId: main.id, messageId: latest.data.id });
      assert.equal(continued.work.id, checkpoint.workId); assert.deepEqual(continued.work.group, checkpoint.group);
      assert.equal(continued.work.state, 'completed'); assert.equal(materialUsed, true, 'resumed native worker must receive the selected exact material');
      const delivered = main.session.snapshotEvents().filter(e => Number(e.seq) > Number(latest.seq) && e.type === 'tool/result' && JSON.stringify(e.data).includes('SG_MEMBER_RESULT'));
      assert.equal(delivered.length, 1, 'one continuation delivers one result to the original conversation');
      const count = requests; await service.resumeWork(resume); assert.equal(requests, count);
      const receipt = continued.work.resumes.find(r => r.operationId === resume.operationId); assert.ok(receipt);
      assert.equal(main.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.id === receipt.messageId).length, 1);
      assert.ok(continued.group.messages.some(m => m.text.includes('SG_MEMBER_RESULT')));
      ctx.dshBots.config.memoryConsolidation.enabled = true;
      const remote = ctx.dshBotMemory, botId = 'sg-owner';
      const sourceId = await remote.createManaged({ botId, scope: 'private', kind: 'user_fact', content: 'CHAIN_CONFIRMED project port 7319',
        valid: { from: null, to: null, basis: 'unknown' }, expectedRevision: (await remote.consolidationStatus(botId)).revision });
      const facts = await remote.query({ botId, scope: 'private', view: 'facts' });
      const proposed = await remote.consolidate({ botId, operationId: randomUUID(), expectedRevision: facts.revision,
        sourceIds: [facts.rows.find(r => r.version.memoryId === sourceId).version.versionId], provider: 'dp-b6b', model: 'fixture' });
      assert.equal(proposed.state, 'proposed'); assert.equal(generations, 1);
      assert.ok(!(await remote.query({ botId, scope: 'private', view: 'facts' })).rows.some(r => r.version.memoryId === proposed.candidateId));
      await remote.decideConsolidation({ botId, operationId: randomUUID(), runId: proposed.id, action: 'accept',
        expectedRevision: (await remote.consolidationStatus(botId)).revision });
      await ctx.sessionController.prompt({ sessionId: main.id, requestId: 'chain-next', mode: 'queue', content: [{ type: 'text', text: 'CHAIN_NEXT_TASK: what project port should I use?' }] }, lifetime.signal);
      await completed('CHAIN_NEXT_TASK'); assert.equal(remembered, true);
      await save('chain-result.json', { status: 'PASS', workId: checkpoint.workId, sameWorkAndGroup: true, materialRetained: true, materialUsed: true, originalConversationDeliveries: delivered.length,
        coldStartupRequests: 0, duplicateResumeRequests: 0, adoptedMemoryInNextRequest: true, generations, realModelRequests: 0,
        warmRequests: checkpoint.warmRequests, coldRequests: requests, waitingScope: 'explicit owner pause; not durable tool suspension' });
      console.log('B4_WEB_READY');
    })().catch(async error => { await save('chain-failure.json', { status: 'FAIL', error: String(error.stack) }); console.error('B4_WEB_FAILED', error); });
    return async () => { lifetime.abort(); clearTimeout(timer); await run; off(); };
  });
}
