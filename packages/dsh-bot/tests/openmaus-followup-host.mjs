import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Peer } from '@deepseek-ai/dsh-client-connection';

class ConditionalAdapter extends LlmAdapter {
  controls = new Map();
  calls = [];
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic condition result' }]; }
  async resolveModel(provider, id) { return { provider, id, name: 'Synthetic condition result' }; }
  async *stream(options) {
    this.calls.push(options.sessionId);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    this.controls.set(options.sessionId, release);
    options.signal.addEventListener('abort', release, { once: true });
    try {
      await gate; options.signal.throwIfAborted();
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Synthetic original subtask completed.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic original subtask completed.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally { options.signal.removeEventListener('abort', release); this.controls.delete(options.sessionId); }
  }
}

/** Runs inside the final installed Host; no real HTTP/model access. */
export async function verify(ctx, config) {
  const registry = ctx.get('dshBots'); await registry.waitUntilReady();
  const service = ctx.get('dshBotProactive'); assert.ok(service, 'Enable proactive service for this isolated fixture');
  const stop = new AbortController();
  const signal = config.signal ? AbortSignal.any([stop.signal, config.signal]) : stop.signal;
  const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
  const adapter = new ConditionalAdapter(), handles = [];
  adapter.ctx = ctx;
  const provider = 'openmaus-followup-local', preset = 'openmaus-followup-child';
  const offAdapter = ctx.llm.registerAdapter([provider], adapter);
  const offPreset = await ctx.agentPresets.register({ id: preset, name: 'Synthetic completion child', plugins: [] });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return; disposed = true; stop.abort();
    for (const release of adapter.controls.values()) release();
    for (const handle of handles.reverse()) await handle.dispose();
    await peer.dispose(); await offPreset(); await offAdapter();
  };
  if (config.releases) config.releases.push(dispose);
  else await ctx.effect(() => dispose, 'OpenMaus follow-up fixture');
  const until = async (read, label) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      signal.throwIfAborted(); const value = await read(); if (value) return value;
      await delay(40, undefined, { signal });
    }
    throw new Error(`OpenMaus follow-up fixture timeout: ${label}`);
  };
  const invoke = (namespace, method, input) => ctx.typertGateway.invoke({ namespace, method, args: { input }, peer, signal });
  const proactive = (method, input) => invoke('dshBot.proactive', method, input);
  const memory = (method, input) => invoke('dshBot.memory', method, input);
  const bot = await registry.create({ id: 'openmaus-followup', name: 'OpenMaus Follow-up and Memory', template: 'minimal',
    model: { provider: 'openmaus-local', model: 'fixture' }, memory: { enabled: true, injectLimit: 20 } });
  const subject = { kind: 'bot', bot: { botId: bot.id, botCreatedAt: bot.createdAt } };
  const { sessionId } = await registry.openConversation(bot.id);
  const { agent: parent } = await ctx.sessionController.resolveAgent(sessionId); assert.ok(parent);
  const nativeCallbacks = [];
  let callbackWrites = Promise.resolve();
  for (const [scope, owner] of [['host', ctx], ['main', parent.ctx]]) {
    for (const name of ['subagent/start', 'subagent/end']) {
      const off = owner.on(name, info => {
        nativeCallbacks.push({ scope, name, id: info.id, runId: info.runId, local: info.local,
          parentSessionId: info.parentSessionId, liveParent: ctx.sessions.get(info.id)?.header.parentSession });
        const body = JSON.stringify(nativeCallbacks, null, 2);
        callbackWrites = callbackWrites.then(() => writeFile(resolve(config.outputDir, 'openmaus-followup-callbacks.json'), body));
      });
      if (config.releases) config.releases.push(off);
    }
  }
  if (config.releases) config.releases.push(() => callbackWrites);
  parent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
    text: 'Synthetic original work: review the child result in this conversation when it completes.' }] }), { surfaceOp: 'append' });
  assert.equal(await ctx.sessions.flush(parent.session), true);
  await until(async () => (await service.status()).state === 'ready', 'coordinator ready');
  const enabled = await service.followUpPolicy(randomUUID(), { subject, action: 'enable-local', expectedRevision: 0 });
  assert.equal(enabled.kind, 'receipt');
  const page = () => proactive('followUpPage', { subject });
  const child = async label => {
    const childId = randomUUID();
    const request = { parent, agentPreset: preset, agentOptions: { provider, model: 'fixture' },
      prompt: [{ type: 'text', text: `Synthetic child work: ${label}` }], maxDepth: 1 };
    const handle = await ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', childId, label, signal, request, ...request });
    handles.push(handle);
    await until(() => adapter.controls.has(childId), `child ${label} waiting`);
    let card;
    try {
      card = await until(async () => (await page()).rows.find(row => row.origin.kind === 'native-subagent' &&
        row.origin.childSessionId === childId && row.completionTarget), `tracking ${label}`);
    } catch (error) {
      const diagnostic = { childId, sessionId, label, adapterCalls: adapter.calls, nativeCallbacks,
        parentBinding: registry.mainSessions.boundSessionId(bot.id, bot.createdAt), page: await page(),
        status: await service.status(), liveHeader: ctx.sessions.get(childId)?.header };
      try {
        const live = ctx.sessions.get(childId);
        if (live) diagnostic.flush = await ctx.sessions.flush(live);
        const reader = await ctx.sessionPersistence.open(childId, 'read', { signal });
        try { diagnostic.reader = { header: reader.header, inheritedEventCount: reader.inheritedEventCount,
          page: await reader.read(Number(reader.inheritedEventCount), 128, { signal }) }; }
        finally { await reader.close(); }
      } catch (failure) { diagnostic.readerError = String(failure.stack); }
      try {
        await ctx.sessions.flush(parent.session);
        ctx.get('dshBotFollowUpEvents').reset();
        await ctx.get('dshBotFollowUpEvents').flush();
        diagnostic.afterBaseline = await page();
      } catch (failure) { diagnostic.baselineError = String(failure.stack); }
      await writeFile(resolve(config.outputDir, 'openmaus-followup-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
      throw error;
    }
    return { childId, handle, card };
  };
  const original = await child('Original native task');
  const watchId = randomUUID(), commandId = randomUUID();
  const creation = { commandId, subject, expectedRevision: 1, id: watchId, watch: {
    title: 'Review original native task', completion: 'Review the result in the originating conversation', source: { kind: 'manual' },
    when: original.card.completionTarget, deadlineAt: new Date(Date.now() + 3600000).toISOString() } };
  assert.equal((await proactive('followUpWatchCreate', creation)).kind, 'receipt');
  const duplicate = await proactive('followUpWatchCreate', creation);
  assert.equal(duplicate.receipt.status, 'duplicate');
  adapter.controls.get(original.childId)(); await original.handle.result;
  const settled = await until(async () => (await page()).rows.find(row => row.origin.kind === 'watch' && row.origin.watchId === watchId &&
    row.condition.kind === 'needs-review'), 'condition result');
  assert.equal(settled.when.origin.sessionId, sessionId);
  assert.equal(settled.when.origin.childSessionId, original.childId);
  assert.equal(settled.state, 'open');
  const calls = adapter.calls.length;
  await ctx.get('dshBotFollowUpEvents').flush();
  assert.equal((await page()).rows.filter(row => row.origin.kind === 'watch' && row.origin.watchId === watchId).length, 1);
  assert.equal(adapter.calls.length, calls, 'Condition observation must not start a model');
  const waiting = await child('Browser condition source');

  const sourceId = 'ci:openmaus-condition';
  const change = async body => {
    const reply = await service.change(randomUUID(), body); assert.equal(reply.kind, 'receipt', JSON.stringify(reply)); return reply;
  };
  await change({ kind: 'ingest-batch', sourceId, generation: 1, expectedCheckpoint: null, nextCheckpoint: 'failure', events: [{
    nativeId: 'openmaus-ci-run', nativeRevision: 'failure-1', threadId: 'openmaus-ci-thread', occurredAt: new Date().toISOString(),
    summary: 'Synthetic original CI failure', ci: { attempt: 1, conclusion: 'failure' } }] });
  const candidates = await service.read({ kind: 'suggestions' });
  const candidate = candidates.suggestions?.find(row => row.sourceId === sourceId); assert.ok(candidate);
  await change({ kind: 'accept-decision', decisionId: candidate.id, expectedRevision: candidate.revision, sourceId,
    policyVersion: candidate.policyVersion, approved: true,
    target: { bot: subject.bot, botUpdatedAt: bot.updatedAt, provider: 'openmaus-local', model: 'fixture' } });
  const ciCard = (await page()).rows.find(row => row.completionTarget?.kind === 'ci-completed'); assert.ok(ciCard);
  const ciWatchId = randomUUID();
  assert.equal((await proactive('followUpWatchCreate', { commandId: randomUUID(), subject, expectedRevision: 1, id: ciWatchId,
    watch: { title: 'Review original CI work', completion: 'Review the next exact CI observation', source: { kind: 'manual' },
      when: ciCard.completionTarget, deadlineAt: new Date(Date.now() + 3600000).toISOString() } })).kind, 'receipt');
  await change({ kind: 'ingest-batch', sourceId, generation: 1, expectedCheckpoint: 'failure', nextCheckpoint: 'success', events: [{
    nativeId: 'openmaus-ci-run', nativeRevision: 'success-2', threadId: 'openmaus-ci-thread', occurredAt: new Date(Date.now() + 1).toISOString(),
    summary: 'Synthetic next CI success', ci: { attempt: 2, conclusion: 'success' } }] });
  const ciSettled = (await page()).rows.find(row => row.origin.kind === 'watch' && row.origin.watchId === ciWatchId);
  assert.equal(ciSettled.condition.kind, 'needs-review');
  assert.equal(ciSettled.when.origin.ticketId, ciCard.origin.ticketId);

  const initial = await memory('changes', { botId: bot.id });
  const id = await memory('createManaged', { botId: bot.id, scope: 'private', kind: 'user_fact', content: 'OPENMAUS_MEMORY_ORIGINAL',
    valid: { from: null, to: null, basis: 'unknown' }, expectedRevision: initial.revision });
  const first = (await memory('changes', { botId: bot.id })).rows.find(row => row.version.memoryId === id);
  assert.ok(first);
  await memory('revise', { id, expectedRevision: (await memory('changes', { botId: bot.id })).revision,
    patch: { content: 'OPENMAUS_MEMORY_EDITED' } });
  const beforeRestore = await memory('changes', { botId: bot.id });
  assert.deepEqual(beforeRestore.rows[0].changed, ['content']);
  assert.equal(beforeRestore.rows[0].previous.content, 'OPENMAUS_MEMORY_ORIGINAL');
  assert.equal(beforeRestore.rows[0].version.provenance.channel, 'management');
  await assert.rejects(() => memory('restore', { botId: bot.id, id, versionId: first.version.versionId,
    expectedRevision: beforeRestore.revision - 1 }));
  await memory('restore', { botId: bot.id, id, versionId: first.version.versionId, expectedRevision: beforeRestore.revision });
  const restored = await memory('changes', { botId: bot.id });
  assert.equal(restored.rows[0].payload.content, 'OPENMAUS_MEMORY_ORIGINAL');
  assert.equal(restored.rows[0].version.revision, 3);
  assert.ok(restored.rows[0].version.sourceRefs.some(ref => ref.parentVersionId === first.version.versionId));
  // Leave a new change for Browser to preview and explicitly restore.
  await memory('revise', { id, expectedRevision: restored.revision, patch: { content: 'OPENMAUS_MEMORY_BROWSER_EDIT' } });
  const securityId = await memory('createManaged', { botId: bot.id, scope: 'private', kind: 'user_fact', content: 'OPENMAUS_OLD_BODY_FORBIDDEN',
    valid: { from: null, to: null, basis: 'unknown' }, expectedRevision: (await memory('changes', { botId: bot.id })).revision });
  const securityOriginal = (await memory('changes', { botId: bot.id })).rows.find(row => row.version.memoryId === securityId);
  assert.ok(securityOriginal);
  await registry.manageMemory(async management => {
    const kernel = management.kernel, current = kernel.snapshot.versions.get(securityId); assert.ok(current);
    const contentRef = randomUUID();
    await kernel.commit({ opId: randomUUID(), kind: 'revise', subjectIds: [securityId], expectedRevision: kernel.seq,
      forgetEpoch: kernel.epoch, versions: [{ ...current, contentRef, versionId: randomUUID(),
        revision: current.revision + 1, commitSeq: kernel.seq + 1, recordedAt: Date.now(),
        labels: { ...current.labels, restrictions: [...current.labels.restrictions, 'secret'] } }],
      payloads: { [contentRef]: { content: 'Current sensitive replacement', valid: { from: null, to: null, basis: 'unknown' } } } });
  });
  const redacted = await memory('changes', { botId: bot.id });
  assert.ok(!JSON.stringify(redacted).includes('OPENMAUS_OLD_BODY_FORBIDDEN'));
  await assert.rejects(() => memory('restore', { botId: bot.id, id: securityId,
    versionId: securityOriginal.version.versionId, expectedRevision: redacted.revision }));

  const inputWatchId = randomUUID();
  assert.equal((await proactive('followUpWatchCreate', { commandId: randomUUID(), subject, expectedRevision: 1, id: inputWatchId,
    watch: { title: 'OPENMAUS_PENDING_INPUT', completion: 'Use the original conversation', source: { kind: 'manual' },
      wait: { reason: 'The original task needs clarification', request: 'Confirm the desired format' } } })).kind, 'receipt');
  const inputCard = (await page()).rows.find(row => row.origin.kind === 'watch' && row.origin.watchId === inputWatchId); assert.ok(inputCard);
  const workList = await service.read({ kind: 'work-list', owner: subject.bot });
  const unknownWork = workList.work.find(row => row.decisionId === candidate.id); assert.ok(unknownWork);
  await change({ kind: 'report-result', ticketId: unknownWork.ticketId, assignmentId: unknownWork.assignmentId,
    expectedRevision: unknownWork.revision, result: { state: 'unknown' } });
  const unknownPage = await proactive('activityPage', { owner: subject.bot, collection: 'work' });
  assert.ok(unknownPage.rows.some(row => row.assignmentId === unknownWork.assignmentId && row.state === 'unknown'));
  // Pausing observation never resolves an existing task awaiting the owner.
  assert.equal((await service.followUpPolicy(randomUUID(), { subject, action: 'pause', expectedRevision: 1 })).kind, 'receipt');
  assert.ok((await page()).rows.some(row => row.id === inputCard.id && row.condition.kind === 'waiting-input'));
  assert.ok((await page()).rows.some(row => row.id === settled.id && row.condition.kind === 'needs-review'));
  assert.equal((await service.followUpPolicy(randomUUID(), { subject, action: 'enable-local', expectedRevision: 2 })).kind, 'receipt');
  return { status: 'PASS', botId: bot.id, botName: bot.name, sessionId, subject, settledCardId: settled.id,
    pending: { inputCardId: inputCard.id, reviewCardId: settled.id, unknownAssignmentId: unknownWork.assignmentId },
    ciSettledCardId: ciSettled.id,
    browserConditionCardId: waiting.card.id, browserConditionTarget: waiting.card.completionTarget,
    memoryId: id, browserRestoreVersionId: first.version.versionId,
    nativeSyntheticRequests: adapter.calls.length, conditionAdditionalRequests: 0, realModelRequests: 0,
    checks: ['owner Remote watch creation', 'native child event completion', 'exact original parent/child/generation',
      'duplicate command receipt', 'single review card without dispatch', 'CI exact source/thread/attempt from original work', 'memory strict Remote source/time/diff',
      'memory expectedRevision conflict', 'memory restore creates revision 3', 'current sensitive labels hide all historical payload and reject restore',
      'existing waiting/review survive observation pause', 'unknown work remains read-only', 'Browser tracking and memory history seeded'] };
}
