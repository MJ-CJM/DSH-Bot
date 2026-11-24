import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { Peer } from '@deepseek-ai/dsh-client-connection';

export const name = 'group-guest-offline-profile';
export const inject = ['loader', 'llm', 'agents', 'dshBots', 'dshBotGroups', 'typertGateway'];

const oldHistory = 'UNRELATED_OLDER_GROUP_NOTE';
const privateFact = 'SYNTHETIC_PRIVATE_NOTE';
const question = '你问下 Jarvis 最近有和这个相关的吗？';
const answer = '这份答复来自受邀的 Jarvis。';
const relayTopic = '迁移验收的合成测试主题';
const relayAnswer = 'B_REPLY_FOR_A_ONLY';
const relayReport = '我向 Jarvis 核对过，迁移验收可以进行。';
const guestTools = new Set(['bot_memory_search', 'bot_memory_list']);
const memberTools = new Set([...guestTools, 'bot_memory_save', 'bot_memory_forget', 'bot_follow_up', 'group_message']);

export function apply(ctx, config) {
  return ctx.effect(() => {
    const output = file => join(config.outputDir, file);
    const lifetime = new AbortController();
    const calls = [];
    const privateSessions = new Set();
    let release;
    let peer;
    const waitFor = async (fn, label) => {
      for (let i = 0; i < 1600; i++) {
        const result = await fn();
        if (result) return result;
        await delay(50, undefined, { signal: lifetime.signal });
      }
      throw Error('Timed out waiting for ' + label);
    };
    class OfflineModel extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Local collaboration fixture' }]; }
      async *stream(options) {
        const agent = ctx.agents.get(options.sessionId);
        assert.ok(agent?.session.header.parentSession, 'The group must use a fresh child');
        const guest = agent.session.header.agentPreset?.endsWith('fixture-jarvis');
        const messages = JSON.stringify(options.messages);
        const relayGuest = guest && messages.includes(relayTopic);
        const relayMember = !guest && messages.includes(relayAnswer);
        const privateMember = !guest && messages.includes('PRIVATE_ANSWER_PENDING');
        const tools = (options.tools ?? []).map(tool => tool.name);
        calls.push({ guest, relayGuest, relayMember, sessionId: options.sessionId, tools });
        const allowedTools = guest ? guestTools : memberTools;
        assert.ok(tools.every(tool => allowedTools.has(tool)), 'unexpected ambient tool: ' + tools.join(', '));
        if (guest && messages.includes('测试无法回答')) throw Error('Offline model could not answer this question');
        const privateRequest = guest && messages.includes('核对你的测试记忆');
        if ((privateRequest || relayGuest) && !privateSessions.has(options.sessionId)) {
          privateSessions.add(options.sessionId);
          assert.ok(tools.includes('bot_memory_list'));
          const id = ToolCallId('guest-own-memory'), name = 'bot_memory_list', args = privateRequest ? '{"includePrivate":true}' : '{}';
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (privateRequest) {
          assert.ok(messages.includes('JARVIS_OWN_SYNTHETIC_MEMORY'), 'Guest may read its own memory');
          assert.ok(!messages.includes(privateFact));
        } else if (relayGuest) {
          assert.ok(!messages.includes('JARVIS_OWN_SYNTHETIC_MEMORY'), 'Default read exposed private memory');
          assert.ok(messages.includes('最近有和这个相关的吗'));
          assert.ok(!messages.includes(oldHistory) && !messages.includes(privateFact) && !messages.includes('已看到本群的测试说明'));
          await waitFor(() => existsSync(output('release-relay')), 'browser verifies external receipt');
        } else if (relayMember) {
          assert.ok(agent.session.header.agentPreset.endsWith('member-deep'));
          assert.ok(!messages.includes('JARVIS_OWN_SYNTHETIC_MEMORY'));
          await waitFor(() => existsSync(output('release-member')), 'browser verifies returned external answer');
        } else if (guest) {
          assert.ok(messages.includes('最近有和这个相关的吗'), 'Guest received the precise question');
          assert.ok(!messages.includes(oldHistory), 'Group history leaked to the guest');
          assert.ok(!messages.includes(privateFact), 'Unexpected private memory injection');
          await waitFor(() => existsSync(output('release-answer')), 'browser receipt check');
        }
        const text = privateMember ? 'MEMBER_PRIVATE_REPORT' : relayGuest ? relayAnswer : relayMember ? relayReport : privateRequest ? 'PRIVATE_ANSWER_PENDING' : guest ? answer : '已看到本群的测试说明。';
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
      release = ctx.llm.registerAdapter(['guest-offline'], new OfflineModel());
      const groups = ctx.dshBotGroups;
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const send = (group, input) => ctx.typertGateway.invoke({ namespace: 'dshBot.groups', method: 'send', args: { group, input }, peer, signal: lifetime.signal });
      const cold = existsSync(output('fixture.json'));
      let fixture;
      if (cold) {
        fixture = JSON.parse(await readFile(output('fixture.json'), 'utf8'));
      } else {
        const bots = [];
        for (const [id, name] of [['member-deep', 'deep'], ['member-other', '研究员'], ['fixture-jarvis', 'Jarvis']]) {
          const bot = await ctx.dshBots.create({ id, name, template: 'minimal',
            memory: { enabled: true, injectLimit: 0 }, model: { provider: 'guest-offline', model: 'fixture' } });
          bots.push({ botId: id, botCreatedAt: bot.createdAt });
        }
        await ctx.dshBots.memoryFor(bots[0].botId).save({ content: privateFact });
        await ctx.dshBots.memoryFor(bots[2].botId).save({ content: 'JARVIS_OWN_SYNTHETIC_MEMORY' });
        const group = await groups.create({ operationId: crypto.randomUUID(), name: '群外提问验收',
          mode: 'natural', members: bots.slice(0, 2), historyConfirmed: true, onDemand: false });
        fixture = { key: { groupId: group.id, groupCreatedAt: group.createdAt }, root: group.rootSessionId,
          members: bots.slice(0, 2), jarvis: bots[2], jarvisMain: (await ctx.dshBots.openConversationExact(bots[2])).sessionId, revision: group.membershipRevision };
        const seed = await send(fixture.key, { text: oldHistory, operationId: crypto.randomUUID(), expectedMembershipRevision: group.membershipRevision });
        await waitFor(async () => (await groups.view(fixture.key)).deliveries.filter(d => d.turnId === seed.id && d.state === 'completed').length === 2, 'ordinary member replies');
        await writeFile(output('fixture.json'), JSON.stringify(fixture));
      }
      const evidence = async () => {
        const view = await groups.view(fixture.key);
        const turn = view.turns.find(t => t.guestQuestion && !t.guestQuestion.via && view.deliveries.some(d => d.turnId === t.id && d.outputMessageId));
        const deliveries = view.deliveries.filter(d => d.turnId === turn?.id);
        const d = deliveries[0];
        if (!d?.outputMessageId) return;
        assert.equal(deliveries.length, 1);
        assert.deepEqual(d.bot, fixture.jarvis);
        assert.deepEqual(turn.guestQuestion.bot, fixture.jarvis);
        assert.ok(d.acceptedAt > 0, 'Missing native acceptance evidence');
        for (const field of ['childSessionId', 'childMessageId', 'nativeRunId', 'inputFlowId', 'failure']) assert.equal(d[field], undefined);
        const message = view.messages.find(m => m.id === d.outputMessageId);
        assert.deepEqual(message?.speaker?.bot, fixture.jarvis);
        assert.equal(message.text, answer);
        assert.equal(message.guestReply, true);
        assert.equal(message.childSessionId, undefined);
        assert.equal(view.messages.filter(m => m.text === answer).length, 1);
        assert.deepEqual(view.members.filter(m => !m.removedAt).map(m => m.bot), fixture.members);
        assert.equal(view.group.membershipRevision, fixture.revision);
        assert.ok(!JSON.stringify(view.messages).includes(privateFact));
        return { turnId: turn.id, outputId: d.outputMessageId, operationId: turn.operationId };
      };
      const relayEvidence = async () => {
        const view = await groups.view(fixture.key);
        const turn = view.turns.find(t => t.guestQuestion?.via && view.messages.some(m => m.turnId === t.id && m.text === relayReport));
        if (!turn) return;
        const rows = view.deliveries.filter(d => d.turnId === turn.id);
        const guest = rows.find(d => d.ordinal === 0);
        const member = rows.find(d => d.ordinal === 1);
        if (!member?.outputMessageId) return;
        assert.equal(rows.length, 2);
        assert.deepEqual(turn.guestQuestion.via.bot, fixture.members[0]);
        assert.deepEqual(guest.bot, fixture.jarvis);
        assert.ok(guest.answeredAt && guest.acceptedAt);
        assert.equal(guest.outputMessageId, undefined);
        assert.deepEqual(member.bot, fixture.members[0]);
        const answers = view.messages.filter(m => m.turnId === turn.id && m.speaker);
        assert.equal(answers.length, 1);
        assert.equal(answers[0].relayReply, true);
        assert.deepEqual(answers[0].speaker.bot, fixture.members[0]);
        assert.equal(answers[0].text, relayReport);
        assert.equal(answers[0].id, member.outputMessageId);
        assert.ok(!JSON.stringify(view).includes(relayAnswer));
        assert.deepEqual(view.members.filter(m => !m.removedAt).map(m => m.bot), fixture.members);
        return { turnId: turn.id, outputId: member.outputMessageId };
      };
      if (cold) {
        assert.deepEqual(await relayEvidence(), JSON.parse(await readFile(output('relay-evidence.json'), 'utf8')));
        assert.deepEqual(await evidence(), JSON.parse(await readFile(output('native-evidence.json'), 'utf8')));
        assert.deepEqual(calls, []);
        await writeFile(output('restart.json'), JSON.stringify({ replayedCalls: calls.length }));
        console.log('B4_WEB_READY');
        return;
      }
      console.log('B4_WEB_READY');
      await waitFor(() => existsSync(output('blocked-mention')), 'browser submits outsider mention');
      const beforeMember = await groups.view(fixture.key);
      assert.equal(beforeMember.turns.length, 1, 'Only the original seed turn is allowed');
      assert.equal(calls.length, 2);
      await assert.rejects(send(fixture.key, { text: '@Jarvis 请检查本群的测试说明', operationId: crypto.randomUUID(),
        expectedGuest: fixture.jarvis, expectedMembershipRevision: fixture.revision }));
      assert.equal((await groups.view(fixture.key)).turns.length, beforeMember.turns.length);
      assert.equal(calls.length, 2);
      await writeFile(output('blocked-mention.json'), JSON.stringify({ additionalTurns: 0, additionalCalls: 0, staleGuestRequestRejected: true }));
      const memberReply = await waitFor(async () => {
        const view = await groups.view(fixture.key);
        const mention = view.messages.find(message => message.text === '@deep 请单独回应成员提及测试。');
        if (!mention) return;
        const rows = view.deliveries.filter(row => row.turnId === mention.turnId);
        if (!rows.some(row => row.outputMessageId)) return;
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].bot, fixture.members[0]);
        const turn = view.turns.find(turn => turn.id === mention.turnId);
        assert.ok(turn && !turn.guestQuestion);
        assert.equal(calls.filter(call => call.guest).length, 0);
        return { turnId: turn.id, member: rows[0].bot };
      }, 'one reply from explicitly mentioned group member');
      await writeFile(output('member-mention.json'), JSON.stringify(memberReply));
      const receipt = await waitFor(evidence, 'attributed native reply');
      const duplicate = await send(fixture.key, { text: question, operationId: receipt.operationId,
        expectedMembershipRevision: fixture.revision, expectedGuest: fixture.jarvis, relayTopic: '公开主题：工程验收' });
      assert.equal(duplicate.id, receipt.turnId);
      await delay(150);
      assert.equal(calls.filter(call => call.guest).length, 1);
      assert.equal(calls.filter(call => !call.guest).length, 3);
      assert.deepEqual(await evidence(), receipt);
      await writeFile(output('native-evidence.json'), JSON.stringify(receipt));
      const privateTurn = await send(fixture.key, { text: '问 Jarvis 核对你的测试记忆', operationId: crypto.randomUUID(),
        expectedGuest: fixture.jarvis, expectedMembershipRevision: fixture.revision });
      const pending = await waitFor(async () => {
        const view = await groups.view(fixture.key);
        assert.ok(!view.messages.some(m => m.text === 'PRIVATE_ANSWER_PENDING'));
        return view.deliveries.find(d => d.turnId === privateTurn.id && d.reasonCode === 'export-approval-required');
      }, 'hold private guest response');
      assert.ok(pending.acceptedAt && !pending.outputMessageId);
      const invoke = (method, args) => ctx.typertGateway.invoke({ namespace: 'dshBot.groups', method, args, peer, signal: lifetime.signal });
      const target = { group: fixture.key, deliveryId: pending.id };
      const preview = await invoke('reviewExport', target);
      assert.ok(JSON.stringify(preview).includes('PRIVATE_ANSWER_PENDING'));
      await assert.rejects(invoke('decideExport', { ...target, token: preview.token, allow: 'always' }));
      await invoke('decideExport', { ...target, token: preview.token, allow: false });
      const after = await groups.view(fixture.key);
      assert.equal(after.deliveries.find(d => d.id === pending.id).reasonCode, 'export-rejected');
      assert.ok(!JSON.stringify(after).includes('PRIVATE_ANSWER_PENDING'));
      assert.ok(!JSON.stringify(after).includes('JARVIS_OWN_SYNTHETIC_MEMORY'));
      const failed = await send(fixture.key, { text: '问 Jarvis 测试无法回答', operationId: crypto.randomUUID(),
        expectedGuest: fixture.jarvis, expectedMembershipRevision: fixture.revision });
      const notAnswered = await waitFor(async () => {
        const view = await groups.view(fixture.key);
        return view.deliveries.find(d => d.turnId === failed.id && ['unknown', 'failed'].includes(d.state));
      }, 'failed guest execution');
      assert.ok(!notAnswered.outputMessageId);
      const called = calls.length;
      await assert.rejects(send(fixture.key, { text: '@MissingBot 你有空吗', operationId: crypto.randomUUID(), expectedMembershipRevision: fixture.revision }));
      assert.equal(calls.length, called);
      await writeFile(output('privacy.json'), JSON.stringify({ protectedReply: 'reviewed-and-rejected', delivered: false }));
      const result = await waitFor(relayEvidence, 'member published independent answer');
      assert.equal(calls.filter(c => c.relayGuest).length, 2);
      assert.equal(calls.filter(c => c.relayMember).length, 1);
      await writeFile(output('relay-evidence.json'), JSON.stringify(result));
      await waitFor(() => existsSync(output('start-private-relay')), 'browser captured ordinary receipts');
      const privateRelay = await send(fixture.key, { text: '让 deep 问 Jarvis 核对你的测试记忆', operationId: crypto.randomUUID(),
        expectedGuest: fixture.jarvis, expectedRelay: fixture.members[0], expectedMembershipRevision: fixture.revision });
      const review = async ordinal => {
        const delivery = await waitFor(async () => (await groups.view(fixture.key)).deliveries.find(row =>
          row.turnId === privateRelay.id && row.ordinal === ordinal && row.reasonCode === 'export-approval-required'), 'private handoff ' + ordinal);
        const target = { group: fixture.key, deliveryId: delivery.id };
        return { target, preview: await invoke('reviewExport', target) };
      };
      const privateB = await review(0);
      assert.deepEqual(privateB.preview.recipients.map(row => row.bot), [fixture.members[0]]);
      assert.equal(privateB.preview.content, 'PRIVATE_ANSWER_PENDING');
      assert.ok(!(await groups.view(fixture.key)).deliveries.some(d => d.turnId === privateRelay.id && d.ordinal === 1 && d.acceptedAt));
      await invoke('decideExport', { ...privateB.target, token: privateB.preview.token, allow: true });
      const privateA = await review(1);
      assert.deepEqual(privateA.preview.recipients.map(row => row.bot), fixture.members);
      assert.equal(privateA.preview.content, 'MEMBER_PRIVATE_REPORT');
      await invoke('decideExport', { ...privateA.target, token: privateA.preview.token, allow: false });
      const protectedView = await groups.view(fixture.key);
      assert.ok(!protectedView.messages.some(m => m.turnId === privateRelay.id && m.speaker));
      assert.ok(!JSON.stringify(protectedView).includes('MEMBER_PRIVATE_REPORT'));
      const protectedDetails = await invoke('getRelayDetails', { request: { kind: 'group', group: fixture.key, turnId: privateRelay.id } });
      assert.equal(protectedDetails.question?.state, 'readable');
      assert.notEqual(protectedDetails.answer?.state, 'readable');
      assert.notEqual(protectedDetails.report?.state, 'readable');
      assert.ok(!JSON.stringify(protectedDetails).includes('PRIVATE_ANSWER_PENDING'));
      assert.ok(!JSON.stringify(protectedDetails).includes('MEMBER_PRIVATE_REPORT'));
      await writeFile(output('private-relay.json'), JSON.stringify({ toMember: 'approved', toGroup: 'rejected', published: false }));

    })().catch(async error => {
      if (lifetime.signal.aborted) return;
      await writeFile(output('fixture-error.txt'), String(error.stack));
      console.log('B4_WEB_FAILED');
    });
    return async () => { lifetime.abort(); await run; peer?.dispose(); release?.(); };
  });
}
