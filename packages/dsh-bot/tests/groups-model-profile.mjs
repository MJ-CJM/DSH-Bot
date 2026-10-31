import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'groups-model-profile';
export const inject = ['loader', 'llm', 'agents', 'dshBots', 'sessionController', 'sessionProjections', 'sessionQuery', 'typertGateway', 'agentDefaultModel', 'commands', 'permissionPresets', 'sandboxPolicy'];
const rootPreset = 'dsh-bot-group-root';
const original = { provider: 'dp-b6b', model: 'fixture', reasoningEffort: 'high' };
const alternate = { provider: 'group-alternate', model: 'second', reasoningEffort: 'high' };
class Adapter extends LlmAdapter {
  calls = []; gates = new Map(); hold = false; handoffTarget; handoffIssued = false;
  async listModels(provider) { return [{ provider, id: provider === 'dp-b6b' ? 'fixture' : 'second', name: 'Synthetic group model fixture' }]; }
  async resolveModel(provider, model) { return { provider, id: model, name: model,
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }; }
  async *stream(options) {
    const agent = this.ctx.agents.get(options.sessionId); assert.ok(agent);
    assert.notEqual(agent.session.header.agentPreset, rootPreset, 'Group root called the adapter');
    this.calls.push({ sessionId: options.sessionId, provider: options.provider, model: options.model,
      reasoningEffort: options.reasoningEffort, sandboxMode: this.ctx.sessionProjections.stateOf(agent.session, 'sandboxMode'),
      permissions: this.ctx.sessionProjections.stateOf(agent.session, 'permissions'), permissionCurrent: this.ctx.permissionPresets.current(agent.session), parentSession: agent.session.header.parentSession, input: JSON.stringify(options) });
    if (this.hold) await new Promise(resolveGate => {
      this.gates.set(options.sessionId, resolveGate);
      options.signal?.addEventListener('abort', resolveGate, { once: true });
    });
    options.signal?.throwIfAborted();
    if (this.handoffTarget && !this.handoffIssued && JSON.stringify(options).includes('MEMBER_MODEL_HANDOFF')) {
      this.handoffIssued = true;
      const id = ToolCallId('member-model-handoff'), args = JSON.stringify({ action: 'send', to: this.handoffTarget, text: 'MEMBER_HANDOFF_QUESTION', requestReply: true });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'group_message', argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'group_message', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    const text = 'SYNTHETIC_MODEL_REPLY';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), adapter = new Adapter(); adapter.ctx = ctx;
    const releases = []; let phase = 'loader';
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const mark = async value => { phase = value; console.log(`GROUP_MODEL_PHASE ${value}`); };
    const wait = async check => { for (;;) { lifetime.signal.throwIfAborted(); const value = await check(); if (value) return value; await delay(20, undefined, { signal: lifetime.signal }); } };
    const timer = setTimeout(() => lifetime.abort(new Error(`Group model timeout: ${phase}`)), 60000);
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-b6b', 'group-alternate'], adapter));
      await ctx.dshBots.waitUntilReady(); const groups = await wait(() => ctx.get('dshBotGroups'));
      const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' }); releases.push(() => peer.dispose());
      const invoke = (method, args) => ctx.typertGateway.invoke({ namespace: 'dshBot.groups', method, args, peer, signal: lifetime.signal });
      const keyOf = group => ({ groupId: group.id, groupCreatedAt: group.createdAt });
      const permissionReceipts = [];
      const permissionOf = agent => ({ sessionId: agent.id,
        sandboxMode: ctx.sessionProjections.stateOf(agent.session, 'sandboxMode'),
        permissions: ctx.sessionProjections.stateOf(agent.session, 'permissions'),
        currentValue: ctx.permissionPresets.current(agent.session),
        effectiveSandbox: ctx.sandboxPolicy.resolve({ session: agent.session }).mode });
      const assertChildPermission = (agent, mode) => {
        const snapshot = permissionOf(agent);
        assert.equal(snapshot.sandboxMode, mode); assert.equal(snapshot.effectiveSandbox, mode);
        assert.equal(snapshot.permissions.sandbox, mode); assert.equal(snapshot.permissions.approval, 'never');
        // Native delegation pins approval=never, so ask-based table presets derive to custom.
        assert.equal(snapshot.currentValue, 'custom'); return snapshot;
      };
      const switchPermission = async (root, preset) => {
        assert.ok(['read-only', 'workspace-write'].includes(preset));
        assert.ok(ctx.permissionPresets.catalog().options.some(option => option.value === preset), `Fixture requires native permission catalog entry: ${preset}`);
        // Public Host command runtime is the same writer called by Client session.command().
        const executed = await ctx.commands.execute(root, `/permission ${preset}`, [], lifetime.signal);
        assert.equal(executed?.result.kind, 'success', executed?.result.text);
        const snapshot = permissionOf(root);
        assert.equal(snapshot.currentValue, preset); assert.equal(snapshot.sandboxMode, preset);
        assert.equal(snapshot.permissions.sandbox, preset); assert.equal(snapshot.permissions.approval, 'ask');
        assert.equal(snapshot.effectiveSandbox, preset);
        permissionReceipts.push({ stage: `root-${preset}`, commandId: executed.commandId, ...snapshot });
        return snapshot;
      };
      const routeOf = call => ({ provider: call.provider, model: call.model, reasoningEffort: call.reasoningEffort });
      const done = async (key, turn) => wait(async () => {
        const view = await groups.view(key), row = view.turns.find(row => row.id === turn.id);
        if (!row || ['accepted', 'running'].includes(row.state)) return;
        assert.equal(row.state, 'completed'); return view;
      });
      if (config.cold) {
        await mark('cold-restored-selection');
        const rows = await groups.list(); assert.equal(rows.length, 3);
        const group = rows.find(row => row.group.name === 'Group models').group, key = keyOf(group);
        assert.deepEqual(group.modelSelection, alternate); assert.ok(group.modelRevision > 0);
        const before = await groups.view(key);
        assert.ok(before.turns.some(turn => turn.operationId === 'queued' && turn.modelSelection.provider === alternate.provider));
        const turn = await invoke('send', { group: key, input: { operationId: 'cold', text: 'COLD_MODEL', round: true, expectedMembershipRevision: group.membershipRevision } });
        await done(key, turn);
        assert.equal(adapter.calls.length, 2); assert.ok(adapter.calls.every(call => JSON.stringify(routeOf(call)) === JSON.stringify(alternate)));
        assert.equal(permissionOf(ctx.agents.get(group.rootSessionId)).sandboxMode, 'workspace-write');
        assert.ok(adapter.calls.every(call => call.sandboxMode === 'workspace-write' && call.permissions.sandbox === 'workspace-write' && call.permissions.approval === 'never'));
        assert.equal(ctx.agents.get(group.rootSessionId).session.snapshotEvents().filter(event => event.type === 'request/header').length, 0);
        const legacy = rows.find(row => row.group.name === 'Legacy model revision').group;
        assert.equal(Object.hasOwn(legacy, 'modelRevision'), false);
        const legacyKey = keyOf(legacy);
        const selectedLegacy = await invoke('setModel', { group: legacyKey, input: { expectedModelRevision: 0, modelSelection: alternate } });
        assert.equal(selectedLegacy.modelRevision, 1);
        const legacyTurn = await invoke('send', { group: legacyKey, input: { operationId: 'cold-legacy-model', text: 'COLD_LEGACY_MODEL', round: true, expectedMembershipRevision: 1 } });
        await done(legacyKey, legacyTurn);
        assert.equal(adapter.calls.length, 4);
        assert.ok(adapter.calls.every(call => JSON.stringify(routeOf(call)) === JSON.stringify(alternate)));
        assert.equal(ctx.agents.get(legacy.rootSessionId).session.snapshotEvents().filter(event => event.type === 'request/header').length, 0);
        const memberGroup = rows.find(row => row.group.name === 'Member model routing').group, memberKey = keyOf(memberGroup);
        assert.deepEqual(memberGroup.modelSelection, alternate); assert.equal(memberGroup.memberModelSelections.length, 2);
        const memberBefore = await groups.view(memberKey), oldMemberIds = memberGroup.memberModelSelections.map(row => row.memberId);
        const memberTurn = await invoke('send', { group: memberKey, input: { operationId: 'cold-member-models', text: 'COLD_MEMBER_MODELS', round: true, expectedMembershipRevision: memberGroup.membershipRevision } });
        const memberAfter = await done(memberKey, memberTurn);
        assert.deepEqual(memberTurn.memberModelSelections.map(row => row.memberId), oldMemberIds);
        const memberRoutes = memberAfter.deliveries.filter(row => row.turnId === memberTurn.id).map(delivery => {
          const call = adapter.calls.find(call => call.sessionId === delivery.childSessionId); assert.ok(call);
          const expected = memberGroup.memberModelSelections.find(row => row.memberId === delivery.memberId)?.modelSelection ?? alternate;
          assert.deepEqual(routeOf(call), expected); return { memberId: delivery.memberId, botId: delivery.bot.botId, ...routeOf(call) };
        });
        assert.equal(memberRoutes.length, memberBefore.members.filter(row => row.removedAt === undefined).length);
        await save('cold-member-model-routes', memberRoutes);
        await save('cold-result', { status: 'PASS', restoredSelection: true, restoredMemberSelections: true, legacyModelRevisionZeroAfterRestart: true, adapterRoutes: adapter.calls.map(routeOf), rootModelRequests: 0, realModelRequests: 0 });
        console.log('GROUP_MODEL_DONE'); return;
      }
      await mark('native-catalog');
      const catalog = await ctx.sessionController.modelCatalog();
      assert.deepEqual(catalog.groups.map(group => group.id).sort(), ['dp-b6b', 'group-alternate']);
      assert.equal(catalog.groups[1].models[0].reasoning.efforts.length, 2);
      const bots = [];
      for (const id of ['alpha', 'beta']) bots.push(await ctx.dshBots.create({ id, name: 'Same-name Bot', template: 'minimal', model: original }));
      const group = await groups.create({ operationId: 'model-group', name: 'Group models', mode: 'mention', members: bots.map(bot => ({ botId: bot.id, botCreatedAt: bot.createdAt })), historyConfirmed: true });
      const key = keyOf(group), view = () => groups.view(key);
      const send = (operationId, extra = {}) => invoke('send', { group: key, input: { operationId, text: operationId, round: true, expectedMembershipRevision: 1, ...extra } });
      const set = async modelSelection => { const latest = (await view()).group; return invoke('setModel', { group: key, input: { expectedModelRevision: latest.modelRevision ?? 0, modelSelection } }); };
      await mark('strict-model-settings');
      for (const input of [ { expectedModelRevision: 0, modelSelection: null, extra: true },
        { expectedModelRevision: 0, modelSelection: { ...alternate, secret: 'not-accepted' } },
        { expectedModelRevision: 0, modelSelection: { ...alternate, reasoningEffort: 'invalid' } } ])
        await assert.rejects(() => invoke('setModel', { group: key, input }));
      await assert.rejects(() => invoke('setModel', { group: key, input: { expectedModelRevision: 999, modelSelection: alternate } }));
      const legacy = await send('legacy-default'); await done(key, legacy);
      assert.equal(legacy.modelSelection, undefined); assert.ok(adapter.calls.every(call => JSON.stringify(routeOf(call)) === JSON.stringify(original)));
      assert.equal(Object.hasOwn(group, 'modelRevision'), false);
      const background = (await view()).group;
      assert.ok(background.revision > group.revision); assert.equal(background.modelRevision ?? 0, 0);
      await mark('same-route-clear-effort');
      const firstSelection = await invoke('setModel', { group: key, input: { expectedModelRevision: group.modelRevision ?? 0,
        modelSelection: { provider: 'dp-b6b', model: 'fixture' } } });
      assert.equal(firstSelection.modelRevision, 1); assert.equal(firstSelection.revision, background.revision + 1);
      const beforeDefault = adapter.calls.length, defaults = await send('provider-default'); await done(key, defaults);
      assert.ok(adapter.calls.slice(beforeDefault).every(call => call.reasoningEffort === 'low'));
      assert.deepEqual(defaults.modelSelection, { provider: 'dp-b6b', model: 'fixture' });
      const aba = await set(alternate);
      await set(original); const restored = await set(alternate);
      assert.deepEqual(restored.modelSelection, aba.modelSelection);
      assert.equal(restored.modelRevision, aba.modelRevision + 2);
      await assert.rejects(() => invoke('setModel', { group: key, input: { expectedModelRevision: aba.modelRevision, modelSelection: null } }));
      await mark('native-read-only-command');
      const rootAgent = ctx.agents.get(group.rootSessionId);
      await switchPermission(rootAgent, 'read-only');
      await mark('queue-and-running-followup');
      const beforeSnapshot = adapter.calls.length; adapter.hold = true;
      const held = await send('held', { round: false, memberIds: [(await view()).members[0].id] });
      await wait(() => adapter.calls.length > beforeSnapshot);
      const delivery = await wait(async () => (await view()).deliveries.find(row => row.turnId === held.id && row.state === 'running'));
      const heldAgent = ctx.agents.get(delivery.childSessionId); assert.ok(heldAgent);
      const heldPermission = assertChildPermission(heldAgent, 'read-only');
      permissionReceipts.push({ stage: 'held-child-read-only', ...heldPermission });
      const queued = await send('queued'); assert.deepEqual(queued.modelSelection, alternate);
      assert.equal((await view()).turns.find(row => row.id === queued.id).state, 'accepted');
      await mark('native-workspace-write-command');
      await switchPermission(rootAgent, 'workspace-write');
      assert.deepEqual(assertChildPermission(heldAgent, 'read-only'), heldPermission, 'Root permission switch must not rewrite an existing child');
      permissionReceipts.push({ stage: 'held-child-after-root-switch', ...permissionOf(heldAgent) });
      const changed = await set({ provider: 'dp-b6b', model: 'fixture', reasoningEffort: 'low' });
      assert.equal(changed.membershipRevision, 1); assert.equal(delivery.state, 'running');
      await send('supplement', { text: 'MODEL_SUPPLEMENT', round: false, followup: { turnId: held.id, deliveryId: delivery.id } });
      adapter.hold = false; for (const release of adapter.gates.values()) release();
      await done(key, held); await done(key, queued);
      const captured = adapter.calls.slice(beforeSnapshot);
      assert.ok(captured.length >= 4, 'Expected supplemental native request and two queued members');
      assert.ok(captured.every(call => JSON.stringify(routeOf(call)) === JSON.stringify(alternate)));
      assert.ok(captured.some(call => call.sessionId === delivery.childSessionId && call.input.includes('MODEL_SUPPLEMENT')));
      const heldCalls = captured.filter(call => call.sessionId === delivery.childSessionId);
      assert.ok(heldCalls.every(call => call.sandboxMode === 'read-only' && call.permissions.sandbox === 'read-only' && call.permissions.approval === 'never'));
      const queuedChildren = (await view()).deliveries.filter(row => row.turnId === queued.id).map(row => row.childSessionId);
      const queuedCalls = captured.filter(call => queuedChildren.includes(call.sessionId));
      assert.equal(queuedCalls.length, 2);
      assert.ok(queuedCalls.every(call => call.sandboxMode === 'workspace-write' && call.permissions.sandbox === 'workspace-write' && call.permissions.approval === 'never'));
      permissionReceipts.push({ stage: 'queued-children-capture-at-native-start', children: queuedCalls.map(call => ({ sessionId: call.sessionId, sandboxMode: call.sandboxMode, permissions: call.permissions, currentValue: call.permissionCurrent })) });
      const after = await send('next-selected'); const afterView = await done(key, after);
      const afterChildren = afterView.deliveries.filter(row => row.turnId === after.id).map(row => row.childSessionId);
      const afterCalls = adapter.calls.filter(call => afterChildren.includes(call.sessionId));
      assert.equal(afterCalls.length, 2);
      assert.ok(afterCalls.every(call => call.provider === 'dp-b6b' && call.reasoningEffort === 'low'));
      assert.ok(afterCalls.every(call => call.sandboxMode === 'workspace-write' && call.permissions.sandbox === 'workspace-write' && call.permissions.approval === 'never'));
      permissionReceipts.push({ stage: 'new-work-workspace-write', children: afterCalls.map(call => ({ sessionId: call.sessionId, sandboxMode: call.sandboxMode, permissions: call.permissions, currentValue: call.permissionCurrent })) });
      await mark('private-chat-unaffected');
      await set(alternate);
      const status = (await ctx.dshBots.status()).find(row => row.id === bots[0].id);
      const privateSession = await ctx.sessionController.create({ cwd: group.cwd, agentPreset: status.presetId });
      await ctx.sessionController.prompt({ sessionId: privateSession.sessionId, requestId: 'private-model', mode: 'queue', content: [{ type: 'text', text: 'PRIVATE_MODEL' }] }, lifetime.signal);
      await ctx.agents.get(privateSession.sessionId).whenIdle();
      const privateCalls = adapter.calls.filter(call => call.sessionId === privateSession.sessionId);
      assert.equal(privateCalls.length, 1); assert.deepEqual(routeOf(privateCalls[0]), original);
      assert.deepEqual(ctx.agentDefaultModel.currentSelection(), original);
      await mark('clear-restores-bot-default');
      const cleared = await set(null); assert.equal(Object.hasOwn(cleared, 'modelSelection'), false);
      const beforeClear = adapter.calls.length, clearedTurn = await send('cleared-default'); await done(key, clearedTurn);
      assert.equal(clearedTurn.modelSelection, undefined);
      assert.ok(adapter.calls.slice(beforeClear).every(call => JSON.stringify(routeOf(call)) === JSON.stringify(original)));
      await set(alternate);
      assert.equal(ctx.agents.get(group.rootSessionId).session.snapshotEvents().filter(event => event.type === 'request/header').length, 0);
      const headers = [];
      for (const row of (await view()).deliveries.filter(row => row.childSessionId)) {
        const observation = await ctx.sessionQuery.observeSession(row.childSessionId);
        try { headers.push({ childSessionId: row.childSessionId, headers: observation.events.filter(event => event.type === 'request/header').map(event => event.data.header.config) }); }
        finally { observation[Symbol.dispose](); }
      }
      assert.ok(headers.every(row => row.headers.length > 0));
      for (const call of adapter.calls.filter(call => call.parentSession === group.rootSessionId)) {
        const logged = headers.find(row => row.childSessionId === call.sessionId);
        assert.ok(logged?.headers.some(header => JSON.stringify(routeOf(header)) === JSON.stringify(routeOf(call))), 'Adapter route must match a durable request header');
      }
      await mark('per-member-precedence-and-identity');
      const gamma = await ctx.dshBots.create({ id: 'gamma', name: 'Same-name Bot', template: 'minimal' });
      const memberGroup = await groups.create({ operationId: 'member-model-group', name: 'Member model routing', mode: 'mention',
        members: [...bots, gamma].map(bot => ({ botId: bot.id, botCreatedAt: bot.createdAt })), historyConfirmed: true });
      const memberKey = keyOf(memberGroup), memberView = () => groups.view(memberKey), settings = [];
      const members = (await memberView()).members, alpha = members.find(row => row.bot.botId === 'alpha'), beta = members.find(row => row.bot.botId === 'beta');
      assert.notEqual(alpha.id, beta.id);
      const alphaRoute = original, betaRoute = { ...alternate, reasoningEffort: 'low' }, changedDefault = { ...original, reasoningEffort: 'low' };
      const memberSet = async (operation, modelSelection, memberId) => {
        const latest = (await memberView()).group;
        const input = { expectedModelRevision: latest.modelRevision ?? 0, modelSelection, ...(memberId ? { memberId } : {}) };
        const result = await invoke('setModel', { group: memberKey, input });
        assert.equal(result.modelRevision, input.expectedModelRevision + 1);
        settings.push({ operation, input, result }); return result;
      };
      const memberSend = async (operationId, extra = {}) => invoke('send', { group: memberKey, input: { operationId, text: operationId,
        round: true, expectedMembershipRevision: (await memberView()).group.membershipRevision, ...extra } });
      const assertRoutes = (view, turn, expected) => {
        const deliveries = view.deliveries.filter(row => row.turnId === turn.id);
        assert.ok(deliveries.length > 0);
        const calls = adapter.calls.filter(call => deliveries.some(row => row.childSessionId === call.sessionId));
        for (const delivery of deliveries) {
          const received = calls.filter(call => call.sessionId === delivery.childSessionId); assert.ok(received.length > 0);
          for (const call of received) assert.deepEqual(routeOf(call), expected[delivery.bot.botId], `Route for ${delivery.bot.botId} (${delivery.memberId})`);
        }
        return { turn, deliveries, calls: calls.map(call => ({ sessionId: call.sessionId, ...routeOf(call) })) };
      };
      const receipts = [];
      await memberSet('group-default', alternate);
      await memberSet('alpha-explicit', alphaRoute, alpha.id);
      const beforeMemberCas = (await memberView()).group.modelRevision;
      await memberSet('beta-explicit', betaRoute, beta.id);
      await assert.rejects(() => invoke('setModel', { group: memberKey, input: { expectedModelRevision: beforeMemberCas, modelSelection: null } }));
      await assert.rejects(async () => invoke('setModel', { group: memberKey, input: { expectedModelRevision: (await memberView()).group.modelRevision, memberId: 'member:unknown', modelSelection: alternate } }));
      let memberTurn = await memberSend('two-distinct-member-models');
      receipts.push(assertRoutes(await done(memberKey, memberTurn), memberTurn, { alpha: alphaRoute, beta: betaRoute, gamma: alternate }));
      assert.deepEqual(memberTurn.memberModelSelections, (await memberView()).group.memberModelSelections);
      const changedGroup = await memberSet('group-default-preserves-members', changedDefault);
      assert.equal(changedGroup.memberModelSelections.length, 2);
      memberTurn = await memberSend('changed-default-members-retain');
      receipts.push(assertRoutes(await done(memberKey, memberTurn), memberTurn, { alpha: alphaRoute, beta: betaRoute, gamma: changedDefault }));
      await memberSet('alpha-reset-inherits-group', null, alpha.id);
      memberTurn = await memberSend('alpha-inherits-default');
      receipts.push(assertRoutes(await done(memberKey, memberTurn), memberTurn, { alpha: changedDefault, beta: betaRoute, gamma: changedDefault }));
      await memberSet('clear-default-preserves-beta', null);
      memberTurn = await memberSend('alpha-inherits-bot');
      receipts.push(assertRoutes(await done(memberKey, memberTurn), memberTurn, { alpha: original, beta: betaRoute, gamma: original }));
      await memberSet('restore-default', alternate); await memberSet('restore-alpha', alphaRoute, alpha.id);
      await mark('per-member-queued-supplement-handoff-snapshot');
      adapter.hold = true;
      const beforeMemberHeld = adapter.calls.length;
      const memberHeld = await memberSend('member-held', { round: false, memberIds: [alpha.id] });
      await wait(() => adapter.calls.length > beforeMemberHeld);
      const memberDelivery = await wait(async () => (await memberView()).deliveries.find(row => row.turnId === memberHeld.id && row.state === 'running'));
      const memberQueued = await memberSend('member-queued');
      assert.equal((await memberView()).turns.find(row => row.id === memberQueued.id).state, 'accepted');
      const snapshot = structuredClone(memberQueued.memberModelSelections);
      await memberSet('edit-alpha-after-admission', betaRoute, alpha.id); await memberSet('edit-beta-after-admission', alphaRoute, beta.id);
      await memberSet('edit-default-after-admission', changedDefault);
      await memberSend('member-supplement', { text: 'MEMBER_MODEL_SUPPLEMENT', round: false, followup: { turnId: memberHeld.id, deliveryId: memberDelivery.id } });
      adapter.hold = false; for (const release of adapter.gates.values()) release();
      receipts.push(assertRoutes(await done(memberKey, memberHeld), memberHeld, { alpha: alphaRoute }));
      receipts.push(assertRoutes(await done(memberKey, memberQueued), memberQueued, { alpha: alphaRoute, beta: betaRoute, gamma: alternate }));
      assert.deepEqual((await memberView()).turns.find(row => row.id === memberQueued.id).memberModelSelections, snapshot);
      assert.ok(adapter.calls.some(call => call.sessionId === memberDelivery.childSessionId && call.input.includes('MEMBER_MODEL_SUPPLEMENT')));
      await memberSet('handoff-alpha', alphaRoute, alpha.id); await memberSet('handoff-beta', betaRoute, beta.id);
      const beforeHandoffMode = (await memberView()).group;
      await invoke('edit', { group: memberKey, input: { expectedRevision: beforeHandoffMode.revision,
        expectedMembershipRevision: beforeHandoffMode.membershipRevision, name: beforeHandoffMode.name, mode: 'natural',
        members: [...bots, gamma].map(bot => ({ botId: bot.id, botCreatedAt: bot.createdAt })), historyConfirmed: true } });
      adapter.handoffTarget = beta.id; adapter.hold = true;
      const beforeHandoff = adapter.calls.length;
      const handoff = await memberSend('member-handoff', { text: 'MEMBER_MODEL_HANDOFF', round: false, memberIds: [alpha.id] });
      await wait(() => adapter.calls.length > beforeHandoff);
      assert.equal(handoff.memberModelSelections.length, 2, 'Admission freezes even the member not initially targeted');
      await memberSet('edit-handoff-target-after-admission', original, beta.id); await memberSet('edit-handoff-default-after-admission', changedDefault);
      adapter.hold = false; for (const release of adapter.gates.values()) release();
      const handoffView = await done(memberKey, handoff);
      assert.deepEqual(handoffView.deliveries.filter(row => row.turnId === handoff.id).map(row => row.bot.botId), ['alpha', 'beta', 'alpha']);
      receipts.push(assertRoutes(handoffView, handoff, { alpha: alphaRoute, beta: betaRoute }));
      adapter.handoffTarget = undefined;
      await mark('per-member-scope-and-remove-readd');
      const oldOther = await send('other-group-isolated');
      const otherView = await done(key, oldOther), otherIds = otherView.deliveries.filter(row => row.turnId === oldOther.id).map(row => row.childSessionId);
      assert.ok(adapter.calls.filter(call => otherIds.includes(call.sessionId)).every(call => JSON.stringify(routeOf(call)) === JSON.stringify(alternate)));
      assert.deepEqual(ctx.agentDefaultModel.currentSelection(), original);
      await ctx.sessionController.prompt({ sessionId: privateSession.sessionId, requestId: 'private-after-member-models', mode: 'queue', content: [{ type: 'text', text: 'PRIVATE_AFTER_MEMBER_MODEL_SETTINGS' }] }, lifetime.signal);
      await ctx.agents.get(privateSession.sessionId).whenIdle();
      const privateAfterMember = adapter.calls.filter(call => call.sessionId === privateSession.sessionId);
      assert.equal(privateAfterMember.length, 2); assert.ok(privateAfterMember.every(call => JSON.stringify(routeOf(call)) === JSON.stringify(original)));
      const editMembers = async keys => {
        const latest = (await memberView()).group;
        return invoke('edit', { group: memberKey, input: { expectedRevision: latest.revision, expectedMembershipRevision: latest.membershipRevision,
          name: latest.name, mode: latest.mode, members: keys.map(bot => ({ botId: bot.id, botCreatedAt: bot.createdAt })), historyConfirmed: true } });
      };
      await memberSet('beta-distinct-before-removal', betaRoute, beta.id);
      const beforeRemove = (await memberView()).group;
      const removed = await editMembers([bots[0], gamma]);
      assert.equal(removed.modelRevision, beforeRemove.modelRevision + 1);
      assert.ok(!(removed.memberModelSelections ?? []).some(row => row.memberId === beta.id));
      await assert.rejects(() => memberSet('removed-member-rejected', alternate, beta.id));
      await editMembers([...bots, gamma]);
      const rejoined = (await memberView()).members.find(row => row.bot.botId === 'beta' && row.removedAt === undefined);
      assert.notEqual(rejoined.id, beta.id);
      assert.ok(!(await memberView()).group.memberModelSelections.some(row => row.memberId === rejoined.id));
      await memberSet('clear-default-for-bot-and-global', null);
      memberTurn = await memberSend('rejoined-inherits-bot-global');
      receipts.push(assertRoutes(await done(memberKey, memberTurn), memberTurn, { alpha: alphaRoute, beta: original, gamma: original }));
      const gammaMember = (await memberView()).members.find(row => row.bot.botId === 'gamma' && row.removedAt === undefined);
      await memberSet('persist-default', alternate); await memberSet('persist-gamma', betaRoute, gammaMember.id);
      await save('member-model-settings', settings); await save('member-model-routes', receipts); await save('member-model-view', await memberView());

      // Leave an actual pre-field record untouched for the next Host process to restore.
      const legacyRecord = await groups.create({ operationId: 'legacy-model-revision', name: 'Legacy model revision', mode: 'mention',
        members: bots.map(bot => ({ botId: bot.id, botCreatedAt: bot.createdAt })), historyConfirmed: true });
      assert.equal(Object.hasOwn(legacyRecord, 'modelRevision'), false);
      await save('permissions', permissionReceipts);
      await save('adapter', adapter.calls); await save('request-headers', headers); await save('view', await view());
      await save('result', { status: 'PASS', strictSetModel: true, separateModelRevision: true, legacyModelRevisionZero: true, modelAbaRejected: true, nativeCatalog: true, defaultBotPriority: true, sameRouteDefaultEffort: true,
        nativeReadOnlyInherited: true, nativeWorkspaceWriteInherited: true, existingChildPermissionUnchanged: true, nativeChildApprovalPinnedNever: true,
        perMemberPrecedence: true, memberSnapshot: true, memberHandoffSnapshot: true, memberRemoveReaddIdentity: true, otherGroupUnchanged: true, queuedSnapshot: true, runningSupplementRetainsModel: true, privateChatUnchanged: true, globalDefaultUnchanged: true,
        rootModelRequests: 0, syntheticModelRequests: adapter.calls.length, realModelRequests: 0 });
      console.log('GROUP_MODEL_DONE');
    })().catch(async error => {
      await save(config.cold ? 'cold-result' : 'result', { status: 'FAIL', phase, error: String(error), stack: error.stack, calls: adapter.calls, realModelRequests: 0 });
      console.log('GROUP_MODEL_FAILED');
    });
    return async () => { clearTimeout(timer); lifetime.abort(); for (const release of adapter.gates.values()) release(); await run; for (const off of releases.reverse()) off(); };
  });
}
