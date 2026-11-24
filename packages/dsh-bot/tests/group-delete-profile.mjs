import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const inject = ['loader', 'sessionPersistence', 'workspaceRegistry', 'dshBots', 'typertGateway', 'llm'];

const contentHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const groupKey = g => ({ groupId: g.id, groupCreatedAt: g.createdAt });

async function run(ctx, outputDir, signal) {
  await ctx.loader.await();
  await ctx.dshBots.waitUntilReady();
  while (!ctx.get('dshBotGroups')) await delay(25, undefined, { signal });
  const groups = ctx.get('dshBotGroups');
  const gate = Promise.withResolvers();
  const answer = 'Public group reply in the deletion test';
  class Fixture extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'fixture', name: 'Local fixture' }]; }
    async *stream() {
      await gate.promise;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: answer };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const release = ctx.llm.registerAdapter(['dp-loopback'], new Fixture());
  const owner = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
  const guest = new Peer(ctx, { principal: { kind: 'fixture-guest' }, interactions: 'none' });
  const remove = (peer, group, expectedRevision) => ctx.typertGateway.invoke({
    namespace: 'dshBot.groups', method: 'deleteGroup', args: { group, expectedRevision }, peer, signal,
  });
  const savedPath = join(outputDir, 'identities.json');
  const logHash = async (id, count) => {
    const handle = await ctx.sessionPersistence.open(id, 'read');
    try {
      const { events } = await handle.read(0, count);
      assert.ok(events.length > 0);
      return { count: events.length, hash: contentHash(events) };
    } finally { await handle.close(); }
  };
  const memories = async ids => Promise.all(ids.map(async id => {
    const entries = await ctx.dshBots.memoryFor(id).list();
    assert.ok(entries.some(entry => entry.content === 'Fixture private memory for ' + id));
    assert.ok(!entries.some(entry => ids.some(other => other !== id && entry.content === 'Fixture private memory for ' + other)));
    return contentHash(entries);
  }));
  try {
    let saved = await readFile(savedPath, 'utf8').then(JSON.parse).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    const cold = Boolean(saved);
    if (!saved) {
      const members = [];
      for (const id of ['delete-fixture-a', 'delete-fixture-b']) {
        const bot = await ctx.dshBots.create({ id, name: id, template: 'minimal', memory: { enabled: true, injectLimit: 0 } });
        await ctx.dshBots.memoryFor(id).save({ content: 'Fixture private memory for ' + id });
        members.push({ botId: id, botCreatedAt: bot.createdAt });
      }
      const input = { operationId: randomUUID(), name: 'Same name', mode: 'natural', members, historyConfirmed: true };
      const target = await groups.create(input);
      const survivor = await groups.create({ ...input, operationId: randomUUID() });
      const key = groupKey(target);
      const ids = members.map(member => member.botId);
      const view = await groups.view(key);
      const turn = await groups.send(key, { operationId: randomUUID(), text: 'A public fixture question',
        memberIds: [view.members[0].id], expectedMembershipRevision: view.group.membershipRevision });
      await assert.rejects(remove(owner, key, (await groups.view(key)).group.revision));
      gate.resolve();
      let finished;
      for (let attempt = 0; attempt < 400; attempt++) {
        finished = await groups.view(key);
        if (finished.turns.some(item => item.id === turn.id && item.state === 'completed')) break;
        await delay(50, undefined, { signal });
      }
      assert.ok(finished.messages.some(item => item.text === answer), 'The public reply reached the original group');
      const revision = finished.group.revision;
      const privateSessions = [];
      for (const member of members) privateSessions.push((await ctx.dshBots.openConversationExact(member)).sessionId);
      saved = { key, root: target.rootSessionId, revision, privateSessions, survivor: groupKey(survivor),
        survivorRoot: survivor.rootSessionId, input, ids, memories: await memories(ids), originalLog: await logHash(target.rootSessionId) };
      await assert.rejects(remove(guest, key, revision));
      await assert.rejects(remove(owner, { ...key, groupCreatedAt: key.groupCreatedAt + 1 }, revision));
      await assert.rejects(remove(owner, key, revision + 1));
      assert.equal((await groups.view(key)).group.revision, revision);
      assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(target.rootSessionId));
      await ctx.workspaceRegistry.pinSession(target.rootSessionId);
      assert.ok(ctx.workspaceRegistry.pinnedSessionIds.includes(target.rootSessionId));
      assert.equal(await remove(owner, key, revision), true);
      await writeFile(savedPath, JSON.stringify(saved));
    }
    assert.deepEqual((await groups.list()).map(row => groupKey(row.group)), [saved.survivor]);
    await assert.rejects(groups.view(saved.key));
    assert.equal(await remove(owner, saved.key, saved.revision), true);
    await assert.rejects(groups.create(saved.input));
    assert.equal((await groups.view(saved.survivor)).group.rootSessionId, saved.survivorRoot);
    assert.ok(ctx.workspaceRegistry.archivedSessionIds.includes(saved.root));
    assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(saved.survivorRoot));
    assert.ok(!ctx.workspaceRegistry.pinnedSessionIds.includes(saved.root));
    assert.deepEqual(await logHash(saved.root, saved.originalLog.count), saved.originalLog);
    assert.deepEqual(await memories(saved.ids), saved.memories);
    for (const [index, member] of saved.input.members.entries()) {
      const { sessionId } = await ctx.dshBots.openConversationExact(member);
      assert.equal(sessionId, saved.privateSessions[index]);
      assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(sessionId));
    }
    await writeFile(join(outputDir, cold ? 'cold-result.json' : 'result.json'), JSON.stringify({
      status: 'PASS', cold, originalNativeLogEvents: saved.originalLog.count, privateMemoryStoresVerified: saved.ids.length,
      survivingSameNameGroup: true, deletedGroupCreateReplayBlocked: true,
    }, null, 2));
  } finally { gate.resolve(); await release(); await Promise.all([owner.dispose(), guest.dispose()]); }
}

export function apply(ctx, { outputDir }) {
  ctx.effect(() => {
    const controller = new AbortController();
    const task = run(ctx, outputDir, controller.signal).then(() => console.log('B4_WEB_READY')).catch(async error => {
      await writeFile(join(outputDir, 'error.txt'), String(error.stack ?? error));
      console.log('B4_WEB_FAILED');
    });
    return async () => { controller.abort(); await task; };
  });
}
