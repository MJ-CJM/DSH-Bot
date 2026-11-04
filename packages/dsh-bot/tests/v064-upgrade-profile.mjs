import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'v064-upgrade-probe';
export const inject = ['loader', 'dshBots', 'llm', 'agents', 'sessions', 'sessionController', 'typertGateway'];
// Optional object keys with undefined are omitted by strict wire codecs and JSON.
function wireValue(value) {
  if (Array.isArray(value)) return value.map(wireValue);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).map(([key, item]) => [key, wireValue(item)]));
  return value;
}
const assertWireEqual = (actual, expected, message) => assert.deepEqual(wireValue(actual), wireValue(expected), message);
const RESULT = 'V064_RETAINED_NATIVE_RESULT';
class UpgradeAdapter extends LlmAdapter {
  requests = 0; sessionIds = [];
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic upgrade history fixture' }]; }
  async *stream(options) {
    this.requests++; this.sessionIds.push(options.sessionId);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: RESULT };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: RESULT } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
/**
 * Phases: `old` seeds data with the public 0.6.3 package; `new` reads it after an in-place
 * upgrade to 0.6.4 without model work, then asks the upgraded group one new question;
 * `reinstalled` reads everything again after remove + add, again without model work.
 */
export function apply(ctx, config) {
  ctx.effect(() => {
    const abort = new AbortController(), adapter = new UpgradeAdapter(), releases = [];
    let phase = 'loader', peer;
    const save = (name, value) => writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(value, null, 2));
    const load = name => readFile(resolve(config.outputDir, name), 'utf8').then(JSON.parse);
    const mark = async value => { phase = value; console.log(`V064_UPGRADE_PHASE ${value}`); await save('progress', { phase }); };
    const wait = async check => { for (;;) { abort.signal.throwIfAborted(); const value = await check(); if (value) return value; await delay(20, undefined, { signal: abort.signal }); } };
    const timer = setTimeout(() => abort.abort(new Error(`V064 fixture deadline: ${phase}`)), 90000);
    const run = (async () => {
      await mark('loader'); await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      await ctx.dshBots.waitUntilReady(); await wait(() => ctx.dshBots.mainSessions);
      const groups = await wait(() => ctx.get('dshBotGroups')),
        connectors = await wait(() => ctx.get('dshBotConnectors')),
        notifications = await wait(() => ctx.get('dshBotNotifications'));
      const key = bot => ({ botId: bot.id, botCreatedAt: bot.createdAt });
      const settled = async (group, turnId) => wait(async () => (await groups.view(group)).turns.find(row => row.id === turnId && !['accepted', 'running'].includes(row.state)));
      if (config.phase === 'old') {
        await mark('old-seed');
        const first = await ctx.dshBots.create({ id: 'v064-primary', name: 'V064 retained primary', template: 'minimal', persona: { prefix: 'Synthetic upgrade fixture; all model responses are local and deterministic.' } });
        const second = await ctx.dshBots.create({ id: 'v064-peer', name: 'V064 retained peer', template: 'minimal', persona: { prefix: 'Synthetic upgrade fixture peer.' } });
        await ctx.dshBots.memoryFor(first.id).save({ content: 'V064 retained pinned private preference.', kind: 'preference', tags: ['upgrade'], pinned: true }, { by: 'user', at: Date.now() });
        const main = await ctx.dshBots.openConversation(first.id), agent = ctx.agents.get(main.sessionId); assert.ok(agent);
        assert.equal((await ctx.sessionController.prompt({ sessionId: main.sessionId, requestId: 'v064-main-history', mode: 'queue',
          content: [{ type: 'text', text: 'V064_RETAINED_MAIN_QUESTION' }] }, abort.signal)).accepted, true);
        await agent.whenIdle();
        for (const mode of ['natural', 'mention']) {
          const g = await groups.create({ operationId: `v064-${mode}`, name: `V064 retained ${mode}`, mode, members: [key(first), key(second)], historyConfirmed: true });
          const group = { groupId: g.id, groupCreatedAt: g.createdAt }, view = await groups.view(group);
          const t = await groups.send(group, { operationId: `v064-history-${mode}`, text: `V064_RETAINED_GROUP_QUESTION_${mode}`,
            ...(mode === 'mention' ? { memberIds: [view.members[0].id] } : {}), expectedMembershipRevision: g.membershipRevision });
          await settled(group, t.id);
          assert.equal(adapter.sessionIds.includes(g.rootSessionId), false, 'Group root must not call the model');
        }
        await ctx.sessions.flush(agent.session);
        await connectors.saveDefinition({ id: 'v064-connector', label: 'V064 disabled MCP', serverName: 'v064fixture', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', enabled: false }, 0);
        await notifications.savePolicy({ id: 'v064-policy', owner: key(first), channel: 'in-app', enabled: true, timezone: 'UTC', dailyLimit: 20, cooldownSec: 0, authorization: { mode: 'ask' } }, 0, false);
        await notifications.record(key(first), { operationId: 'v064-inbox', policyId: 'v064-policy', text: 'V064 retained in-app notification.' }, { kind: 'tool', id: 'v064-synthetic-fixture', sessionId: main.sessionId });
      }
      const seeded = adapter.requests;
      await mark('read-state');
      const snapshot = async () => {
        const bots = await ctx.dshBots.list(), main = await ctx.dshBots.openConversation('v064-primary'), memories = await ctx.dshBots.memoryFor('v064-primary').list();
        const groupRows = await groups.list();
        const views = await Promise.all(groupRows.map(row => groups.view({ groupId: row.group.id, groupCreatedAt: row.group.createdAt })));
        const mainAgent = ctx.agents.get(main.sessionId); assert.ok(mainAgent);
        const mainHistory = mainAgent.session.snapshotEvents().filter(e => ['user/message', 'assistant/message'].includes(e.type)).map(e => ({ type: e.type, data: e.data }));
        return { bots, main, mainHistory, memories, groups: groupRows, views, connectors: connectors.definitions(), policies: notifications.policies(), inbox: notifications.list() };
      };
      const state = await snapshot();
      assert.ok(JSON.stringify(state.mainHistory).includes('V064_RETAINED_MAIN_QUESTION'));
      assert.ok(JSON.stringify(state.mainHistory).includes(RESULT));
      assert.ok(state.views.every(view => view.messages.some(m => m.text === RESULT)), 'Every group keeps its member reply');
      assert.equal(state.memories.length, 1); assert.ok(state.memories[0].content.includes('retained pinned private'));
      assert.deepEqual(state.groups.map(row => row.group.mode).sort(), ['mention', 'natural']);
      assert.equal(state.connectors[0].enabled, false); assert.equal(state.inbox[0].state, 'recorded');
      if (config.phase === 'new') assertWireEqual(state, await load('old-state.json'), 'Upgrade changed retained data');
      if (config.phase === 'reinstalled') assertWireEqual(state, await load('new-final-state.json'), 'Reinstall changed retained data');
      await save('state', state);
      assert.equal(adapter.requests, seeded, 'Reading retained state must not replay model work');

      await mark('strict-remote');
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (namespace, method, args) => ctx.typertGateway.invoke({ namespace, method, args, peer, signal: abort.signal });
      const { GROUPS_REMOTE } = await import(pathToFileURL(resolve(config.installedRoot, 'lib/shared/groups-contract.js')).href);
      const viewDescriptor = GROUPS_REMOTE.descriptors.find(d => d.namespace === 'dshBot.groups' && d.method === 'view');
      const listDescriptor = GROUPS_REMOTE.descriptors.find(d => d.namespace === 'dshBot.groups' && d.method === 'list');
      assert.equal(viewDescriptor.result.mode, 'strict'); assert.equal(listDescriptor.result.mode, 'strict');
      assertWireEqual(await invoke('dshBot.groups', 'list', {}), state.groups);
      for (const view of state.views) {
        const group = { groupId: view.group.id, groupCreatedAt: view.group.createdAt };
        assertWireEqual(await invoke('dshBot.groups', 'view', { group, page: {} }), view);
        assertWireEqual(viewDescriptor.result.decode(JSON.parse(JSON.stringify(viewDescriptor.result.encode(view, () => null)))), view);
      }

      let followupRequests = 0;
      if (config.phase === 'new') {
        await mark('new-question');
        const natural = state.views.find(view => view.group.mode === 'natural');
        const group = { groupId: natural.group.id, groupCreatedAt: natural.group.createdAt }, before = adapter.requests;
        const t = await groups.send(group, { operationId: 'v064-after-upgrade', text: 'V064_QUESTION_AFTER_UPGRADE', expectedMembershipRevision: natural.group.membershipRevision });
        const turn = await settled(group, t.id);
        assert.ok(['completed', 'idle'].includes(turn.state), `Upgraded group answers a new question (${turn.state})`);
        followupRequests = adapter.requests - before; assert.ok(followupRequests > 0);
        assert.equal(adapter.sessionIds.includes(natural.group.rootSessionId), false, 'Group root must not call the model');
        await save('final-state', await snapshot());
      }
      await save('result', { status: 'PASS', phase: config.phase, installedVersion: config.installedVersion,
        seededModelRequests: seeded, followupModelRequests: followupRequests, replayedModelRequests: 0, realModelRequests: 0,
        botsMemoryMainGroupsConnectorsNotificationsRetained: config.phase !== 'old', strictRemoteRoundTrip: true });
      console.log('V064_UPGRADE_DONE');
    })().catch(async error => { await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, modelRequests: adapter.requests, realModelRequests: 0 }); console.log('V064_UPGRADE_FAILED'); });
    return async () => { clearTimeout(timer); abort.abort(); await run; await peer?.dispose(); for (const release of releases.reverse()) release(); };
  });
}
