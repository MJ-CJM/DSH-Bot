import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'bot-mode-supergroup-input-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController'];
const ambient = new Set(['runtime-context', 'time-context', 'agent-instructions', 'tmux-context', 'skill-catalog', 'user-approval', 'model-selection']);
class Adapter extends LlmAdapter {
  calls = []; mainId; holdMain = false; releases = [];
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic B03 input' }]; }
  async *stream(options) {
    const agent = this.ctx.agents.get(options.sessionId); assert.ok(agent);
    const events = agent.session.snapshotEvents();
    const input = events.findLast(event => event.type === 'user/message' && !ambient.has(event.data.source.kind));
    this.calls.push({ sessionId: agent.id, inputId: input?.data.id, source: input?.data.source,
      privateSeen: JSON.stringify(options).includes('B03_PRIVATE_CANARY'), privateMemorySeen: JSON.stringify(options).includes('B03_PRIVATE_MEMORY_CANARY') });
    if (agent.id !== this.mainId) assert.ok(!JSON.stringify(options).includes('B03_PRIVATE_CANARY'));
    if (agent.id !== this.mainId) assert.ok(!JSON.stringify(options).includes('B03_PRIVATE_MEMORY_CANARY'));
    if (agent.id === this.mainId && this.holdMain) await new Promise(release => {
      this.releases.push(release); options.signal.addEventListener('abort', release, { once: true });
    });
    options.signal.throwIfAborted();
    const text = JSON.stringify(input?.data.content);
    if (agent.id === this.mainId && text.includes('B03_START') &&
      !events.some(event => event.type === 'tool/result' && Number(event.seq) > Number(input.seq))) {
      const id = ToolCallId(`b03-tool-${this.calls.length}`), args = JSON.stringify({ action: 'start', memberIds: ['b03-a', 'b03-b'] });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'bot_supergroup', argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bot_supergroup', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    if (agent.id !== this.mainId && agent.session.header.agentPreset?.endsWith('b03-a') &&
      !events.some(event => event.type === 'tool/call' && event.data.name === 'group_message')) {
      // Real checked tool admission runs while the approval-style catalog observer is active.
      await delay(100, undefined, { signal: options.signal });
      const id = ToolCallId(`b03-expert-${this.calls.length}`), args = JSON.stringify({ action: 'request-expert', botId: 'b03-c', question: 'Review the supplied proposal.' });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'group_message', argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'group_message', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    const output = agent.id === this.mainId ? 'B03_ORIGINAL_BOT_FINAL' : 'B03_EXPERT_RESULT';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: output };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: output } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), adapter = new Adapter(), releases = [], receipts = [];
    adapter.ctx = ctx;
    let phase = 'startup';
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const mark = name => { phase = name; console.log(`B03_INPUT_PHASE ${name}`); void save('phase', { phase: name }); };
    const wait = async read => { for (;;) { lifetime.signal.throwIfAborted(); const result = await read(); if (result) return result; await delay(20, undefined, { signal: lifetime.signal }); } };
    const timer = setTimeout(() => lifetime.abort(new Error(`B03 input deadline: ${phase}`)), 100000);
    const task = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      assert.deepEqual(ctx.llm.listProviders(), []); releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      const service = await wait(() => ctx.dshBots.supergroup), groups = await wait(() => ctx.get('dshBotGroups'));
      let observing = false, again = false, observerCalls = 0;
      const observe = () => {
        again = true; if (observing) return; observing = true;
        void (async () => {
          while (again && !lifetime.signal.aborted) { again = false; await service.catalog(); observerCalls++; }
        })().catch(error => { lifetime.abort(error); }).finally(() => { observing = false; });
      };
      releases.push(ctx.on('domain/changed', change => { if (change.domain === 'dsh_bot_supergroup') observe(); }));
      const observerTimer = setInterval(observe, 5); releases.push(() => clearInterval(observerTimer));
      for (const id of ['b03-owner', 'b03-a', 'b03-b', 'b03-c']) {
        await ctx.dshBots.create({ id, name: id, template: 'minimal', model: { provider: 'dp-b6b', model: 'fixture' }, memory: { enabled: true, injectLimit: 20 } });
        await ctx.dshBots.memoryFor(id).save({ content: `B03_PRIVATE_MEMORY_CANARY_${id}`, pinned: true });
      }
      const opened = await ctx.dshBots.openConversation('b03-owner'), main = ctx.agents.get(opened.sessionId); assert.ok(main); adapter.mainId = main.id;
      const prompt = (requestId, text) => ctx.sessionController.prompt({ sessionId: main.id, requestId, mode: 'queue', content: [{ type: 'text', text }] }, lifetime.signal);
      mark('initial-native-work');
      await prompt('b03-private', 'B03_PRIVATE_CANARY previous private conversation.'); await main.whenIdle();
      await prompt('b03-start', 'B03_START: compare the supplied options.'); await main.whenIdle();
      const first = (await service.catalog())[0]; assert.ok(first?.work.group);
      assert.equal(first.group.members.filter(member => member.enabled && member.removedAt === undefined).length, 3);
      assert.ok(first.work.experts.some(expert => expert.botId === 'b03-c' && expert.state === 'invited'));
      assert.equal(first.work.collaboration.requests, adapter.calls.filter(call => call.sessionId !== main.id).length,
        'the production group callback charges every initial and expert model request');
      assert.ok(adapter.calls.some(call => call.sessionId === main.id && call.privateMemorySeen));
      assert.ok(observerCalls > 0);
      receipts.push({ name: 'real-expert-tool-and-concurrent-catalog-observer-no-deadlock', status: 'PASS', observerCalls });
      const key = first.work.group, humanCount = main.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length;
      const input = { group: key, workId: first.work.id, expectedRevision: first.work.revision, operationId: 'b03-human-one', text: 'B03_REAL_GROUP_INPUT: prioritize cost.', memberIds: [first.group.members[0].id] };
      mark('real-group-input');
      const accepted = await service.sendGroupInput(input); assert.equal(accepted.receipt.state, 'queued');
      const root = ctx.agents.get(first.group.group.rootSessionId); assert.ok(root);
      const event = root.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === accepted.receipt.messageId);
      assert.equal(event.data.source.kind, 'user'); assert.deepEqual(event.data.source.group, key); assert.equal(Number(event.seq), accepted.receipt.seq);
      const delivered = await wait(async () => {
        const view = await service.byGroup(key); return view.work.groupInputs[0]?.delivery?.state === 'delivered' && view;
      });
      assert.equal(delivered.group.group.supergroup.originSessionId, main.id);
      assert.equal(delivered.group.group.supergroup.originMessageId, first.work.inputMessageId);
      await main.whenIdle(); assert.equal(main.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, humanCount);
      assert.ok(delivered.group.messages.some(message => message.id === accepted.receipt.messageId && message.authorKind === 'user'));
      assert.deepEqual(delivered.group.turns.find(turn => turn.inputMessageId === accepted.receipt.messageId).orderedMemberIds, input.memberIds);
      const followup = main.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'dsh-bot-supergroup-result');
      assert.equal(followup.data.source.originMessageId, accepted.receipt.messageId);
      assert.deepEqual(ctx.dshBots.memoryOutlets.label(main.id).readers, [{ botId: 'b03-owner', botCreatedAt: first.work.owner.botCreatedAt }]);
      assert.equal(delivered.work.collaboration.requests, adapter.calls.filter(call => call.sessionId !== main.id).length,
        'real group human supplements keep the same actual request budget');
      receipts.push({ name: 'real-root-input-original-bot-answer-exact-data-label', status: 'PASS', inputMessageId: accepted.receipt.messageId,
        answerMessageId: delivered.work.groupInputs[0].delivery.answerMessageId, humanSourceNotSpoofed: true });
      mark('idempotency-conflict-and-query');
      const before = adapter.calls.length; await service.sendGroupInput(input); await service.catalog(); await service.byGroup(key);
      assert.equal(adapter.calls.length, before); await assert.rejects(() => service.sendGroupInput({ ...input, text: 'Changed replay body' }));
      const conflict = await service.sendGroupInput({ ...input, operationId: 'b03-stale', text: 'B03_STALE_BUT_SAVED' });
      assert.equal(conflict.receipt.state, 'conflict'); assert.equal(adapter.calls.length, before);
      assert.ok((await groups.view(key)).messages.some(message => message.id === conflict.receipt.messageId && message.authorKind === 'user'));
      receipts.push({ name: 'exact-replay-inert-and-stale-text-preserved', status: 'PASS' });
      mark('busy-original-bot-queued'); adapter.holdMain = true;
      await prompt('b03-busy', 'B03_BUSY_MAIN'); await wait(() => adapter.releases.length);
      const busyWork = await service.byGroup(key), queued = await service.sendGroupInput({ ...input, expectedRevision: busyWork.work.revision,
        operationId: 'b03-busy-group', text: 'B03_BUSY_GROUP_SUPPLEMENT' });
      await wait(async () => (await service.byGroup(key)).work.groupInputs.find(row => row.operationId === 'b03-busy-group')?.delivery?.state === 'queued');
      assert.ok(!main.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'dsh-bot-supergroup-result' && event.data.source.originMessageId === queued.receipt.messageId));
      adapter.holdMain = false; for (const release of adapter.releases.splice(0)) release();
      await wait(async () => (await service.byGroup(key)).work.groupInputs.find(row => row.operationId === 'b03-busy-group')?.delivery?.state === 'delivered');
      receipts.push({ name: 'busy-main-queues-and-original-bot-completes', status: 'PASS' });
      mark('cancel-queued-main-result'); await main.whenIdle(); adapter.holdMain = true;
      await prompt('b03-cancel-busy', 'B03_CANCEL_BUSY_MAIN'); await wait(() => adapter.releases.length);
      const cancelWork = await service.byGroup(key), cancelledInput = await service.sendGroupInput({ ...input,
        expectedRevision: cancelWork.work.revision, operationId: 'b03-cancel-group', text: 'B03_CANCEL_SUPPLEMENT' });
      await wait(async () => (await service.byGroup(key)).work.groupInputs.find(row => row.operationId === 'b03-cancel-group')?.delivery?.state === 'queued');
      const beforeCancel = await service.byGroup(key); await service.cancel(beforeCancel.work.id, beforeCancel.work.revision);
      adapter.holdMain = false; for (const release of adapter.releases.splice(0)) release();
      await main.whenIdle().catch(() => {}); await delay(100, undefined, { signal: lifetime.signal });
      assert.ok(!adapter.calls.some(call => call.source?.kind === 'dsh-bot-supergroup-result' && call.source.originMessageId === cancelledInput.receipt.messageId));
      assert.equal((await service.byGroup(key)).work.groupInputs.find(row => row.operationId === 'b03-cancel-group').delivery.state, 'cancelled');
      receipts.push({ name: 'cancel-fences-already-queued-native-followup-before-model', status: 'PASS' });
      assert.ok(!adapter.calls.some(call => call.sessionId === root.id));
      assert.ok(adapter.calls.filter(call => call.sessionId !== main.id).every(call => !call.privateSeen));
      assert.ok(adapter.calls.filter(call => call.sessionId !== main.id).every(call => !call.privateMemorySeen));
      await save('receipts', receipts); await save('calls', adapter.calls); await save('work', await service.byGroup(key));
      await save('result', { status: 'PASS', checks: receipts.length, zeroRootRequests: true, zeroRealRequests: true,
        sharedRequestCounter: true, privateMemoryCanaryAbsentFromWorkers: true });
      console.log('B03_INPUT_DONE');
    })().catch(async error => { await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack }); console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timer));
    return async () => { lifetime.abort(); adapter.holdMain = false; for (const release of adapter.releases.splice(0)) release(); await task.catch(() => {}); for (const release of releases.reverse()) release(); };
  });
}
