import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { Peer } from '@deepseek-ai/dsh-client-connection';
export const name = 'fresh-main-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'subagents', 'schedule', 'typertGateway'];
const ambient = new Set(['runtime-context', 'time-context', 'agent-instructions', 'tmux-context']);
class Adapter extends LlmAdapter {
  ctx; oldChild; newChild; counts = new Map(); calls = [];
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic fresh main recovery' }]; }
  async *stream(options) {
    const agent = this.ctx.agents.get(options.sessionId); assert.ok(agent);
    const input = agent.session.snapshotEvents().findLast(e => e.type === 'user/message' && !ambient.has(e.data.source.kind));
    const text = input?.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? '';
    const nth = (this.counts.get(input?.data.id) ?? 0) + 1; this.counts.set(input?.data.id, nth);
    this.calls.push({ sessionId: agent.id, text }); let result;
    if (agent.session.header.parentSession) {
      if (text === 'FRESH_CHILD_OLD') {
        this.oldChild = { id: agent.id, signal: options.signal };
        await new Promise((accept, reject) => {
          const abort = () => reject(options.signal.reason); options.signal.addEventListener('abort', abort, { once: true });
          this.oldChild.release = () => { options.signal.removeEventListener('abort', abort); accept(); };
        });
        result = 'FRESH_OLD_TASK_RESULT';
      } else { assert.equal(text, 'FRESH_CHILD_NEW'); this.newChild = agent.id; result = 'FRESH_NEW_TASK_RESULT'; }
    } else if (input?.data.source.kind === 'user' && ['FRESH_START_OLD', 'FRESH_START_NEW'].includes(text) && nth === 1) {
      const id = ToolCallId(text), args = JSON.stringify({ targetBotId: 'alpha', task: text === 'FRESH_START_OLD' ? 'FRESH_CHILD_OLD' : 'FRESH_CHILD_NEW', title: 'Synthetic fresh recovery task' });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'bot_delegate', argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bot_delegate', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    } else result = 'FRESH_MAIN_ACK';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: result };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: result } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), adapter = new Adapter(), releases = []; adapter.ctx = ctx;
    let phase = 'loader', peer;
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const mark = async name => { phase = name; console.log(`FRESH_NATIVE_PHASE ${name}`); await save('progress', { phase }); };
    const wait = async check => { for (;;) { controller.signal.throwIfAborted(); const value = await check(); if (value) return value; await delay(20, undefined, { signal: controller.signal }); } };
    const timer = setTimeout(() => controller.abort(new Error(`Fresh main timeout: ${phase}`)), 60000);
    releases.push(ctx.on('approval/request', async request => request.toolName === 'bot_delegate' && /FRESH_CHILD_(OLD|NEW)/.test(request.reason) ? 'allowed-once' : 'rejected', { prepend: true }));
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []); releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      await ctx.dshBots.waitUntilReady(); await wait(() => ctx.dshBots.mainSessions); await wait(() => ctx.get('dshBotCapabilitiesRemote'));
      const bot = await ctx.dshBots.create({ id: 'alpha', name: 'Fresh recovery alpha', template: 'minimal', model: { provider: 'dp-b6b', model: 'fixture' } }), key = { botId: bot.id, botCreatedAt: bot.createdAt };
      const old = await ctx.dshBots.openConversation('alpha'), oldAgent = (await ctx.sessionController.resolveAgent(old.sessionId)).agent; assert.ok(oldAgent);
      const send = async (agent, text) => { await ctx.sessionController.prompt({ sessionId: agent.id, requestId: text, mode: 'queue', content: [{ type: 'text', text }] }, controller.signal); await agent.whenIdle(); };
      await ctx.dshBots.memoryFor('alpha').save({ content: 'FRESH_PRIVATE_MEMORY_RETAINED' });
      await mark('old-live-task'); await send(oldAgent, 'FRESH_START_OLD'); await wait(() => adapter.oldChild);
      const schedule = await ctx.schedule.create(oldAgent.id, { title: 'Retained synthetic reminder', prompt: 'FRESH_OLD_REMINDER', after_seconds: 86400 }, controller.signal);
      const flow = ctx.dshBots.memoryOutlets; assert.ok(flow);
      // Explicit fixture-only legacy contamination; product recovery never writes or clears labels.
      await flow.inherit(oldAgent.id, { readers: [], originTrust: 'candidate', sourceVersions: [], restrictions: ['no-egress'], grants: [] });
      const originalLabel = flow.label(oldAgent.id), originalEvents = oldAgent.session.snapshotEvents();
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const request = input => ctx.typertGateway.invoke({ namespace: 'dshBot.capabilities', method: 'request', args: { input }, peer, signal: controller.signal });
      await mark('diagnosis'); const diagnosis = await request({ action: 'inspect', bot: key });
      assert.equal(diagnosis.mainSessionId, oldAgent.id); assert.equal(diagnosis.dataFlow.state, 'restricted'); assert.ok(diagnosis.dataFlow.reasons.includes('no-egress'));
      await mark('explicit-fresh'); const fresh = await request({ action: 'freshConversation', bot: key, expectedSessionId: oldAgent.id });
      assert.equal(fresh.kind, 'conversation'); assert.notEqual(fresh.sessionId, oldAgent.id);
      assert.equal((await ctx.dshBots.openConversation('alpha')).sessionId, fresh.sessionId);
      assert.deepEqual(flow.label(oldAgent.id), originalLabel); assert.deepEqual(oldAgent.session.snapshotEvents(), originalEvents);
      assert.equal(adapter.oldChild.signal.aborted, false);
      assert.ok((await ctx.schedule.list({ sessionId: oldAgent.id })).some(row => row.id === schedule.id));
      assert.ok((await ctx.dshBots.memoryFor('alpha').search({ query: 'FRESH_PRIVATE_MEMORY_RETAINED' })).length);
      const newAgent = (await ctx.sessionController.resolveAgent(fresh.sessionId)).agent; assert.ok(newAgent);
      assert.equal(newAgent.session.snapshotEvents().some(e => e.type === 'user/message'), false);
      await mark('new-checked-task'); await send(newAgent, 'FRESH_START_NEW'); await wait(() => adapter.newChild);
      await wait(() => newAgent.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.source.kind === 'dsh-bot-delegate' && e.data.source.sourceSessionId === adapter.newChild && JSON.stringify(e.data.content).includes('FRESH_NEW_TASK_RESULT')));
      await newAgent.whenIdle();
      const newLabel = flow.label(newAgent.id);
      assert.ok(newLabel.readers === 'shared' || newLabel.readers.some(reader => reader.botId === key.botId && reader.botCreatedAt === key.botCreatedAt));
      await mark('old-task-still-delivers-old'); adapter.oldChild.release();
      await wait(() => oldAgent.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.source.kind === 'dsh-bot-delegate' && e.data.source.sourceSessionId === adapter.oldChild.id && JSON.stringify(e.data.content).includes('FRESH_OLD_TASK_RESULT')));
      await oldAgent.whenIdle();
      assert.ok(!JSON.stringify(newAgent.session.snapshotEvents()).includes('FRESH_OLD_TASK_RESULT'));
      assert.deepEqual(flow.label(oldAgent.id), originalLabel);
      await assert.rejects(() => request({ action: 'freshConversation', bot: key, expectedSessionId: oldAgent.id }));
      assert.equal((await ctx.dshBots.openConversation('alpha')).sessionId, fresh.sessionId);
      await save('diagnosis', diagnosis); await save('identities', { old: oldAgent.id, fresh: newAgent.id, oldChild: adapter.oldChild.id, newChild: adapter.newChild, scheduleId: schedule.id });
      await save('adapter', { count: adapter.calls.length, calls: adapter.calls, realModelRequests: 0 });
      await save('result', { status: 'PASS', syntheticAdapterCalls: adapter.calls.length, exactMainCas: true, oldHistoryRetained: true, oldLabelUnchanged: true, memoryRetained: true, scheduleRetained: true,
        oldNativeTaskNotStopped: true, oldResultDeliveredOnlyToOldMain: true, newCheckedSelfTaskCompleted: true, noOldHistoryCopied: true, realModelRequests: 0 });
      console.log('FRESH_NATIVE_DONE');
    })().catch(async error => { await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, calls: adapter.calls, realModelRequests: 0 }); console.log('FRESH_NATIVE_FAILED'); });
    return async () => { clearTimeout(timer); controller.abort(); await run; await peer?.dispose(); for (const release of releases.reverse()) release(); };
  });
}
