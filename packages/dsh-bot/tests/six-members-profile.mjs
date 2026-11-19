import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const name = 'six-members-acceptance';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'typertGateway', 'sessionPersistence'];

/** Real native workers, deterministic model transport confined to the runner's loopback endpoint. */
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), releases = [], calls = [], checks = [];
    let phase = 'startup', groups, key;
    const save = (file, value) => writeFile(resolve(config.outputDir, file), JSON.stringify(value, null, 2));
    const check = (name, value) => { assert.ok(value, name); checks.push(name); };
    const wait = async read => {
      for (let n = 0; n < 1500; n++) {
        controller.signal.throwIfAborted();
        const value = await read(); if (value) return value;
        await delay(30, undefined, { signal: controller.signal });
      }
      throw new Error(`Timed out during ${phase}`);
    };
    class Adapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Six-member local fixture' }]; }
      async *stream(options) {
        const response = await fetch(config.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(options), signal: options.signal, redirect: 'error' });
        assert.equal(response.status, 200);
        const text = `SIX_MEMBER_RECEIPT ${options.sessionId}`;
        calls.push({ sessionId: options.sessionId, text });
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-loopback'], new Adapter()));
      groups = await wait(() => ctx.get('dshBotGroups'));
      const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      releases.push(() => peer.dispose());
      const invoke = (method, args) => ctx.typertGateway.invoke({ namespace: 'dshBot.groups', method, args, peer, signal: controller.signal });
      check('effective ordinary group limit is six', ctx.dshBots.config.groupMaxMembers === 6);
      check('effective Supergroup default or legacy limit is preserved safely', ctx.dshBots.config.supergroup.maxMembers ===
        (config.suite === 'six-members-legacy' ? 6 : 4));
      const existing = await groups.list();
      if (existing.length) {
        phase = 'cold persistence';
        assert.equal(existing.length, 1);
        const g = existing[0].group; key = { groupId: g.id, groupCreatedAt: g.createdAt };
        const view = await groups.view(key);
        check('cold retains all six active members', view.members.filter(m => m.enabled && m.removedAt === undefined).length === 6);
        const turn = view.turns.find(t => t.operationId === 'six-member-round');
        // Natural protocol 2 keeps a successfully settled conversation idle for explicit continuation.
        check('cold retains settled round', turn && ['idle', 'completed'].includes(turn.state));
        check('cold retains six completed deliveries', view.deliveries.filter(d => d.turnId === turn.id).length === 6 &&
          view.deliveries.filter(d => d.turnId === turn.id).every(d => d.state === 'completed'));
        check('cold retains six published receipts', view.messages.filter(m => m.turnId === turn.id && m.text.startsWith('SIX_MEMBER_RECEIPT ')).length === 6);
        check('cold does not replay model calls', calls.length === 0);
        await save('cold-result.json', { status: 'PASS', checks, fixtureRequests: 0, realModelRequests: 0 });
        console.log('B4_WEB_READY'); return;
      }
      const bots = [];
      for (let i = 1; i <= 7; i++) {
        const bot = await ctx.dshBots.create({ id: `six-bot-${i}`, name: `Acceptance Bot ${i}`, template: 'minimal',
          model: { provider: 'dp-loopback', model: 'fixture' } });
        bots.push({ botId: bot.id, botCreatedAt: bot.createdAt });
      }
      phase = 'create boundary';
      await assert.rejects(invoke('create', { input: { operationId: 'seven-rejected', name: 'Seven must reject',
        mode: 'natural', members: bots, historyConfirmed: true } }));
      check('seven creation creates no group', (await groups.list()).length === 0);
      const g = await invoke('create', { input: { operationId: 'six-accepted', name: 'Six-member acceptance',
        mode: 'natural', onDemand: false, members: bots.slice(0, 6), historyConfirmed: true } });
      key = { groupId: g.id, groupCreatedAt: g.createdAt };
      const view = () => groups.view(key);
      check('six creation admits six active members', (await view()).members.filter(m => m.enabled && m.removedAt === undefined).length === 6);
      phase = 'edit boundary';
      const edit = async members => {
        const current = (await view()).group;
        return invoke('edit', { group: key, input: { expectedRevision: current.revision,
          expectedMembershipRevision: current.membershipRevision, name: current.name, mode: current.mode,
          members, historyConfirmed: true } });
      };
      await assert.rejects(edit(bots));
      check('seven edit preserves original six', (await view()).members.filter(m => m.enabled && m.removedAt === undefined).length === 6);
      await edit(bots.slice(0, 5));
      check('can reduce six to five', (await view()).members.filter(m => m.enabled && m.removedAt === undefined).length === 5);
      await edit(bots.slice(0, 6));
      check('can return to six despite removed member history', (await view()).members.filter(m => m.enabled && m.removedAt === undefined).length === 6);
      phase = 'six native workers';
      const before = await view();
      const turn = await invoke('send', { group: key, input: { operationId: 'six-member-round',
        text: 'Each of the six members must provide one short local acceptance receipt.', round: true,
        expectedMembershipRevision: before.group.membershipRevision } });
      const final = await wait(async () => {
        const v = await view(); return v.turns.find(t => t.id === turn.id && !['accepted', 'running'].includes(t.state)) && v;
      });
      const deliveries = final.deliveries.filter(d => d.turnId === turn.id);
      check('six deliveries completed', deliveries.length === 6 && deliveries.every(d => d.state === 'completed'));
      check('six distinct Bot identities', new Set(deliveries.map(d => d.bot.botId)).size === 6);
      check('six distinct native worker sessions', new Set(deliveries.map(d => d.childSessionId)).size === 6);
      check('one model request per worker', calls.length === 6 && new Set(calls.map(c => c.sessionId)).size === 6);
      check('group root never invokes model', !calls.some(c => c.sessionId === g.rootSessionId));
      const receipts = final.messages.filter(m => m.turnId === turn.id && m.text.startsWith('SIX_MEMBER_RECEIPT '));
      check('six exact published receipts', receipts.length === 6 && deliveries.every(d => receipts.some(m =>
        m.id === d.outputMessageId && m.speaker?.bot.botId === d.bot.botId && m.text === `SIX_MEMBER_RECEIPT ${d.childSessionId}`)));
      for (const delivery of deliveries) {
        const handle = await ctx.sessionPersistence.open(delivery.childSessionId, 'read', { signal: controller.signal });
        try {
          const snapshot = await handle.read();
          assert.equal(snapshot.events.findLast(e => e.type === 'turn/end')?.data.reason.kind, 'completed');
        } finally { await handle.close(); }
      }
      check('all six native turns completed', true);
      await save('group-view.json', final);
      await save('result.json', { status: 'PASS', checks, fixtureRequests: calls.length, realModelRequests: 0,
        config: { groupMaxMembers: ctx.dshBots.config.groupMaxMembers, supergroup: ctx.dshBots.config.supergroup },
        calls, ui: { key, sessionId: g.rootSessionId }, receipts: deliveries.map(d => ({ bot: d.bot, childSessionId: d.childSessionId, outputMessageId: d.outputMessageId })) });
      console.log('B4_WEB_READY');
    })().catch(async error => {
      await save('fixture-error.json', { phase, checks, calls, error: String(error.stack ?? error) });
      if (groups && key) await save('failed-view.json', await groups.view(key).catch(() => null));
      console.error('B4_WEB_FAILED', String(error));
    });
    return async () => { controller.abort(); await run; for (const off of releases.reverse()) await off(); };
  });
}
