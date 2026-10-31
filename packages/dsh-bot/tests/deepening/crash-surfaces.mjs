import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cleanHistory } from '../../lib/host/memory/history.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import { referenceMemoryDomain, keyOf } from '../../lib/host/reference-memory/model.js';
import { checkpoint, afterPut } from './crash-checkpoint.mjs';
const canary = 'B7_SURFACE_GRAPH_CANARY';
export async function crashSurfaces(ctx, config, adapter) {
  const registry = ctx.dshBots, crash = config.phase === 'crash', path = resolve(config.outputDir, 'identity.json');
  if (crash) for (const id of ['alpha', 'beta', 'gamma']) await registry.create({ id, name: id, template: 'minimal',
    model: { provider: 'dp-b6b', model: 'fixture' }, persona: { prefix: `Synthetic ${id}` } });
  const main = await registry.openConversation('alpha'), resolved = await ctx.sessionController.resolveAgent(main.sessionId);
  assert.ok(resolved.agent); const agent = resolved.agent, bot = await registry.get('alpha');
  const key = { botId: bot.id, botCreatedAt: bot.createdAt }, graph = ctx.get('dshBotReferenceMemory'); assert.ok(graph);
  if (crash) {
    const row = await registry.memoryFor('alpha').save({ content: canary });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: canary }], source: { kind: 'user' } }));
    await agent.whenIdle(); assert.ok(await ctx.sessions.flush(agent.session));
    const identity = { sessionId: main.sessionId, memoryId: row.id, bot: key };
    const save = () => writeFile(path, JSON.stringify(identity, null, 2), { flag: 'wx' });
    if (config.window === 'surface-flush') {
      const flush = ctx.sessions.flush.bind(ctx.sessions);
      ctx.sessions.flush = async session => {
        if (session.id === main.sessionId && !JSON.stringify(session.deriveMessages().slice(1)).includes(canary))
          await checkpoint(config, { phase: 'surface-replaced-before-native-flush', sessionId: session.id });
        return flush(session);
      };
      await save();
      const preview = await registry.memoryForget.preview('alpha', { memoryId: row.id, mode: 'version' });
      await registry.memoryForget.choose({ previewRevision: preview.previewRevision, choice: 'clean' });
    } else {
      const preview = await graph.request({ action: 'preview', bot: key }); identity.copyId = preview.copy.id;
      await graph.request({ action: 'stage', bot: key, copyId: identity.copyId });
      const domain = ctx.storageDomain.get(referenceMemoryDomain.name); assert.ok(domain);
      if (config.window === 'copy-pointer') {
        afterPut(domain.table('bindings'), (_id, value) => value.importId === identity.copyId,
          () => checkpoint(config, { phase: 'binding-pointer-durable-before-copy-receipt', copyId: identity.copyId }));
        await save(); await graph.request({ action: 'commit', bot: key, copyId: identity.copyId, confirmed: true });
      } else {
        await graph.request({ action: 'commit', bot: key, copyId: identity.copyId, confirmed: true });
        // Pause on the public native tool boundary inside real forgetCleanup, after file erasure, before two cold MCP reads.
        const execute = agent.ctx.tools.execute.bind(agent.ctx.tools);
        agent.ctx.tools.execute = async exec => {
          if (exec.name === 'mcp__bot_memory_graph__read_graph' && registry.memoryKernel.blocked)
            await checkpoint(config, { phase: 'mcp-cleanup-erased-awaiting-native-cold-reader', copyId: identity.copyId });
          return execute(exec);
        };
        await save();
        const selected = await registry.memoryForget.preview('alpha', { memoryId: row.id, mode: 'version' });
        await registry.memoryForget.choose({ previewRevision: selected.previewRevision, choice: 'clean' });
      }
    }
    throw new Error('Native surface/copy crash checkpoint was not reached');
  }
  const identity = JSON.parse(await readFile(path)); assert.equal(main.sessionId, identity.sessionId);
  if (config.window === 'copy-pointer') {
    const before = await graph.request({ action: 'status', bot: identity.bot });
    assert.equal(before.status.binding.importId, identity.copyId);
    const target = before.status.binding.fileIdentity;
    await graph.request({ action: 'commit', bot: identity.bot, copyId: identity.copyId, confirmed: true });
    const after = await graph.request({ action: 'status', bot: identity.bot });
    assert.equal(after.status.binding.fileIdentity, target);
    assert.equal(after.status.copies.find(c => c.id === identity.copyId).phase, 'committed');
    return { nativePointerReconciled: true, oldPointerRestored: false, sessionId: main.sessionId };
  }
  const jobs = registry.memoryForget.runner.statuses(); assert.equal(jobs.length, 1);
  if (!jobs[0].strong) await registry.memoryForget.runner.resume(jobs[0].id);
  const state = registry.memoryForget.runner.status(jobs[0].id); assert.equal(state.strong, true);
  assert.equal(registry.memoryKernel.snapshot.versions.has(identity.memoryId), false);
  assert.ok(await ctx.sessions.flush(agent.session));
  const reader = await ctx.sessionPersistence.open(agent.session.id, 'read');
  try {
    const raw = await reader.read(), cold = Session.create(reader.id, raw.events, reader.header, reader.inheritedEventCount);
    assert.ok(!JSON.stringify(cold.deriveMessages()).includes(canary));
    assert.deepEqual(cold.deriveMessages(), agent.session.deriveMessages());
  } finally { await reader.close(); }
  const request = await registry.memoryAdmission.verifyRequest(agent);
  assert.ok(!JSON.stringify(request).includes(canary));
  await cleanHistory(agent, { flush: s => ctx.sessions.flush(s), readSurface: s => ctx.sessionQuery.readSurface(s.id),
    rawReadPolicyVerified: true, headBlocked: false });
  assert.equal((await graph.forgetInventory()).count, 0);
  return { state, coldSurfaceClean: true, fullRequestClean: true, sessionId: main.sessionId, fixtureRequests: adapter.requests,
    bindingKey: keyOf(identity.bot) };
}
