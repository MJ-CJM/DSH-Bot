import '../../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareAutomaticShare } from '../../lib/host/memory/auto-share.js';
import { hostPolicyPairs } from './b6b-host-policy.mjs';
import { B6bAdapter } from './b6b-adapter.mjs';
import { bounded } from './b6a-support.mjs';
export const name = 'dp-b6b-probe';
export const inject = ['loader', 'llm', 'agents', 'dshBots', 'sessionController', 'dshBotMessaging',
  'dshBotGroups', 'dshBotNotifications', 'dshBotReferenceMemory'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), signal = lifetime.signal, adapter = new B6bAdapter();
    let phase = 'loader-ready', done = false;
    const save = (name, value) => writeFile(resolve(config.outputDir, `receipts/${name}.json`), JSON.stringify(value, null, 2));
    const mark = async value => { phase = value; await save('progress', { phase }); console.log(`DP_B6B_PHASE ${phase}`); };
    const until = async check => {
      while (true) { signal.throwIfAborted(); const value = await check(); if (value) return value; await delay(20, undefined, { signal }); }
    };
    const releases = [ctx.llm.registerAdapter(['dp-b6b'], adapter)];
    releases.push(ctx.on('approval/request', async request => {
      if (request.toolName === 'bot_message' || request.toolName === 'bot_delegate' ||
        request.toolName.startsWith('dsh_bot_export_')) return 'allowed-once';
      return 'rejected';
    }, { prepend: true }));
    const timer = setTimeout(() => lifetime.abort(new Error(`B6b deadline: ${phase}`)), 60000);
    const run = bounded(async () => {
      assert.equal(ctx.llm.listProviders().length, 0);
      await mark('loader-ready'); await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      await until(() => ctx.dshBots.mainSessions);
      const agents = {}, keys = {};
      for (const id of (config.suite === 'message-egress' ? ['alpha', 'beta', 'gamma'] : ['alpha', 'beta'])) {
        const b = await ctx.dshBots.create({ id, name: id, template: 'minimal',
          model: { provider: 'dp-b6b', model: 'fixture' }, persona: { prefix: 'Synthetic B6b fixture.' } });
        const main = await ctx.dshBots.openConversation(id), resolved = await ctx.sessionController.resolveAgent(main.sessionId);
        assert.ok(resolved.agent); agents[id] = resolved.agent; keys[id] = { botId: id, botCreatedAt: b.createdAt };
      }
      const registry = ctx.dshBots, flow = registry.memoryOutlets;
      assert.ok(flow); await mark(config.suite);
      const prompt = async (id, tool) => {
        if (tool) adapter.plans.set(agents[id].session.id, [tool]);
        const result = await ctx.sessionController.prompt({ requestId: randomUUID(), sessionId: agents[id].session.id,
          mode: 'queue', content: [{ type: 'text', text: 'Synthetic explicit task, not a trusted automatic-share entry.' }] }, signal);
        assert.equal(result.accepted, true); await agents[id].whenIdle();
      };
      let detail = {};
      if (config.suite === 'message-egress') {
        const incoming = () => agents.beta.session.snapshotEvents().findLast(e =>
          e.type === 'user/message' && e.data.source.kind === 'dsh-bot-message').data.source.messageId;
        adapter.plans.set(agents.beta.session.id, [
          () => ({ name: 'bot_message', arguments: { action: 'send', to: 'gamma', mode: 'notify',
            content: 'B6B_FORWARD', inReplyToContext: incoming() } }),
          () => ({ name: 'bot_message', arguments: { action: 'reply', replyTo: incoming(), content: 'B6B_REPLY' } }),
        ]);
        await prompt('alpha', { name: 'bot_message', arguments: { action: 'send', to: 'beta', mode: 'ask', content: 'B6B_MESSAGE' } });
        await until(() => ctx.dshBotMessaging.store.rows().filter(r => r.delivery === 'delivered').length === 3);
        const record = ctx.dshBotMessaging.store.rows()[0]; assert.ok(record.flowId);
        assert.equal(flow.get(record.flowId).state, 'delivered');
        await agents.beta.whenIdle();
        const before = ctx.dshBotMessaging.store.rows().length;
        await flow.inherit(agents.alpha.session.id, { ...flow.label(agents.alpha.session.id), restrictions: ['secret'] });
        await prompt('alpha', { name: 'bot_message', arguments: { action: 'send', to: 'beta', mode: 'notify', content: 'PRIVATE_CANARY_B6B' } });
        await ctx.dshBotMessaging.settled(); assert.equal(ctx.dshBotMessaging.store.rows().length, before);
        detail = { nativeMessageDelivered: true, secretRejected: true, nativeForwardDelivered: true, fixedReplyDelivered: true };
      } else if (config.suite === 'group-egress') {
        const group = await ctx.dshBotGroups.create({ operationId: randomUUID(), name: 'Synthetic B6b',
          members: Object.values(keys), mode: 'round-robin', historyConfirmed: true });
        const key = { groupId: group.id, groupCreatedAt: group.createdAt };
        const turn = await ctx.dshBotGroups.send(key, { operationId: randomUUID(), text: 'B6B_GROUP',
          round: true, expectedMembershipRevision: group.membershipRevision });
        const view = await until(async () => { const v = await ctx.dshBotGroups.view(key);
          return v.turns.find(t => t.id === turn.id)?.state === 'completed' && v; });
        assert.equal(view.deliveries.filter(d => d.outputMessageId).length, 2);
        detail = { nativeGroupResults: 2, memberIsolation: 'persistent policy pairs are UNIT only' };
      } else if (config.suite === 'delegate-egress') {
        await prompt('alpha', { name: 'bot_delegate', arguments: { targetBotId: 'beta', task: 'B6B_TASK' } });
        await until(() => [...flow.kernel.domain.table('flows').entries()].some(([, r]) =>
          r.envelope?.outlet === 'delegate-result' && r.state === 'delivered'));
        assert.ok(agents.alpha.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.source.kind === 'dsh-bot-delegate'));
        detail = { nativeCallerDelivery: true, checkedParentReport: true };
      } else if (config.suite === 'notify-egress') {
        await ctx.dshBotNotifications.savePolicy({ id: 'synthetic-in-app', owner: keys.alpha, channel: 'in-app',
          enabled: true, timezone: 'UTC', dailyLimit: 20, cooldownSec: 0, authorization: { mode: 'ask' } }, 0, true);
        await prompt('alpha', { name: 'bot_notify', arguments: { policyId: 'synthetic-in-app', text: 'B6B_LOCAL_NOTIFICATION' } });
        const rows = ctx.dshBotNotifications.list(); assert.equal(rows.length, 1); assert.ok(rows[0].flowId);
        assert.equal(flow.get(rows[0].flowId).state, 'delivered');
        detail = { inAppRecorded: true, systemNotifications: 0, imSends: 0 };
      } else if (config.suite === 'mcp-egress') {
        await registry.memoryFor('alpha').save({ content: 'B6B_COPY' });
        const graph = ctx.dshBotReferenceMemory, bot = keys.alpha;
        const preview = await graph.request({ action: 'preview', bot }); assert.ok(preview.copy);
        await graph.request({ action: 'stage', bot, copyId: preview.copy.id });
        await graph.request({ action: 'commit', bot, copyId: preview.copy.id });
        const read = await graph.request({ action: 'tool', bot, call: { tool: 'read_graph', arguments: {} } });
        assert.ok(JSON.stringify(read.graph).includes('B6B_COPY'));
        detail = { nativeMcpCopy: true, connectors: 'separate loopback tests; no external servers enabled' };
      } else if (config.suite === 'auto-share') {
        assert.throws(() => prepareAutomaticShare({ isTrusted: true }, {}));
        assert.equal((await registry.autoShareStatus()).effectiveAutoShare, false);
        detail = { status: 'FAIL (capability)', automaticLegalPath: false };
      } else {
        detail = await hostPolicyPairs(registry, keys);
      }
      signal.throwIfAborted();
      await save('result', { status: 'PASS', suite: config.suite, evidenceLevel: 'HOST_SYNTHETIC_ADAPTER',
        ...detail, syntheticAdapterRequests: adapter.requests, realModelRequests: 0 });
      done = true; console.log('DP_B6B_DONE');
    }, signal).catch(async error => {
      await save('result', { status: 'FAIL', suite: config.suite, phase, error: String(error), stack: error.stack, realModelRequests: 0 });
      console.log('DP_B6B_FAILED');
    }).finally(() => clearTimeout(timer));
    return async () => { if (!done) lifetime.abort(new Error(`B6b unload at ${phase}`)); await run; for (const off of releases) off(); };
  });
}
