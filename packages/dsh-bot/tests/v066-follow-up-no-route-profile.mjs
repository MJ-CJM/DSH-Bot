import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';

export const inject = ['loader', 'llm', 'typertGateway'];

export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), { signal } = controller;
    const releases = [];
    const counters = { agentRequests: 0, modelStreams: 0, nativeDispatches: 0, externalSends: 0 };
    let peer;
    const save = (file, value) => writeFile(join(config.outputDir, file), JSON.stringify(value, null, 2));
    const run = (async () => {
      releases.push(ctx.on('agent/request', (_request, next) => { counters.agentRequests++; return next(); }, { prepend: true }));
      releases.push(ctx.on('llm/stream', (_request, next) => { counters.modelStreams++; return next(); }, { prepend: true }));
      releases.push(ctx.on('subagent/start', () => { counters.nativeDispatches++; }));
      await ctx.loader.await();
      assert.deepEqual(ctx.llm.listProviders(), []);
      const nativeDefaultSelection = ctx.get('agentDefaultModel').currentSelection();
      assert.notEqual(nativeDefaultSelection.provider, 'dp-loopback');
      await assert.rejects(access(join(config.outputDir, 'synthetic-credentials.yml')), { code: 'ENOENT' });
      const registry = ctx.get('dshBots');
      await registry.waitUntilReady();
      for (let i = 0; i < 200 && !(ctx.get('dshBotGroups') && ctx.get('dshBotNotifications') && ctx.get('dshBotProactive')); i++)
        await delay(50, undefined, { signal });
      const groups = ctx.get('dshBotGroups');
      const notices = ctx.get('dshBotNotifications');
      assert.ok(groups && notices && ctx.get('dshBotProactive'));
      releases.push(notices.attachPort({
        async describe() { return { targetDigest: 'v066-no-route-target', label: 'Synthetic target' }; },
        async send() { counters.externalSends++; },
      }));
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (method, input, namespace = 'dshBot.proactive') =>
        ctx.typertGateway.invoke({ namespace, method, args: { input }, peer, signal });
      const bots = [];
      for (const id of ['no-route-a', 'no-route-b', 'no-route-c', 'no-route-d']) {
        const bot = await registry.create({ id, name: id, template: 'minimal' });
        assert.equal(bot.model, undefined);
        bots.push({ kind: 'bot', bot: { botId: bot.id, botCreatedAt: bot.createdAt } });
      }
      const created = await invoke('create', { operationId: randomUUID(), name: 'Four members without a model route',
        mode: 'mention', members: bots.map(subject => subject.bot), historyConfirmed: true }, 'dshBot.groups');
      assert.equal(created.modelSelection, undefined);
      const group = { kind: 'group', group: { groupId: created.id, groupCreatedAt: created.createdAt } };
      const summary = subject => invoke('followUpSummary', subject);
      const editor = ctx.get('configEditor');
      const entry = editor.entries().find(row => row.options.name === 'dsh-bot');
      assert.ok(entry);
      const check = async (subject, untouched) => {
        const disabled = await summary(subject);
        assert.equal(disabled.state, 'disabled');
        for (const other of untouched) assert.deepEqual(await summary(other), disabled);
        const commandId = randomUUID();
        const applied = await invoke('followUpPolicy', { commandId, subject, action: 'enable-local',
          expectedRevision: null, expectedConfigEpoch: disabled.configEpoch });
        assert.equal(applied.kind, 'receipt', JSON.stringify(applied));
        assert.equal(applied.receipt.commandId, commandId);
        const enabled = await summary(subject);
        assert.equal(enabled.state, 'ready');
        assert.equal(enabled.scopeOnly, true);
        assert.deepEqual(enabled.summary.policy.subject, subject);
        assert.equal(enabled.summary.policy.localEnabled, true);
        assert.equal(enabled.summary.legacyCiActive, false);
        for (const other of untouched) assert.equal((await summary(other)).summary.policy.localEnabled, false);
        await delay(1100, undefined, { signal });
        assert.deepEqual(await summary(subject), enabled);
        for (const other of untouched) assert.equal((await summary(other)).summary.policy.localEnabled, false);
        const service = ctx.get('dshBotProactive');
        const status = await service.status();
        assert.equal(status.state, 'ready');
        assert.equal(status.directRoute, undefined);
        assert.equal(status.localFeedScope, undefined);
        assert.equal(status.capabilities.directExecution, false);
        assert.deepEqual(await service.workList(), []);
        assert.deepEqual(notices.list(), []);
        const view = await groups.view(group.group);
        assert.equal(view.members.filter(member => member.enabled).length, 4);
        assert.deepEqual(view.turns, []);
        assert.deepEqual(view.deliveries, []);
        assert.deepEqual(ctx.llm.listProviders(), []);
        assert.deepEqual(counters, { agentRequests: 0, modelStreams: 0, nativeDispatches: 0, externalSends: 0 });
        return { subject, commandId, untouched: untouched.length, localEnabled: true, maintenanceMs: 1100 };
      };
      const personal = await check(bots[0], [group, ...bots.slice(1)]);
      await editor.edit(entry, raw => ({ ...raw, proactiveEnabled: false }));
      const shared = await check(group, bots);
      await save('product-no-model-route.json', { personal, group: shared, members: bots.length, providers: 0,
        nativeDefaultSelection, ...counters });
      console.log('B4_WEB_READY');
    })().catch(async error => {
      if (signal.aborted) return;
      await save('product-no-model-route-error.json', { message: String(error), stack: error.stack, ...counters });
      console.error('B4_WEB_FAILED', error);
    });
    return async () => { controller.abort(); await run; await peer?.dispose(); for (const release of releases.reverse()) release(); };
  });
}
