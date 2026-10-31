import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'live-persona-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'typertGateway'];
const roleSteps = [
  { callId: 'persona-get-1', name: 'bot_manage', args: { action: 'get', id: 'persona-live' } },
  { callId: 'persona-update-1', name: 'bot_manage', args: { action: 'update', id: 'persona-live',
    input: { persona: { prefix: 'ROLE_AFTER', suffix: 'ROLE_SUFFIX', complete: false } } } },
];
class Adapter extends LlmAdapter {
  calls = []; expected = 'ROLE_BEFORE'; getAgent;

  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic live persona' }]; }
  async *stream(options) {
    const agent = this.getAgent(options.sessionId); assert.ok(agent);
    assert.notEqual(agent.session.header.agentPreset, 'dsh-bot-group-root', 'Group root must not request a model');
    const events = agent.session.snapshotEvents();
    const input = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user');
    const inputText = input?.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const toolResult = callId => events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === callId)?.data.message;
    const updateResult = toolResult(roleSteps[1].callId);
    if (inputText?.startsWith('PERSONA_SET_ROLE\n') && updateResult) {
      assert.equal(updateResult.isError, false, JSON.stringify(updateResult));
      this.expected = 'ROLE_AFTER';
    }
    // Inspect the provider-facing system role itself: historical tool results
    // can also contain ROLE_AFTER and must not masquerade as a prompt update.
    const system = options.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
    assert.ok(system.includes(this.expected), `Current system prompt omitted ${this.expected}`);
    if (this.expected !== 'ROLE_BEFORE') assert.ok(!system.includes('ROLE_BEFORE'));
    this.calls.push({ sessionId: options.sessionId, expected: this.expected, inputText, system,
      preset: agent.session.header.agentPreset, parentSession: agent.session.header.parentSession, origin: agent.session.header.origin });
    if (inputText?.startsWith('PERSONA_SET_ROLE\n')) {
      const getResult = toolResult(roleSteps[0].callId);
      if (getResult) {
        assert.equal(getResult.isError, false, JSON.stringify(getResult));
        assert.ok(JSON.stringify(getResult.content).includes('ROLE_BEFORE'));
        assert.ok(JSON.stringify(getResult.content).includes('ROLE_SUFFIX'));
        const rendered = getResult.content.find(block => block.type === 'text' && block.text.startsWith('Bot get completed.\n'));
        assert.ok(rendered, 'Get must return its actual Bot snapshot');
        const snapshot = JSON.parse(rendered.text.slice(rendered.text.indexOf('\n') + 1)).bots[0];
        assert.equal(snapshot.id, 'persona-live');
        assert.ok(Number.isSafeInteger(snapshot.createdAt) && Number.isSafeInteger(snapshot.updatedAt));
        roleSteps[1].args.input.expectedCreatedAt = snapshot.createdAt;
        roleSteps[1].args.input.expectedUpdatedAt = snapshot.updatedAt;
      }
      const step = !getResult ? roleSteps[0] : !updateResult ? roleSteps[1] : undefined;
      if (step) {
        assert.ok(agent.ctx.tools.get(step.name, agent), 'Real bot_manage tool must be registered');
        assert.ok(options.tools?.some(tool => tool.name === step.name), 'Actual request must expose bot_manage');
        const id = ToolCallId(step.callId), args = JSON.stringify(step.args);
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: args };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: args } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
    }
    const text = `ROLE_RESPONSE_${this.calls.length}`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), adapter = new Adapter(), releases = [];
    let phase = 'load', agent;
    const approvalPermits = new Map(), approvalReceipts = [], executions = [];
    adapter.getAgent = id => ctx.agents.get(id);
    releases.push(ctx.on('tools/pre-execute', async (exec, next) => {
      // Fail closed: only the two exact synthetic calls on the original main Agent.
      const step = roleSteps.find(step => step.callId === exec.callId && step.name === exec.name);
      if (exec.agent !== agent || !step || JSON.stringify(exec.arguments) !== JSON.stringify(step.args))
        return { kind: 'deny', reason: 'Persona fixture rejects unspecified Agent, call identity or arguments' };
      assert.ok(!executions.some(row => row.callId === exec.callId), 'Tool call must not execute twice');
      const decision = await next();
      if (decision.kind === 'deny' || decision.kind === 'cancel') return decision;
      executions.push({ callId: exec.callId, name: exec.name, arguments: exec.arguments });
      // get is read-only; the update must retain the real bot_manage ask reason.
      if (step.args.action === 'get') return decision;
      // A narrower native listener may wrap this waterfall after next returns.
      // Do not manufacture ask here: the native request/audit below must prove it.
      approvalPermits.set(exec.callId, JSON.stringify(exec.arguments));
      return decision;
    }, { prepend: true }));
    releases.push(ctx.on('approval/request', async request => {
      const step = roleSteps[1];
      if (request.agent !== agent || request.toolName !== step.name || request.callId !== step.callId ||
        approvalPermits.get(request.callId) !== JSON.stringify(step.args)) return 'rejected';
      approvalPermits.delete(request.callId);
      assert.ok(request.reason.includes('persona-live')); assert.ok(request.reason.includes('persona'));
      assert.ok(request.reason.includes('ROLE_AFTER'), 'Approval must preview the proposed role');
      assert.ok(request.reason.includes(`createdAt=${step.args.input.expectedCreatedAt}`));
      assert.ok(request.reason.includes(`updatedAt=${step.args.input.expectedUpdatedAt}`));
      approvalReceipts.push({ callId: request.callId, toolName: request.toolName, arguments: step.args, outcome: 'allowed-once' });
      return 'allowed-once';
    }, { prepend: true }));
    const save = value => writeFile(resolve(config.outputDir, 'result.json'), JSON.stringify(value, null, 2));
    const timer = setTimeout(() => lifetime.abort(new Error(`Persona probe timed out: ${phase}`)), 60000);
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      await ctx.dshBots.waitUntilReady();
      while (!ctx.dshBots.mainSessions) await delay(20, undefined, { signal: lifetime.signal });
      const wait = async check => { for (;;) { lifetime.signal.throwIfAborted(); const value=await check(); if(value)return value; await delay(20,undefined,{signal:lifetime.signal}); } };
      const groupRole = async (bot, mainAgent, existing) => {
        phase = existing ? 'cold-group-role-final' : 'native-group-role-final';
        const groups = await wait(() => ctx.get('dshBotGroups'));
        const peer = new Peer(ctx,{principal:{kind:'owner'},interactions:'none'});releases.push(()=>peer.dispose());
        let group;
        if(existing) group=(await groups.view(existing.key)).group;
        else {
          const peerBot=await ctx.dshBots.create({id:'persona-peer',name:'Persona fixture peer',template:'minimal',persona:{prefix:'ROLE_FINAL'},model:{provider:'dp-b6b',model:'fixture'}});
          group=await groups.create({operationId:'persona-role-group',name:'Persona native role reuse',mode:'mention',
            members:[bot,peerBot].map(row=>({botId:row.id,botCreatedAt:row.createdAt})),historyConfirmed:true});
        }
        const key={groupId:group.id,groupCreatedAt:group.createdAt};
        const beforeView=await groups.view(key);
        const member=beforeView.members.find(row=>row.bot.botId===bot.id&&row.bot.botCreatedAt===bot.createdAt&&row.removedAt===undefined);assert.ok(member);
        const mainEvents=mainAgent.session.snapshotEvents(),beforeCalls=adapter.calls.length;
        const mainCallCount=adapter.calls.filter(call=>call.sessionId===mainAgent.id).length;
        adapter.expected='ROLE_FINAL';
        const turn=await ctx.typertGateway.invoke({namespace:'dshBot.groups',method:'send',args:{group:key,input:{operationId:existing?'cold-persona-role-group':'hot-persona-role-group',
          text:'PERSONA_GROUP_ROLE_FINAL',round:false,memberIds:[member.id],expectedMembershipRevision:group.membershipRevision}},peer,signal:lifetime.signal});
        const view=await wait(async()=>{const view=await groups.view(key),row=view.turns.find(row=>row.id===turn.id);if(!row||['accepted','running'].includes(row.state))return;assert.equal(row.state,'completed');return view;});
        const deliveries=view.deliveries.filter(row=>row.turnId===turn.id);assert.equal(deliveries.length,1);
        const delivery=deliveries[0];assert.deepEqual(delivery.bot,{botId:bot.id,botCreatedAt:bot.createdAt});assert.equal(delivery.state,'completed');
        assert.ok(delivery.childSessionId);assert.notEqual(delivery.childSessionId,mainAgent.id);
        const calls=adapter.calls.slice(beforeCalls);assert.equal(calls.length,1);const call=calls[0];
        assert.equal(call.sessionId,delivery.childSessionId);assert.equal(call.preset,`bot-${bot.id}`);assert.equal(call.parentSession,group.rootSessionId);assert.equal(call.origin,'subagent');
        assert.ok(call.system.includes('ROLE_FINAL'));assert.ok(!call.system.includes('ROLE_BEFORE')&&!call.system.includes('ROLE_AFTER')&&!call.system.includes('ROLE_COMPLETE'));
        const root=ctx.agents.get(group.rootSessionId);assert.ok(root);assert.equal(root.session.header.agentPreset,'dsh-bot-group-root');
        assert.equal(root.session.snapshotEvents().filter(event=>event.type==='request/header').length,0);
        assert.equal(adapter.calls.filter(row=>row.sessionId===group.rootSessionId).length,0);
        assert.deepEqual(mainAgent.session.snapshotEvents(),mainEvents);assert.equal(adapter.calls.filter(row=>row.sessionId===mainAgent.id).length,mainCallCount);
        const receipt={key,rootSessionId:group.rootSessionId,memberId:member.id,delivery,call,rootModelRequests:0,mainHistoryUnchanged:true,actualNativeWorker:true};
        await writeFile(resolve(config.outputDir,existing?'cold-group-role.json':'group-role.json'),JSON.stringify(receipt,null,2));return receipt;
      };
      if (config.phase === 'cold') {
        phase = 'cold-host-restore';
        const seed = JSON.parse(await readFile(resolve(config.outputDir, 'seed.json')));
        const main = await ctx.dshBots.openConversation('persona-live');
        assert.equal(main.sessionId, seed.sessionId);
        const restored = (await ctx.sessionController.resolveAgent(main.sessionId)).agent;
        const prompt = (await restored.ctx.systemPrompt.assemble({ scope: restored, agent: restored })).sections.map(s => s.text).join('\n');
        assert.ok(prompt.includes('ROLE_FINAL')); assert.ok(!prompt.includes('ROLE_BEFORE'));
        assert.ok(JSON.stringify(restored.session.snapshotEvents()).includes('ROLE_RESPONSE_1'));
        assert.deepEqual(restored.session.snapshotEvents().filter(event => event.type === 'tool/result')
          .map(event => event.data.message.toolCallId), roleSteps.map(step => step.callId));
        assert.ok(restored.session.snapshotEvents().some(event => event.type === 'approval/decided' && event.data.outcome === 'allowed-once'));
        adapter.expected = 'ROLE_FINAL';
        assert.equal((await ctx.sessionController.prompt({ sessionId: main.sessionId, requestId: 'PERSONA_COLD_TASK', mode: 'queue',
          content: [{ type: 'text', text: 'PERSONA_COLD_TASK' }] }, lifetime.signal)).accepted, true);
        await restored.whenIdle(); assert.equal(adapter.calls.length, 1);
        const groupReceipt=await groupRole(await ctx.dshBots.get('persona-live'),restored,seed.group);assert.equal(adapter.calls.length,2);
        await save({ status: 'PASS', coldHostRestored: true, mainSessionRetained: true, historyRetained: true,
          groupWorkerRoleFinal:true,groupRootModelRequests:0,groupMainHistoryUnchanged:true,groupChildSessionId:groupReceipt.delivery.childSessionId,
          syntheticModelRequests: adapter.calls.length, realModelRequests: 0 });
        console.log('LIVE_PERSONA_DONE'); return;
      }
      const bot = await ctx.dshBots.create({ id: 'persona-live', name: 'Persona fixture', template: 'minimal',
        persona: { prefix: 'ROLE_BEFORE', suffix: 'ROLE_SUFFIX', complete: false }, model: { provider: 'dp-b6b', model: 'fixture' } });
      const main = await ctx.dshBots.openConversation(bot.id);
      agent = (await ctx.sessionController.resolveAgent(main.sessionId)).agent;
      const text = async () => (await agent.ctx.systemPrompt.assemble({ scope: agent, agent })).sections.map(s => s.text).join('\n');
      const send = async (id, message = id) => {
        const result = await ctx.sessionController.prompt({ sessionId: main.sessionId, requestId: id, mode: 'queue',
          content: [{ type: 'text', text: message }] }, lifetime.signal);
        assert.equal(result.accepted, true); await agent.whenIdle();
      };
      phase = 'before'; await send('PERSONA_TASK_FIRST'); assert.equal(adapter.calls.length, 1);
      const originalEvents = agent.session.snapshotEvents();
      phase = 'committed-update';
      await send('PERSONA_SET_ROLE', 'PERSONA_SET_ROLE\nFrom now on, save ROLE_AFTER as my lasting role for this Bot. First inspect its current configuration, then update only persona, preserving the existing suffix and complete setting.');
      assert.equal(adapter.calls.length, 4); // first reply, get, update, post-commit reply
      assert.equal(approvalReceipts.length, 1);
      assert.equal(approvalPermits.size, 0);
      assert.deepEqual(executions, roleSteps.map(step => ({ callId: step.callId, name: step.name, arguments: step.args })));
      assert.deepEqual((await ctx.dshBots.get(bot.id)).persona, roleSteps[1].args.input.persona);
      const roleEvents = agent.session.snapshotEvents();
      const audit = roleEvents.filter(event => event.type === 'approval/asked' || event.type === 'approval/decided');
      assert.deepEqual(audit.map(event => event.type), ['approval/asked', 'approval/decided']);
      assert.equal(audit[0].data.callId, roleSteps[1].callId);
      assert.equal(audit[0].data.toolName, 'bot_manage');
      assert.equal(audit[1].data.id, audit[0].data.id);
      assert.equal(audit[1].data.outcome, 'allowed-once');
      const producedCalls = roleEvents.filter(event => event.type === 'assistant/message')
        .flatMap(event => event.data.message.content.filter(block => block.type === 'tool-call'));
      assert.deepEqual(producedCalls.map(block => ({ callId: block.id, name: block.name, args: JSON.parse(block.arguments) })), roleSteps);
      assert.ok(adapter.calls[3].system.includes('ROLE_AFTER'));
      await writeFile(resolve(config.outputDir, 'persona-tool-events.json'), JSON.stringify({
        executions, approvalReceipts, audit, calls: adapter.calls,
        events: roleEvents,
      }, null, 2));
      assert.equal(ctx.agents.get(main.sessionId), agent);
      assert.ok((await text()).includes('ROLE_AFTER')); assert.ok(!(await text()).includes('ROLE_BEFORE'));
      adapter.expected = 'ROLE_AFTER'; await send('PERSONA_TASK_SECOND'); assert.equal(adapter.calls.length, 5);
      phase = 'complete-mode';
      await ctx.dshBots.update(bot.id, { persona: { prefix: 'ROLE_COMPLETE', complete: true } });
      assert.equal(await text(), 'ROLE_COMPLETE'); adapter.expected = 'ROLE_COMPLETE';
      await send('PERSONA_TASK_THIRD'); assert.equal(adapter.calls.length, 6);
      phase = 'restore-sections';
      await ctx.dshBots.update(bot.id, { persona: { prefix: 'ROLE_FINAL', complete: false } });
      assert.ok((await text()).includes('ROLE_FINAL'));
      assert.ok(!(await text()).includes('ROLE_COMPLETE'));
      assert.equal((await ctx.dshBots.openConversation(bot.id)).sessionId, main.sessionId);
      assert.ok(agent.session.snapshotEvents().length > originalEvents.length);
      assert.deepEqual(agent.session.snapshotEvents().slice(0, originalEvents.length), originalEvents);
      assert.ok(JSON.stringify(agent.session.snapshotEvents()).includes('ROLE_RESPONSE_1'));
      const groupReceipt=await groupRole(await ctx.dshBots.get(bot.id),agent);assert.equal(adapter.calls.length,7);
      await ctx.sessions.flush(agent.session);
      await writeFile(resolve(config.outputDir, 'seed.json'), JSON.stringify({ sessionId: main.sessionId,group:{key:groupReceipt.key,memberId:groupReceipt.memberId} }));
      await save({ status: 'PASS', sameLiveAgent: true, nextRequestUpdated: true, completeModeUpdated: true,
        messageToolPersonaUpdate: true, groupWorkerRoleFinal:true,groupRootModelRequests:0,groupMainHistoryUnchanged:true,groupChildSessionId:groupReceipt.delivery.childSessionId,exactToolCalls: executions, exactAllowedOnceApprovals: approvalReceipts,
        nativeApprovalAudit: audit.map(event => ({ type: event.type, data: event.data })),
        originalHistoryRetained: true, syntheticModelRequests: adapter.calls.length, realModelRequests: 0 });
      console.log('LIVE_PERSONA_DONE');
    })().catch(async error => { await save({ status: 'FAIL', phase, error: String(error), stack: error.stack, calls: adapter.calls, executions, approvalReceipts, realModelRequests: 0 }); console.log('LIVE_PERSONA_FAILED'); });
    return async () => { clearTimeout(timer); lifetime.abort(); await run; for (const off of releases.reverse()) off(); };
  });
}
