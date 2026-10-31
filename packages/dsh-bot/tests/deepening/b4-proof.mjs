import assert from 'node:assert/strict';
export async function verifyClean(s) {
  const { registry, agents, adapter, message, canary, ctx, config } = s;
  assert.equal(registry.memoryKernel.blocked, false);
  const before = adapter.count;
  adapter.mode = 'text';
  const off = ctx.on('llm/stream', async function* (options, next) {
    assert.ok(!JSON.stringify(options).includes(canary), 'Full post-release request still contains target');
    yield* next();
  }, { prepend: true });
  try {
    for (const agent of agents) {
      agent.followup(message('CLEAN_NORMAL_REQUEST')); await agent.whenIdle();
      assert.ok(!JSON.stringify(agent.session.deriveMessages()).includes(canary));
      await ctx.sessions.flush(agent.session);
    }
    assert.equal(adapter.count - before, agents.length);
    if (config.scenario.startsWith('copy-')) {
      const graph = ctx.get('dshBotReferenceMemory'), bot = await registry.get('alpha');
      const key = { botId: bot.id, botCreatedAt: bot.createdAt };
      const status = await graph.request({ action: 'status', bot: key });
      await graph.request({ action: 'configure', bot: key, mode: 'internal+reference-graph',
        expectedRevision: status.status.binding.revision });
      const read = await graph.request({ action: 'tool', bot: key, call: { tool: 'read_graph', arguments: {} } });
      assert.deepEqual(read.graph, { entities: [], relations: [] });
    }
    return adapter.count - before;
  } finally { off(); }
}
export async function verifyCold({ ctx, registry, ids, old, agents, adapter, message, canary, save }) {
  assert.deepEqual(ids, old.ids);
  const cleanup = registry.memoryForget.runner.statuses()[0];
  if (old.cleanup.strong) assert.equal(cleanup.strong, true, 'Verified cleanup must survive cold recovery');
  assert.notEqual(cleanup.phase, 'cleaning', 'Cold receipt must describe settled recovery');
  // Fault recovery may complete after the synthetic outage ends, but legacy heads/Inbox/root remain blocked.
  assert.equal(registry.memoryKernel.blocked, !cleanup.strong);
  adapter.mode = 'text';
  const before = adapter.count;
  const off = ctx.on('llm/stream', async function* (options, next) {
    if (cleanup.strong) assert.ok(!JSON.stringify(options).includes(canary), 'Cold complete request contains target');
    yield* next();
  }, { prepend: true });
  try {
    for (const agent of agents) {
      if (cleanup.strong) { agent.followup(message('COLD_NORMAL_REQUEST')); await agent.whenIdle(); }
      else await assert.rejects(async () => {
        for await (const _ of agent.ctx.llm.stream({ provider: 'dp-loopback', model: 'fixture',
          sessionId: agent.session.id, messages: agent.session.deriveMessages(), toolHistory: agent.session.toolHistory() })) {}
      }, /blocked|epoch|surface/i);
    }
    assert.equal(adapter.count - before, cleanup.strong ? agents.length : 0);
    for (const agent of agents) {
      const raw = await ctx.sessionPersistence.open(agent.session.id, 'read');
      try { assert.ok(JSON.stringify(await raw.read()).includes(canary)); } finally { await raw.close(); }
    }
    await save({ ids, blockedRequests: 0, cleanRequests: adapter.count - before, rawLogsStillContainCanary: true, cleanup });
  } finally { off(); }
}
