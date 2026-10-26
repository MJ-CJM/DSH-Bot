import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function exerciseBeforeForget(s) {
  const { config, registry, agents, adapter, rows, message, canary, ctx } = s;
  const kind = config.scenario, agent = agents[0], memory = registry.memoryFor('alpha'), kernel = registry.memoryKernel;
  if (kind === 'related-duplicate') {
    const saved = await memory.save({ content: `${canary}_DUPLICATE` });
    await memory.update(saved.id, { content: `${canary}_alpha` });
    s.duplicate = saved.id;
  }
  if (kind === 'derived-lineage') {
    const saved = await memory.save({ content: 'DERIVED_SYNTHETIC' });
    const seed = kernel.snapshot.versions.get(rows[0].id), current = kernel.snapshot.versions.get(saved.id);
    const next = { ...structuredClone(current), versionId: randomUUID(), revision: current.revision + 1, commitSeq: kernel.seq + 1 };
    next.labels.sourceVersions = [seed.versionId];
    await kernel.commit({ opId: randomUUID(), kind: 'revise', subjectIds: [saved.id], versions: [next],
      expectedRevision: kernel.seq, forgetEpoch: kernel.epoch });
    s.duplicate = saved.id;
  }
  if (kind === 'earlier-revision') await memory.update(rows[0].id, { content: `${canary}_NEW_REVISION` });
  if (kind === 'system-head') {
    s.offStatic = agent.ctx.effect(() => agent.ctx.systemPrompt.section({ name: 'b4-static', order: 301, text: canary }));
    adapter.mode = 'text'; agent.followup(message('POPULATE_SYSTEM_HEADER')); await agent.whenIdle();
    // Disposing a section cannot retroactively change the persisted native system head.
    s.offStatic();
  }
  if (kind === 'runtime-context') {
    const off = agent.ctx.effect(() => agent.ctx.systemPrompt.context({ name: 'b4-context', order: 302,
      required: true, interpolate: false, text: canary }));
    adapter.mode = 'text'; agent.followup(message('POPULATE_RUNTIME')); await agent.whenIdle(); off();
  }
  if (kind === 'user-history' || kind === 'summary')
    agent.session.append('user/message', message(`${kind.toUpperCase()} ${canary}`), { surfaceOp: 'append' });
  if (kind === 'nonmonotonic') {
    const nodes = agent.session.surface.nodes.slice(1, 2);
    assert.equal(nodes.length, 1);
    agent.session.append('user/message', message(`SYNTHETIC_SUMMARY ${canary}`), {
      surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes[0] }, sourceEventSeqs: nodes,
    });
    assert.ok(agent.session.surface.nodes.some((seq, i, all) => i > 0 && seq < all[i - 1]));
  }
  if (kind === 'human-inbox' || kind === 'derived-inbox') {
    const pending = kind === 'human-inbox' ? message(`HUMAN_KEEP ${canary}`) : {
      ...message(`DERIVED_KEEP ${canary}`), source: { kind: 'dsh-bot-memory-forget', form: 'notice', summary: 'Synthetic derived input' } };
    agent.inbox.append('next-turn', pending); s.pendingId = pending.id;
  }
  if (['copy-current', 'copy-stage', 'copy-previous', 'copy-orphan'].includes(kind)) {
    const graph = ctx.get('dshBotReferenceMemory'), bot = await registry.get('alpha');
    const key = { botId: bot.id, botCreatedAt: bot.createdAt };
    await graph.request({ action: 'configure', bot: key, mode: 'internal+reference-graph', expectedRevision: 0 });
    await graph.request({ action: 'tool', bot: key, call: { tool: 'create_entities', arguments: {
      entities: [{ name: 'SYNTHETIC_REFERENCE', entityType: 'fixture', observations: [canary] }] } } });
    if (['copy-stage', 'copy-previous'].includes(kind)) {
      const preview = await graph.request({ action: 'preview', bot: key });
      const stage = await graph.request({ action: 'stage', bot: key, copyId: preview.copy.id });
      assert.equal(stage.copy.phase, 'verified');
      if (kind === 'copy-previous') {
        const committed = await graph.request({ action: 'commit', bot: key, copyId: preview.copy.id, confirmed: true });
        assert.equal(committed.copy.phase, 'committed');
        const next = await graph.request({ action: 'preview', bot: key });
        await graph.request({ action: 'stage', bot: key, copyId: next.copy.id });
      }
    }
    if (kind === 'copy-orphan') {
      const files = (await graph.forgetInventory()).stamp.files;
      assert.ok(files.length);
      await writeFile(join(dirname(files[0].path), `${randomUUID()}.jsonl`), `${JSON.stringify({
        type: 'entity', name: 'orphan', entityType: 'fixture', observations: [canary] })}\n`);
    }
    assert.ok((await graph.forgetInventory()).count > 0);
  }
  if (kind === 'root-instructions') {
    const path = join(registry.memoryForget.root, 'AGENTS.md');
    await writeFile(path, `SYNTHETIC_ROOT ${canary}`);
    s.rootPath = path;
  }
  if (kind === 'prepared-lazy') {
    const prepared = await ctx.llm.prepareCall({ provider: 'dp-loopback', model: 'fixture' });
    s.lazy = prepared.stream({ ...prepared.config, sessionId: agent.session.id, messages: [message(canary)] });
  }
  if (kind === 'active-lease') {
    adapter.mode = 'text'; adapter.hold = true;
    const before = adapter.count; agent.followup(message('SYNTHETIC_ACTIVE'));
    const deadline = Date.now() + 5000;
    while (adapter.count === before || registry.memoryAdmission.inFlight !== 1) {
      if (Date.now() > deadline) throw new Error('Active lease did not start'); await delay(10);
    }
  }
  if (kind === 'approval-wait') {
    let asked = false;
    const offPolicy = agent.ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next();
      return exec.name === 'dp_fixture' ? { kind: 'ask', reason: 'Synthetic pending approval' } : decision;
    });
    const offAnswer = ctx.on('approval/request', async (req, next) => {
      if (req.agent !== agent) return next();
      asked = true;
      return new Promise(accept => {
        if (req.signal?.aborted) accept('cancelled');
        else req.signal?.addEventListener('abort', () => accept('cancelled'), { once: true });
      });
    }, { prepend: true });
    adapter.mode = 'tool'; s.approvalBodies = s.toolBodies();
    agent.followup(message('SYNTHETIC_APPROVAL_WAIT'));
    const deadline = Date.now() + 5000;
    while (!asked) { if (Date.now() > deadline) throw new Error('Native approval did not open'); await delay(10); }
    s.offApproval = () => { offPolicy(); offAnswer(); };
    assert.ok(agent.session.snapshotEvents().some(e => e.type === 'approval/asked'));
  }
  if (kind === 'retry-boundary') {
    adapter.mode = 'error'; let retried = false;
    const off = ctx.on('agent/request-error', async () => {
      if (retried) return;
      retried = true;
      const preview = await registry.memoryForget.preview('alpha', { memoryId: rows[0].id, mode: 'version' });
      const cleanup = await registry.memoryForget.choose({ previewRevision: preview.previewRevision, choice: 'stop' });
      s.preChosen = { preview, cleanup }; return { kind: 'retry' };
    });
    const before = adapter.count;
    agent.followup(message('SYNTHETIC_RETRY')); await agent.whenIdle(); off();
    assert.equal(adapter.count, before + 1); assert.equal(retried, true);
  }
}
export async function exerciseAfterForget(s, cleanup) {
  const { config, registry, agents, adapter, ctx, message, canary } = s;
  const kind = config.scenario;
  if (s.duplicate) assert.ok(!registry.memoryKernel.snapshot.versions.has(s.duplicate));
  if (kind === 'earlier-revision') {
    const refs = [...registry.memoryKernel.domain.table('ops').entries()].flatMap(([, op]) => op.versions)
      .filter(v => v.memoryId === s.rows[0].id).map(v => v.contentRef);
    assert.ok(refs.length >= 2);
    for (const ref of refs) assert.equal(registry.memoryKernel.domain.table('payloads').get(ref), undefined);
  }
  if (kind === 'repeat-cleanup') {
    const counts = agents.map(a => a.session.snapshotEvents().length);
    await registry.memoryForget.runner.resume(cleanup.id);
    assert.deepEqual(agents.map(a => a.session.snapshotEvents().length), counts);
  }
  if (s.pendingId) assert.ok(agents[0].inbox.nextTurn.some(m => m.id === s.pendingId));
  if (s.lazy) await assert.rejects(async () => { for await (const _ of s.lazy) {} }, /blocked|epoch/i);
  if (kind === 'unknown-summary') await assert.rejects(async () => {
    for await (const _ of ctx.llm.stream({ provider: 'dp-loopback', model: 'fixture', purpose: 'compaction', messages: [message(canary)] })) {}
  }, /blocked/i);
  if (kind === 'active-lease') { adapter.hold = false; assert.equal(registry.memoryAdmission.inFlight, 0); }
  if (kind === 'approval-wait') {
    assert.equal(s.toolBodies(), s.approvalBodies, 'Pending approval must not execute tool body after forget');
    assert.ok(agents[0].session.snapshotEvents().some(e => e.type === 'approval/decided' && e.data.outcome === 'cancelled'));
    s.offApproval();
  }
  if (kind.startsWith('copy-') && kind !== 'copy-unavailable') {
    const graph = ctx.get('dshBotReferenceMemory');
    assert.equal((await graph.forgetInventory()).count, 0);
    const bot = await registry.get('alpha');
    await assert.rejects(graph.request({ action: 'apply', bot: { botId: bot.id, botCreatedAt: bot.createdAt } }), /blocked/i);
  }
  if (kind === 'copy-unavailable') assert.ok(cleanup.reasons.includes('copies'));
  if (kind === 'flush-failure') assert.ok(cleanup.reasons.includes('flush'));
  if (kind === 'root-instructions') assert.ok(cleanup.reasons.includes('root-instructions'));
  if (kind === 'unload-guard') {
    await registry.memoryAdmission.close();
    await assert.rejects(async () => {
      for await (const _ of agents[0].ctx.llm.stream({ provider: 'dp-loopback', model: 'fixture',
        sessionId: agents[0].session.id, messages: [message(canary)] })) {}
    }, /blocked/i);
  }
}
