import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'v075-release-ui-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'subagents', 'agentPresets', 'webServer', 'attachments'];

class NativeAdapter extends LlmAdapter {
  calls = []; active = new Set(); maxActive = 0; endpoint; ui = false;
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Native API fixture' }]; }
  async *stream(options) {
    const call = { sessionId: options.sessionId, input: JSON.stringify(options), started: Date.now(), release: undefined };
    this.calls.push(call); this.active.add(call); this.maxActive = Math.max(this.maxActive, this.active.size);
    try {
      if (this.endpoint) await fetch(this.endpoint, { method: 'POST', body: JSON.stringify({ sessionId: options.sessionId }) });
      options.signal?.throwIfAborted();
      const live = this.ui && call.input.includes('UI_LIVE_TRACE');
      let reasoning = live ? `Live reasoning ${options.sessionId}` : 'Synthetic native reasoning';
      yield { type: 'block-start', index: 0, blockType: 'reasoning' };
      yield { type: 'reasoning-delta', index: 0, text: reasoning };
      if (live) {
        await delay(4500, undefined, { signal: options.signal });
        reasoning += ' — streamed update';
        yield { type: 'reasoning-delta', index: 0, text: ' — streamed update' };
        await delay(60000, undefined, { signal: options.signal });
      }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } };
      if (!this.ui) await new Promise(resolve => { call.release = resolve; options.signal?.addEventListener('abort', resolve, { once: true }); });
      options.signal?.throwIfAborted();
      if (this.ui && this.calls.filter(c => c.sessionId === options.sessionId).length === 1) {
        const id = 'native-ui-reply', args = JSON.stringify({ action: 'send', text: 'Published native Bot reply', requestReply: false });
        yield { type: 'block-start', index: 1, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 1, id, name: 'group_message', argumentsDelta: args };
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'group_message', arguments: args } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      const text = `Native result ${this.calls.filter(c => c.sessionId === options.sessionId).length}`;
      yield { type: 'block-start', index: 1, blockType: 'text' };
      yield { type: 'text-delta', index: 1, text };
      yield { type: 'block-end', index: 1, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally { call.ended = Date.now(); this.active.delete(call); }
  }
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), adapter = new NativeAdapter(), releases = [];
    const timer = setTimeout(() => lifetime.abort(new Error('UI fixture deadline')), 45000);
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const wait = async check => { for (;;) { lifetime.signal.throwIfAborted(); const v = await check(); if (v) return v; await delay(15, undefined, { signal: lifetime.signal }); } };
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      adapter.endpoint = config.endpoint; adapter.ui = true;
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter)); await ctx.dshBots.waitUntilReady();
      const groups = await wait(() => ctx.get('dshBotGroups'));
      const bots = [];
      for (const id of ['api-alpha', 'api-beta']) bots.push(await ctx.dshBots.create({ id, name: id, template: 'minimal', model: { provider: 'dp-b6b', model: 'fixture' } }));
      const g = await groups.create({ operationId: 'v075-ui', name: 'Release UI fixture', mode: 'natural', historyConfirmed: true,
        members: bots.map(b => ({ botId: b.id, botCreatedAt: b.createdAt })) });
      const key = { groupId: g.id, groupCreatedAt: g.createdAt };
      const members = (await groups.view(key)).members;
      const turn = await groups.send(key, { operationId: 'ui-trace', text: 'UI_TRACE', memberIds: [members[0].id], expectedMembershipRevision: 1 });
      const view = await wait(async () => { const v = await groups.view(key); return v.turns.find(t => t.id === turn.id && !['accepted', 'running'].includes(t.state)) && v; });
      assert.equal(view.turns.find(t => t.id === turn.id).state, 'idle');
      await save('ui-fixture', { rootId: g.rootSessionId, groupName: g.name, inputMessageId: turn.inputMessageId, turnId: turn.id, modelRequests: adapter.calls.length });
      clearTimeout(timer); console.log('B4_WEB_READY');
    })().catch(async error => { await save('result', { status: 'FAIL', error: String(error), stack: error.stack }); console.log('B4_WEB_FAILED'); });
    return async () => { clearTimeout(timer); lifetime.abort(); await run; for (const off of releases.reverse()) off(); };
  });
}
