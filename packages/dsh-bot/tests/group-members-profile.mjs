import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';

export const name = 'group-members-native-acceptance';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'sessionController', 'dshBots', 'typertGateway', 'sessionPersistence', 'workspaceRegistry'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const groupKey = g => ({ groupId: g.id, groupCreatedAt: g.createdAt });
const present = view => view.members.filter(member => member.removedAt === undefined);
const conflict = error => error.code === 'dsh-bot/conflict';

async function run(ctx, config, signal, disposers) {
  const checks = [], calls = [], sessions = new Map(), gates = new Map(), aborted = new Set();
  let phase = 'startup';
  const check = name => checks.push(name);
  const save = (file, value) => writeFile(join(config.outputDir, file), JSON.stringify(value, null, 2));
  const wait = async read => {
    for (let n = 0; n < 1200; n++) {
      signal.throwIfAborted();
      const value = await read(); if (value) return value;
      await delay(25, undefined, { signal });
    }
    throw Error('Timed out: ' + phase);
  };
  class Adapter extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'fixture', name: 'Local membership acceptance' }]; }
    async *stream(options) {
      const index = sessions.get(options.sessionId) ?? 0; sessions.set(options.sessionId, index + 1);
      calls.push({ phase, sessionId: options.sessionId });
      const response = await fetch(config.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phase, sessionId: options.sessionId }), signal: options.signal });
      assert.equal(response.status, 200);
      if (phase === 'active-removal') {
        const gate = Promise.withResolvers(); gates.set(options.sessionId, gate);
        try {
          if (options.signal.aborted) throw options.signal.reason;
          await new Promise((accept, reject) => {
            const abort = () => { aborted.add(options.sessionId); reject(options.signal.reason ?? Error('aborted')); };
            options.signal.addEventListener('abort', abort, { once: true });
            gate.promise.then(() => { options.signal.removeEventListener('abort', abort); accept(); });
          });
        } finally { gates.delete(options.sessionId); }
      }
      if (phase === 'stale-export' && index === 0) {
        const id = ToolCallId('membership-private-read');
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name: 'bot_memory_list', argumentsDelta: '{}' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bot_memory_list', arguments: '{}' } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      const text = phase === 'stale-export' ? 'PRIVATE_MEMBER_EDIT_REPLY' : `MEMBER_EDIT_REPLY ${options.sessionId}`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const log = async (id, count) => {
    const handle = await ctx.sessionPersistence.open(id, 'read', { signal });
    try { const { events } = await handle.read(0, count); return { count: events.length, sha256: digest(events) }; }
    finally { await handle.close(); }
  };
  try {
    await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
    assert.deepEqual(ctx.llm.listProviders(), []);
    disposers.push(ctx.llm.registerAdapter(['dp-loopback'], new Adapter()));
    const groups = await wait(() => ctx.get('dshBotGroups'));
    const owner = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
    const guest = new Peer(ctx, { principal: { kind: 'fixture-guest' }, interactions: 'none' });
    disposers.push(() => owner.dispose(), () => guest.dispose());
    const invoke = (method, args, peer = owner) => ctx.typertGateway.invoke({ namespace: 'dshBot.groups', method, args, peer, signal });
    const view = key => groups.view(key);
    const editInput = async (key, members, extra = {}) => {
      const g = (await view(key)).group;
      return { operationId: randomUUID(), expectedRevision: g.revision, expectedMembershipRevision: g.membershipRevision, members, ...extra };
    };
    const edit = async (key, members, extra = {}) => {
      const input = await editInput(key, members, extra);
      const result = await invoke('editMembers', { group: key, input });
      assert.equal(result.status, 'saved'); assert.ok(result.group);
      return { input, result };
    };
    const make = async (name, members) => groupKey(await invoke('create', { input: { operationId: randomUUID(),
      name, mode: 'natural', onDemand: false, members, historyConfirmed: true } }));
    const unchanged = async (key, fn) => {
      const before = digest(await view(key)); await assert.rejects(fn); assert.equal(digest(await view(key)), before);
    };
    const settle = (key, turn) => wait(async () => {
      const v = await view(key); return v.turns.some(t => t.id === turn.id && !['accepted', 'running'].includes(t.state)) && v;
    });
    const send = async (key, extra = {}) => {
      const v = await view(key);
      return invoke('send', { group: key, input: { operationId: randomUUID(), text: 'Synthetic member-management acceptance input',
        expectedMembershipRevision: v.group.membershipRevision, ...extra } });
    };
    const statePath = join(config.outputDir, 'identities.json');
    const stored = await readFile(statePath, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const privateState = async (bots, baseline) => Promise.all(bots.map(async bot => {
      const entries = await ctx.dshBots.memoryFor(bot.botId).list();
      assert.ok(entries.some(entry => entry.content === 'PRIVATE_FIXTURE_' + bot.botId));
      const conversation = await ctx.dshBots.openConversationExact(bot);
      const prior = baseline?.find(row => row.bot.botId === bot.botId);
      return { bot, sessionId: conversation.sessionId, memoriesSha256: digest(entries), log: await log(conversation.sessionId, prior?.log.count) };
    }));
    if (stored) {
      phase = 'cold';
      for (const receipt of stored.receipts) {
        assert.deepEqual(await invoke('getMemberEditResult', { group: receipt.key, operationId: receipt.input.operationId }), receipt.result);
        assert.deepEqual(await invoke('editMembers', { group: receipt.key, input: receipt.input }), receipt.result);
      }
      assert.deepEqual(await privateState(stored.bots, stored.privateState), stored.privateState);
      for (const row of stored.logs) assert.deepEqual(await log(row.id, row.log.count), row.log);
      for (const row of stored.groups) {
        const v = await view(row.key); assert.equal(v.group.rootSessionId, row.rootSessionId);
        assert.deepEqual(present(v).map(m => m.bot), row.members);
      }
      const disabled = await readFile(join(config.outputDir, 'ui-disabled-seeded.json'), 'utf8').then(JSON.parse)
        .catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (disabled) {
        const uiBefore = await view(stored.ui.key);
        assert.equal(uiBefore.members.find(m => m.id === disabled.memberId)?.enabled, false);
        await edit(stored.ui.key, present(uiBefore).map(m => m.bot));
        const uiAfter = await view(stored.ui.key);
        assert.equal(uiAfter.members.find(m => m.id === disabled.memberId)?.enabled, false);
        assert.equal(present(uiAfter).length, 3);
        check('seeded disabled member survives real owner save and remains present with its disabled flag');
      }
      assert.equal(calls.length, 0); check('cold lookup/replay preserves receipts, memberships, native histories, private sessions and memories; no model replay');
      await save('cold-result.json', { status: 'PASS', checks, fixtureRequests: 0, realModelRequests: 0 }); return;
    }
    const bots = [], receipts = [];
    for (let i = 0; i < 7; i++) {
      const bot = await ctx.dshBots.create({ id: 'members-fixture-' + i, name: 'Member fixture ' + i, template: 'minimal',
        memory: { enabled: true, injectLimit: 0 }, model: { provider: 'dp-loopback', model: 'fixture' } });
      bots.push({ botId: bot.id, botCreatedAt: bot.createdAt });
      await ctx.dshBots.memoryFor(bot.id).save({ content: 'PRIVATE_FIXTURE_' + bot.id });
    }
    phase = 'private-history-seed';
    const privateChat = await ctx.dshBots.openConversationExact(bots[0]);
    const { agent: privateAgent } = await ctx.sessionController.resolveAgent(privateChat.sessionId);
    assert.ok(privateAgent);
    await ctx.sessionController.prompt({ sessionId: privateChat.sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: 'PRIVATE_MAIN_HISTORY_TO_PRESERVE' }] }, signal);
    await privateAgent.whenIdle(); await ctx.sessions.flush(privateAgent.session);
    assert.ok(privateAgent.session.snapshotEvents().some(event => event.type === 'user/message' &&
      event.data.content.some(block => block.type === 'text' && block.text === 'PRIVATE_MAIN_HISTORY_TO_PRESERVE')));
    const originalPrivate = await privateState(bots);
    const key = await make('Independent member-management acceptance', bots.slice(0, 3));
    const initialGroup = (await view(key)).group;
    phase = 'public-history'; const publicTurn = await send(key, { memberIds: [present(await view(key))[0].id] });
    const publicView = await settle(key, publicTurn);
    assert.ok(publicView.messages.some(m => m.text.startsWith('MEMBER_EDIT_REPLY ')));
    const originalHistory = await log(initialGroup.rootSessionId);
    phase = 'membership-boundaries';
    const noConsent = await editInput(key, bots.slice(0, 4));
    await unchanged(key, () => invoke('editMembers', { group: key, input: noConsent }));
    assert.equal((await invoke('getMemberEditResult', { group: key, operationId: noConsent.operationId })).status, 'not-found');
    const pureRemoval = await edit(key, bots.slice(0, 2)); receipts.push({ key, ...pureRemoval });
    check('pure removal succeeds without history consent; addition without consent rejected without mutation or durable attempt');
    const authorized = await edit(key, bots.slice(0, 4), { historyConfirmed: true }); receipts.push({ key, ...authorized });
    const afterAuthorized = digest(await view(key));
    assert.deepEqual(await invoke('editMembers', { group: key, input: authorized.input }), authorized.result);
    assert.equal(digest(await view(key)), afterAuthorized);
    await assert.rejects(invoke('editMembers', { group: key, input: { ...authorized.input, members: bots.slice(0, 3) } }), conflict);
    await unchanged(key, () => invoke('editMembers', { group: key, input: { ...authorized.input, operationId: randomUUID() } }));
    await assert.rejects(invoke('getMemberEditResult', { group: { ...key, groupCreatedAt: key.groupCreatedAt + 1 },
      operationId: authorized.input.operationId }));
    await assert.rejects(invoke('editMembers', { group: key, input: await editInput(key, bots.slice(0, 3)) }, guest));
    await assert.rejects(invoke('getMemberEditResult', { group: key, operationId: authorized.input.operationId }, guest));
    await unchanged(key, async () => invoke('editMembers', { group: key, input: await editInput(key, bots.slice(0, 1)) }));
    await unchanged(key, async () => invoke('editMembers', { group: key, input: await editInput(key, bots, { historyConfirmed: true }) }));
    await unchanged(key, async () => invoke('editMembers', { group: key, input: await editInput(key,
      [bots[0], bots[1], { ...bots[6], botCreatedAt: bots[6].botCreatedAt + 1 }], { historyConfirmed: true }) }));
    const maximum = await edit(key, bots.slice(0, 6), { historyConfirmed: true }); receipts.push({ key, ...maximum });
    assert.equal(present(await view(key)).length, (await view(key)).memberLimit);
    check('confirmed additions, owner guard, exact birthday, minimum two, configured maximum and operation replay/conflict verified');
    const missing = await ctx.dshBots.create({ id: 'unavailable-fixture', name: 'Unavailable fixture', template: 'minimal' });
    const unavailableKey = await make('Unavailable retained member', [bots[0], bots[1], { botId: missing.id, botCreatedAt: missing.createdAt }]);
    await ctx.dshBots.remove(missing.id, { expectedCreatedAt: missing.createdAt, deleteMemories: false, deleteHome: false });
    const unavailableMembers = present(await view(unavailableKey)).map(m => m.bot);
    receipts.push({ key: unavailableKey, ...await edit(unavailableKey, unavailableMembers) });
    receipts.push({ key: unavailableKey, ...await edit(unavailableKey, bots.slice(0, 2)) });
    check('unavailable exact member can be retained and explicitly removed without blocking other membership edits');
    phase = 'stale-export';
    const staleKey = await make('Stale return approval', bots.slice(0, 3));
    const staleTurn = await send(staleKey, { memberIds: [present(await view(staleKey))[0].id] });
    const held = await settle(staleKey, staleTurn), delivery = held.deliveries.find(d => d.turnId === staleTurn.id);
    assert.equal(delivery.reasonCode, 'export-approval-required');
    const preview = await invoke('reviewExport', { group: staleKey, deliveryId: delivery.id });
    assert.ok(preview.content.includes('PRIVATE_MEMBER_EDIT_REPLY'));
    const callCount = calls.length;
    receipts.push({ key: staleKey, ...await edit(staleKey, bots.slice(0, 2)) });
    await assert.rejects(invoke('decideExport', { group: staleKey, deliveryId: delivery.id, token: preview.token, allow: true }), conflict);
    await assert.rejects(invoke('reviewExport', { group: staleKey, deliveryId: delivery.id }), conflict);
    assert.ok(!(await view(staleKey)).messages.some(m => m.text.includes('PRIVATE_MEMBER_EDIT_REPLY')));
    assert.equal(calls.length, callCount);
    check('membership change invalidates old private preview/token without publishing or reexecuting it');
    phase = 'active-removal';
    const activeKey = await make('Exact running-member cancellation', bots.slice(0, 3));
    const activeTurn = await send(activeKey, { round: true });
    const running = await wait(async () => {
      const v = await view(activeKey), ds = v.deliveries.filter(d => d.turnId === activeTurn.id);
      return ds.length === 3 && ds.every(d => d.state === 'running' && gates.has(d.childSessionId)) && ds;
    });
    const removed = running.find(d => d.bot.botId === bots[2].botId);
    receipts.push({ key: activeKey, ...await edit(activeKey, bots.slice(0, 2)) });
    await wait(() => aborted.has(removed.childSessionId));
    assert.ok(running.filter(d => d.id !== removed.id).every(d => !aborted.has(d.childSessionId)));
    for (const gate of gates.values()) gate.resolve();
    const ended = await settle(activeKey, activeTurn), endedDeliveries = ended.deliveries.filter(d => d.turnId === activeTurn.id);
    assert.equal(endedDeliveries.find(d => d.id === removed.id).state, 'cancelled');
    for (const d of running.filter(d => d.id !== removed.id)) {
      const handle = await ctx.sessionPersistence.open(d.childSessionId, 'read');
      try { assert.equal((await handle.read()).events.findLast(e => e.type === 'turn/end')?.data.reason.kind, 'completed'); }
      finally { await handle.close(); }
    }
    assert.ok(!ended.messages.some(m => m.speaker?.bot.botId === bots[2].botId));
    check('removal cancels only the removed native worker; two retained native turns finish; removed reply is not published');
    assert.equal((await view(key)).group.rootSessionId, initialGroup.rootSessionId);
    assert.deepEqual(await log(initialGroup.rootSessionId, originalHistory.count), originalHistory);
    assert.deepEqual(await privateState(bots, originalPrivate), originalPrivate);
    assert.equal((await ctx.dshBots.list()).length, bots.length);
    for (const row of originalPrivate) assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(row.sessionId));
    check('original group native log prefix, all seven Bots, private main-session identities and private-memory payloads are preserved');
    phase = 'ui-preparation';
    const uiKey = await make('CUA member management fixture', bots.slice(0, 3));
    const uiView = await view(uiKey);
    const ui = { key: uiKey, rootSessionId: uiView.group.rootSessionId, groupName: uiView.group.name,
      disabledMemberId: present(uiView)[2].id, availableFourthBot: bots[3].botId };
    const keys = [key, unavailableKey, staleKey, activeKey, uiKey], groupRows = [];
    for (const k of keys) { const v = await view(k); groupRows.push({ key: k, rootSessionId: v.group.rootSessionId, members: present(v).map(m => m.bot) }); }
    const logs = [{ id: initialGroup.rootSessionId, log: await log(initialGroup.rootSessionId) }];
    await save('identities.json', { bots, receipts, privateState: originalPrivate, logs, groups: groupRows, ui });
    await save('result.json', { status: 'PASS', checks, fixtureRequests: calls.length, realModelRequests: 0,
      receiptCount: receipts.length, nativeWorkers: running.length, ui: { key, rootSessionId: initialGroup.rootSessionId }, calls });
  } catch (error) {
    await save('failure.json', { status: 'FAIL', phase, checks, calls, error: String(error.stack ?? error) }); throw error;
  } finally { for (const gate of gates.values()) gate.resolve(); }
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), disposers = [];
    const task = run(ctx, config, controller.signal, disposers).then(() => console.log('B4_WEB_READY'))
      .catch(error => console.error('B4_WEB_FAILED', String(error)));
    return async () => { controller.abort(); await task; for (const dispose of disposers.reverse()) await dispose(); };
  });
}
