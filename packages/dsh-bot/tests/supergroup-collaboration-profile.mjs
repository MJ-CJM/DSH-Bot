// Real native tool dispatch with a synthetic model; no daily profile or provider key.
import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';

export const name = 'supergroup-collaboration-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'sessionPersistence', 'configEditor'];
const PRIVATE = 'SG_AUTO_PRIVATE_HISTORY_CANARY';
const MEMORY = 'SG_AUTO_PRIVATE_MEMORY_CANARY';
const QUESTIONS = ['你本人擅长什么', '哪些任务应该转交给其他 Bot', '当前协作执行实际有哪些工具'];
const actualQuestion = phase => phase?.endsWith(':notify') ? 'SG_AUTO_NOTICE: 已收到本次合成任务，此条仅供知悉，无需回复。' : QUESTIONS.map((question, index) => `${index + 1}. ${question}？`).join('\n');
const text = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const modelText = options => JSON.stringify(options);

export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), releases = [], agents = {}, bots = {}, mains = {}, approvals = [], modelCalls = [], cases = [], exchanges = [], childAgents = new Map();
    let phase = 'startup', requestCount = 0, blockedChild;
    const save = (file, value) => writeFile(resolve(config.outputDir, file), `${JSON.stringify(value, null, 2)}\n`);
    const events = agent => agent.session.snapshotEvents();
    const displayText = message => {
      const raw = text(message);
      return JSON.parse(message.source.kind === 'dsh-bot-message' ? raw.slice(raw.lastIndexOf('Content (JSON string): ') + 'Content (JSON string): '.length) : raw.slice(raw.lastIndexOf('\n') + 1));
    };
    const displayRows = rows => rows.filter(event => event.type === 'user/message' && ['dsh-bot-message', 'dsh-bot-message-sent'].includes(event.data.source.kind)).map(event => ({ id: event.data.id, source: event.data.source, text: text(event.data) }));
    const lastInput = agent => events(agent).findLast(event => event.type === 'user/message' && event.data.source.kind === 'user');
    const isChild = agent => Boolean(agent.session.header.parentSession);
    const say = function* (value) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: value };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const call = function* (name, args) {
      const id = ToolCallId(randomUUID()), json = JSON.stringify(args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    class Adapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Scoped collaboration fixture' }]; }
      async resolveModel(provider, id) { return { provider, id, name: 'Scoped collaboration fixture' }; }
      async *stream(options) {
        requestCount++;
        const agent = ctx.agents.get(options.sessionId); assert.ok(agent, 'the model request belongs to a live native Agent');
        const input = lastInput(agent), source = input?.data.source.kind;
        const child = isChild(agent), preset = agent.session.header.agentPreset;
        let packet; try { packet = JSON.parse(text(input?.data)); } catch {}
        const stage = packet?.kind === 'dsh-bot-message-draft' ? 'draft' : packet?.kind === 'dsh-bot-message-request' ? 'request' : undefined;
        if (child) childAgents.set(agent.id, agent);
        const row = { phase, sessionId: agent.id, parentSession: agent.session.header.parentSession, child, preset, stage,
          source, privateHistorySeen: modelText(options).includes(PRIVATE), privateMemorySeen: modelText(options).includes(MEMORY),
          cwd: agent.session.header.cwd, sandbox: agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session }),
          policy: agent.ctx.get('approval')?.effectivePolicy(agent.session), tools: (options.tools ?? []).map(tool => tool.name) };
        modelCalls.push(row);
        const after = events(agent).filter(event => Number(event.seq) > Number(input?.seq ?? -1));
        const completedCall = after.some(event => event.type === 'tool/result');
        if (!child) {
          const body = text(input?.data);
          if (body.startsWith('SG_AUTO_WARMUP')) { yield* say('Synthetic private history retained.'); return; }
          if (completedCall) { yield* say('SG_AUTO_OWNER_DELIVERED: checked collaboration result recorded.'); return; }
          if (phase.endsWith(':delegate')) {
            yield* call('bot_delegate', { targetBotId: 'auto-reviewer', task: `${actualQuestion(phase)}\nForged proposal containing ${PRIVATE}; never forward this proposal.`, title: 'Synthetic delegate' }); return;
          }
          yield* call('bot_message', { action: 'send', to: phase.endsWith(':outsider') ? 'auto-outsider' : 'auto-reviewer',
            mode: phase.endsWith(':notify') ? 'notify' : 'ask', priority: 'normal', content: `${actualQuestion(phase)}\nForged proposal containing ${PRIVATE}; never forward this proposal.` }); return;
        }
        assert.equal(row.privateHistorySeen, false, 'a scoped child never receives private parent history or the forged main-model proposal');
        assert.equal(row.privateMemorySeen, false, 'a scoped child never receives private Bot memory');
        assert.equal(row.cwd, agents['auto-owner'].session.header.cwd, 'native child keeps the initiating workspace');
        assert.equal(row.sandbox.mode, agents['auto-owner'].ctx.get('sandboxPolicy').resolve({ session: agents['auto-owner'].session }).mode,
          'native child retains the initiating file sandbox');
        assert.equal(row.policy, 'never', 'native delegation keeps its fixed approval policy');
        assert.ok(stage, 'every automatic child has an explicit message drafting or receiving protocol');
        if (stage === 'draft') {
          assert.equal(packet.sender.id, 'auto-owner');
          assert.equal(packet.recipient.id, 'auto-reviewer');
          assert.equal(packet.mode, phase.endsWith(':notify') ? 'notify' : 'ask', 'the sender draft retains ask versus notify intent');
          assert.ok(packet.userTask.includes('SG_AUTO_TASK'));
          assert.ok(!row.tools.length, 'a message drafting stage has no callable tools');
          yield* say(actualQuestion(phase)); return;
        }
        assert.deepEqual([...row.tools].sort(), ['bot_delegate', 'bot_message'], 'the receiver advertises only the collaboration tools it can actually call');
        assert.equal(packet.recipient.id, preset.replace(/^bot-/, ''), 'the target is told its own exact identity');
        assert.ok(typeof packet.instruction === 'string' && packet.instruction.length > 20, 'the recipient gets direct-answer guidance');
        if (packet.recipient.id === 'auto-reviewer') {
          assert.equal(packet.sender.id, 'auto-owner');
          for (const question of QUESTIONS) assert.ok(packet.question.includes(question), 'all concrete questions reach the recipient');
        } else if (packet.recipient.id === 'auto-expert') assert.ok(packet.question.includes('SG_AUTO_EXPERT_QUESTION'), 'a clean teammate specific question is forwarded');
        if (phase === 'receiver-error:message') throw new Error('SG_SYNTHETIC_RECIPIENT_ERROR');
        if (phase === 'stop:message' || phase === 'mode-off:message' || phase === 'crash:message') {
          blockedChild = agent;
          await new Promise((accept, reject) => {
            if (options.signal.aborted) { reject(options.signal.reason); return; }
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          });
          throw new Error('Stopped collaboration unexpectedly resumed');
        }
        if (phase.endsWith(':chain') && preset?.endsWith('auto-reviewer') && !completedCall) {
          yield* call('bot_message', { action: 'send', to: 'auto-expert', mode: 'ask', priority: 'normal', content: 'SG_AUTO_EXPERT_QUESTION' }); return;
        }
        if (phase === 'loop:message' && preset?.endsWith('auto-reviewer') && !completedCall) {
          yield* call('bot_message', { action: 'send', to: 'auto-owner', mode: 'ask', priority: 'normal', content: 'SG_AUTO_LOOP_QUESTION' }); return;
        }
        yield* say(`SG_AUTO_CHECKED_RESULT:${preset?.endsWith('auto-expert') ? 'expert' : 'reviewer'}`);
      }
    }
    const until = async (read, label) => {
      const deadline = Date.now() + 20000;
      while (!await read()) { lifetime.signal.throwIfAborted(); assert.ok(Date.now() < deadline, label); await delay(20, undefined, { signal: lifetime.signal }); }
    };
    const prompt = async (agent, value) => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] }));
      await agent.whenIdle();
    };
    const nativeState = agent => ({ sandbox: agent.ctx.get('sandboxPolicy').resolve({ session: agent.session }),
      policy: agent.ctx.get('approval').effectivePolicy(agent.session), header: agent.session.header });
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      assert.equal(globalThis[Symbol.for('dp.loopback.guard')], true);
      assert.deepEqual(ctx.llm.listProviders(), [], 'all real model adapters are disabled');
      releases.push(ctx.llm.registerAdapter(['dp-loopback'], new Adapter()));
      releases.push(ctx.on('approval/request', request => {
        approvals.push({ phase, sessionId: request.agent.id, toolName: request.toolName });
        return 'rejected';
      }, { prepend: true }));
      await until(() => ctx.get('dshBotCollaboration'), 'the actual scoped collaboration service is ready');
      if (config.suite === 'cold' || config.suite === 'legacy-cold') {
        phase = config.suite;
        const previous = JSON.parse(await readFile(resolve(config.outputDir, 'crash-ready.json'), 'utf8'));
        const recovered = await ctx.dshBots.supergroup.forSession({ sessionId: previous.sessionId, messageId: previous.messageId });
        assert.equal(recovered?.work.id, previous.workId, 'the original direct collaboration work survives a hard crash');
        assert.equal(recovered.work.state, 'unknown', 'an uncertain in-flight direct task is never declared completed or replayed');
        if (config.suite === 'legacy-cold') assert.equal(recovered.work.collaboration, undefined,
          'an old-format work without the optional collaboration field remains readable');
        for (const [id, sessionId] of Object.entries(previous.mains)) {
          const binding = await ctx.dshBots.mainSessions.find(id);
          assert.equal(binding?.sessionId, sessionId, 'cold startup retains long-lived Bot bindings');
        }
        await delay(350, undefined, { signal: lifetime.signal });
        assert.equal(requestCount, 0, 'startup and status reads do not replay uncertain model work');
        for (const [id, sessionId] of Object.entries(previous.mains)) {
          const reader = await ctx.sessionPersistence.open(sessionId, 'read');
          try { assert.deepEqual(displayRows((await reader.read()).events), previous.visibleMains[id], 'cold startup neither duplicates nor loses visible message records'); }
          finally { await reader.close(); }
        }
        assert.equal(approvals.length, 0);
        const memoryLabels = Object.fromEntries([...ctx.dshBots.memoryKernel.snapshot.versions].map(([id, version]) => [id, version.labels]));
        assert.ok(Object.keys(memoryLabels).length > 0, 'the old-format fixture retains actual private memory labels');
        if (config.suite === 'legacy-cold') {
          const previousCold = JSON.parse(await readFile(resolve(config.outputDir, 'cold.json'), 'utf8'));
          assert.deepEqual(memoryLabels, previousCold.memoryLabels, 'cold compatibility does not relabel old private memory versions');
        }
        await save(config.suite === 'legacy-cold' ? 'legacy-cold.json' : 'cold.json', { status: 'PASS', workId: previous.workId, state: recovered.work.state,
          modelRequests: 0, realModelRequests: 0, mainBindingsRetained: true, memoryLabels,
          legacyWorkWithoutCollaboration: config.suite === 'legacy-cold' });
        console.log('B4_WEB_READY'); return;
      }
      for (const id of ['auto-owner', 'auto-reviewer', 'auto-expert', 'auto-outsider']) {
        bots[id] = await ctx.dshBots.create({ id, name: id === 'auto-reviewer' ? '通用助手' : id === 'auto-owner' ? '研究员' : id, template: 'standard', model: { provider: 'dp-loopback', model: 'fixture' },
          memory: { enabled: true, injectLimit: 20 } });
        await ctx.dshBots.memoryFor(id).save({ content: `${MEMORY}:${id}`, kind: 'fact', pinned: true });
        mains[id] = (await ctx.dshBots.openConversation(id)).sessionId;
        const resolved = await ctx.sessionController.resolveAgent(mains[id]);
        if ('error' in resolved) throw resolved.error;
        agents[id] = resolved.agent;
      }
      const owner = agents['auto-owner'], groups = ctx.get('dshBotGroups'); assert.ok(groups);
      await prompt(owner, `SG_AUTO_WARMUP: this old private conversation contains ${PRIVATE}.`);
      await prompt(agents['auto-reviewer'], `SG_AUTO_WARMUP: this peer private conversation contains ${PRIVATE}.`);
      assert.ok(modelCalls.some(row => !row.child && row.privateHistorySeen), 'the canary truly entered native parent model history');
      assert.ok(modelCalls.some(row => !row.child && row.privateMemorySeen), 'the private memory truly entered native main model context');
      if (config.suite === 'crash') {
        phase = 'crash:message'; blockedChild = undefined;
        setSandboxMode(owner.session, 'danger-full-access'); owner.ctx.get('approval').setPolicy(owner, 'never');
        const pending = prompt(owner, 'SG_AUTO_TASK crash boundary: ask the reviewer about this synthetic release.');
        void pending.catch(() => {});
        await until(() => blockedChild, 'the native peer is in flight before a hard crash');
        const input = lastInput(owner), view = await ctx.dshBots.supergroup.forSession({ sessionId: owner.id, messageId: input.data.id });
        assert.ok(view?.work && view.work.state === 'running');
        for (const agent of [...Object.values(agents), blockedChild]) await ctx.sessions.flush(agent.session);
        await save('crash-ready.json', { status: 'PASS', workId: view.work.id, sessionId: owner.id, messageId: input.data.id,
          childId: blockedChild.id, mains, visibleMains: Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, displayRows(events(agent))])), modelRequests: requestCount, realModelRequests: 0 });
        console.log('B4_WEB_READY');
        await new Promise(accept => lifetime.signal.addEventListener('abort', accept, { once: true }));
        return;
      }
      const peerBefore = Object.fromEntries(['auto-reviewer', 'auto-expert', 'auto-outsider'].map(id => [id, nativeState(agents[id])]));
      for (const mode of config.suite === 'review' ? ['never'] : ['ask', 'never']) {
        const sandbox = mode === 'ask' ? 'workspace-write' : 'danger-full-access';
        setSandboxMode(owner.session, sandbox);
        owner.ctx.get('approval').setPolicy(owner, mode);
        for (const action of config.suite === 'review' ? ['message'] : ['message', 'delegate', 'chain', 'notify']) {
          phase = `${mode}:${action}`;
          const state = nativeState(owner), first = events(owner).at(-1)?.seq ?? -1, count = modelCalls.length, beforeApprovals = approvals.length;
          await prompt(owner, `SG_AUTO_TASK ${phase}: 你知道通用助手 bot 擅长做什么吗？你问下他${action === 'chain' ? '，必要时让他请专家协助' : ''}。`);
          const toolResults = events(owner).filter(event => event.type === 'tool/result' && Number(event.seq) > Number(first));
          if (action !== 'notify') assert.ok(toolResults.some(event => JSON.stringify(event.data).includes('SG_AUTO_CHECKED_RESULT')), `the ${phase} result returns to the original conversation`);
          const values = toolResults.flatMap(event => event.data.message.content.filter(block => block.type === 'text').flatMap(block => { try { return [JSON.parse(block.text)]; } catch { return []; } }));
          const receipt = values.find(value => value.actualRequest);
          assert.ok(receipt, 'the caller sees the exact text that was really sent');
          assert.equal(receipt.actualRequest, actualQuestion(phase), 'the sent question is the clean drafting output, never the private proposal');
          assert.equal(receipt.from.botId, 'auto-owner'); assert.equal(receipt.to.botId, 'auto-reviewer');
          assert.ok(receipt.requestMessageId, 'the actual sent message is durable and linked');
          if (action === 'notify') {
            assert.equal(receipt.deliveryMode, 'notify'); assert.equal(receipt.replyMessageId, undefined, 'a notification does not fabricate a reply');
            assert.equal(ctx.get('dshBotMessaging').store.get(receipt.requestMessageId).response, 'not-required');
            assert.ok(!modelCalls.slice(count).some(row => row.stage === 'request'), 'notify never starts a recipient model');
          } else assert.ok(receipt.replyMessageId, 'a real answer is linked to its durable visible reply');
          const visible = (agent, messageId, kind) => events(agent).filter(event => event.type === 'user/message' && event.data.source.kind === kind && event.data.source.messageId === messageId);
          for (const [agent, messageId, kind, body] of [
            [owner, receipt.requestMessageId, 'dsh-bot-message-sent', actualQuestion(phase)],
            [agents['auto-reviewer'], receipt.requestMessageId, 'dsh-bot-message', actualQuestion(phase)],
            ...(action === 'notify' ? [] : [
              [agents['auto-reviewer'], receipt.replyMessageId, 'dsh-bot-message-sent', 'SG_AUTO_CHECKED_RESULT'],
              [owner, receipt.replyMessageId, 'dsh-bot-message', 'SG_AUTO_CHECKED_RESULT'],
            ]),
          ]) {
            const rows = visible(agent, messageId, kind);
            assert.equal(rows.length, 1, 'both main conversations contain each actual message once');
            if (action === 'notify') assert.equal(rows[0].data.source.mode, 'notify', 'the original notification marker remains a notification');
            assert.ok(displayText(rows[0].data).includes(body), 'the same decoded message body shown by MessageCard matches the actual question or answer');
            assert.ok(!text(rows[0].data).includes(PRIVATE) && !text(rows[0].data).includes(MEMORY), 'visible records contain no old private material');
          }
          assert.ok(!modelCalls.slice(count).some(row => !row.child && row.sessionId !== owner.id), 'visible recipient history does not wake the private main model');
          assert.equal(approvals.length, beforeApprovals, 'internal collaboration never reaches an interactive approval answerer');
          assert.ok(!events(owner).some(event => Number(event.seq) > Number(first) && event.type === 'approval/asked'), 'internal collaboration creates zero native asks');
          const children = modelCalls.slice(count).filter(row => row.child);
          assert.ok(children.length > 0, 'the peer actually executed in a native clean child');
          if (action === 'chain') assert.ok(children.some(row => row.preset?.endsWith('auto-expert')), 'the reviewer autonomously consulted an expert');
          assert.deepEqual(nativeState(owner), state, 'the initiating file/approval settings are unchanged');
          assert.equal((await groups.list()).length, 0, 'two-Bot collaboration does not force a Group');
          exchanges.push({ phase, actualRequest: receipt.actualRequest, from: receipt.from, to: receipt.to,
            requestMessageId: receipt.requestMessageId, replyMessageId: receipt.replyMessageId, deliveryMode: receipt.deliveryMode,
            visibleMainRecords: action === 'notify' ? 2 : 4, receiverMainModelRequests: 0 });
          cases.push({ phase, status: 'PASS', nativeAsks: 0, answererCalls: 0, childRequests: children.length });
        }
      }
      if (config.suite === 'review') {
        for (const agent of Object.values(agents)) await ctx.sessions.flush(agent.session);
        await save('review-ready.json', { status: 'PASS', mains, cases, exchanges, modelCalls, modelRequests: requestCount, realModelRequests: 0,
          sender: { id: 'auto-owner', name: '研究员' }, recipient: { id: 'auto-reviewer', name: '通用助手' },
          actualQuestion: actualQuestion(phase), mainBindingsRetained: true, nativeAsks: 0 });
        console.log('B4_WEB_READY'); return;
      }
      for (const id of ['auto-reviewer', 'auto-expert', 'auto-outsider']) {
        assert.deepEqual(nativeState(agents[id]), peerBefore[id], 'target main conversations retain their persistent file and approval settings');
        assert.equal((await ctx.dshBots.openConversation(id)).sessionId, mains[id], 'long-lived Bot main binding is retained');
      }
      phase = 'loop:message';
      const beforeLoop = modelCalls.length;
      await prompt(owner, 'SG_AUTO_TASK loop boundary: ask the reviewer about this synthetic release.');
      const loopChildren = modelCalls.slice(beforeLoop).filter(row => row.child && row.stage === 'request');
      assert.ok(loopChildren.some(row => row.preset?.endsWith('auto-reviewer')), 'the reviewer actually attempted the loop');
      assert.ok(!loopChildren.some(row => row.preset?.endsWith('auto-owner')), 'a teammate cannot recurse into its initiating Bot');
      const loopInput = lastInput(owner), loopWork = await ctx.dshBots.supergroup.forSession({ sessionId: owner.id, messageId: loopInput.data.id });
      assert.ok(loopWork && loopWork.work.state !== 'running', 'a rejected loop cannot leave an orphaned prepared operation running forever');
      cases.push({ phase, status: 'PASS', zeroRecursiveOwnerRequests: true, workState: loopWork.work.state });
      phase = 'receiver-error:message';
      const beforeError = events(owner).at(-1)?.seq ?? -1;
      await prompt(owner, 'SG_AUTO_TASK recipient error boundary: ask the reviewer about its own capabilities.');
      const errorReceipts = events(owner).filter(event => event.type === 'tool/result' && Number(event.seq) > Number(beforeError))
        .flatMap(event => event.data.message.content.filter(block => block.type === 'text').flatMap(block => { try { return [JSON.parse(block.text)]; } catch { return []; } }));
      const failed = errorReceipts.find(value => value.status === 'error');
      assert.ok(failed && failed.errorCode && failed.diagnostic, 'an empty native output includes an explicit safe error reason');
      assert.equal(failed.actualRequest, actualQuestion(phase), 'a failed receiving attempt still reports what was really sent');
      assert.ok(!failed.errorCode.includes('approval-denied'), 'an unknown recipient failure is not falsely blamed on the approval policy');
      assert.ok(failed.requestMessageId && failed.replyMessageId, 'the receiving failure remains visible as a linked exchange');
      cases.push({ phase, status: 'PASS', errorCode: failed.errorCode, diagnosticPresent: true });
      for (const veto of ['ask', 'deny']) {
        phase = `native-${veto}:message`;
        const first = events(owner).at(-1)?.seq ?? -1, count = modelCalls.filter(row => row.child).length;
        const off = owner.ctx.on('tools/pre-execute', async (exec, next) => {
          const decision = await next();
          return exec.name === 'bot_message' ? { kind: veto, reason: 'Synthetic independent native veto' } : decision;
        }, { prepend: true });
        try { await prompt(owner, `SG_AUTO_TASK ${phase}: evaluate this synthetic release.`); } finally { off(); }
        assert.equal(modelCalls.filter(row => row.child).length, count, 'native veto prevents all peer execution');
        assert.ok(events(owner).some(event => Number(event.seq) > Number(first) && event.type === 'tool/result'), 'the model receives the native veto outcome');
        if (veto === 'ask') assert.ok(events(owner).some(event => Number(event.seq) > Number(first) && event.type === 'approval/decided' && event.data.outcome === 'rejected'),
          'never still rejects an independently required native ask');
        cases.push({ phase, status: 'PASS', zeroPeerExecution: true });
      }
      phase = 'scope:outsider';
      const childCount = modelCalls.filter(row => row.child).length;
      await prompt(owner, 'SG_AUTO_TASK scope boundary: ask the reviewer about this synthetic release.');
      assert.equal(modelCalls.filter(row => row.child).length, childCount, 'a target outside the allowed pool never executes');
      cases.push({ phase, status: 'PASS', zeroPeerExecution: true });
      const editor = ctx.get('configEditor'), entry = editor.entries().find(row => row.options.id === 'dsh-bot'); assert.ok(entry);
      phase = 'stop:message'; blockedChild = undefined;
      const beforeStop = events(owner).at(-1)?.seq ?? -1;
      const stopping = prompt(owner, 'SG_AUTO_TASK stop boundary: ask the reviewer about this synthetic release.');
      await until(() => blockedChild, 'a real native peer execution is in flight before stopping');
      const stopInput = lastInput(owner), service = ctx.dshBots.supergroup;
      const running = await service.forSession({ sessionId: owner.id, messageId: stopInput.data.id });
      assert.ok(running?.work, 'direct collaboration is linked to the existing Supergroup work owner');
      const beforeCancellation = modelCalls.filter(row => row.child).length;
      await service.cancel(running.work.id, running.work.revision);
      await stopping;
      assert.equal(modelCalls.filter(row => row.child).length, beforeCancellation, 'stop prevents additional peer execution');
      assert.ok(!events(owner).some(event => Number(event.seq) > Number(beforeStop) && event.type === 'tool/result' && JSON.stringify(event.data).includes('SG_AUTO_CHECKED_RESULT')),
        'a cancelled peer never returns a completed result');
      const stopped = await service.forSession({ sessionId: owner.id, messageId: stopInput.data.id });
      assert.equal(stopped.work.state, 'cancelled');
      cases.push({ phase, status: 'PASS', stoppedWorkId: stopped.work.id, zeroCompletedPeerResults: true });
      phase = 'budget:chain';
      await editor.edit(entry, raw => ({ ...raw, supergroup: { ...raw.supergroup, maxRequests: 1 } }));
      await until(() => ctx.dshBots.config.supergroup.maxRequests === 1, 'the native config update changes the work budget');
      const beforeBudget = modelCalls.length;
      await prompt(owner, 'SG_AUTO_TASK budget boundary: ask the reviewer, who should consult the expert.');
      const budgetChildren = modelCalls.slice(beforeBudget).filter(row => row.child);
      assert.equal(budgetChildren.length, 1, 'one clean drafting request consumes the shared budget before any recipient or nested expert');
      assert.equal(budgetChildren[0].stage, 'draft', 'the exhausted task does not start a receiver');
      assert.ok(events(owner).filter(event => event.type === 'tool/result').some(event => JSON.stringify(event.data).includes('dsh-bot/budget-exhausted')), 'budget exhaustion has an explicit reason rather than approval-denied or an empty result');
      assert.ok(!budgetChildren.some(row => row.preset?.endsWith('auto-expert')), 'the nested expert cannot bypass the exhausted shared budget');
      cases.push({ phase, status: 'PASS', sharedRequestBudget: 1, childRequests: budgetChildren.length });
      await editor.edit(entry, raw => ({ ...raw, supergroup: { ...raw.supergroup, maxRequests: 36 } }));
      await until(() => ctx.dshBots.config.supergroup.maxRequests === 36, 'the request budget is restored for the disable test');
      phase = 'mode-off:message'; blockedChild = undefined;
      const disabling = prompt(owner, 'SG_AUTO_TASK disable in flight: ask the reviewer about this synthetic release.');
      await until(() => blockedChild, 'a real native peer execution is in flight before disabling');
      const beforeOff = modelCalls.filter(row => row.child).length;
      await editor.edit(entry, raw => ({ ...raw, supergroup: { ...raw.supergroup, enabled: false } }));
      await until(() => !ctx.dshBots.config.supergroup.enabled, 'the native config update disables the mode');
      await disabling;
      await prompt(owner, 'SG_AUTO_TASK mode disabled: ask the reviewer about this synthetic release.');
      assert.equal(modelCalls.filter(row => row.child).length, beforeOff, 'mode off does not retain automatic peer execution');
      cases.push({ phase, status: 'PASS', zeroPeerExecution: true });
      for (const agent of Object.values(agents)) { await agent.whenIdle(); await ctx.sessions.flush(agent.session); }
      assert.equal(owner.ctx.get('sandboxPolicy').resolve({ session: owner.session }).mode, 'danger-full-access');
      assert.equal(owner.ctx.get('approval').effectivePolicy(owner.session), 'never');
      assert.equal((await ctx.dshBots.openConversation('auto-owner')).sessionId, mains['auto-owner']);
      for (const id of Object.keys(bots)) assert.ok((await ctx.dshBots.memoryFor(id).list()).some(row => row.content === `${MEMORY}:${id}`),
        'private memories are retained without rewriting or deleting them');
      assert.equal(approvals.length, 0, 'never gates reject before answerers; automatic paths never request approval');
      await save('collaboration.json', { status: 'PASS', mains, cases, exchanges, modelCalls, modelRequests: requestCount, realModelRequests: 0,
        approvals, providerIds: ctx.llm.listProviders().map(provider => typeof provider === 'string' ? provider : provider.id), groups: (await groups.list()).length,
        scope: 'native tool dispatch, clean task context, fixed file permissions, direct messaging/delegation/chain, native veto and mode off' });
      console.log('B4_WEB_READY');
    })().catch(async error => {
      await save('fixture-error.json', { status: 'FAIL', phase, error: String(error.stack), cases, modelCalls, modelRequests: requestCount, approvals,
        trace: Object.fromEntries([...Object.entries(agents), ...childAgents].map(([id, agent]) => [id, events(agent).map(event => ({ seq: event.seq, type: event.type,
          source: event.data?.source?.kind, outcome: event.data?.outcome, data: event.type === 'tool/result' ? event.data : undefined }))])) });
      console.error('B4_WEB_FAILED', error);
    });
    return async () => { lifetime.abort(); for (const off of releases.reverse()) off(); await run; };
  }, 'dsh-bot: scoped collaboration Host verification');
}
