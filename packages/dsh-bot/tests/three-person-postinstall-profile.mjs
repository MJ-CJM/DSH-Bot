// Synthetic, native three-person acceptance. No real provider or account is loaded.
import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'three-person-postinstall-fixture';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'typertGateway', 'sessionPersistence', 'clientModules'];
export function apply(ctx, config) { return ctx.effect(() => {
  const abort = new AbortController(), releases = [], calls = [], steps = new Set();
  let timer, observing = false, disposed = false, key, bots;
  const save = (name, value) => writeFile(resolve(config.outputDir, name + '.json'), JSON.stringify(value, null, 2));
  const capture = value => new Promise((accept, reject) => { const req = request(config.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' } }, response => { response.resume(); response.on('end', accept); }); req.on('error', reject); req.end(JSON.stringify(value)); });
  const ids = ['proof-alpha', 'proof-beta', 'proof-gamma'];
  const memoryContent = botId => 'Verified owner jasmine-tea preference for ' + botId;
  const wait = async test => { for (let n = 0; n < 1500; n++) { const value = await test(); if (value) return value; await delay(20); } throw Error('Three-person fixture timed out'); };
  class Adapter extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'fixture', name: 'Three-person local acceptance model' }]; }
    async *stream(options) {
      const agent = ctx.agents.get(options.sessionId); assert.ok(agent);
      const botId = ids.find(id => agent.session.header.agentPreset?.endsWith(id)); assert.ok(botId, 'Only synthetic member models may run');
      const prompt = JSON.stringify(options.messages);
      const round = ['THREE_STATUS_WRITE', 'THREE_R4', 'THREE_R3', 'THREE_R2', 'THREE_R1'].find(marker => prompt.includes(marker)); assert.ok(round);
      const marker = options.sessionId + '/' + round, first = !steps.has(marker); steps.add(marker);
      calls.push({ botId, round, sessionId: options.sessionId, tool: first ? round === 'THREE_STATUS_WRITE' ? 'bot_memory_save' : 'bot_memory_list' : undefined });
      await capture(calls.at(-1));
      if (first) {
        const name = round === 'THREE_STATUS_WRITE' ? 'bot_memory_save' : 'bot_memory_list';
        const args = round === 'THREE_STATUS_WRITE' ? JSON.stringify({ content: memoryContent(botId) }) : '{}', id = ToolCallId('proof-' + crypto.randomUUID());
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      const text = round === 'THREE_STATUS_WRITE' ? `PRIVATE_NARRATIVE_MUST_NOT_BE_PUBLISHED:${botId}` : `PRIVATE_EXPORT:${round}:${botId}\nSynthetic private lesson, shared only after this group's exact approval.`;
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const run = (async () => {
    await ctx.loader.await(); await ctx.dshBots.waitUntilReady(); assert.deepEqual(ctx.llm.listProviders(), []);
    releases.push(ctx.llm.registerAdapter(['three-person-proof'], new Adapter()));
    const groups = await wait(() => ctx.get('dshBotGroups'));
    const previous = await readFile(resolve(config.outputDir, 'fixture.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (previous) {
      assert.equal(calls.length, 0); const view = await groups.view(previous.key);
      const turn = view.turns.find(row => row.memoryStatusOnly);
      assert.ok(turn);
      const retained = view.deliveries.filter(row => row.turnId === turn.id);
      assert.equal(retained.length, 3);
      assert.ok(retained.every(row => row.memoryWriteStatus === 'saved'));
      assert.ok(!JSON.stringify(view.messages).includes('PRIVATE_NARRATIVE_MUST_NOT_BE_PUBLISHED'));
      assert.deepEqual(view.group.exportApprovals ?? [], [], 'Revoked policy must stay revoked after cold start');
      await save('cold-result', { status: 'PASS', nativeModelCalls: 0, realModelRequests: 0, retainedThreeSavedReceipts: true, revokedPolicyRemainsDisabled: true, noPublishedPrivateNarrative: true });
      console.log('B4_WEB_READY'); return;
    }
    bots = [];
    for (const id of ids) {
      const bot = await ctx.dshBots.create({ id, name: id, template: 'minimal', model: { provider: 'three-person-proof', model: 'fixture' }, memory: { enabled: true, injectLimit: 0 } });
      bots.push({ botId: id, botCreatedAt: bot.createdAt }); await ctx.dshBots.memoryFor(id).save({ content: 'SYNTHETIC_PRIVATE_SOURCE:' + id });
    }
    const group = await groups.create({ operationId: crypto.randomUUID(), name: 'Three-person final acceptance', mode: 'natural', onDemand: false, members: bots, historyConfirmed: true });
    key = { groupId: group.id, groupCreatedAt: group.createdAt };
    const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' }); releases.push(() => peer.dispose());
    const turn = await ctx.typertGateway.invoke({ namespace: 'dshBot.groups', method: 'send', args: { group: key, input: { operationId: crypto.randomUUID(), text: 'THREE_R1: review private notes for this group.', expectedMembershipRevision: group.membershipRevision } }, peer, signal: abort.signal });
    const initial = await wait(async () => { const view = await groups.view(key); return view.turns.some(row => row.id === turn.id && !['accepted', 'running'].includes(row.state)) && view; });
    assert.equal(initial.deliveries.filter(row => row.turnId === turn.id && row.reasonCode === 'export-approval-required').length, 3);
    assert.ok(!JSON.stringify(initial.messages).includes('PRIVATE_EXPORT:'));
    const productPath = ctx.clientModules.clientPath('dsh-botgroup'); assert.ok(productPath?.includes('/node_modules/dsh-botgroup/'));
    const fixture = { synthetic: true, key, sessionId: group.rootSessionId, name: group.name, bots, turn1: turn.id, productPath, realModelRequests: 0 };
    await save('fixture', fixture);
    const observe = async () => {
      if (observing || disposed) return; observing = true;
      try {
        const view = await groups.view(key), phases = {};
        for (const marker of ['THREE_R1', 'THREE_R2', 'THREE_R3', 'THREE_R4', 'THREE_STATUS_WRITE']) {
          const message = view.messages.find(row => row.authorKind === 'user' && row.text.includes(marker));
          const turn = message && view.turns.find(row => row.inputMessageId === message.id);
          if (!turn) continue;
          const deliveries = view.deliveries.filter(row => row.turnId === turn.id);
          phases[marker] = { turn, deliveries, publishedReplies: deliveries.filter(row => row.outputMessageId).length,
            publishedPrivateExportReplies: view.messages.filter(row => row.authorKind === 'bot' && row.turnId === turn.id && row.text.includes('PRIVATE_EXPORT:')).length };
        }
        const memory = phases.THREE_STATUS_WRITE;
        let memoryProof;
        if (memory && !['accepted', 'running'].includes(memory.turn.state) && memory.deliveries.length === 3) {
          memoryProof = [];
          for (const delivery of memory.deliveries) {
            const handle = await ctx.sessionPersistence.open(delivery.childSessionId, 'read', { signal: abort.signal });
            let events; try { events = (await handle.read()).events; } finally { await handle.close(); }
            const saves = events.filter(event => event.type === 'tool/call' && event.data.name === 'bot_memory_save');
            const successful = saves.flatMap(call => events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId && !event.data.message.isError));
            const receiptIds = successful.flatMap(event => { try { return [JSON.parse(event.data.message.content[0].text).id]; } catch { return []; } });
            const rows = await ctx.dshBots.memoryFor(delivery.bot.botId).list();
            const stored = rows.find(row => row.content === memoryContent(delivery.bot.botId) && receiptIds.includes(row.id));
            memoryProof.push({ botId: delivery.bot.botId, status: delivery.memoryWriteStatus, nativeSaveCalls: saves.length, nativeSuccessfulResults: successful.length,
              actualStoredReceiptId: stored?.id, matchedContent: Boolean(stored), noOutputMessage: !delivery.outputMessageId });
          }
        }
        const privateVersionsUnchanged = [...ctx.dshBots.memoryKernel.snapshot.versions.values()].every(row => row.scope === 'private' && row.labels.readers.length === 1);
        const report = { status: 'OBSERVING', phases, calls, exportApprovals: view.group.exportApprovals ?? [], memoryProof, privateVersionsUnchanged,
          publishedPrivateNarrative: JSON.stringify(view.messages).includes('PRIVATE_NARRATIVE_MUST_NOT_BE_PUBLISHED'), realModelRequests: 0 };
        await save('proof-live', report);
      } catch (error) { await save('observer-error', { error: String(error.stack ?? error) }); }
      finally { observing = false; }
    };
    await observe(); timer = setInterval(() => { void observe(); }, 100);
    console.log('B4_WEB_READY');
  })().catch(async error => { await save('fixture-error', { error: String(error.stack ?? error), calls }); console.log('B4_WEB_FAILED'); });
  return async () => { disposed = true; abort.abort(); clearInterval(timer); await run; for (const release of releases.reverse()) await release(); };
}); }
