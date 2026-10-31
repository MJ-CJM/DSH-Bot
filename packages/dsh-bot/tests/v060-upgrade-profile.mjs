import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'v060-upgrade-probe';
export const inject = ['loader', 'dshBots', 'llm', 'agents', 'sessions', 'sessionController', 'typertGateway'];
// Optional object keys with undefined are omitted by strict wire codecs and JSON.
// Preserve every defined value, field, array entry and ordering during comparisons.
function wireValue(value) {
  if (Array.isArray(value)) return value.map(wireValue);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).map(([key, item]) => [key, wireValue(item)]));
  return value;
}
const assertWireEqual = (actual, expected, message) => assert.deepEqual(wireValue(actual), wireValue(expected), message);
class UpgradeAdapter extends LlmAdapter {
  requests = 0; sessionIds = [];
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic upgrade history fixture' }]; }
  async *stream(options) {
    this.requests++; this.sessionIds.push(options.sessionId);
    const text = 'V060_RETAINED_NATIVE_RESULT';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const abort = new AbortController(), adapter = new UpgradeAdapter(), releases = [];
    let phase = 'loader', peer;
    const save = (name, value) => writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(value, null, 2));
    const mark = async value => { phase = value; console.log(`V060_UPGRADE_PHASE ${value}`); await save('progress', { phase }); };
    const wait = async check => { for (;;) { abort.signal.throwIfAborted(); const value = await check(); if (value) return value; await delay(20, undefined, { signal: abort.signal }); } };
    const timer = setTimeout(() => abort.abort(new Error(`V060 fixture deadline: ${phase}`)), 60000);
    const run = (async () => {
      await mark('loader'); await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      await ctx.dshBots.waitUntilReady(); await wait(() => ctx.dshBots.mainSessions);
      const groups = await wait(() => ctx.get('dshBotGroups')),
        connectors = await wait(() => ctx.get('dshBotConnectors')),
        notifications = await wait(() => ctx.get('dshBotNotifications'));
      const key = bot => ({ botId: bot.id, botCreatedAt: bot.createdAt });
      if (config.phase === 'old') {
        await mark('old-seed');
        const first = await ctx.dshBots.create({ id: 'v060-primary', name: 'V060 retained primary', template: 'minimal', persona: { prefix: 'Synthetic migration fixture; all model responses are local and deterministic.' } });
        const second = await ctx.dshBots.create({ id: 'v060-peer', name: 'V060 retained peer', template: 'minimal', persona: { prefix: 'Synthetic migration fixture peer.' } });
        // Actual 0.5.1 public memory capability, not a new-package format written into old storage.
        const memory = ctx.dshBots.memoryFor(first.id);
        assert.equal(typeof memory.save, 'function');
        await memory.save({ content: 'V060 retained pinned private preference.', kind: 'preference', tags: ['upgrade'], pinned: true }, { by: 'user', at: Date.now() });
        const main = await ctx.dshBots.openConversation(first.id), agent = ctx.agents.get(main.sessionId); assert.ok(agent);
        assert.equal((await ctx.sessionController.prompt({ sessionId: main.sessionId, requestId: 'v060-main-history', mode: 'queue',
          content: [{ type: 'text', text: 'V060_RETAINED_MAIN_QUESTION' }] }, abort.signal)).accepted, true);
        await agent.whenIdle();
        for (const mode of ['mention', 'round-robin']) {
          const g = await groups.create({ operationId: `v060-${mode}`, name: `V060 retained ${mode}`, mode, members: [key(first), key(second)], historyConfirmed: true });
          const group = { groupId: g.id, groupCreatedAt: g.createdAt }, view = await groups.view(group);
          const t = await groups.send(group, { operationId: `v060-history-${mode}`, text: `V060_RETAINED_GROUP_QUESTION_${mode}`,
            ...(mode === 'mention' ? { memberIds: [view.members[0].id] } : {}), expectedMembershipRevision: g.membershipRevision });
          await wait(async () => (await groups.view(group)).turns.find(row => row.id === t.id && !['accepted', 'running'].includes(row.state)));
          assert.equal(adapter.sessionIds.includes(g.rootSessionId), false);
        }
        await ctx.sessions.flush(agent.session);
        await connectors.saveDefinition({ id: 'v060-connector', label: 'V060 disabled MCP', serverName: 'v060fixture', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', enabled: false }, 0);
        await notifications.savePolicy({ id: 'v060-policy', owner: key(first), channel: 'in-app', enabled: true, timezone: 'UTC', dailyLimit: 20, cooldownSec: 0, authorization: { mode: 'ask' } }, 0, false);
        const flow = ctx.dshBots.memoryOutlets; assert.ok(flow);
        await flow.inherit(main.sessionId, { readers: [key(first)], originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [] });
        await notifications.record(key(first), { operationId: 'v060-inbox', policyId: 'v060-policy', text: 'V060 retained in-app notification.' }, { kind: 'tool', id: 'v060-synthetic-fixture', sessionId: main.sessionId });
      }
      await mark('read-state');
      const bots = await ctx.dshBots.list(), main = await ctx.dshBots.openConversation('v060-primary'), memories = await ctx.dshBots.memoryFor('v060-primary').list();
      const groupRows = await groups.list();
      const views = await Promise.all(groupRows.map(row => groups.view({ groupId: row.group.id, groupCreatedAt: row.group.createdAt })));
      const mainAgent = ctx.agents.get(main.sessionId); assert.ok(mainAgent);
      const mainHistory = mainAgent.session.snapshotEvents().filter(e => ['user/message', 'assistant/message'].includes(e.type)).map(e => ({ type: e.type, data: e.data }));
      assert.ok(JSON.stringify(mainHistory).includes('V060_RETAINED_MAIN_QUESTION'));
      assert.ok(JSON.stringify(mainHistory).includes('V060_RETAINED_NATIVE_RESULT'));
      assert.ok(views.every(view => view.messages.some(m => m.text === 'V060_RETAINED_NATIVE_RESULT')));
      const snapshot = { bots, main, mainHistory, memories, groups: groupRows, views, connectors: connectors.definitions(), assignments: connectors.assignments(), policies: notifications.policies(), inbox: notifications.list() };
      assert.equal(memories.length, 1); assert.ok(memories[0].content.includes('retained pinned private'));
      assert.deepEqual(snapshot.groups.map(row => row.group.mode).sort(), ['mention', 'round-robin']);
      assert.equal(snapshot.connectors[0].enabled, false); assert.equal(snapshot.inbox[0].state, 'recorded');
      if (config.phase !== 'old') assertWireEqual(snapshot, JSON.parse(await readFile(resolve(config.outputDir, 'old-state.json'))));
      await save('state', snapshot);
      await mark('strict-remote');
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (namespace, method, args) => ctx.typertGateway.invoke({ namespace, method, args, peer, signal: abort.signal });
      const { GROUPS_REMOTE } = await import(pathToFileURL(resolve(config.installedRoot, 'lib/shared/groups-contract.js')).href);
      const descriptor = GROUPS_REMOTE.descriptors.find(d => d.namespace === 'dshBot.groups' && d.method === 'view');
      assert.equal(descriptor.result.mode, 'strict');
      const listDescriptor = GROUPS_REMOTE.descriptors.find(d => d.namespace === 'dshBot.groups' && d.method === 'list');
      assert.equal(listDescriptor.result.mode, 'strict');
      const wireList = await invoke('dshBot.groups', 'list', {}); assertWireEqual(wireList, groupRows);
      assertWireEqual(listDescriptor.result.decode(JSON.parse(JSON.stringify(listDescriptor.result.encode(wireList, () => null)))), wireList);
      for (const view of snapshot.views) {
        const group = { groupId: view.group.id, groupCreatedAt: view.group.createdAt };
        const wireView = await invoke('dshBot.groups', 'view', { group, page: {} });
        assertWireEqual(wireView, view);
        const encoded = descriptor.result.encode(view, () => null);
        assertWireEqual(descriptor.result.decode(JSON.parse(JSON.stringify(encoded))), view);
        assert.throws(() => descriptor.result.encode({ ...view, privateStorageField: 'forbidden' }, () => null));
        await assert.rejects(() => invoke('dshBot.groups', 'view', { group, page: {}, sessionId: 'forged-private-address' }));
      }
      if (config.phase !== 'old') {
        const first = bots.find(b => b.id === 'v060-primary');
        const diagnosis = await invoke('dshBot.capabilities', 'request', { input: { action: 'inspect', bot: key(first) } });
        assert.equal(diagnosis.mainSessionId, main.sessionId);
      }
      if (config.phase !== 'old') {
        await mark('new-optional-input');
        const { groupSendSchema } = await import(pathToFileURL(resolve(config.installedRoot, 'lib/shared/groups.js')).href);
        const view = views[0], turn = view.turns[0], delivery = view.deliveries[0];
        assert.ok(turn && delivery);
        const group = { groupId: view.group.id, groupCreatedAt: view.group.createdAt };
        const input = { operationId: 'v060-invalid-completed-followup', text: 'Precise completed worker must reject', expectedMembershipRevision: view.group.membershipRevision,
          followup: { turnId: turn.id, deliveryId: delivery.id } };
        assert.deepEqual(groupSendSchema.parse(input).followup, input.followup);
        assert.throws(() => groupSendSchema.parse({ ...input, followup: { ...input.followup, childSessionId: 'forged' } }));
        await assert.rejects(() => invoke('dshBot.groups', 'send', { group, input }), error => {
          assert.ok(!String(error).includes('definition-unavailable')); assert.match(String(error), /unavailable/); return true;
        });
        assertWireEqual(await groups.view(group), view, 'Rejected followup changed legacy history');
      }
      assert.equal(adapter.requests, config.phase === 'old' ? 3 : 0);
      await save('result', { status: 'PASS', phase: config.phase, installedVersion: config.installedVersion,
        botsMemoryMainGroupsConnectorsNotificationsEqual: true, legacyGroupModesPreserved: true, strictRemotePositiveAndNegative: true, modelRequests: adapter.requests, realModelRequests: 0, mainAndGroupHistoryPreserved: true, newOptionalInputRegistered: config.phase !== 'old' });
      console.log('V060_UPGRADE_DONE');
    })().catch(async error => { await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, modelRequests: adapter.requests, realModelRequests: 0 }); console.log('V060_UPGRADE_FAILED'); });
    return async () => { clearTimeout(timer); abort.abort(); await run; await peer?.dispose(); for (const release of releases.reverse()) release(); };
  });
}
