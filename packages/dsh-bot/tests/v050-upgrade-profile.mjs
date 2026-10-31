import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'v050-upgrade-probe';
export const inject = ['loader', 'dshBots', 'llm', 'agents', 'sessions', 'sessionController', 'typertGateway'];
class NoModel extends LlmAdapter {
  requests = 0;
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Catalog only; generation forbidden' }]; }
  stream() { this.requests++; throw new Error('V050 migration must never generate a model request'); }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const abort = new AbortController(), adapter = new NoModel(), releases = [];
    let phase = 'loader', peer;
    const save = (name, value) => writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(value, null, 2));
    const mark = async value => { phase = value; console.log(`V050_UPGRADE_PHASE ${value}`); await save('progress', { phase }); };
    const wait = async check => { for (;;) { abort.signal.throwIfAborted(); const value = await check(); if (value) return value; await delay(20, undefined, { signal: abort.signal }); } };
    const timer = setTimeout(() => abort.abort(new Error(`V050 fixture deadline: ${phase}`)), 60000);
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
        const first = await ctx.dshBots.create({ id: 'v050-primary', name: 'V050 retained primary', template: 'minimal', persona: { prefix: 'Synthetic migration fixture; no model prompts.' } });
        const second = await ctx.dshBots.create({ id: 'v050-peer', name: 'V050 retained peer', template: 'minimal', persona: { prefix: 'Synthetic migration fixture peer.' } });
        // Actual 0.4.1 public memory capability, not a new-package format written into old storage.
        const memory = ctx.dshBots.memoryFor(first.id);
        assert.equal(typeof memory.save, 'function');
        await memory.save({ content: 'V050 retained pinned private preference.', kind: 'preference', tags: ['upgrade'], pinned: true }, { by: 'user', at: Date.now() });
        const main = await ctx.dshBots.openConversation(first.id), agent = ctx.agents.get(main.sessionId); assert.ok(agent);
        for (const mode of ['mention', 'round-robin']) await groups.create({ operationId: `v050-${mode}`, name: `V050 retained ${mode}`, mode, members: [key(first), key(second)], historyConfirmed: true });
        await connectors.saveDefinition({ id: 'v050-connector', label: 'V050 disabled MCP', serverName: 'v050fixture', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', enabled: false }, 0);
        await notifications.savePolicy({ id: 'v050-policy', owner: key(first), channel: 'in-app', enabled: true, timezone: 'UTC', dailyLimit: 20, cooldownSec: 0, authorization: { mode: 'ask' } }, 0, false);
        const flow = ctx.dshBots.memoryOutlets; assert.ok(flow);
        await flow.inherit(main.sessionId, { readers: [key(first)], originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [] });
        await notifications.record(key(first), { operationId: 'v050-inbox', policyId: 'v050-policy', text: 'V050 retained in-app notification.' }, { kind: 'tool', id: 'v050-synthetic-fixture', sessionId: main.sessionId });
      }
      await mark('read-state');
      const bots = await ctx.dshBots.list(), main = await ctx.dshBots.openConversation('v050-primary'), memories = await ctx.dshBots.memoryFor('v050-primary').list();
      const groupRows = await groups.list();
      const views = await Promise.all(groupRows.map(row => groups.view({ groupId: row.group.id, groupCreatedAt: row.group.createdAt })));
      const snapshot = { bots, main, memories, groups: groupRows, views, connectors: connectors.definitions(), assignments: connectors.assignments(), policies: notifications.policies(), inbox: notifications.list() };
      assert.equal(memories.length, 1); assert.ok(memories[0].content.includes('retained pinned private'));
      assert.deepEqual(snapshot.groups.map(row => row.group.mode).sort(), ['mention', 'round-robin']);
      assert.equal(snapshot.connectors[0].enabled, false); assert.equal(snapshot.inbox[0].state, 'recorded');
      if (config.phase !== 'old') assert.deepEqual(snapshot, JSON.parse(await readFile(resolve(config.outputDir, 'old-state.json'))));
      await save('state', snapshot);
      await mark('strict-remote');
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (namespace, method, args) => ctx.typertGateway.invoke({ namespace, method, args, peer, signal: abort.signal });
      const { GROUPS_REMOTE } = await import(pathToFileURL(resolve(config.installedRoot, 'lib/shared/groups-contract.js')).href);
      const descriptor = GROUPS_REMOTE.descriptors.find(d => d.namespace === 'dshBot.groups' && d.method === 'view');
      assert.equal(descriptor.result.mode, 'strict');
      for (const view of snapshot.views) {
        const group = { groupId: view.group.id, groupCreatedAt: view.group.createdAt };
        const wireView = await invoke('dshBot.groups', 'view', { group, page: {} });
        assert.deepEqual(wireView, view);
        const encoded = descriptor.result.encode(view, () => null);
        assert.deepEqual(descriptor.result.decode(JSON.parse(JSON.stringify(encoded))), view);
        assert.throws(() => descriptor.result.encode({ ...view, privateStorageField: 'forbidden' }, () => null));
        await assert.rejects(() => invoke('dshBot.groups', 'view', { group, page: {}, sessionId: 'forged-private-address' }));
      }
      if (config.phase !== 'old') {
        const first = bots.find(b => b.id === 'v050-primary');
        const diagnosis = await invoke('dshBot.capabilities', 'request', { input: { action: 'inspect', bot: key(first) } });
        assert.equal(diagnosis.mainSessionId, main.sessionId);
      }
      assert.equal(adapter.requests, 0);
      await save('result', { status: 'PASS', phase: config.phase, installedVersion: config.installedVersion,
        botsMemoryMainGroupsConnectorsNotificationsEqual: true, legacyGroupModesPreserved: true, strictRemotePositiveAndNegative: true, modelRequests: 0, realModelRequests: 0 });
      console.log('V050_UPGRADE_DONE');
    })().catch(async error => { await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, modelRequests: adapter.requests, realModelRequests: 0 }); console.log('V050_UPGRADE_FAILED'); });
    return async () => { clearTimeout(timer); abort.abort(); await run; await peer?.dispose(); for (const release of releases.reverse()) release(); };
  });
}
