import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'natural-groups-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'fileUploads', 'attachments'];
class GroupAdapter extends LlmAdapter {
  calls = []; sessions = new Map(); alphaChildren = new Set(); target; attachment = false;
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic natural group fixture' }]; }
  async *stream(options) {
    const serialized = JSON.stringify(options);
    assert.ok(!serialized.includes('PRIVATE_GROUP_CANARY'), 'private memory must not enter a group worker');
    const nth = (this.sessions.get(options.sessionId) ?? 0) + 1;
    this.sessions.set(options.sessionId, nth);
    this.calls.push({ sessionId: options.sessionId, toolAvailable: serialized.includes('group_message'), input: serialized });
    let text;
    if (this.attachment) { assert.ok(serialized.includes('native-group-input.txt')); text = 'NATIVE_FILE_READ'; }
    else if (serialized.includes('NATURAL_PERSONA_ALPHA')) {
      this.alphaChildren.add(options.sessionId);
      if (this.alphaChildren.size === 1 && nth === 1) {
        const id = ToolCallId('natural-ask-b'), args = JSON.stringify({ action: 'send', to: this.target, text: 'NATURAL_B_QUESTION', requestReply: true });
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name: 'group_message', argumentsDelta: args };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'group_message', arguments: args } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      text = this.alphaChildren.size === 1 ? 'NATURAL_A_WAITING' : 'NATURAL_A_CONTINUED_WITH_B';
      if (this.alphaChildren.size > 1) assert.ok(serialized.includes('NATURAL_B_VERIFIED_42'));
    } else { assert.ok(serialized.includes('NATURAL_PERSONA_BETA')); assert.ok(serialized.includes('NATURAL_B_QUESTION')); text = 'NATURAL_B_VERIFIED_42'; }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), adapter = new GroupAdapter(), releases = [];
    let phase = 'loader';
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const mark = async name => { phase = name; console.log(`NATURAL_GROUP_PHASE ${name}`); await save('progress', { phase }); };
    const timer = setTimeout(() => controller.abort(new Error(`Natural group timeout: ${phase}`)), 60000);
    const wait = async check => { for (;;) { controller.signal.throwIfAborted(); const value = await check(); if (value) return value; await delay(20, undefined, { signal: controller.signal }); } };
    const run = (async () => {
      await mark('loader'); await ctx.loader.await();
      assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      await mark('registry'); await ctx.dshBots.waitUntilReady(); await wait(() => ctx.dshBots.mainSessions);
      const groups = await wait(() => ctx.get('dshBotGroups'));
      const keys = [];
      for (const id of ['alpha', 'beta']) {
        const bot = await ctx.dshBots.create({ id, name: id, template: 'minimal', persona: { prefix: `NATURAL_PERSONA_${id.toUpperCase()}` }, model: { provider: 'dp-b6b', model: 'fixture' } });
        keys.push({ botId: id, botCreatedAt: bot.createdAt });
        await ctx.dshBots.memoryFor(id).save({ content: `PRIVATE_GROUP_CANARY_${id}` });
      }
      assert.ok(ctx.dshBots.memoryKernel); assert.ok(ctx.dshBots.memoryOutlets);
      await mark('group');
      const group = await groups.create({ operationId: 'native-group', name: 'Natural native fixture', mode: 'natural', members: keys, historyConfirmed: true });
      const key = { groupId: group.id, groupCreatedAt: group.createdAt }, view = () => groups.view(key), members = (await view()).members;
      adapter.target = members.find(m => m.bot.botId === 'beta').id;
      await mark('mutual-tool-chain');
      const turn = await groups.send(key, { operationId: 'native-mutual', text: 'NATURAL_USER_QUESTION', memberIds: [members.find(m => m.bot.botId === 'alpha').id], expectedMembershipRevision: 1 });
      const done = await wait(async () => { const v = await view(); return v.turns.find(t => t.id === turn.id && !['accepted', 'running'].includes(t.state)) && v; });
      await save('mutual-view', done);
      assert.equal(done.turns.find(t => t.id === turn.id).state, 'completed');
      assert.deepEqual(done.deliveries.filter(d => d.turnId === turn.id).map(d => d.bot.botId), ['alpha', 'beta', 'alpha']);
      assert.deepEqual(done.messages.map(m => m.text), ['NATURAL_USER_QUESTION', 'NATURAL_B_QUESTION', 'NATURAL_A_WAITING', 'NATURAL_B_VERIFIED_42', 'NATURAL_A_CONTINUED_WITH_B']);
      assert.equal(done.messages.filter(m => m.authorKind === 'user').length, 1);
      const root = ctx.agents.get(group.rootSessionId); assert.ok(root);
      assert.equal(adapter.calls.some(c => c.sessionId === root.id), false);
      await mark('native-file-upload'); adapter.attachment = true;
      const upload = await ctx.fileUploads.upload(root, { data: Buffer.from('native attachment fixture').toString('base64'), name: 'native-group-input.txt' }, controller.signal);
      const inputTurn = await groups.send(key, { operationId: 'native-file', text: '', fileReceiptIds: [upload.receiptId], memberIds: [members[0].id], expectedMembershipRevision: 1 });
      const fileDone = await wait(async () => { const v = await view(); return v.turns.find(t => t.id === inputTurn.id && !['accepted', 'running'].includes(t.state)) && v; });
      assert.equal(fileDone.turns.find(t => t.id === inputTurn.id).state, 'completed');
      const inputMessage = fileDone.messages.find(m => m.id === inputTurn.inputMessageId);
      assert.equal(inputMessage.attachments[0].attachment.attachmentId, upload.file.attachmentId);
      assert.equal(ctx.fileUploads.resolve(root, upload.receiptId), undefined);
      await save('file-view', fileDone);
      await save('adapter', { calls: adapter.calls.map(({input, ...call}) => call), distinctChildren: adapter.sessions.size, rootModelRequests: 0, realModelRequests: 0, privateCanaryAbsent: true });
      await save('result', { status: 'PASS', phase, trueNativeActivations: true, trueToolExecution: true, memoryKernelEnabled: true, privateMemorySeeded: true, trueAttachmentStore: true, realModelRequests: 0 });
      console.log('NATURAL_GROUP_DONE');
    })().catch(async error => { await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, realModelRequests: 0 }); console.log('NATURAL_GROUP_FAILED'); });
    return async () => { clearTimeout(timer); controller.abort(); await run; for (const release of releases.reverse()) release(); };
  });
}
