import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'supergroup-groups-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController'];
class Adapter extends LlmAdapter {
  calls = []; gates = []; hold = false; duringStream; expertIssued = false; requestExpert = false;
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic SG Groups' }]; }
  async *stream(options) {
    this.calls.push({ sessionId: options.sessionId, input: JSON.stringify(options) });
    assert.ok(!JSON.stringify(options).includes('SG_PRIVATE_MEMORY_CANARY'));
    const current = this.ctx.agents.get(options.sessionId);
    if (current?.session.header.parentSession && JSON.stringify(options).includes('SG_CHECKED_ADAPTER_TASK')) {
      assert.ok(JSON.stringify(options).includes('authorizedExperts'), 'Scoped child did not receive the expert directory');
      assert.ok(JSON.stringify(options).includes('action=request-expert'), 'Scoped child did not receive expert guidance');
      if (JSON.stringify(options).includes('SG_PERSONA_alpha')) assert.ok(JSON.stringify(options).includes('gamma'), 'Future expert absent');
    }
    if (this.duringStream) { const callback = this.duringStream; this.duringStream = undefined; await callback(); }
    if (this.hold) await new Promise(release => {
      this.gates.push(release); options.signal.addEventListener('abort', release, { once: true });
    });
    options.signal.throwIfAborted();
    if (this.requestExpert && !this.expertIssued && JSON.stringify(options).includes('SG_CHECKED_ADAPTER_TASK') && JSON.stringify(options).includes('SG_PERSONA_alpha')) {
      this.expertIssued = true;
      const id = ToolCallId('sg-expert-request'), args = JSON.stringify({ action: 'request-expert', botId: 'gamma', question: 'SG_EXPERT_QUESTION: verify the report.' });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'group_message', argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'group_message', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    const text = 'SG_GROUP_RESULT';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), adapter = new Adapter(), releases = [], receipts = [];
    adapter.ctx = ctx;
    let phase = 'loader', permit;
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const mark = name => { phase = name; console.log(`SG_GROUPS_PHASE ${name}`); };
    const wait = async check => {
      for (;;) { controller.signal.throwIfAborted(); const result = await check(); if (result) return result; await delay(20, undefined, { signal: controller.signal }); }
    };
    const timer = setTimeout(() => controller.abort(new Error(`SG Groups timeout: ${phase}`)), 60000);
    const denied = async (name, action, pattern = /authorization|conflict/) => {
      let error;
      try { await action(); } catch (caught) { error = String(caught); }
      assert.ok(error, `${name} unexpectedly accepted`); assert.match(error, pattern);
      receipts.push({ name, status: 'PASS', refusal: error });
    };
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      releases.push(ctx.on('approval/request', request => {
        if (permit && request.agent === permit.agent && request.toolName === permit.tool && request.reason.includes(permit.content)) {
          receipts.push({ name: 'exact-export-approval', toolName: request.toolName, content: permit.content, outcome: 'allowed-once' });
          permit = undefined; return 'allowed-once';
        }
        return 'rejected';
      }, { prepend: true }));
      await ctx.dshBots.waitUntilReady();
      const groups = await wait(() => ctx.get('dshBotGroups'));
      // This probe owns the Groups backend handler. The separate full runtime
      // exercises the real coordinator; no guard or source policy is removed.
      await (await wait(() => ctx.dshBots.supergroup)).close();
      const flow = ctx.dshBots.memoryOutlets; assert.ok(flow);
      const pool = [];
      for (const id of ['alpha', 'beta', 'gamma']) {
        const bot = await ctx.dshBots.create({ id, name: id, template: 'minimal', persona: { prefix: `SG_PERSONA_${id}` }, model: { provider: 'dp-b6b', model: 'fixture' } });
        pool.push({ botId: id, botCreatedAt: bot.createdAt });
      }
      const label = readers => ({ readers, originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [] });
      const keyOf = group => ({ groupId: group.id, groupCreatedAt: group.createdAt });
      const create = operationId => groups.create({ operationId, name: operationId, mode: 'round-robin', members: pool.slice(0, 2), historyConfirmed: true });
      const done = (key, turn) => wait(async () => {
        const view = await groups.view(key), row = view.turns.find(row => row.id === turn.id);
        return row && !['accepted', 'running'].includes(row.state) && view;
      });
      mark('current-chat-export');
      const main = await ctx.dshBots.openConversation('alpha');
      const agent = (await ctx.sessionController.resolveAgent(main.sessionId)).agent;
      await ctx.sessionController.prompt({ sessionId: agent.id, requestId: 'sg-human-request', mode: 'queue', content: [{ type: 'text', text: 'SG_EXACT_HUMAN_TASK: analyze this synthetic report with alpha, beta, gamma.' }] }, controller.signal);
      await agent.whenIdle(); assert.equal(await ctx.sessions.flush(agent.session), true);
      const human = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.data.content.some(block => block.type === 'text' && block.text.startsWith('SG_EXACT_HUMAN_TASK')));
      assert.ok(human); assert.deepEqual(flow.label(agent.id).readers, [pool[0]]);
      const group = await create('sg-running-membership'), key = keyOf(group);
      const target = { kind: 'group', ...key, members: pool.slice(0, 2) };
      const content = 'SG_EXACT_SHARED_PAYLOAD';
      const envelope = flow.draft('group-input', pool[0], agent.id, 'sg-exact-export', target, content);
      await denied('private-main-cannot-auto-export', () => flow.admit(envelope));
      permit = { agent, tool: 'dsh_bot_export_group-input', content };
      // Native approval must remain inside a genuine open model turn.
      let grant;
      adapter.duringStream = async () => { grant = await flow.request(agent, envelope, controller.signal); };
      await ctx.sessionController.prompt({ sessionId: agent.id, requestId: 'sg-export-approval-turn', mode: 'queue', content: [{ type: 'text', text: 'SG_APPROVE_EXACT_EXPORT' }] }, controller.signal);
      await agent.whenIdle(); assert.ok(grant);
      await denied('approval-cannot-change-payload', () => flow.admit({ ...envelope, content: `${content}_changed` }, grant), /Grant invalid/);
      const approved = await flow.admit(envelope, grant, controller.signal);
      let exports = 0;
      await flow.dispatch(approved, () => { exports++; }, controller.signal);
      await denied('approval-cannot-replay', () => flow.dispatch(approved, () => { exports++; }), /already attempted/);
      assert.equal(exports, 1); assert.deepEqual(flow.label(agent.id).readers, [pool[0]]);
      receipts.push({ name: 'current-chat-exact-export', status: 'PASS', human: { sessionId: agent.id, messageId: human.data.id, seq: Number(human.seq) }, flowId: approved, exactPayloadOnly: true, labelUnchanged: true });
      mark('running-membership-revision');
      const baseline = await groups.send(key, { operationId: 'sg-baseline', text: 'SG_BASELINE', round: true, expectedMembershipRevision: 1 });
      const before = await done(key, baseline); assert.equal(before.turns.find(row => row.id === baseline.id).state, 'completed');
      adapter.hold = true;
      const held = await groups.send(key, { operationId: 'sg-held', text: 'SG_HELD', memberIds: [before.members[0].id], expectedMembershipRevision: 1 });
      const delivery = await wait(async () => (await groups.view(key)).deliveries.find(row => row.turnId === held.id && row.state === 'running'));
      await wait(() => adapter.gates.length);
      const current = (await groups.view(key)).group;
      const edited = await groups.edit(key, { expectedRevision: current.revision, expectedMembershipRevision: current.membershipRevision, name: current.name, mode: current.mode, members: pool, historyConfirmed: true });
      assert.equal(edited.membershipRevision, 2);
      await denied('old-turn-followup-after-edit', () => groups.send(key, { operationId: 'sg-stale-followup', text: 'SG_OLD_TURN', expectedMembershipRevision: 2, followup: { turnId: held.id, deliveryId: delivery.id } }));
      await denied('old-membership-send-after-edit', () => groups.send(key, { operationId: 'sg-stale-send', text: 'SG_OLD_REVISION', round: true, expectedMembershipRevision: 1 }));
      adapter.hold = false; for (const release of adapter.gates.splice(0)) release();
      const after = await done(key, held);
      assert.notEqual(after.turns.find(row => row.id === held.id).state, 'completed');
      assert.ok(!after.messages.some(row => row.turnId === held.id && row.authorKind === 'bot'));
      const calls = adapter.calls.length;
      await denied('new-round-cannot-widen-old-root', () => groups.send(key, { operationId: 'sg-new-revision', text: 'SG_NEW_ROUND', round: true, expectedMembershipRevision: 2 }));
      assert.equal(adapter.calls.length, calls);
      await save('membership', { group: edited, baseline: before, after, rootLabel: flow.label(group.rootSessionId), zeroNewRequestsAfterRefusal: true });
      mark('initial-pool-is-narrowed-by-existing-helper');
      const seeded = await create('sg-initial-pool'), seededKey = keyOf(seeded);
      await flow.inherit(seeded.rootSessionId, label(pool));
      const seededTurn = await groups.send(seededKey, { operationId: 'sg-pool-turn', text: 'SG_INITIAL_POOL', round: true, expectedMembershipRevision: 1 });
      await done(seededKey, seededTurn);
      assert.deepEqual(flow.label(seeded.rootSessionId).readers, pool.slice(0, 2));
      receipts.push({ name: 'current-helper-intersects-pool-to-active-roster', status: 'PASS', initialReaders: pool, actualReaders: flow.label(seeded.rootSessionId).readers });
      mark('proposed-admission-contract-only');
      // A contract experiment using existing data-flow primitives. This is NOT a
      // Groups implementation: current groupInput has no authorized-pool argument.
      // One fresh synthetic scope is initialized once, with an exact human ref.
      const contractGroup = await create('sg-proposed-source-contract'), contractKey = keyOf(contractGroup);
      const contractRoot = ctx.agents.get(contractGroup.rootSessionId); assert.ok(contractRoot);
      const proposedSession = contractRoot.id;
      const authorization = { userSessionId: agent.id, userMessageId: human.data.id, userSeq: Number(human.seq), readers: pool, exactInput: human.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n') };
      assert.ok(agent.session.eventAt(human.seq)?.data.id === authorization.userMessageId);
      await flow.inherit(proposedSession, label(authorization.readers));
      const machineInput = createUserMessage({ source: { kind: 'dsh-bot-supergroup', originSessionId: agent.id, originMessageId: human.data.id, originSeq: Number(human.seq), contractProbeOnly: true }, content: human.data.content });
      const proposed = flow.draft('group-input', pool[0], proposedSession, 'initial-authorized-input', { kind: 'group', ...contractKey, members: pool.slice(0, 2) }, JSON.stringify(machineInput));
      const first = await flow.admit(proposed);
      const appended = await flow.dispatch(first, () => contractRoot.session.append('user/message', machineInput, { surfaceOp: 'append' }));
      assert.equal(await ctx.sessions.flush(contractRoot.session), true);
      assert.equal(appended.data.source.kind, 'dsh-bot-supergroup');
      assert.deepEqual(appended.data.content, human.data.content);
      const contractEdited = await groups.edit(contractKey, { expectedRevision: contractGroup.revision, expectedMembershipRevision: 1, name: contractGroup.name, mode: contractGroup.mode, members: pool, historyConfirmed: true });
      assert.equal(contractEdited.membershipRevision, 2);
      const third = flow.draft('group-input', pool[0], proposedSession, 'safe-next-round', { kind: 'group', ...contractKey, members: pool }, JSON.stringify(machineInput));
      const next = await flow.admit(third); await flow.dispatch(next, () => {});
      assert.deepEqual(flow.label(proposedSession).readers, pool);
      await flow.inherit(proposedSession, label([pool[0]]));
      await denied('private-material-still-narrows-proposed-contract', () => flow.admit(flow.draft('group-input', pool[0], proposedSession, 'private-summary', { kind: 'group', ...contractKey, members: pool }, 'SG_SUMMARY_OF_PRIVATE_MATERIAL')));
      assert.deepEqual(flow.label(proposedSession).readers, [pool[0]]);
      await save('proposed-contract', { status: 'PASS', authorization, group: contractKey, rootSessionId: proposedSession, membershipRevision: contractEdited.membershipRevision, nativeSource: appended.data.source, nativeInputMessageId: appended.data.id, firstFlow: first, nextFlow: next, implementedGroupsBridge: false, groupTurnNotCreated: true, noLabelReset: true, privateMaterialDenied: true });
      mark('checked-groups-adapter');
      const raw = 'SG_CHECKED_ADAPTER_TASK: analyze this report using the permitted expert pool.';
      await ctx.sessionController.prompt({ sessionId: agent.id, requestId: 'sg-checked-origin', mode: 'queue', content: [{ type: 'text', text: raw }] }, controller.signal);
      await agent.whenIdle();
      const latest = agent.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user');
      assert.ok(latest);
      // The expert request belongs to a child, never to the main model.
      adapter.expertIssued = false;
      adapter.requestExpert = true;
      let enabled = true;
      const authority = { workId: 'sg-checked-work', origin: agent, messageId: latest.data.id,
        owner: pool[0], readers: pool, expiresAt: Date.now() + 60000, maxRequests: 8,
        check: async () => { if (!enabled) throw new Error('SG_REVOKED'); } };
      for (const bot of pool) await ctx.dshBots.memoryFor(bot.botId).save({ content: `SG_PRIVATE_MEMORY_CANARY_${bot.botId}` });
      const expertRequests = [];
      releases.push(groups.setExpertHandler(async request => { expertRequests.push({ workId: request.workId, botId: request.botId, question: request.question, callId: request.callId, agentId: request.agent.id, turnId: request.binding.turnId }); }));
      const checkedGroup = await groups.createSupergroup({ operationId: 'sg-checked-group', name: 'Checked scope fixture', mode: 'round-robin', members: pool.slice(0, 2), historyConfirmed: true }, authority);
      const checkedKey = keyOf(checkedGroup);
      await denied('scoped-group-rejects-ordinary-send', () => groups.send(checkedKey, { operationId: 'sg-unscoped', text: raw, round: true, expectedMembershipRevision: 1 }), /approval-denied/);
      await denied('scoped-group-rejects-model-authored-task', () => groups.sendSupergroup(checkedKey, { operationId: 'sg-model-text', text: 'MODEL_SUMMARY', round: true, expectedMembershipRevision: 1 }, authority), /approval-denied/);
      const checkedTurn = await groups.sendSupergroup(checkedKey, { operationId: 'sg-checked-turn', text: raw, round: true, expectedMembershipRevision: 1 }, authority);
      await groups.waitForTurn(checkedTurn.id);
      const checkedView = await groups.view(checkedKey);
      assert.equal(checkedView.turns.find(turn => turn.id === checkedTurn.id).state, 'completed');
      assert.equal(expertRequests.length, 1); assert.equal(expertRequests[0].botId, 'gamma');
      const checkedRoot = ctx.agents.get(checkedGroup.rootSessionId), nativeInput = checkedRoot.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === checkedTurn.inputMessageId);
      assert.equal(nativeInput.data.source.kind, 'dsh-bot-supergroup');
      assert.equal(nativeInput.data.source.originMessageId, latest.data.id);
      assert.equal(nativeInput.data.content[0].text, raw);
      assert.equal(checkedView.messages.find(message => message.id === checkedTurn.inputMessageId).authorKind, 'proactive');
      assert.deepEqual(flow.label(checkedGroup.rootSessionId).readers, pool);
      await denied('scoped-group-rejects-ordinary-edit', () => groups.edit(checkedKey, { expectedRevision: checkedView.group.revision, expectedMembershipRevision: 1, name: checkedGroup.name, mode: checkedGroup.mode, members: pool, historyConfirmed: true }), /approval-denied/);
      const joined = await groups.editSupergroup(checkedKey, { expectedRevision: checkedView.group.revision, expectedMembershipRevision: 1, name: checkedGroup.name, mode: checkedGroup.mode, members: pool, historyConfirmed: true }, authority);
      const gamma = (await groups.view(checkedKey)).members.find(member => member.bot.botId === 'gamma');
      const expertTurn = await groups.sendSupergroup(checkedKey, { operationId: 'sg-checked-expert', text: raw, memberIds: [gamma.id], expectedMembershipRevision: joined.membershipRevision }, authority);
      await groups.waitForTurn(expertTurn.id);
      const expertView = await groups.view(checkedKey);
      assert.equal(expertView.turns.find(turn => turn.id === expertTurn.id).state, 'completed');
      const gammaDelivery = expertView.deliveries.find(delivery => delivery.turnId === expertTurn.id);
      assert.ok(adapter.calls.find(call => call.sessionId === gammaDelivery.childSessionId)?.input.includes('SG_EXPERT_QUESTION'));
      assert.equal(expertView.group.id, checkedGroup.id);
      await ctx.sessionController.prompt({ sessionId: agent.id, requestId: 'sg-checked-continue', mode: 'queue', content: [{ type: 'text', text: 'SG_CONTINUE_SAME_WORK' }] }, controller.signal);
      await agent.whenIdle();
      const continuedHuman = agent.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user');
      const refreshed = { ...authority, messageId: continuedHuman.data.id };
      await groups.refreshSupergroupAuthority(checkedKey, refreshed);
      const continued = await groups.sendSupergroup(checkedKey, { operationId: 'sg-checked-continuation', text: 'SG_CONTINUE_SAME_WORK', memberIds: [gamma.id], expectedMembershipRevision: joined.membershipRevision }, refreshed);
      await groups.waitForTurn(continued.id);
      await flow.inherit(checkedGroup.rootSessionId, label([pool[0]]));
      await denied('checked-adapter-does-not-reset-private-taint', () => groups.sendSupergroup(checkedKey, { operationId: 'sg-private-taint', text: 'SG_CONTINUE_SAME_WORK', memberIds: [gamma.id], expectedMembershipRevision: joined.membershipRevision }, refreshed));
      assert.deepEqual(flow.label(checkedGroup.rootSessionId).readers, [pool[0]]);
      enabled = false;
      const beforeRevoke = adapter.calls.length;
      await denied('scope-revocation-blocks-next-execution', () => groups.sendSupergroup(checkedKey, { operationId: 'sg-revoked', text: 'SG_CONTINUE_SAME_WORK', memberIds: [gamma.id], expectedMembershipRevision: joined.membershipRevision }, refreshed), /SG_REVOKED/);
      assert.equal(adapter.calls.length, beforeRevoke);
      await save('checked-adapter', { status: 'PASS', group: checkedKey, expertRequests, firstTurn: checkedTurn.id, expertTurn: expertTurn.id, continuedTurn: continued.id, originalInput: nativeInput, view: await groups.view(checkedKey), sameGroup: true, readerPoolUnchanged: true, ordinaryBypassDenied: true, privateMemoryCanaryAbsent: true, revokedNewRequests: 0 });
      mark('durable-native-request-budget');
      const budgetAuthority = { ...refreshed, workId: 'sg-budget-work', maxRequests: 1, check: async () => {} };
      const budgetGroup = await groups.createSupergroup({ operationId: 'sg-budget-group', name: 'Native request budget', mode: 'round-robin', members: pool.slice(0, 2), historyConfirmed: true }, budgetAuthority);
      const budgetKey = keyOf(budgetGroup), beta = (await groups.view(budgetKey)).members.find(member => member.bot.botId === 'beta');
      const budgetTurn = await groups.sendSupergroup(budgetKey, { operationId: 'sg-budget-first', text: 'SG_CONTINUE_SAME_WORK', memberIds: [beta.id], expectedMembershipRevision: 1 }, budgetAuthority);
      await groups.waitForTurn(budgetTurn.id);
      const budgetCalls = adapter.calls.length;
      await denied('native-budget-blocks-additional-turn', () => groups.sendSupergroup(budgetKey, { operationId: 'sg-budget-extra', text: 'SG_CONTINUE_SAME_WORK', memberIds: [beta.id], expectedMembershipRevision: 1 }, budgetAuthority), /approval-denied/);
      await ctx.sessionController.prompt({ sessionId: agent.id, requestId: 'sg-budget-refresh-human', mode: 'queue', content: [{ type: 'text', text: 'SG_BUDGET_CONTINUE' }] }, controller.signal);
      await agent.whenIdle();
      const budgetHuman = agent.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user');
      const budgetRefreshed = { ...budgetAuthority, messageId: budgetHuman.data.id };
      await groups.refreshSupergroupAuthority(budgetKey, budgetRefreshed);
      const afterRefreshCalls = adapter.calls.length;
      await denied('authority-refresh-does-not-reset-native-budget', () => groups.sendSupergroup(budgetKey, { operationId: 'sg-budget-after-refresh', text: 'SG_BUDGET_CONTINUE', memberIds: [beta.id], expectedMembershipRevision: 1 }, budgetRefreshed), /approval-denied/);
      assert.equal(adapter.calls.length, afterRefreshCalls);
      await save('budget', { status: 'PASS', budget: 1, firstTurn: budgetTurn.id, beforeHumanRefreshCalls: budgetCalls, counterPreservedAcrossAuthorityRefresh: true, extraNativeRequests: 0 });
      const rootIds = [group.rootSessionId, seeded.rootSessionId, proposedSession, checkedGroup.rootSessionId, budgetGroup.rootSessionId];
      assert.ok(adapter.calls.every(call => !rootIds.includes(call.sessionId)));
      assert.ok(adapter.calls.every(call => !call.input.includes('SG_SUMMARY_OF_PRIVATE_MATERIAL')));
      await save('receipts', receipts);
      await save('result', { status: 'PASS', capability: 'CHECKED_GROUPS_DYNAMIC_AUDIENCE_PASS', legacyWideningDenied: true, proposedContract: 'PASS', productionBridge: 'CHECKED_ADAPTER_PASS', checks: receipts.length, syntheticModelRequests: adapter.calls.length, realModelRequests: 0, groupRootModelRequests: 0 });
      console.log('SG_GROUPS_DONE');
    })().catch(async error => {
      await save('receipts', receipts);
      await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, realModelRequests: 0 });
      console.log('SG_GROUPS_FAILED');
    });
    return async () => { clearTimeout(timer); controller.abort(); for (const release of adapter.gates) release(); await run; for (const off of releases.reverse()) off(); };
  });
}
