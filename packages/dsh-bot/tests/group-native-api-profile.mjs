import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'group-native-api-profile';
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
    const lifetime = new AbortController(), adapter = new NativeAdapter(), releases = [], starts = [], ends = [], assertions = [];
    const timer = setTimeout(() => lifetime.abort(new Error('native API fixture deadline')), 65000);
    let phase = 'loader', root, childIds = [];
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const wait = async check => { for (;;) { lifetime.signal.throwIfAborted(); const v = await check(); if (v) return v; await delay(15, undefined, { signal: lifetime.signal }); } };
    const mark = name => { phase = name; console.log(`GROUP_API_PHASE ${name}`); };
    const ok = (name, value) => { assert.ok(value, name); assertions.push(name); };
    const blocks = text => [{ type: 'text', text }];
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      adapter.endpoint = config.endpoint;
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter)); await ctx.dshBots.waitUntilReady();
      const groups = await wait(() => ctx.get('dshBotGroups'));
      const bots = [];
      for (const id of ['api-alpha', 'api-beta']) bots.push(await ctx.dshBots.create({ id, name: id, template: 'minimal', model: { provider: 'dp-b6b', model: 'fixture' } }));
      const g = await groups.create({ operationId: 'native-api', name: 'Native API fixture', mode: 'natural', historyConfirmed: true,
        members: bots.map(b => ({ botId: b.id, botCreatedAt: b.createdAt })) });
      root = ctx.agents.get(g.rootSessionId); assert.ok(root);
      // Isolate the native API contract from the plugin's checked-worker admission.
      // Product integration must still reserve the exact group worker before activation.
      releases.push(await ctx.agentPresets.register({ id: 'native-api-child', name: 'Native API child', plugins: [] }));
      childIds = [randomUUID(), randomUUID()];
      releases.push(ctx.on('subagent/start', info => { if (childIds.includes(info.id)) starts.push({ ...info, at: Date.now() }); }));
      releases.push(ctx.on('subagent/end', info => { if (childIds.includes(info.id)) ends.push({ ...info, at: Date.now() }); }));
      const start = (index) => ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', childId: childIds[index],
        label: bots[index].name, signal: lifetime.signal, request: { parent: root,
          agentPreset: 'native-api-child',
          agentOptions: { provider: 'dp-b6b', model: 'fixture' }, prompt: blocks(`INITIAL_${index}`), maxDepth: 1 } });
      mark('concurrent');
      const handles = await Promise.all([start(0), start(1)]);
      await wait(() => adapter.active.size === 2 && adapter.calls.every(c => c.release));
      ok('two native model streams actually overlap', adapter.maxActive === 2);
      const a = ctx.agents.get(childIds[0]), b = ctx.agents.get(childIds[1]);
      assert.ok(a && b);
      ok('delegated approval remains never', [a, b].every(agent => agent.session.snapshotEvents().findLast(e => e.type === 'approval/policy')?.data.policy === 'never'));
      await assert.rejects(ctx.subagents.sendMessage(a, b.id, blocks('INVALID_SIBLING'), { signal: lifetime.signal }));
      ok('direct sibling delivery rejected', true);
      mark('active-parent-bridge');
      const bridge = await ctx.subagents.sendMessage(root, b.id, blocks('BRIDGE_FROM_ALPHA task=native-api author=api-alpha CHECK_BETA'), { signal: lifetime.signal });
      ok('active child inbox accepts attributed parent bridge', Boolean(bridge));
      adapter.calls[0].release(); adapter.calls[1].release();
      await wait(() => adapter.calls.length === 3 && adapter.calls[2].release);
      ok('busy child processes bridged message at later step', adapter.calls[2].sessionId === b.id && adapter.calls[2].input.includes('CHECK_BETA'));
      const attributed = b.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.id === bridge);
      ok('native attribution is the parent Agent, not an impersonated user', attributed?.data.source.kind === 'agent-message' && attributed.data.source.senderSessionId === root.id);
      adapter.calls[2].release();
      const initial = await Promise.all(handles.map(h => h.result));
      ok('initial results are individually completed', initial.every(r => r.stopReason === 'completed'));
      ok('result lifecycle pairs use unique run ids', starts.length === 2 && ends.length === 2 && starts.every(s => ends.some(e => e.runId === s.runId && e.id === s.id)));
      mark('idle-resume');
      const messageId = await ctx.subagents.sendMessage(root, a.id, blocks('RESUME_SAME_CHILD'), { signal: lifetime.signal });
      await wait(() => adapter.calls.length === 4 && adapter.calls[3].release);
      ok('idle continuation reuses durable child identity and history', adapter.calls[3].sessionId === a.id && adapter.calls[3].input.includes('INITIAL_0') && adapter.calls[3].input.includes('RESUME_SAME_CHILD'));
      await handles[0].dispose();
      ok('old activation disposer does not cancel new activation', adapter.active.has(adapter.calls[3]));
      adapter.calls[3].release();
      await wait(() => ends.length === 3);
      ok('resumed result available on new public lifecycle event', ends[2].id === a.id && ends[2].runId !== starts[0].runId && ends[2].lastAssistantMessage?.some(v => v.type === 'text'));
      mark('independent-stop');
      await Promise.all(childIds.map(id => ctx.subagents.sendMessage(root, id, blocks('STOP_TEST'), { signal: lifetime.signal })));
      await wait(() => adapter.active.size === 2 && [...adapter.active].every(c => c.release));
      ctx.subagents.interrupt(a.id, { kind: 'ancestor', agent: root });
      await wait(() => ![...adapter.active].some(c => c.sessionId === a.id));
      ok('interrupt one member preserves sibling execution', [...adapter.active].some(c => c.sessionId === b.id));
      for (const call of adapter.active) call.release();
      await wait(() => ends.length === 5);
      await ctx.subagents.drainChildren(root, childIds);
      ok('drain releases selected children', childIds.every(id => !ctx.agents.get(id)));
      const catalog = await ctx.subagents.listChildren(root.id, lifetime.signal);
      ok('discovery retains both durable children without waking', childIds.every(id => catalog.some(row => row.id === id)));
      const count = adapter.calls.length; await delay(150);
      ok('inspection and cleanup do not make extra model requests', adapter.calls.length === count);
      ok('group root never calls the model', adapter.calls.every(c => c.sessionId !== root.id));
      await save('result', { status: 'PASS', assertions, starts, ends, accepted: { bridge, messageId }, modelRequests: count,
        rootModelRequests: 0, realModelRequests: 0, calls: adapter.calls.map(({ release, ...c }) => c) });
      console.log('GROUP_API_DONE');
      if (['group-api', 'ui-completion'].includes(config.suite)) {
        mark('native-ui-trace'); adapter.ui = true;
        const key = { groupId: g.id, groupCreatedAt: g.createdAt };
        const members = (await groups.view(key)).members;
        const turn = await groups.send(key, { operationId: 'ui-trace', text: 'UI_TRACE', memberIds: [members[0].id], expectedMembershipRevision: 1 });
        const view = await wait(async () => { const v = await groups.view(key); return v.turns.find(t => t.id === turn.id && !['accepted', 'running'].includes(t.state)) && v; });
        const delivery = view.deliveries.find(d => d.turnId === turn.id);
        assert.ok(delivery.childSessionId);
        const second = await groups.send(key, { operationId: 'ui-trace-second', text: 'UI_TRACE_SECOND', memberIds: [members[1].id], expectedMembershipRevision: 1 });
        await wait(async () => (await groups.view(key)).turns.find(t => t.id === second.id && !['accepted', 'running'].includes(t.state)));
        const imageContent = await ctx.attachments.admitPromptContent([{ type: 'text', text: 'UI_IMAGE_PREVIEW' },
          { type: 'image', mediaType: 'image/png', name: 'ui-preview.png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }]);
        const imageMessage = createUserMessage({ source: { kind: 'dsh-bot-group-user', group: key, turnId: second.id }, content: imageContent });
        await root.session.append('user/message', imageMessage, { surfaceOp: 'append' });
        await ctx.sessions.flush(root.session);
        await save('ui-fixture', { rootId: g.rootSessionId, childId: delivery.childSessionId, groupName: g.name,
          inputMessageId: turn.inputMessageId, turnId: turn.id, secondInputMessageId: second.inputMessageId, secondTurnId: second.id, modelRequests: adapter.calls.length });
        if (config.suite === 'ui-completion') {
          for (let i = 2; i < 50; i++) await ctx.dshBots.create({ id: `ui-bot-${i}`, name: i < 4 ? '同名助手 / Same name' : `研究与项目协作助手 ${i} — Long name for narrow screens`, template: 'minimal' });
        }
        clearTimeout(timer); console.log('B4_WEB_READY');
      }
    })().catch(async error => { await save('result', { status: 'FAIL', phase, assertions, error: String(error), stack: error.stack,
      starts, ends, calls: adapter.calls.map(({ release, ...c }) => c) }); console.log(['group-api', 'ui-completion'].includes(config.suite) ? 'B4_WEB_FAILED' : 'GROUP_API_FAILED'); });
    return async () => { clearTimeout(timer); lifetime.abort(); for (const call of adapter.active) call.release?.();
      if (root) await ctx.subagents.drainChildren(root, childIds).catch(() => {}); await run; for (const off of releases.reverse()) off(); };
  });
}
