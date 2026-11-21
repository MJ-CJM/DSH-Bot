// Real native DSH tool routing with only local synthetic Bot identities and model calls.
import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';

export const inject = ['loader', 'agents', 'llm', 'dshBots', 'sessionController', 'sessionPersistence', 'sessions'];
const owner = 'peer-craft', peer = 'peer-jarvis', other = 'peer-alex';
const privateAnswer = 'PRIVATE_RESEARCH_RESULT_Z9';
const privateHistory = 'PRIVATE_DM_C4D5', privateMemory = 'PRIVATE_MEMORY_E6F7';
const turns = [
  ['ask', '请问 Jarvis：项目有哪些公开接口？'],
  ['follow1', '请问 Jarvis：其中哪个支持只读查询？'],
  ['follow2', '请问 Jarvis：该查询支持分页吗？'],
  ['lookup', '他查到的结果是什么？'],
  ['deny', '把我的上次私聊结论分享给对方'],
  ['approve', '请再次分享那条私有结论'],
  ['memory', '向对方分享上一次保存的那一条记忆'],
];
const text = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
function *say(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: value };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
function *tool(args) {
  const id = ToolCallId(randomUUID()), json = JSON.stringify(args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name: 'bot_message', argumentsDelta: json };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bot_message', arguments: json } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

export function apply(ctx, config) {
  return ctx.effect(() => {
    const cleanup = [], approvals = [], calls = [], evidence = [], agents = {};
    let phase = 'warmup', lastRequest;
    const rows = () => ctx.get('dshBotMessaging').store.rows();
    const events = agent => agent.session.snapshotEvents();
    const privateTransfer = () => ['deny', 'approve', 'memory'].includes(phase);
    const exportBody = () => phase === 'memory' ? privateMemory + owner : privateHistory;
    const modelArgs = () => {
      if (phase === 'stock' || phase === 'capabilities') return { action: 'query', to: other, topic: phase === 'stock' ? 'previous-result' : 'capabilities' };
      if (phase === 'lookup') return { action: 'result', to: peer, requestId: lastRequest };
      if (privateTransfer()) return { action: 'send', to: peer, mode: 'notify', priority: 'normal', sharePrivate: true, content: exportBody() };
      return { action: 'send', to: peer, mode: 'ask', priority: 'normal', content: 'A forged draft with ' + privateHistory,
        ...(phase.startsWith('follow') ? { inReplyToContext: lastRequest } : {}) };
    };
    class Adapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Local peer smoke' }]; }
      async resolveModel(provider, id) { return { provider, id, name: 'Local peer smoke' }; }
      async *stream(options) {
        const agent = ctx.agents.get(options.sessionId); assert.ok(agent);
        const child = Boolean(agent.session.header.parentSession);
        const ordered = events(agent), input = ordered.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user');
        const done = ordered.some(event => event.seq > (input?.seq ?? -1) && event.type === 'tool/result');
        const data = JSON.stringify(options.messages);
        let packet;
        try { packet = JSON.parse(text(input?.data)); } catch {}
        calls.push({ phase, child, id: agent.id, kind: packet?.kind, privateHistorySeen: data.includes(privateHistory), privateMemorySeen: data.includes(privateMemory) });
        if (child) {
          assert.ok(!data.includes(privateHistory) && !data.includes(privateMemory), 'clean peer context excludes private history and memory');
          if (packet?.kind === 'dsh-bot-message-draft') {
            assert.match(packet.userTask, /公开接口|只读查询|支持分页/);
            if (phase.startsWith('follow')) {
              const prior = phase === 'follow1' ? 'ask' : 'follow1';
              assert.ok(packet.userTask.includes('SHARED_RESULT_' + prior), 'follow-up includes the previous shared answer');
              assert.match(packet.userTask, phase === 'follow1' ? /公开接口/ : /只读查询/, 'follow-up includes the linked shared question');
            }
            yield* say(phase === 'ask' ? '项目有哪些公开接口？' : phase === 'follow1' ? '其中哪个支持只读查询？' : '该查询支持分页吗？'); return;
          }
          assert.equal(packet?.kind, 'dsh-bot-message-request');
          assert.match(packet.question, /公开接口|只读查询|支持分页/);
          yield* say('SHARED_RESULT_' + phase); return;
        }
        if (phase === 'stock' && agent === agents[other]) {
          const incoming = ordered.findLast(row => row.type === 'user/message' && row.data.source.kind === 'dsh-bot-message' && row.data.source.mode === 'ask');
          const replied = incoming && ordered.some(row => row.seq > incoming.seq && row.type === 'tool/result');
          if (incoming && !replied) { yield* tool({ action: 'reply', replyTo: incoming.data.source.messageId, content: privateAnswer }); return; }
        }
        if (phase === 'warmup' || done || agent !== agents[owner]) { yield* say('The synthetic turn is complete.'); return; }
        yield* tool(modelArgs());
      }
    }
    const save = (file, data) => writeFile(join(config.outputDir, file + '.json'), JSON.stringify(data, null, 2));
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      assert.deepEqual(ctx.llm.listProviders(), []);
      cleanup.push(ctx.llm.registerAdapter(['dp-loopback'], new Adapter()));
      const prior = await readFile(join(config.outputDir, 'verified.json'), 'utf8').then(JSON.parse).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (prior) {
        for (const { sessionId, eventCount } of prior.persistedSessions) {
          const reader = await ctx.sessionPersistence.open(sessionId, 'read');
          try { assert.ok((await reader.read()).events.length >= eventCount); }
          finally { await reader.close(); }
        }
        const saved = rows();
        assert.equal(saved.length, 10);
        assert.ok(saved.every(record => record.delivery === 'delivered' && record.nativeRef && record.outgoingRef));
        assert.equal(calls.length, 0);
        await save('verified-cold', { status: 'PASS', readableSessions: prior.persistedSessions.length,
          delivered: saved.length, modelRequests: 0 });
        console.log('B4_WEB_READY'); return;
      }
      cleanup.push(ctx.on('approval/request', request => {
        const info = [request.reason ?? '', request.displayReason?.en ?? '', request.displayReason?.zh ?? ''].join('\n');
        const previewExact = info.includes(exportBody()) && !info.includes(phase === 'memory' ? privateHistory : privateMemory) && !info.includes('nativeInput') && info.includes('Jarvis');
        const stockReview = phase === 'stock' && request.agent.id === agents[other]?.id && info.includes(privateAnswer) && info.includes('craft') && !info.includes('nativeInput');
        const approve = request.toolName === 'dsh_bot_export_message' && (stockReview || ['approve', 'memory'].includes(phase) && previewExact);
        approvals.push({ phase, tool: request.toolName, previewExact: stockReview || previewExact, approved: approve });
        return approve ? 'allowed-once' : 'rejected';
      }, { prepend: true }));
      for (const [id, name] of [[owner, 'craft'], [peer, 'Jarvis'], [other, 'Alex']]) {
        await ctx.dshBots.create({ id, name, template: 'standard', model: { provider: 'dp-loopback', model: 'fixture' }, memory: { enabled: true, injectLimit: 4 } });
        await ctx.dshBots.memoryFor(id).save({ content: privateMemory + id, kind: 'fact', pinned: true });
        const { sessionId } = await ctx.dshBots.openConversation(id);
        const resolved = await ctx.sessionController.resolveAgent(sessionId);
        if ('error' in resolved) throw resolved.error;
        agents[id] = resolved.agent;
      }
      const sender = agents[owner];
      const prompt = async (agent, value) => {
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] }));
        await agent.whenIdle();
      };
      await prompt(sender, 'My own old DM contains ' + privateHistory);
      assert.ok(calls.some(row => !row.child && row.privateMemorySeen && row.privateHistorySeen));
      assert.equal(ctx.dshBots.config.supergroup.enabled, config.suite === 'peer-supergroup');
      for (const [id, value] of turns) {
        phase = id;
        const beforeCalls = calls.length, beforeApprovals = approvals.length, beforeRows = rows().length;
        const seq = events(sender).at(-1)?.seq ?? -1;
        await prompt(sender, value);
        const toolResult = events(sender).filter(row => row.seq > seq && row.type === 'tool/result').map(row => text(row.data.message)).join('\n');
        const prompts = approvals.slice(beforeApprovals), callee = calls.slice(beforeCalls).filter(row => row.child || row.id === agents[peer].id);
        if (privateTransfer()) {
          assert.deepEqual(prompts.map(row => row.tool), ['dsh_bot_export_message'], 'exactly one private share request');
          assert.ok(prompts[0].previewExact);
          const sent = rows().filter(row => row.envelope.content === exportBody() && row.envelope.to.botId === peer);
          assert.equal(sent.length, phase === 'deny' ? 0 : 1, 'only the exactly approved private text was accepted');
          const visible = (agent, kind) => events(agent).filter(row => row.type === 'user/message' &&
            row.data.source.kind === kind && row.data.source.messageId === sent[0]?.envelope.id && text(row.data).includes(exportBody()));
          if (sent.length) {
            const expires = Date.now() + 10000;
            for (;;) {
              const record = ctx.get('dshBotMessaging').store.get(sent[0].envelope.id);
              if (record?.delivery === 'delivered' && record.nativeRef && record.outgoingRef &&
                visible(agents[peer], 'dsh-bot-message').length === 1 && visible(sender, 'dsh-bot-message-sent').length === 1) break;
              assert.ok(Date.now() < expires, 'both approved sender and recipient copies must be visible and durable, status=' + record?.delivery + '/' + record?.lastErrorCode);
              await delay(20);
            }
          } else assert.ok(!events(agents[peer]).some(row => row.type === 'user/message' && row.data.source.kind === 'dsh-bot-message' && text(row.data).includes(exportBody())));
        } else {
          assert.equal(prompts.length, 0, 'ordinary send, reply, follow-up and lookup need zero approvals');
          if (id === 'lookup') {
            const answers = events(sender).filter(row => row.seq > seq && row.type === 'assistant/message').map(row => text(row.data.message ?? row.data));
            assert.ok(answers.some(answer => answer.includes('SHARED_RESULT_follow2')), 'result appears in the native conversation');
            assert.equal(calls.length, beforeCalls, 'previous result needs no owner or peer model calls');
            assert.equal(callee.length, 0, 'reading a completed answer makes zero new draft or peer model calls');
            assert.equal(rows().length, beforeRows);
          } else {
            assert.ok(toolResult.includes('SHARED_RESULT_' + id), 'caller receives the concrete result');
            const requests = rows().filter(row => row.envelope.to.botId === peer && row.envelope.mode === 'ask');
            const latest = requests.find(row => rows().some(answer => answer.envelope.replyTo === row.envelope.id && answer.envelope.content === 'SHARED_RESULT_' + id));
            assert.ok(latest, 'durable request linked to exactly this answer'); lastRequest = latest.envelope.id;
            assert.ok(callee.some(row => row.kind === 'dsh-bot-message-request'));
          }
          assert.ok(rows().every(row => !row.envelope.content.includes(privateMemory) && !row.envelope.content.includes(privateHistory)));
        }
        evidence.push({ id, approvals: prompts, modelRequests: calls.length - beforeCalls, peerModelRequests: callee.length, addedRows: rows().length - beforeRows });
      }
      phase = 'warmup';
      await prompt(agents[other], 'My private research result is ' + privateAnswer);
      phase = 'capabilities';
      let initial = rows().length, approvedBefore = approvals.length, callIndex = calls.length;
      await prompt(sender, '这里还有谁能帮忙？');
      assert.equal(rows().length, initial); assert.equal(approvals.length, approvedBefore);
      assert.ok(!calls.slice(callIndex).some(row => row.id === agents[other].id || row.child));
      assert.ok(events(sender).filter(row => row.type === 'tool/result').some(row => text(row.data.message).includes('Alex')));
      evidence.push({ id: phase, sent: 0, peerModelRequests: 0, approvals: [] });
      phase = 'stock';
      initial = rows().length; approvedBefore = approvals.length;
      await prompt(sender, '他是不是已经查完了？' + privateHistory);
      const deadline = Date.now() + 10000;
      let question, answer;
      for (;;) {
        question = rows().find(row => row.envelope.to.botId === other && row.envelope.queryTopic === 'previous-result');
        answer = question && rows().find(row => row.envelope.replyTo === question.envelope.id);
        if (answer?.delivery === 'delivered' && answer.nativeRef && answer.outgoingRef) break;
        assert.ok(Date.now() < deadline, 'the stock question and private reply both finish');
        await delay(25);
      }
      assert.equal(rows().length, initial + 2);
      assert.ok(question.envelope.content.includes('most recent relevant task'));
      assert.ok(!question.envelope.content.includes(privateHistory));
      assert.equal(answer.envelope.content, privateAnswer);
      const stockAsks = approvals.slice(approvedBefore);
      assert.deepEqual(stockAsks.map(row => [row.tool, row.approved, row.previewExact]), [['dsh_bot_export_message', true, true]]);
      evidence.push({ id: phase, sent: 2, privateReplyReviews: 1, senderReviews: 0 });
      const persistedSessions = [];
      for (const agent of Object.values(agents)) {
        await agent.whenIdle();
        assert.equal(await ctx.sessions.flush(agent.session), true);
        const reader = await ctx.sessionPersistence.open(agent.id, 'read');
        try {
          const { events: persisted } = await reader.read();
          assert.ok(persisted.some(row => row.type === 'user/message'));
          assert.ok(persisted.some(row => row.type === 'system/message'), 'the first native model turn left a valid system surface');
          persistedSessions.push({ sessionId: agent.id, eventCount: persisted.length });
        } finally { await reader.close(); }
      }
      await save('verified', { status: 'PASS', persistedSessions, supergroup: ctx.dshBots.config.supergroup.enabled, groups: (await ctx.get('dshBotGroups').list()).length, cases: evidence, realModelRequests: 0 });
      console.log('B4_WEB_READY');
    })().catch(async error => {
      const traces = Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, events(agent).filter(row => ['tool/result','turn/end','system/error','approval/asked','approval/decided'].includes(row.type)).slice(-10)]));
      await save('fixture-error', { phase, error: String(error.stack), calls, approvals, evidence, traces });
      console.error('B4_WEB_FAILED', phase, error.message);
    });
    return async () => { for (const off of cleanup.reverse()) off(); await run; };
  }, 'dsh-bot: isolated peer communication verification');
}
