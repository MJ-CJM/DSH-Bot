import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'background-natural-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'subagents'];
const ambient = new Set(['runtime-context', 'time-context', 'agent-instructions', 'tmux-context']);
class BackgroundAdapter extends LlmAdapter {
  getAgent; workers = new Map(); counts = new Map(); calls = []; foregroundHeld = false;
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic deferred background fixture' }]; }
  async hold(signal, key) {
    signal.throwIfAborted();
    await new Promise((accept, reject) => {
      const abort = () => { const worker = this.workers.get(key); if (worker) worker.aborted = true; reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      const release = () => { signal.removeEventListener('abort', abort); accept(); };
      if (key === 'parent') this.foregroundHeld = true;
      else this.workers.get(key).release = release;
    });
  }
  async *stream(options) {
    const agent = this.getAgent(options.sessionId); assert.ok(agent);
    const input = agent.session.snapshotEvents().findLast(e => e.type === 'user/message' && !ambient.has(e.data.source.kind));
    const text = input?.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? '';
    const nth = (this.counts.get(input?.data.id) ?? 0) + 1; this.counts.set(input?.data.id, nth);
    this.calls.push({ sessionId: options.sessionId, parent: agent.session.header.parentSession, inputKind: input?.data.source.kind, nth });
    let result;
    if (agent.session.header.parentSession) {
      const key = text.includes('BG_CHILD_A') ? 'A' : text.includes('BG_CHILD_B') ? 'B' : undefined; assert.ok(key, text);
      this.workers.set(key, { id: options.sessionId, started: Date.now(), signal: options.signal });
      await this.hold(options.signal, key);
      result = `BG_CHILD_${key}_COMPLETE`;
    } else if (input?.data.source.kind === 'dsh-bot-delegate') result = 'BG_NOTICE_ACK';
    else if (text === 'BG_PARENT_STOP') { await this.hold(options.signal, 'parent'); result = 'must not complete'; }
    else if (text === 'BG_FOREGROUND') result = 'BG_FOREGROUND_ANSWER';
    else if ((text === 'BG_START_A' || text === 'BG_START_B') && nth === 1) {
      const key = text.at(-1), id = ToolCallId(`bg-start-${key}`), args = JSON.stringify({ targetBotId: 'alpha', task: `BG_CHILD_${key}`, title: `BG_TASK_${key}` });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'bot_delegate', argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bot_delegate', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    } else result = `BG_ACCEPTED_${text.at(-1)}`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: result };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: result } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), adapter = new BackgroundAdapter(), releases = [];
    adapter.getAgent = id => ctx.agents.get(id);
    let phase = 'loader', approvals = 0;
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const mark = async name => { phase = name; console.log(`BACKGROUND_NATIVE_PHASE ${name}`); await save('progress', { phase }); };
    const wait = async check => { for (;;) { lifetime.signal.throwIfAborted(); const result = await check(); if (result) return result; await delay(20, undefined, { signal: lifetime.signal }); } };
    const timer = setTimeout(() => lifetime.abort(new Error(`Background deadline: ${phase}`)), 60000);
    releases.push(ctx.on('approval/request', async request => {
      if (request.toolName === 'bot_delegate' && /BG_CHILD_[AB]/.test(request.reason)) { approvals++; return 'allowed-once'; }
      return 'rejected';
    }, { prepend: true }));
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      await ctx.dshBots.waitUntilReady(); await wait(() => ctx.dshBots.mainSessions);
      await ctx.dshBots.create({ id: 'alpha', name: 'Synthetic alpha', template: 'minimal', model: { provider: 'dp-b6b', model: 'fixture' } });
      const main = await ctx.dshBots.openConversation('alpha'), resolved = await ctx.sessionController.resolveAgent(main.sessionId), agent = resolved.agent;
      assert.ok(agent); assert.ok(ctx.dshBots.memoryKernel); assert.ok(ctx.dshBots.memoryOutlets);
      const send = async text => {
        await ctx.sessionController.prompt({ sessionId: agent.id, requestId: `synthetic-${text}`, mode: 'queue', content: [{ type: 'text', text }] }, lifetime.signal);
        await agent.whenIdle();
      };
      await mark('start-a'); await send('BG_START_A'); await wait(() => adapter.workers.has('A'));
      await mark('start-b'); await send('BG_START_B'); await wait(() => adapter.workers.has('B'));
      const a = adapter.workers.get('A'), b = adapter.workers.get('B');
      assert.notEqual(a.id, b.id); assert.equal(a.signal.aborted, false); assert.equal(b.signal.aborted, false);
      await save('overlap', { status: 'PASS', a: a.id, b: b.id, bothRunning: true });
      await mark('foreground'); await send('BG_FOREGROUND');
      assert.ok(JSON.stringify(agent.session.snapshotEvents()).includes('BG_FOREGROUND_ANSWER'));
      assert.equal(a.signal.aborted, false); assert.equal(b.signal.aborted, false);
      await mark('stop-a'); const receipt = ctx.subagents.interruptByParent(a.id, agent.id, 'continuable'); assert.equal(receipt.accepted, true);
      await wait(() => a.signal.aborted); assert.equal(b.signal.aborted, false);
      await mark('stop-parent');
      await ctx.sessionController.prompt({ sessionId: agent.id, requestId: 'synthetic-parent-stop', mode: 'queue', content: [{ type: 'text', text: 'BG_PARENT_STOP' }] }, lifetime.signal);
      await wait(() => adapter.foregroundHeld);
      assert.equal(ctx.sessionController.cancel({ sessionId: agent.id }).accepted, true); await agent.whenIdle();
      assert.equal(b.signal.aborted, false);
      await mark('complete-b'); b.release();
      await wait(() => agent.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.source.kind === 'dsh-bot-delegate' && e.data.source.sourceSessionId === b.id));
      await agent.whenIdle();
      const events = agent.session.snapshotEvents(), notices = events.filter(e => e.type === 'user/message' && e.data.source.kind === 'dsh-bot-delegate');
      assert.equal(notices.filter(e => e.data.source.sourceSessionId === b.id).length, 1);
      assert.equal(notices.filter(e => e.data.source.sourceSessionId === a.id).length, 0);
      assert.ok(JSON.stringify(notices).includes('BG_CHILD_B_COMPLETE')); assert.ok(!JSON.stringify(notices).includes('BG_CHILD_A_COMPLETE'));
      assert.equal(approvals, 2);
      assert.equal(await ctx.sessions.flush(agent.session), true);
      await save('events', events);
      await save('result', { status: 'PASS', approvals, actualControllerPrompts: 4, actualBotDelegateStarts: 2, overlappingNativeChildren: true, foregroundRespondedWhileBothRunning: true,
        stopAOnly: true, parentStopPreservesB: true, bResultDeliveredExactlyOnce: true, memoryKernelEnabled: true, syntheticAdapterCalls: adapter.calls.length, realModelRequests: 0 });
      console.log('BACKGROUND_NATIVE_DONE');
    })().catch(async error => { await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, calls: adapter.calls, realModelRequests: 0 }); console.log('BACKGROUND_NATIVE_FAILED'); });
    return async () => { clearTimeout(timer); lifetime.abort(); await run; for (const release of releases.reverse()) release(); };
  });
}
