// Synthetic fixture for the official DSH Web Host. No live model, profile, or memory is used.
import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';

export const inject = ['loader', 'llm', 'agents', 'dshBots', 'typertGateway', 'sessionPersistence', 'clientModules'];

const ids = ['expiry-alpha', 'expiry-beta', 'expiry-gamma', 'expiry-delta'];
const markers = { old: 'STALE_FIXTURE_ORIGINAL', fresh: 'STALE_FIXTURE_CURRENT' };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const outputMarker = (round, botId) => `PRIVATE_EXPIRY_${round.toUpperCase()}:${botId}`;
const wait = async test => {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const result = await test();
    if (result) return result;
    await delay(25);
  }
  throw Error('Group export expiry fixture timed out');
};

export function apply(ctx, config) {
  return ctx.effect(() => {
    const controller = new AbortController();
    const releases = [];
    const calls = [];
    const modelSessions = new Set();
    let timer, observation;
    const save = async (name, value) => {
      const path = resolve(config.outputDir, name + '.json');
      await writeFile(path + '.tmp', JSON.stringify(value, null, 2));
      await rename(path + '.tmp', path);
    };
    const load = name => readFile(resolve(config.outputDir, name + '.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const capture = value => new Promise((accept, reject) => {
      const req = request(config.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
        res.resume();
        res.on('end', accept);
      });
      req.on('error', reject);
      req.end(JSON.stringify(value));
    });

    class FixtureAdapter extends LlmAdapter {
      async listModels(provider) {
        return [{ provider, id: 'fixture', name: 'Local export expiry fixture' }];
      }
      async *stream(options) {
        const agent = ctx.agents.get(options.sessionId);
        const botId = ids.find(id => agent?.session.header.agentPreset?.endsWith(id));
        assert.ok(botId, 'Only synthetic expiry Bot sessions may call the mock model');
        const prompt = JSON.stringify(options.messages);
        const round = Object.keys(markers).reverse().find(round => prompt.includes(markers[round]));
        assert.ok(round);
        const session = options.sessionId + '/' + round;
        const first = !modelSessions.has(session);
        modelSessions.add(session);
        calls.push({ botId, round, first });
        await capture(calls.at(-1));
        if (first) {
          const id = ToolCallId('expiry-' + crypto.randomUUID());
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id, name: 'bot_memory_list', argumentsDelta: '{}' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bot_memory_list', arguments: '{}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        const text = outputMarker(round, botId);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }

    const run = (async () => {
      await ctx.loader.await();
      await ctx.dshBots.waitUntilReady();
      assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['export-expiry-proof'], new FixtureAdapter()));
      const groups = await wait(() => ctx.get('dshBotGroups'));
      const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      releases.push(() => peer.dispose());
      const invoke = (method, args) => ctx.typertGateway.invoke({
        namespace: 'dshBot.groups', method, args, peer, signal: controller.signal,
      });

      const memoryFacts = async () => {
        const versions = [...ctx.dshBots.memoryKernel.snapshot.versions.values()].sort((a, b) => a.memoryId.localeCompare(b.memoryId));
        const records = await Promise.all(ids.map(id => ctx.dshBots.memoryFor(id).list()));
        return {
          digest: digest([versions, records]),
          privateAndOwnerOnly: versions.length === ids.length
            && versions.every(row => row.scope === 'private' && Array.isArray(row.labels.readers) && row.labels.readers.length === 1
              && digest(row.labels.readers[0]) === digest(row.ownerBotKey) && row.labels.grants.length === 0)
            && records.every((rows, index) => rows.length === 1 && rows[0].content === 'PRIVATE_EXPIRY_SOURCE:' + ids[index]),
        };
      };
      const childEvents = async id => {
        const handle = await ctx.sessionPersistence.open(id, 'read', { signal: controller.signal });
        try { return (await handle.read()).events; } finally { await handle.close(); }
      };
      const flowTable = ctx.dshBots.memoryOutlets.kernel.domain.table('flows');
      const metrics = async fixture => {
        const { key, oldIds, oldTurn, oldMessages, childLogs, before } = fixture;
        const view = await groups.view(key);
        const old = view.deliveries.filter(row => oldIds.includes(row.id));
        const messages = new Map(view.messages.map(message => [message.id, message]));
        const freshMessage = view.messages.find(row => row.authorKind === 'user' && row.text.includes(markers.fresh));
        const freshTurn = freshMessage && view.turns.find(row => row.inputMessageId === freshMessage.id);
        const fresh = freshTurn ? view.deliveries.filter(row => row.turnId === freshTurn.id) : [];
        const memory = await memoryFacts();
        const messageCount = marker => view.messages.filter(row => row.authorKind === 'bot' && row.text.includes(marker)).length;
        return {
          pending: view.exportPendingCount,
          staleOpen: old.filter(row => !row.staleExportClosedAt).length,
          staleClosed: old.filter(row => row.staleExportClosedAt).length,
          freshHeld: fresh.filter(row => row.reasonCode === 'export-approval-required').map(row => ({ id: row.id, botId: row.bot.botId })),
          publishedOld: messageCount('PRIVATE_EXPIRY_OLD:'),
          publishedFresh: messageCount('PRIVATE_EXPIRY_FRESH:'),
          privateMemoryUnchanged: memory.privateAndOwnerOnly && memory.digest === before.memory,
          historicalMessagesUnchanged: oldMessages.every(({ id, hash }) => messages.has(id) && digest(messages.get(id)) === hash),
          historicalTurnUnchanged: digest(groups.state.table('turns').get(oldTurn) ?? null) === before.turn,
          historicalDeliveriesUnchanged: digest(oldIds.map(id => groups.state.table('deliveries').get(id))) === before.deliveries,
          historicalReviewFlowsUnchanged: digest(fixture.oldFlowIds.map(id => flowTable.get(id))) === before.flows,
          historicalChildrenUnchanged: (await Promise.all(childLogs.map(async ({ id, length, hash }) =>
            digest((await childEvents(id)).slice(0, length)) === hash))).every(Boolean),
          noAutomaticApproval: (view.group.exportApprovals ?? []).length === 0,
          calls: calls.length,
        };
      };
      const previous = await load('fixture');
      if (previous) {
        const cold = await metrics(previous);
        assert.equal(cold.pending, 3);
        assert.equal(cold.staleOpen, 0);
        assert.equal(cold.staleClosed, 3);
        assert.equal(cold.freshHeld.length, 3);
        assert.equal(cold.publishedFresh, 1);
        assert.equal(cold.publishedOld, 0);
        assert.equal(cold.calls, 0);
        assert.ok(cold.privateMemoryUnchanged && cold.historicalMessagesUnchanged && cold.historicalTurnUnchanged
          && cold.historicalDeliveriesUnchanged && cold.historicalReviewFlowsUnchanged && cold.historicalChildrenUnchanged
          && cold.noAutomaticApproval);
        const result = await invoke('closeStaleExports', { group: previous.key, expectedMembershipRevision: previous.membershipRevision });
        assert.equal(result.closed, 0);
        await save('cold-result', { status: 'PASS', ...cold, idempotent: true });
        console.log('B4_WEB_READY');
        return;
      }

      const bots = [];
      for (const id of ids) {
        const bot = await ctx.dshBots.create({
          id, name: id, template: 'minimal', model: { provider: 'export-expiry-proof', model: 'fixture' },
          memory: { enabled: true, injectLimit: 0 },
        });
        bots.push({ botId: id, botCreatedAt: bot.createdAt });
        await ctx.dshBots.memoryFor(id).save({ content: 'PRIVATE_EXPIRY_SOURCE:' + id });
      }
      const name = 'Group export expiry regression';
      const group = await groups.create({ operationId: crypto.randomUUID(), name, mode: 'natural', onDemand: false, members: bots.slice(0, 3), historyConfirmed: true });
      const key = { groupId: group.id, groupCreatedAt: group.createdAt };
      const turn = await invoke('send', { group: key, input: {
        operationId: crypto.randomUUID(), text: markers.old, expectedMembershipRevision: group.membershipRevision,
      } });
      const initial = await wait(async () => {
        const view = await groups.view(key);
        return view.turns.some(row => row.id === turn.id && !['accepted', 'running'].includes(row.state)) && view;
      });
      const old = initial.deliveries.filter(row => row.turnId === turn.id);
      assert.equal(old.length, 3);
      assert.ok(old.every(row => row.reasonCode === 'export-approval-required' && row.exportFlowId));
      assert.equal(calls.length, 6);
      const preview = await invoke('reviewExport', { group: key, deliveryId: old[0].id });

      // Produce the pre-flow record seen when an old Host persisted a failed native response.
      const legacy = old[1];
      await flowTable.delete(legacy.exportFlowId);
      const { revision, updatedAt, exportFlowId, stopReason, ...legacyData } = groups.state.table('deliveries').get(legacy.id);
      await groups.state.table('deliveries').put(legacy.id, { ...legacyData, state: 'unknown', reasonCode: 'native-failure' });

      const edited = await groups.edit(key, {
        expectedRevision: initial.group.revision, expectedMembershipRevision: initial.group.membershipRevision,
        name, mode: initial.group.mode, members: bots, historyConfirmed: true,
      });
      assert.ok(edited.membershipRevision > group.membershipRevision);
      const conflict = error => error.code === 'dsh-bot/conflict';
      await assert.rejects(invoke('reviewExport', { group: key, deliveryId: old[0].id }), conflict);
      await assert.rejects(invoke('reviewExport', { group: key, deliveryId: legacy.id }), conflict);
      await assert.rejects(invoke('decideExport', { group: key, deliveryId: old[0].id, token: preview.token, allow: true }), conflict);
      await assert.rejects(invoke('closeStaleExports', { group: key, expectedMembershipRevision: group.membershipRevision }), conflict);

      const changed = await groups.view(key);
      const productPath = ctx.clientModules.clientPath('dsh-botgroup');
      assert.ok(productPath?.includes('/node_modules/dsh-botgroup/'));
      const memory = await memoryFacts();
      assert.ok(memory.privateAndOwnerOnly);
      const fixture = {
        key, name, bots, productPath, sessionId: group.rootSessionId, membershipRevision: edited.membershipRevision,
        oldTurn: turn.id, oldIds: old.map(row => row.id), legacyId: legacy.id,
        oldFlowIds: old.map(row => row.exportFlowId),
        staleReviewRejected: true, staleTokenRejected: true, staleCloseRevisionRejected: true,
        oldMessages: changed.messages.map(row => ({ id: row.id, hash: digest(row) })),
        childLogs: await Promise.all(old.map(async row => {
          const events = await childEvents(row.childSessionId);
          return { id: row.childSessionId, length: events.length, hash: digest(events) };
        })),
        before: {
          memory: memory.digest, turn: digest(groups.state.table('turns').get(turn.id) ?? null),
          deliveries: digest(old.map(row => groups.state.table('deliveries').get(row.id))),
          flows: digest(old.map(row => flowTable.get(row.exportFlowId))),
        },
      };
      await save('fixture', fixture);
      const observe = () => {
        observation ??= metrics(fixture).then(report => save('proof-live', report))
          .catch(error => save('observer-error', { error: String(error.stack ?? error) }))
          .finally(() => { observation = undefined; });
      };
      observe();
      await observation;
      timer = setInterval(observe, 100);
      console.log('B4_WEB_READY');
    })().catch(async error => {
      await save('fixture-error', { error: String(error.stack ?? error), calls });
      console.error('B4_WEB_FAILED', String(error));
    });
    return async () => {
      await run;
      clearInterval(timer);
      await observation;
      controller.abort();
      for (const release of releases.reverse()) await release();
    };
  });
}
