import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Peer } from '@deepseek-ai/dsh-client-connection';

export const name = 'v066-group-owner-follow-up';
export const inject = ['loader', 'llm', 'agents', 'dshBots', 'sessionProjections', 'typertGateway'];
const rootPreset = 'dsh-bot-group-root';
const defaultRoute = { provider: 'dp-b6b', model: 'fixture' };
const alternate = { provider: 'group-alternate', model: 'second', reasoningEffort: 'high' };
const ownerInput = { operationId: 'owner-approved', text: 'OWNER_FOLLOW_UP_APPROVED_TEXT' };
const nativeKey = group => ({ groupId: group.id, groupCreatedAt: group.createdAt });

class Adapter extends LlmAdapter {
  calls = [];
  release;
  hold = false;
  async listModels(provider) { return [await this.resolveModel(provider, provider === defaultRoute.provider ? 'fixture' : 'second')]; }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } };
  }
  async *stream(options) {
    const agent = this.ctx.agents.get(options.sessionId);
    assert.ok(agent);
    assert.notEqual(agent.session.header.agentPreset, rootPreset);
    this.calls.push({
      sessionId: options.sessionId, provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort,
      maxTokens: options.maxTokens, toolNames: options.tools?.map(tool => tool.name) ?? [],
      sandbox: this.ctx.sessionProjections.stateOf(agent.session, 'sandboxMode'), input: JSON.stringify(options.messages),
    });
    if (this.hold) await new Promise(resolveGate => {
      this.release = resolveGate;
      options.signal?.addEventListener('abort', resolveGate, { once: true });
    });
    options.signal?.throwIfAborted();
    if (options.messages.some(message => message.content.some(block => block.type === 'text' &&
      block.text.includes('"question":"DO_NOT_COPY_ORIGINAL_GROUP_PROMPT"')))) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Synthetic predecessor failure', code: 'INVALID_REQUEST', status: 400 } } };
      return;
    }
    const text = 'SYNTHETIC_GROUP_RESULT';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), adapter = new Adapter();
    adapter.ctx = ctx;
    let phase = 'start', releaseAdapter, peer;
    const save = report => writeFile(resolve(config.outputDir, config.cold ? 'cold-result.json' : 'result.json'), JSON.stringify(report, null, 2));
    const mark = value => { phase = value; console.log(`GROUP_OWNER_PHASE ${value}`); };
    const timer = setTimeout(() => lifetime.abort(new Error(`Timeout during ${phase}`)), 30000);
    const wait = async check => {
      for (;;) {
        lifetime.signal.throwIfAborted();
        const value = await check();
        if (value) return value;
        await delay(20, undefined, { signal: lifetime.signal });
      }
    };
    const run = (async () => {
      await ctx.loader.await();
      assert.deepEqual(ctx.llm.listProviders(), []);
      releaseAdapter = ctx.llm.registerAdapter(['dp-b6b', 'group-alternate'], adapter);
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (method, input) => ctx.typertGateway.invoke({
        namespace: 'dshBot.proactive', method, args: { input }, peer, signal: lifetime.signal,
      });
      await ctx.dshBots.waitUntilReady();
      const groups = await wait(() => ctx.get('dshBotGroups'));
      if (config.cold) {
        mark('durable duplicate');
        const group = (await groups.list())[0].group, key = nativeKey(group);
        const completed = (await groups.view(key)).turns.find(row => row.ownerFollowUp?.cardId && row.state === 'completed');
        assert.equal(completed.state, 'completed');
        const unexpected = async () => assert.fail('Duplicate touched the admission or dispatch callback');
        const replay = await groups.startOwnerFollowUp(key, { ...ownerInput, operationId: completed.operationId }, completed.ownerFollowUp, unexpected, unexpected);
        assert.equal(replay.id, completed.id);
        assert.equal(adapter.calls.length, 0);
        await save({ status: 'PASS', replayTurnId: replay.id, requests: 0, realModelRequests: 0 });
        console.log('GROUP_OWNER_DONE');
        return;
      }

      mark('create four-member natural group');
      const bots = [];
      for (const id of ['alpha', 'beta', 'gamma', 'delta']) {
        const bot = await ctx.dshBots.create({ id, name: id, template: 'minimal', model: defaultRoute });
        bots.push({ botId: bot.id, botCreatedAt: bot.createdAt });
      }
      const group = await groups.create({ operationId: 'owner-group', name: 'Single owner follow-up', mode: 'natural',
        members: bots, historyConfirmed: true });
      const key = nativeKey(group), view = () => groups.view(key);
      const subject = { kind: 'group', group: key };
      const summary = () => invoke('followUpSummary', subject);
      const changePolicy = async (action, expectedRevision) => {
        const view = await summary();
        const result = await invoke('followUpPolicy', { commandId: randomUUID(), subject, action,
          expectedRevision, expectedConfigEpoch: view.configEpoch });
        assert.equal(result.kind, 'receipt'); return result;
      };
      if (config.integrated) {
        await wait(async () => (await summary()).state === 'ready');
        await changePolicy('enable-local', 0);
      }
      const members = (await view()).members;
      assert.equal(members.length, 4);
      const target = members.find(row => row.bot.botId === 'delta');
      const send = (operationId, text) => groups.send(key, { operationId, text, memberIds: [members[0].id],
        expectedMembershipRevision: group.membershipRevision });
      const finished = async turn => wait(async () => {
        const current = await view(), row = current.turns.find(row => row.id === turn.id);
        if (!row || ['accepted', 'running'].includes(row.state)) return;
        return { current, row };
      });
      const original = await send('original', 'DO_NOT_COPY_ORIGINAL_GROUP_PROMPT');
      assert.equal((await finished(original)).row.state, 'partial');
      await groups.setModel(key, { expectedModelRevision: 0, memberId: target.id, modelSelection: alternate });
      const binding = { ...await groups.ownerFollowUpChoice(key, original.id, target.id), cardId: 'owner-card', cardRevision: 4 };
      assert.deepEqual(binding.modelSelection, alternate);

      mark('approve one member');
      let admitted = 0;
      const admit = async () => { admitted++; };
      const verify = async () => {};
      let accepted, before, integratedReceipt;
      if (config.integrated) {
        let card = await wait(async () => (await summary()).summary?.rows.find(row =>
          row.origin.kind === 'group-turn' && row.origin.turnId === original.id && row.condition.kind === 'failed'));
        let request = { subject, cardId: card.id, expectedRevision: card.revision };
        const { choice } = await invoke('followUpGroupChoice', { ...request, memberId: target.id });
        assert.deepEqual(choice, await groups.ownerFollowUpChoice(key, original.id, target.id));
        const beforeAbandon = adapter.calls.length;
        const abandonedId = randomUUID();
        const abandoned = { ...request, text: 'Discarded before native work', approved: true, choice, expectedPolicyRevision: 1 };
        const committed = await ctx.get('dshBotProactive').change(abandonedId,
          { kind: 'follow-up-group-accept', operationId: abandonedId, input: abandoned });
        assert.equal(committed.kind, 'receipt');
        const pending = await invoke('followUpGroupChoice', { ...request, memberId: target.id });
        assert.equal(pending.existing.commandId, abandonedId);
        assert.equal(pending.canAbandon, true);
        const abandonRequest = { ...request, operationId: abandonedId, commandId: randomUUID(), approved: true };
        assert.equal((await invoke('followUpGroupAbandon', abandonRequest)).receipt.status, 'committed');
        assert.equal((await invoke('followUpGroupAbandon', abandonRequest)).receipt.status, 'duplicate');
        assert.equal((await invoke('followUpGroupAccept', { ...abandoned, commandId: abandonedId })).kind, 'rejected');
        assert.equal(adapter.calls.length, beforeAbandon);
        const newCard = (await summary()).summary.rows.find(row => row.id === card.id);
        assert.equal(newCard.revision, card.revision + 1);
        card = newCard;
        request = { subject, cardId: card.id, expectedRevision: card.revision };
        const accept = { ...request, commandId: randomUUID(), text: ownerInput.text, approved: true, choice, expectedPolicyRevision: 1 };
        await changePolicy('pause', 1);
        assert.equal((await invoke('followUpGroupAccept', accept)).kind, 'rejected');
        await changePolicy('enable-local', 2);
        const blocked = { ...accept, commandId: randomUUID(), expectedPolicyRevision: 3 };
        adapter.hold = true;
        const beforeOrdinary = adapter.calls.length;
        const ordinary = await send('manual-race-blocker', 'Ordinary already-running input');
        await wait(() => adapter.calls.length > beforeOrdinary);
        before = adapter.calls.length;
        const [first, second] = await Promise.all([
          invoke('followUpGroupAccept', blocked), invoke('followUpGroupAccept', blocked),
        ]);
        assert.equal(first.kind, 'started'); assert.deepEqual(first, second);
        assert.equal((await invoke('followUpGroupAccept', { ...blocked, text: 'Changed body' })).kind, 'rejected');
        const cannotAbandon = await invoke('followUpGroupAbandon', {
          ...request, operationId: blocked.commandId, commandId: randomUUID(), approved: true,
        });
        assert.deepEqual(cannotAbandon, { kind: 'rejected', code: 'conflict' });
        accepted = (await view()).turns.find(row => row.id === first.turnId);
        assert.equal(accepted.state, 'accepted');
        await changePolicy('pause', 3);
        assert.equal(adapter.calls.length, before);
        adapter.hold = false; adapter.release?.();
        assert.equal((await finished(ordinary)).row.state, 'idle');
        integratedReceipt = first;
      } else {
        before = adapter.calls.length;
        const [first, duplicate] = await Promise.all([
          groups.startOwnerFollowUp(key, ownerInput, binding, admit, verify),
          groups.startOwnerFollowUp(key, ownerInput, binding, admit, verify),
        ]);
        accepted = first;
        assert.equal(accepted.id, duplicate.id);
        await assert.rejects(() => groups.startOwnerFollowUp(key, { ...ownerInput, text: 'Changed body' }, binding, admit, verify));
      }
      const approved = await finished(accepted);
      assert.equal(approved.row.state, 'completed');
      assert.equal(admitted, config.integrated ? 0 : 1);
      assert.deepEqual(accepted.orderedMemberIds, [target.id]);
      assert.deepEqual(accepted.predecessorTurnIds, [original.id]);
      const deliveries = approved.current.deliveries.filter(row => row.turnId === accepted.id);
      assert.deepEqual(deliveries.map(row => row.memberId), [target.id]);
      const calls = adapter.calls.slice(before);
      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.equal(call.sessionId, deliveries[0].childSessionId);
      assert.deepEqual({ provider: call.provider, model: call.model, reasoningEffort: call.reasoningEffort }, alternate);
      assert.deepEqual(call.toolNames, []);
      assert.equal(call.sandbox, 'read-only');
      assert.ok(call.maxTokens > 0 && call.maxTokens <= 1024);
      assert.ok(call.input.includes(ownerInput.text));
      assert.ok(!call.input.includes('DO_NOT_COPY_ORIGINAL_GROUP_PROMPT'));
      assert.equal(ctx.agents.get(group.rootSessionId).session.snapshotEvents().filter(event => event.type === 'request/header').length, 0);

      mark('queued model change');
      adapter.hold = true;
      const beforeBlocker = adapter.calls.length;
      const blocker = await send('blocker', 'One already-running ordinary member');
      await wait(() => adapter.calls.length > beforeBlocker);
      const queued = await groups.startOwnerFollowUp(key, { operationId: 'stale-model', text: 'STALE_OWNER_CHOICE' },
        binding, admit, verify);
      assert.equal((await view()).turns.find(row => row.id === queued.id).state, 'accepted');
      await groups.setModel(key, { expectedModelRevision: 1, memberId: target.id, modelSelection: defaultRoute });
      const beforeRelease = adapter.calls.length;
      adapter.hold = false;
      adapter.release?.();
      assert.equal((await finished(blocker)).row.state, 'idle');
      const stale = await finished(queued);
      assert.equal(stale.row.state, 'partial');
      assert.equal(adapter.calls.length, beforeRelease);
      assert.ok(adapter.calls.every(row => !row.input.includes('STALE_OWNER_CHOICE')));
      await assert.rejects(() => groups.startOwnerFollowUp(key, { operationId: 'new-stale', text: 'No request' }, binding, admit, verify));
      assert.equal(admitted, config.integrated ? 1 : 2);

      mark('queued member removal');
      const currentChoice = { ...await groups.ownerFollowUpChoice(key, original.id, target.id), cardId: 'removal-card', cardRevision: 0 };
      adapter.hold = true;
      const beforeMembershipBlocker = adapter.calls.length;
      const membershipBlocker = await send('membership-blocker', 'One other running member');
      await wait(() => adapter.calls.length > beforeMembershipBlocker);
      const removedTarget = await groups.startOwnerFollowUp(key, { operationId: 'removed-member', text: 'REMOVED_OWNER_CHOICE' },
        currentChoice, admit, verify);
      assert.equal((await view()).turns.find(row => row.id === removedTarget.id).state, 'accepted');
      const beforeEdit = (await view()).group;
      await groups.edit(key, { expectedRevision: beforeEdit.revision, expectedMembershipRevision: beforeEdit.membershipRevision,
        name: beforeEdit.name, mode: beforeEdit.mode, members: bots.filter(bot => bot.botId !== 'delta'), historyConfirmed: true });
      const beforeMembershipRelease = adapter.calls.length;
      adapter.hold = false; adapter.release?.();
      await finished(membershipBlocker);
      assert.equal((await finished(removedTarget)).row.state, 'cancelled');
      assert.equal(adapter.calls.length, beforeMembershipRelease);
      assert.ok(adapter.calls.every(row => !row.input.includes('REMOVED_OWNER_CHOICE')));
      await save({ status: 'PASS', groupMembers: members.length, selectedMember: target.id, delivery: deliveries[0],
        approvedRequest: call, duplicateAdmissions: 1, integratedReceipt, queuedChangedModelRequests: 0,
        queuedRemovedMemberRequests: 0, rootModelRequests: 0, realModelRequests: 0 });
      console.log('GROUP_OWNER_DONE');
    })().catch(async error => {
      await save({ status: 'FAIL', phase, error: String(error), stack: error.stack, calls: adapter.calls, realModelRequests: 0 });
      console.log('GROUP_OWNER_FAILED');
    });
    return async () => { clearTimeout(timer); lifetime.abort(); adapter.release?.(); await run; peer?.dispose(); releaseAdapter?.(); };
  });
}
