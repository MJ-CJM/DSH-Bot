import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const name = 'v067-npm-upgrade-probe';
export const inject = ['loader', 'dshBots', 'configEditor', 'llm', 'agents', 'sessions', 'sessionController', 'typertGateway'];

const primaryId = 'v067-primary';
const groupPreset = 'dsh-bot-group-root';
const mainQuestion = 'Synthetic upgrade question for the main conversation.';
const groupQuestion = 'Synthetic upgrade question for the group.';
const answer = 'Synthetic answer retained across the npm package rename.';
const privateFile = 'Private Bot home retained across the npm package rename.';
const memoryContent = 'Pinned synthetic memory retained across the npm package rename.';
const botKey = bot => ({ botId: bot.id, botCreatedAt: bot.createdAt });
const groupKey = group => ({ groupId: group.id, groupCreatedAt: group.createdAt });
const canonical = value => JSON.parse(JSON.stringify(value));

class Adapter extends LlmAdapter {
  requests = [];
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic npm upgrade fixture' }]; }
  async *stream(options) {
    this.requests.push(options.sessionId);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: answer };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), adapter = new Adapter();
    const { signal } = lifetime;
    let phase = 'loader', stage, peer, off;
    const timer = setTimeout(() => lifetime.abort(new Error(`Upgrade deadline: ${phase}`)), 60000);
    const mark = value => { phase = value; console.log(`V067_NPM_UPGRADE_PHASE ${value}`); };
    const load = name => readFile(resolve(config.outputDir, `${name}.json`), 'utf8').then(JSON.parse);
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
    const wait = async check => {
      for (;;) {
        signal.throwIfAborted();
        const value = await check();
        if (value) return value;
        await delay(25, undefined, { signal });
      }
    };
    const prompt = async (agent, requestId, text) => {
      assert.equal((await ctx.sessionController.prompt({ sessionId: agent.id, requestId, mode: 'queue',
        content: [{ type: 'text', text }] }, signal)).accepted, true);
      await agent.whenIdle();
      assert.ok(await ctx.sessions.flush(agent.session));
      return agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind;
    };

    const run = (async () => {
      const { phase: currentStage, packageName } = await load('phase');
      stage = currentStage;
      assert.ok(['old', 'new', 'cold'].includes(stage));
      await ctx.loader.await();
      assert.deepEqual(ctx.llm.listProviders(), []);
      off = ctx.llm.registerAdapter(['dp-b6b'], adapter);
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (method, input) => ctx.typertGateway.invoke({
        namespace: 'dshBot.proactive', method, args: { input }, peer, signal,
      });
      const registry = ctx.dshBots;
      await registry.waitUntilReady();
      const memoryKernel = registry.memoryKernel;
      assert.ok(memoryKernel);
      await wait(() => registry.mainSessions);
      const groups = await wait(() => ctx.get('dshBotGroups'));

      mark('verify-single-loader-entry');
      const entries = [...ctx.loader.entries()].filter(entry => ['dsh-bot', 'dsh-botgroup'].includes(entry.options.name));
      assert.deepEqual(entries.map(({ options }) => ({ id: options.id, name: options.name })), [{ id: 'dsh-bot', name: packageName }]);
      const [entry] = entries;
      assert.ok(entry.fiber && !entry.disabled);
      assert.ok(ctx.configEditor.entries().includes(entry));
      assert.equal(entry.options.config.dataDir, resolve(config.outputDir, 'bots'));
      assert.equal(entry.options.config.memoryListLimit, 13);
      assert.equal(registry.config.memoryListLimit, 13);
      assert.equal(entry.options.config.proactiveExecutionEnabled, false);

      if (stage === 'old') {
        mark('seed-native-data');
        const primary = await registry.create({ id: primaryId, name: 'Upgrade Primary', template: 'minimal', avatarVariant: 'hat' });
        const second = await registry.create({ id: 'v067-peer', name: 'Upgrade Peer', template: 'minimal' });
        await registry.memoryFor(primary.id).save({ content: memoryContent, kind: 'preference', tags: ['upgrade'], pinned: true },
          { by: 'user', at: Date.now() });
        const { path } = await registry.ensureHome(primary.id);
        await writeFile(resolve(path, 'upgrade-fixture.txt'), privateFile);
        const { sessionId } = await registry.openConversation(primary.id);
        const main = ctx.agents.get(sessionId);
        assert.ok(main);
        assert.equal(await prompt(main, 'v067-old-main', mainQuestion), 'completed');
        const group = await groups.create({ operationId: 'v067-create', name: 'Upgrade Group', mode: 'mention',
          members: [botKey(primary), botKey(second)], historyConfirmed: true });
        const key = groupKey(group), view = await groups.view(key);
        const turn = await groups.send(key, { operationId: 'v067-old-group', text: groupQuestion,
          expectedMembershipRevision: group.membershipRevision, memberIds: [view.members[0].id] });
        const settled = await wait(async () => (await groups.view(key)).turns.find(row => row.id === turn.id &&
          !['accepted', 'running'].includes(row.state)));
        assert.ok(['completed', 'idle'].includes(settled.state));
        assert.equal(adapter.requests.length, 2);
      } else {
        assert.equal(adapter.requests.length, 0, 'Startup dispatched unexpected model work');
      }

      mark('verify-native-bot-and-group-state');
      const bots = (await registry.list()).sort((left, right) => left.id.localeCompare(right.id));
      assert.deepEqual(bots.map(bot => bot.id), ['v067-peer', primaryId]);
      const primary = bots.find(bot => bot.id === primaryId);
      assert.equal(primary.avatarVariant, 'hat');
      const { sessionId } = await registry.openConversation(primaryId);
      const main = ctx.agents.get(sessionId);
      assert.ok(main);
      assert.equal(main.session.header.agentPreset, `bot-${primaryId}`);
      for (const tool of ['bot_memory_list', 'bot_group_recall']) assert.ok(main.ctx.tools.get(tool, main), `Missing ${tool}`);
      const mainHistory = main.session.snapshotEvents().filter(event => ['user/message', 'assistant/message'].includes(event.type))
        .map(({ type, data }) => ({ type, data }));
      assert.ok(JSON.stringify(mainHistory).includes(mainQuestion));
      assert.ok(JSON.stringify(mainHistory).includes(answer));
      const memories = await registry.memoryFor(primaryId).list();
      assert.deepEqual(memories.map(row => [row.content, row.pinned]), [[memoryContent, true]]);
      const { path: botHome } = await registry.ensureHome(primaryId);
      assert.equal(await readFile(resolve(botHome, 'upgrade-fixture.txt'), 'utf8'), privateFile);
      const catalog = await groups.list();
      assert.equal(catalog.length, 1);
      const { group } = catalog[0];
      const opened = await groups.open(groupKey(group));
      assert.equal(opened.sessionId, group.rootSessionId);
      const root = ctx.agents.get(opened.sessionId);
      assert.ok(root);
      assert.equal(root.session.header.agentPreset, groupPreset);
      assert.ok(root.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'));
      assert.ok(!adapter.requests.includes(root.id));
      const groupView = await groups.view(groupKey(group));
      assert.ok(groupView.messages.some(message => message.text === groupQuestion));
      assert.ok(groupView.messages.some(message => message.text === answer));
      const state = canonical({ bots, sessionId, mainHistory, memories, botHome, opened, groupView });
      if (stage !== 'old') assert.deepEqual(state, await load('old-state'));
      await save(`${stage}-state`, state);

      mark('verify-group-root-guard');
      if (stage !== 'old') assert.equal(await prompt(root, `v067-${stage}-blocked`, 'A direct root prompt must be blocked.'), 'blocked');
      assert.ok(!root.session.snapshotEvents().some(event => event.type === 'request/header' || event.type === 'assistant/message'));

      mark('verify-native-proactive-configuration');
      const subject = { kind: 'bot', bot: botKey(primary) };
      const summary = () => invoke('followUpSummary', subject);
      let setup;
      if (stage === 'old') {
        assert.equal((await summary()).state, 'disabled');
        await ctx.configEditor.edit(entry, raw => ({ ...raw, proactiveMaintenanceIntervalMs: 451 }));
      } else if (stage === 'new') {
        assert.deepEqual(await summary(), { state: 'disabled', configEpoch: null });
        const commandId = randomUUID();
        const result = await invoke('followUpPolicy', { commandId, subject, action: 'enable-local',
          expectedRevision: null, expectedConfigEpoch: null });
        assert.equal(result.kind, 'receipt', JSON.stringify(result));
        assert.equal(result.receipt.status, 'committed');
        mark('verify-live-host-after-setup');
        // Cordis exposes a new traced service wrapper on every lookup.
        assert.ok(ctx.dshBots.memoryKernel === memoryKernel, 'Scoped setup replaced the Host memory kernel');
        assert.ok((await ctx.sessionController.resolveAgent(sessionId)).agent === main, 'Scoped setup replaced the existing Bot agent');
        setup = { commandId, receipt: result.receipt };
      }
      assert.equal(entry.options.config.proactiveMaintenanceIntervalMs, 451);
      let policy;
      if (stage !== 'old') {
        const active = await wait(async () => { const current = await summary(); return current.state === 'ready' && current; });
        assert.equal(active.scopeOnly, true);
        assert.equal(active.summary.policy.localEnabled, true);
        assert.equal(active.summary.legacyCiActive, false);
        assert.equal(entry.options.config.proactiveEnabled, true);
        assert.equal(entry.options.config.proactiveExecutionEnabled, false);
        assert.equal(entry.options.config.proactiveFollowUpBootstrap.operation.configEpoch, active.configEpoch);
        policy = active;
        if (stage === 'cold') {
          const previous = await load('new-result');
          assert.deepEqual(policy, previous.policy);
          assert.equal(entry.options.config.proactiveFollowUpBootstrap.operation.operationId, previous.setup.commandId);
        }
      }
      await delay(500, undefined, { signal });
      assert.equal(adapter.requests.length, stage === 'old' ? 2 : 0);
      await save(`${stage}-result`, { status: 'PASS', stage, packageName, entryId: entry.options.id, mainSessionId: sessionId,
        groupRootSessionId: root.id, groupGuard: stage === 'old' ? 'setup-completed' : 'direct-prompt-blocked',
        syntheticModelRequests: adapter.requests.length, realModelRequests: 0, setup, policy });
      console.log('V067_NPM_UPGRADE_DONE');
    })().catch(async error => {
      await save(`${stage ?? 'unknown'}-result`, { status: 'FAIL', phase, error: String(error), stack: error.stack,
        syntheticModelRequests: adapter.requests.length, realModelRequests: 0 });
      console.log('V067_NPM_UPGRADE_FAILED');
    });

    return async () => { clearTimeout(timer); lifetime.abort(); await run; await peer?.dispose(); off?.(); };
  });
}
