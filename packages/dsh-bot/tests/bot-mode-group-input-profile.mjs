import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'bot-mode-group-input-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'subagents', 'dshBots', 'sessionController'];
class Adapter extends LlmAdapter {
  calls = []; mainId; hold = false; releases = [];
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic B00 group input' }]; }
  async *stream(options) {
    const agent = this.ctx.agents.get(options.sessionId);
    const input = agent.session.snapshotEvents().findLast(event => event.type === 'user/message' &&
      !['runtime-context', 'time-context', 'agent-instructions', 'tmux-context'].includes(event.data.source.kind));
    this.calls.push({ sessionId: agent.id, inputId: input?.data.id, source: input?.data.source, content: input?.data.content });
    if (agent.id !== this.mainId) assert.ok(!JSON.stringify(options).includes('B00_PRIVATE_CANARY'));
    if (this.hold && agent.id === this.mainId) await new Promise(release => {
      this.releases.push(release); options.signal.addEventListener('abort', release, { once: true });
    });
    options.signal.throwIfAborted();
    const text = agent.id === this.mainId ? 'B00_ORIGINAL_BOT_DELIVERY' : 'B00_MEMBER_RESULT';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), adapter = new Adapter(), releases = [], receipts = [];
    adapter.ctx = ctx;
    let phase = 'startup';
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const mark = name => { phase = name; console.log(`B00_GROUP_PHASE ${name}`); };
    const wait = async read => { for (;;) { controller.signal.throwIfAborted(); const value = await read(); if (value) return value; await delay(20, undefined, { signal: controller.signal }); } };
    const timer = setTimeout(() => controller.abort(new Error(`B00 deadline: ${phase}`)), 65000);
    const task = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      const groups = await wait(() => ctx.get('dshBotGroups'));
      const pool = [];
      for (const id of ['b00-origin', 'b00-peer']) {
        const bot = await ctx.dshBots.create({ id, name: id, template: 'minimal',
          model: { provider: 'dp-b6b', model: 'fixture' }, memory: { enabled: false, injectLimit: 20 } });
        pool.push({ botId: id, botCreatedAt: bot.createdAt });
      }
      const opened = await ctx.dshBots.openConversation('b00-origin');
      const main = ctx.agents.get(opened.sessionId); assert.ok(main); adapter.mainId = main.id;
      const prompt = (requestId, text) => ctx.sessionController.prompt({ sessionId: main.id, requestId, mode: 'queue', content: [{ type: 'text', text }] }, controller.signal);
      await prompt('b00-main-private', 'B00_PRIVATE_CANARY: private previous conversation.'); await main.whenIdle();
      const mainHumanCount = () => main.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length;
      const originalHumanCount = mainHumanCount();
      mark('real-group-root-human');
      // This is an ordinary Groups input via its public Host send route. It is
      // deliberately not represented as the unimplemented Supergroup bridge.
      const group = await groups.create({ operationId: 'b00-group', name: 'B00 input route', mode: 'round-robin', members: pool, historyConfirmed: true });
      const key = { groupId: group.id, groupCreatedAt: group.createdAt };
      const turn = await groups.send(key, { operationId: 'b00-group-human', text: 'B00_REAL_GROUP_SUPPLEMENT: prioritize cost.', memberIds: [], round: true, expectedMembershipRevision: 1 });
      await groups.waitForTurn(turn.id);
      const view = await groups.view(key), root = ctx.agents.get(group.rootSessionId); assert.ok(root);
      const human = root.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === turn.inputMessageId);
      assert.equal(human.data.source.kind, 'user'); assert.deepEqual(human.data.source.group, key);
      assert.ok(view.messages.some(message => message.id === human.data.id && message.authorKind === 'user'));
      assert.equal(await ctx.sessions.flush(root.session), true);
      receipts.push({ name: 'real-group-root-user-source', status: 'PASS', group: key, messageId: human.data.id, seq: Number(human.seq) });
      const source = { kind: 'dsh-bot-supergroup-group-input', group: key, originSessionId: root.id,
        originMessageId: human.data.id, originSeq: Number(human.seq), workId: 'b00-contract-only-work', workRevision: 1, contractProbeOnly: true };
      const message = () => createUserMessage({ source, content: human.data.content });
      mark('source-preserving-original-bot-followup');
      const first = message(); main.followup(first); await main.whenIdle();
      const delivered = main.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === first.id);
      assert.deepEqual(delivered.data.source, source); assert.deepEqual(delivered.data.content, human.data.content);
      assert.equal(mainHumanCount(), originalHumanCount);
      assert.ok(main.session.snapshotEvents().some(event => event.type === 'assistant/message' && Number(event.seq) > Number(delivered.seq) && JSON.stringify(event.data).includes('B00_ORIGINAL_BOT_DELIVERY')));
      assert.deepEqual(ctx.dshBots.memoryOutlets.label(main.id).readers, []);
      receipts.push({ name: 'native-followup-source-and-original-bot-delivery', status: 'PASS', noPrivateUserSpoof: true, continuationGuardUnmodified: true });
      receipts.push({ name: 'current-data-flow-rejects-unadmitted-new-source', status: 'PASS', actualReaders: [], productBridgeImplemented: false });
      mark('busy-original-bot-queues-followup');
      adapter.hold = true;
      const busy = prompt('b00-busy-main', 'B00_MAIN_BUSY');
      await wait(() => adapter.releases.length);
      const pending = message(), callsBefore = adapter.calls.length;
      main.followup(pending);
      assert.throws(() => main.followup(pending), /already pending/);
      await delay(80, undefined, { signal: controller.signal });
      assert.equal(adapter.calls.length, callsBefore, 'Followup must wait for next turn');
      adapter.hold = false; for (const release of adapter.releases.splice(0)) release();
      await busy; await main.whenIdle();
      assert.ok(adapter.calls.find(call => call.inputId === pending.id));
      assert.equal(mainHumanCount(), originalHumanCount + 1);
      receipts.push({ name: 'busy-main-next-turn-and-pending-id-dedup', status: 'PASS' });
      mark('native-does-not-dedup-work-source');
      const before = adapter.calls.length, replay = message(); main.followup(replay); await main.whenIdle();
      assert.equal(adapter.calls.length, before + 1);
      receipts.push({ name: 'same-source-new-id-reexecutes-without-plugin-receipt', status: 'PASS', requiredPluginIdempotency: true });
      const childId = view.deliveries.find(delivery => delivery.childSessionId)?.childSessionId;
      assert.ok(childId);
      // Ordinary controller routing rejects subagent-owned sessions before
      // restoration. Use the public subagent delivery route to test the guard.
      mark('settled-child-continuation-stays-blocked');
      const beforeChild = adapter.calls.length;
      await assert.rejects(() => ctx.subagents.prompt({ parentSessionId: root.id, childSessionId: childId,
        mode: 'continuable', requestId: 'b00-denied-child-continuation', delivery: 'queue',
        content: [{ type: 'text', text: 'B00_DENIED_CHILD_CONTINUATION' }] }, controller.signal), error => error.code === 'subagent/not-resumable');
      assert.equal(adapter.calls.length, beforeChild, 'Settled group child followup must not reach the model');
      receipts.push({ name: 'settled-child-execution-guard', status: 'PASS', rejectedModelRequests: 0 });
      assert.ok(!adapter.calls.some(call => call.sessionId === root.id));
      assert.equal(await ctx.sessions.flush(main.session), true);
      await save('receipts', receipts); await save('calls', adapter.calls);
      await save('result', { status: 'PASS', capability: 'native-source-preserving-followup-only', realModelRequests: 0,
        syntheticRequests: adapter.calls.length, originalBotSessionId: main.id, group: key,
        implementedSupergroupInputBridge: false, sameWorkRevisionRuntime: 'NOT_RUN',
        durableIdempotencyAndCrashRecovery: 'NOT_RUN', ownerAuthenticatedGroupRemote: 'NOT_RUN' });
      console.log('B00_GROUP_DONE');
    })().catch(async error => {
      await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, receipts, calls: adapter.calls, realModelRequests: 0 });
      console.error('B00_GROUP_FAILED', error);
    }).finally(() => clearTimeout(timer));
    return async () => { controller.abort(); for (const release of adapter.releases) release(); await task; for (const off of releases.reverse()) off(); };
  }, 'bot-mode-group-input-native-probe');
}
