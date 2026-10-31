import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'delegate-continuation-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'subagents', 'sessionQuery'];
const ambient = new Set(['runtime-context', 'time-context', 'agent-instructions', 'tmux-context']);
class Adapter extends LlmAdapter {
  ctx; calls = []; counts = new Map(); children = new Map(); released;
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'P0 native continuation fixture' }]; }
  async *stream(options) {
    const agent = this.ctx.agents.get(options.sessionId); assert.ok(agent);
    const latest = agent.session.snapshotEvents().findLast(e => e.type === 'user/message' && !ambient.has(e.data.source.kind));
    const text = latest?.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? '';
    const nth = (this.counts.get(latest?.data.id) ?? 0) + 1; this.counts.set(latest?.data.id, nth);
    this.calls.push({ id: options.sessionId, parent: agent.session.header.parentSession, text });
    let result;
    if (agent.session.header.parentSession) {
      assert.ok(!JSON.stringify(options).includes('P0_BETA_PRIVATE_CANARY'), 'resumed private context reached the model');
      const old = this.children.get(agent.id), key = old?.key ?? (text.includes('CROSS') ? 'cross' : 'self');
      this.children.set(agent.id, { key, agent });
      if (key === 'cross' && !old) await new Promise((accept, reject) => {
        const abort = () => reject(options.signal.reason);
        options.signal.addEventListener('abort', abort, { once: true });
        this.released = () => { options.signal.removeEventListener('abort', abort); accept(); };
      });
      result = key === 'cross' ? 'P0_CROSS_SAFE_COMPLETE' : 'P0_SELF_SAFE_COMPLETE';
    } else if (latest?.data.source.kind === 'user' && (text === 'P0_START_CROSS' || text.startsWith('P0_START_SELF')) && nth === 1) {
      const cross = text.endsWith('CROSS'), id = ToolCallId(`p0-${cross ? 'cross' : 'self'}`), args = JSON.stringify({ targetBotId: cross ? 'beta' : 'alpha', task: cross ? 'P0_CHILD_CROSS' : 'P0_CHILD_SELF', title: 'P0 synthetic checked child' });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'bot_delegate', argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bot_delegate', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    } else result = 'P0_PARENT_ACK';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: result };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: result } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), adapter = new Adapter(), releases = [], created = [];
    adapter.ctx = ctx;
    let phase = 'loader';
    const save = (name, value) => writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(value, null, 2));
    const mark = async name => { phase = name; console.log(`P0_CONTINUATION_PHASE ${name}`); await save('progress', { phase }); };
    const wait = async check => { for (;;) { controller.signal.throwIfAborted(); const value = await check(); if (value) return value; await delay(20, undefined, { signal: controller.signal }); } };
    const timer = setTimeout(() => controller.abort(new Error(`P0 timeout ${phase}`)), 60000);
    releases.push(ctx.on('agent/created', ({ agent, source }) => { created.push({ agent, source }); }));
    releases.push(ctx.on('approval/request', async request =>
      ((request.toolName === 'bot_delegate' || request.toolName === 'dsh_bot_export_delegate-input') && /P0_CHILD_(CROSS|SELF)/.test(request.reason)) ? 'allowed-once' : 'rejected', { prepend: true }));
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      await ctx.dshBots.waitUntilReady(); await wait(() => ctx.dshBots.mainSessions);
      if (config.phase === 'first') for (const id of ['alpha', 'beta']) await ctx.dshBots.create({ id, name: id, template: 'minimal', model: { provider: 'dp-b6b', model: 'fixture' } });
      const main = await ctx.dshBots.openConversation('alpha'), agent = (await ctx.sessionController.resolveAgent(main.sessionId)).agent;
      assert.ok(agent);
      const prompt = async (child, text) => ctx.subagents.prompt({ parentSessionId: agent.id, childSessionId: child,
        mode: 'continuable', requestId: `${config.phase}-${text}`, delivery: 'queue', content: [{ type: 'text', text }] }, controller.signal);
      const send = async text => { await ctx.sessionController.prompt({ sessionId: agent.id, requestId: `${config.phase}-${text}`, mode: 'queue', content: [{ type: 'text', text }] }, controller.signal); await agent.whenIdle(); };
      const checked = async child => wait(() => agent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.source.kind === 'dsh-bot-delegate' && e.data.source.sourceSessionId === child));
      const blockedResume = async (child, label, wake) => {
        await mark(label);
        const before = adapter.calls.filter(c => c.id === child).length, prior = created.filter(row => row.agent.id === child).length, parentSeq = agent.session.seq;
        let refusal;
        try { await wake(); } catch (error) { refusal = { code: error.code, message: String(error) }; }
        assert.ok(refusal, 'Unleased continuation must fail during Agent creation');
        assert.equal(refusal.code, label === 'send-message-cold-wake' ? 'NOT_RESUMABLE' : 'subagent/not-resumable');
        assert.equal(created.filter(row => row.agent.id === child).at(prior)?.source, 'resume');
        await wait(() => !ctx.agents.get(child)); await agent.whenIdle();
        const history = await ctx.sessionQuery.observeSession(child, { signal: controller.signal });
        try { assert.equal(history.header.parentSession, agent.id); assert.ok(history.events.length); } finally { history[Symbol.dispose](); }
        assert.equal(adapter.calls.filter(c => c.id === child).length, before);
        const parentNew = agent.session.snapshotEvents(parentSeq);
        assert.ok(!JSON.stringify(parentNew).includes('P0_BETA_PRIVATE_CANARY'));
        assert.ok(!JSON.stringify(parentNew).includes('P0_CROSS_SAFE_COMPLETE'), 'old assistant output was re-exported');
        assert.ok(!parentNew.some(e => e.type === 'user/message' && e.data.source.kind === 'subagent-settled'), 'rejection generated an unchecked parent notice');
        await save(label, { status: 'PASS', historicalReadAllowed: true, refusal, modelCalls: 0, parentNewEvents: parentNew, lifecycleAttempts: created.filter(row => row.agent.id === child).length - prior });
      };
      let ids;
      if (config.phase === 'first') {
        await mark('self-initial'); await send('P0_START_SELF');
        const self = await wait(() => [...adapter.children.entries()].find(([, v]) => v.key === 'self'));
        await checked(self[0]); await agent.whenIdle();
        await mark('cross-initial'); await send('P0_START_CROSS');
        const cross = await wait(() => [...adapter.children.entries()].find(([, v]) => v.key === 'cross'));
        await mark('inflight-supplement'); await prompt(cross[0], 'P0_INFLIGHT_CROSS'); adapter.released();
        await checked(cross[0]); await agent.whenIdle();
        assert.ok(adapter.calls.filter(c => c.id === cross[0]).length >= 2, 'in-flight supplement did not run under original caller');
        assert.ok(adapter.calls.some(c => c.id === cross[0] && c.text === 'P0_INFLIGHT_CROSS'));
        assert.ok(JSON.stringify(agent.session.snapshotEvents()).includes('P0_CROSS_SAFE_COMPLETE'));
        await ctx.dshBots.memoryFor('beta').save({ content: 'P0_BETA_PRIVATE_CANARY' });
        ids = { self: self[0], cross: cross[0], parent: agent.id };
        await writeFile(resolve(config.outputDir, 'identities.json'), JSON.stringify(ids, null, 2));
        await blockedResume(ids.cross, 'native-ui-cold-resume', () => prompt(ids.cross, 'P0_RESUME_READ_PRIVATE'));
        await blockedResume(ids.cross, 'send-message-cold-wake', () => ctx.subagents.sendMessage(agent, ids.cross, [{ type: 'text', text: 'P0_SEND_MESSAGE_WAKE' }], { signal: controller.signal }));
        await blockedResume(ids.self, 'same-bot-cold-resume', () => prompt(ids.self, 'P0_SELF_RESUME'));
      } else {
        ids = JSON.parse(await readFile(resolve(config.outputDir, 'identities.json'))); assert.equal(agent.id, ids.parent);
        await blockedResume(ids.cross, 'process-cold-resume', () => prompt(ids.cross, 'P0_PROCESS_RESTART_RESUME'));
      }
      await mark('fresh-self-after-rejections');
      const previous = new Set(adapter.children.keys());
      await send('P0_START_SELF_AFTER_REJECT');
      const fresh = await wait(() => [...adapter.children.entries()].find(([id]) => !previous.has(id)));
      const freshResult = await checked(fresh[0]); await agent.whenIdle();
      assert.ok(JSON.stringify(freshResult.data.content).includes('P0_SELF_SAFE_COMPLETE'), 'new child returned only an unavailable notice');
      await save('result', { status: 'PASS', phase: config.phase, checkedInitialExecution: config.phase === 'first', actualNativeContinuation: true,
        freshCheckedSelfAfterRejection: true, noUncheckedSettlement: true, coldModelRequests: 0, privateCanaryNotExported: true, oldAssistantOutputNotReExported: true, actualInFlightSupplement: config.phase === 'first', realModelRequests: 0 });
      console.log('P0_CONTINUATION_DONE');
    })().catch(async error => { await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, calls: adapter.calls, realModelRequests: 0 }); console.log('P0_CONTINUATION_FAILED'); });
    return async () => { clearTimeout(timer); controller.abort(); await run; for (const release of releases.reverse()) release(); };
  });
}
