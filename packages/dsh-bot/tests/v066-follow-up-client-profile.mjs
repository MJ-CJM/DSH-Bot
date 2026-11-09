import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { ReloadAdapter } from './v066-reload-profile.mjs';

export const inject = ['loader', 'llm', 'storageDomain', 'typertGateway'];
const failureInput = 'VISUAL_FIXTURE_PREDECESSOR_FAILURE';
const continuationInput = 'Check the isolated package integrity again.';
const watchTitle = 'Verify the offline installer';
const primary = { provider: 'dp-loopback', model: 'fixture' };
const selectedRoute = { provider: 'follow-up-loopback', model: 'single-member' };

class ClientAdapter extends ReloadAdapter {
  calls = [];
  async listModels(provider) {
    return [{ provider, id: provider === primary.provider ? primary.model : selectedRoute.model, name: 'Follow-up test route' }];
  }
  async *stream(options) {
    const text = JSON.stringify(options.messages);
    this.calls.push({ sessionId: options.sessionId, provider: options.provider, model: options.model,
      continuation: text.includes(continuationInput), predecessor: text.includes(failureInput),
      tools: options.tools?.map(tool => tool.name) ?? [] });
    if (options.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes(`"question":"${failureInput}"`)))) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Synthetic integrity check failed', code: 'INVALID_REQUEST' } } };
      return;
    }
    yield* super.stream(options);
  }
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const lifecycle = new AbortController(), signal = lifecycle.signal;
    let release, peer;
    const save = (name, value) => writeFile(join(config.outputDir, name), JSON.stringify(value, null, 2));
    const until = async (read, limitMs = 120000) => {
      const deadline = Date.now() + limitMs;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const value = await read();
        if (value) return value;
        await delay(80, undefined, { signal });
      }
      throw new Error('Native follow-up Client fixture timed out');
    };
    const run = (async () => {
      await ctx.loader.await();
      assert.deepEqual(ctx.llm.listProviders(), []);
      const adapter = new ClientAdapter();
      release = ctx.llm.registerAdapter([primary.provider, selectedRoute.provider], adapter);
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (method, input) => ctx.typertGateway.invoke({ namespace: 'dshBot.proactive', method,
        args: { input }, peer, signal });
      const registry = ctx.get('dshBots');
      await registry.waitUntilReady();
      const bots = [];
      for (const id of ['alpha', 'beta', 'gamma', 'delta']) {
        const bot = await registry.create({ id, name: `Fixture ${id}`, template: 'minimal', model: primary });
        bots.push({ botId: bot.id, botCreatedAt: bot.createdAt });
      }
      const personal = { kind: 'bot', bot: bots[0] };
      const other = { kind: 'bot', bot: bots[1] };
      await registry.openConversation(personal.bot.botId);
      const groups = () => ctx.get('dshBotGroups');
      const record = await groups().create({ operationId: randomUUID(), name: 'Follow-up verification group',
        mode: 'natural', members: bots, historyConfirmed: true });
      const group = { kind: 'group', group: { groupId: record.id, groupCreatedAt: record.createdAt } };
      const view = () => groups().view(group.group);
      const members = (await view()).members;
      const select = members.find(row => row.bot.botId === 'delta');
      await groups().setModel(group.group, { expectedModelRevision: 0, memberId: select.id, modelSelection: selectedRoute });
      // Existing native group/model metadata can predate an available route.
      // Both owner enable operations run while the Host has no model providers.
      release();
      release = undefined;
      assert.deepEqual(ctx.llm.listProviders(), []);
      const summary = subject => invoke('followUpSummary', subject);
      const active = async subject => (await summary(subject)).summary?.policy.localEnabled;
      assert.equal((await summary(personal)).state, 'disabled');
      assert.equal((await summary(group)).state, 'disabled');
      await save('client-initial.json', { personal, group, other, selected: select.id, members: members.map(row => row.id),
        watchTitle, selectedRoute, continuationInput, initialRequests: adapter.calls.length });
      console.log('B4_WEB_READY');

      await until(() => active(personal));
      assert.equal(Boolean(await active(group)), false);
      assert.equal(Boolean(await active(other)), false);
      assert.equal(adapter.calls.length, 0);
      assert.deepEqual(ctx.llm.listProviders(), []);
      await save('client-personal-enabled.json', { personal: true, group: false, other: false, requests: 0, modelProviders: 0 });
      await until(() => active(group));
      assert.equal(Boolean(await active(other)), false);
      assert.equal(adapter.calls.length, 0);
      assert.deepEqual(ctx.llm.listProviders(), []);
      await save('client-group-enabled.json', { personal: true, group: true, other: false, requests: 0, modelProviders: 0 });
      release = ctx.llm.registerAdapter([primary.provider, selectedRoute.provider], adapter);
      const send = text => groups().send(group.group, { operationId: randomUUID(), text,
        expectedMembershipRevision: record.membershipRevision, memberIds: [members[0].id] });
      const settled = turn => until(async () => {
        const record = (await view()).turns.find(row => row.id === turn.id);
        return record && !['accepted', 'running'].includes(record.state) ? record : undefined;
      });
      const predecessor = await send(failureInput);
      assert.equal((await settled(predecessor)).state, 'partial');
      const cards = async subject => (await invoke('followUpPage', { subject })).rows;
      const failure = await until(async () => (await cards(group)).find(row =>
        row.origin.kind === 'group-turn' && row.origin.turnId === predecessor.id && row.condition.kind === 'failed'));
      adapter.tool = 'bot_follow_up';
      adapter.toolArguments = { action: 'create', title: watchTitle, completion: 'The owner verifies installation.' };
      const proposalTurn = await send('Synthetic human request to follow the installer verification.');
      await settled(proposalTurn);
      const proposal = await until(async () => (await cards(group)).find(row => row.title === watchTitle && row.condition.kind === 'approval-pending'));
      assert.deepEqual(await cards(personal), []);
      assert.equal(adapter.calls.length, 3);
      await save('client-cards.json', { failure, proposal, predecessor: predecessor.id, requests: adapter.calls.length });

      const confirmed = await until(async () => (await cards(group)).find(row => row.id === proposal.id && row.condition.kind === 'tracking'));
      assert.equal(adapter.calls.length, 3, 'Rendering, choice and confirming a watch cannot call a model');
      await save('client-confirmed.json', { card: confirmed, requests: adapter.calls.length });
      const continuation = await until(async () => (await view()).turns.find(turn =>
        turn.ownerFollowUp?.cardId === failure.id && turn.state === 'completed'));
      const deliveries = (await view()).deliveries.filter(row => row.turnId === continuation.id);
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].memberId, select.id);
      assert.equal(deliveries[0].state, 'completed');
      const calls = adapter.calls.filter(call => call.continuation);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].sessionId, deliveries[0].childSessionId);
      assert.equal(calls[0].provider, selectedRoute.provider);
      assert.equal(calls[0].model, selectedRoute.model);
      assert.equal(calls[0].predecessor, false);
      assert.deepEqual(calls[0].tools, []);
      assert.equal(adapter.calls.length, 4);
      await save('client-accepted.json', { turnId: continuation.id, selected: select.id, requests: adapter.calls.length,
        nativeRequest: calls[0], realModelRequests: 0 });

      await until(() => readFile(join(config.outputDir, 'client-start-burst'), 'utf8').catch(() => undefined));
      const domain = ctx.storageDomain.get('dsh_bot_groups');
      assert.ok(domain);
      const turnTable = domain.table('turns'), deliveryTable = domain.table('deliveries');
      const previous = turnTable.get(predecessor.id), previousDelivery = deliveryTable.get(`${predecessor.id}:0`);
      assert.ok(previous && previousDelivery);
      const ids = Array.from({ length: 30 }, (_, index) => `turn:browser-burst-${index}`);
      const requestsBefore = adapter.calls.length;
      const commits = await Promise.all(ids.map(async id => {
        const at = Date.now();
        await turnTable.put(id, { ...previous, id, operationId: id, inputMessageId: id, inputSeq: undefined,
          createdAt: at, updatedAt: at, revision: 1, state: 'partial' });
        const deliveryId = `${id}:0`;
        await deliveryTable.put(deliveryId, { id: deliveryId, turnId: id, memberId: previousDelivery.memberId,
          ordinal: 0, bot: previousDelivery.bot, botRevision: previousDelivery.botRevision, presetId: previousDelivery.presetId,
          contextOutputMessageIds: [], contextTruncated: false, endedAt: at, updatedAt: at, revision: 1,
          state: 'failed', failure: { message: 'Synthetic browser performance fact' } });
        const committedAt = Date.now();
        ctx.emit('dsh-bot/group-fact-changed', group.group, id);
        return committedAt;
      }));
      const expected = new Set(ids);
      await until(async () => {
        const rows = new Set();
        let cursor;
        do {
          const page = await invoke('followUpPage', { subject: group, ...(cursor ? { cursor } : {}) }).catch(() => undefined);
          if (!page) return;
          for (const row of page.rows) {
            if (row.origin.kind === 'group-turn' && expected.has(row.origin.turnId)) rows.add(row.origin.turnId);
          }
          cursor = page.next;
        } while (cursor && rows.size < expected.size);
        return rows.size === expected.size;
      });
      assert.equal(adapter.calls.length, requestsBefore);
      await save('client-burst.json', { facts: ids.length, firstDurableAt: Math.min(...commits), lastDurableAt: Math.max(...commits),
        uniqueProjected: ids.length, adapterRequests: adapter.calls.length - requestsBefore });
    })().catch(async error => {
      if (signal.aborted) return;
      console.error('B4_WEB_FAILED', error);
      await save('client-error.json', { message: String(error), stack: error.stack });
    });
    return async () => { lifecycle.abort(); peer?.dispose(); release?.(); await run; };
  });
}
