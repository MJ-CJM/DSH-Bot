import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'supergroup-runtime-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'configEditor'];
const ambient = new Set(['runtime-context', 'time-context', 'agent-instructions', 'tmux-context', 'skill-catalog', 'user-approval', 'model-selection']);
export class Adapter extends LlmAdapter {
  ctx; mainId; calls = []; peerSent = false; invited = false; existingRequested = false; onGamma; promotion = false; directWork; stopGates = [];
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic Supergroup' }]; }
  async *stream(options) {
    options.signal.throwIfAborted();
    const agent = this.ctx.agents.get(options.sessionId); assert.ok(agent);
    const events = agent.session.snapshotEvents();
    const message = events.findLast(event => event.type === 'user/message' && (agent.id === this.mainId ? event.data.source.kind === 'user' : !ambient.has(event.data.source.kind)));
    const input = JSON.stringify(message?.data.content);
    let packet; try { packet = JSON.parse(message?.data.content?.filter(block => block.type === 'text').map(block => block.text).join('\n')); } catch {}
    this.calls.push({ sessionId: agent.id, preset: agent.session.header.agentPreset, source: message?.data.source.kind,
      privateParentSeen: JSON.stringify(options).includes('SG_PARENT_ONLY_CANARY'), privateMemorySeen: JSON.stringify(options).includes('SG_PRIVATE_MEMORY_CANARY') });
    if (agent.id !== this.mainId) {
      assert.ok(!JSON.stringify(options).includes('SG_PARENT_ONLY_CANARY'), 'private main history does not enter task execution');
      assert.ok(!JSON.stringify(options).includes('SG_PRIVATE_MEMORY_CANARY'), 'private memory does not enter group or direct task workers');
      assert.ok(!JSON.stringify(options).includes('SG_MODEL_TASK_NOT_AUTHORIZED'), 'main-model proposals are not shared as task materials');
    }
    if (packet?.kind === 'dsh-bot-message-draft') {
      const text = 'SG_DRAFTED_DIRECT_QUESTION: independently review the supplied migration proposal.';
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    if (agent.id !== this.mainId && input.includes('SG_STOP_TASK')) {
      options.signal.throwIfAborted();
      await new Promise(release => { this.stopGates.push(agent.id); options.signal.addEventListener('abort', release, { once: true }); });
      options.signal.throwIfAborted();
      throw new Error('Stopped group worker unexpectedly resumed');
    }
    let step;
    if (agent.id === this.mainId) {
      const results = events.filter(event => event.type === 'tool/result' && Number(event.seq) > Number(message?.seq ?? -1)), already = results.length > 0;
      if (input.includes('SG_COMPLEX') && this.promotion && !already)
        step = { name: 'bot_message', args: { action: 'send', to: 'sg-alpha', mode: 'ask', priority: 'normal', content: 'SG_MODEL_TASK_NOT_AUTHORIZED' } };
      else if (input.includes('SG_COMPLEX') && this.promotion && results.length === 1) {
        this.directWork = await this.ctx.dshBots.supergroup.forSession({ sessionId: agent.id, messageId: message.data.id });
        assert.ok(this.directWork?.work && !this.directWork.group && this.directWork.work.collaboration.requests === 2,
          'a real direct exchange precedes the group in the same human task');
        step = { name: 'bot_supergroup', args: { action: 'start', memberIds: ['sg-alpha', 'sg-beta'] } };
      } else if (input.includes('SG_COMPLEX') && !already) step = { name: 'bot_supergroup', args: { action: 'start', memberIds: ['sg-alpha', 'sg-beta'] } };
      if (input.includes('SG_CONTINUE') && !already) step = { name: 'bot_supergroup', args: { action: 'continue' } };
      if (input.includes('SG_STOP_TASK') && !already) step = { name: 'bot_supergroup', args: { action: 'start', memberIds: ['sg-alpha', 'sg-beta'] } };
    } else if (agent.session.header.agentPreset?.endsWith('sg-alpha') && agent.ctx.tools.get('group_message', agent)) {
      if (!this.peerSent) {
        this.peerSent = true;
        const rows = await this.ctx.get('dshBotGroups').list();
        const group = await this.ctx.get('dshBotGroups').view({ groupId: rows[0].group.id, groupCreatedAt: rows[0].group.createdAt });
        const beta = group.members.find(member => member.bot.botId === 'sg-beta'); assert.ok(beta);
        step = { name: 'group_message', args: { action: 'send', to: beta.id, kind: 'request', text: 'SG_PEER_REQUEST: independently review the report.' } };
      } else if (!this.invited) {
        this.invited = true;
        step = { name: 'group_message', args: { action: 'request-expert', botId: 'sg-gamma', question: 'SG_EXPERT_QUESTION: evaluate the migration risk.' } };
      } else if (input.includes('SG_CONTINUE') && !this.existingRequested) {
        this.existingRequested = true;
        step = { name: 'group_message', args: { action: 'request-expert', botId: 'sg-gamma', question: 'SG_EXISTING_EXPERT: verify the refined recommendation.' } };
      }
    }
    if (step) {
      assert.ok(agent.ctx.tools.get(step.name, agent), `Tool missing: ${step.name}`);
      const id = ToolCallId(`sg-runtime-${this.calls.length}`), args = JSON.stringify(step.args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    const gamma = agent.session.header.agentPreset?.endsWith('sg-gamma');
    if (gamma && this.onGamma) {
      await this.onGamma(agent);
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      options.signal.throwIfAborted();
    }
    const text = agent.id === this.mainId ? 'SG_MAIN_FINAL' : gamma ? 'SG_EXPERT_RESULT: migration requires a staged rollout.' : 'SG_MEMBER_RESULT';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), releases = [], adapter = new Adapter(); adapter.ctx = ctx;
    let phase = 'startup';
    const save = (file, value) => writeFile(resolve(config.outputDir, `${file}.json`), JSON.stringify(value, null, 2));
    const wait = async read => { for (;;) { lifetime.signal.throwIfAborted(); const result = await read(); if (result) return result; await delay(20, undefined, { signal: lifetime.signal }); } };
    const timer = setTimeout(() => lifetime.abort(new Error(`Supergroup deadline: ${phase}`)), 110000);
    const work = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      await wait(() => ctx.get('dshBotSupergroupRemote'));
      const service = await wait(() => ctx.dshBots.supergroup);
      if (config.phase === 'cold') {
        const previous = JSON.parse(await readFile(resolve(config.outputDir, 'crash-ready.json'), 'utf8'));
        const recovered = await service.forSession({ sessionId: previous.sessionId, messageId: previous.messageId });
        assert.equal(recovered?.work.id, previous.workId);
        assert.equal(recovered.work.state, 'unknown');
        assert.ok(recovered.group.turns.some(turn => turn.state === 'recovery_needed'));
        await delay(500, undefined, { signal: lifetime.signal });
        assert.equal(adapter.calls.length, 0, 'Cold startup and status queries must not replay unknown model work');
        await save('cold-result', { status: 'PASS', unknownPreserved: true, zeroReplayRequests: true, workId: previous.workId });
        console.log('SG_RUNTIME_DONE'); return;
      }
      adapter.promotion = config.phase === 'promotion';
      for (const id of ['sg-owner', 'sg-alpha', 'sg-beta', 'sg-gamma']) {
        await ctx.dshBots.create({ id, name: id, template: 'minimal', persona: { prefix: `SG_PERSONA_${id}` },
          model: { provider: 'dp-b6b', model: 'fixture' }, memory: { enabled: true, injectLimit: 20 } });
        await ctx.dshBots.memoryFor(id).save({ content: `SG_PRIVATE_MEMORY_CANARY_${id}`, pinned: true });
      }
      const opened = await ctx.dshBots.openConversation('sg-owner'); adapter.mainId = opened.sessionId;
      const main = ctx.agents.get(adapter.mainId); assert.ok(main);
      const groups = ctx.get('dshBotGroups'); assert.ok(groups);
      if (config.phase === 'crash') adapter.onGamma = async gamma => {
        const input = main.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user');
        const view = await service.forSession({ sessionId: main.id, messageId: input.data.id });
        await ctx.sessions.flush(main.session);
        const root = ctx.agents.get(view.group.group.rootSessionId); await ctx.sessions.flush(root.session);
        await save('crash-ready', { workId: view.work.id, sessionId: main.id, messageId: input.data.id, gammaId: gamma.id });
        console.log('SG_RUNTIME_PHASE crash-ready');
      };
      phase = 'simple'; console.log(`SG_RUNTIME_PHASE ${phase}`);
      await ctx.sessionController.prompt({ sessionId: main.id, requestId: 'sg-simple', mode: 'queue', content: [{ type: 'text', text: 'SG_SIMPLE: private prior transcript SG_PARENT_ONLY_CANARY.' }] }, lifetime.signal);
      await main.whenIdle(); assert.equal((await groups.list()).length, 0);
      phase = 'complex'; console.log(`SG_RUNTIME_PHASE ${phase}`);
      await ctx.sessionController.prompt({ sessionId: main.id, requestId: 'sg-complex', mode: 'queue', content: [{ type: 'text', text: 'SG_COMPLEX: compare this supplied proposal and evaluate migration risk.' }] }, lifetime.signal);
      await main.whenIdle();
      const input = main.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user'); assert.ok(input);
      const view = await service.forSession({ sessionId: main.id, messageId: input.data.id });
      assert.ok(view?.group, 'Original conversation must link to actual group');
      assert.equal(view.group.members.filter(member => member.enabled && member.removedAt === undefined).length, 3);
      assert.ok(view.group.messages.some(message => message.text.includes('SG_EXPERT_RESULT')));
      assert.ok(main.session.snapshotEvents().some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('SG_EXPERT_RESULT')),
        'Checked expert result must return through original native tool result');
      assert.equal(view.work.originSessionId, main.id);
      assert.equal(view.group.group.cwd, main.session.header.cwd);
      assert.ok(adapter.peerSent && adapter.invited);
      assert.ok(adapter.calls.filter(call => call.sessionId !== main.id).every(call => !call.privateParentSeen));
      assert.ok(adapter.calls.some(call => call.sessionId === main.id && call.privateMemorySeen), 'the memory canary really entered the main context');
      assert.ok(adapter.calls.filter(call => call.sessionId !== main.id).every(call => !call.privateMemorySeen));
      assert.ok(!adapter.calls.some(call => call.sessionId === view.group.group.rootSessionId));
      if (adapter.promotion) assert.equal(view.work.id, adapter.directWork.work.id, 'direct exchange upgrades the same work into a group');
      assert.equal(view.work.collaboration.requests, adapter.calls.filter(call => call.sessionId !== main.id).length,
        'the production group callback and direct exchange share one actual request counter');
      await save('work', view); await save('calls', adapter.calls);
      phase = 'continue'; console.log(`SG_RUNTIME_PHASE ${phase}`);
      await ctx.sessionController.prompt({ sessionId: main.id, requestId: 'sg-continue', mode: 'queue', content: [{ type: 'text', text: 'SG_CONTINUE: keep the same work and refine the second recommendation.' }] }, lifetime.signal);
      await main.whenIdle();
      const continuedInput = main.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user');
      assert.ok(continuedInput);
      const continued = await service.forSession({ sessionId: main.id, messageId: continuedInput.data.id });
      assert.equal(continued?.work.id, view.work.id, 'Continue must retain the same work');
      assert.deepEqual(continued?.work.group, view.work.group, 'Continue must retain the same actual group');
      assert.equal(continued.work.inputMessageIds.length, 2);
      assert.equal(continued.group.members.filter(member => member.enabled && member.removedAt === undefined).length, 3);
      assert.ok(adapter.existingRequested, 'An already joined expert should be reused');
      assert.equal(continued.work.collaboration.requests, adapter.calls.filter(call => call.sessionId !== main.id).length,
        'continuation and expert requests accumulate in the same work budget');
      const beforeReplay = adapter.calls.length;
      await service.invoke(main, { action: 'continue', workId: view.work.id }, lifetime.signal);
      assert.equal(adapter.calls.length, beforeReplay, 'Replaying the same human input must not repeat members');
      const childId = continued.group.deliveries.find(delivery => delivery.childSessionId)?.childSessionId;
      const child = ctx.agents.get(childId);
      if (child) await assert.rejects(() => service.invoke(child, { action: 'start', memberIds: ['sg-alpha', 'sg-beta'] }, lifetime.signal));
      await save('continued', continued);
      phase = 'mode-hot-update'; console.log(`SG_RUNTIME_PHASE ${phase}`);
      const registry = ctx.dshBots, memory = registry.memoryKernel;
      const editor = ctx.get('configEditor'); assert.ok(editor);
      const entry = editor.entries().find(row => row.options.id === 'dsh-bot'); assert.ok(entry);
      const hostFiberUid = entry.fiber.uid;
      phase = 'mode-edit-off'; console.log(`SG_RUNTIME_PHASE ${phase}`);
      await editor.edit(entry, raw => ({ ...raw, supergroup: { ...raw.supergroup, enabled: false } }));
      phase = 'mode-off-committed'; console.log(`SG_RUNTIME_PHASE ${phase}`);
      await wait(() => !registry.config.supergroup.enabled && !main.ctx.tools.get('bot_supergroup', main));
      // Cordis creates a fresh traceable Service proxy per get; proxy === does
      // not establish service replacement. Compare the public owning fiber and
      // actual resource identities, keeping assertion diagnostics content-free.
      assert.equal(entry.fiber.uid, hostFiberUid);
      assert.ok(registry.memoryKernel === memory, 'Memory kernel must remain the same');
      assert.ok(ctx.agents.get(main.id) === main, 'Bot main Agent must remain the same');
      assert.match(await readFile(editor.documentPath, 'utf8'), /supergroup:\s*\n\s*enabled: false/);
      await save('mode-off', { status: 'PASS', persisted: true, hostFiberUid, memoryKernelUnchanged: true, mainAgentUnchanged: true, supergroupToolRemoved: true });
      await ctx.sessionController.prompt({ sessionId: main.id, requestId: 'sg-after-disable', mode: 'queue', content: [{ type: 'text', text: 'SG_SIMPLE_AFTER_DISABLE: ordinary conversation still works.' }] }, lifetime.signal);
      await main.whenIdle(); assert.equal((await groups.list()).length, 1);
      await editor.edit(entry, raw => ({ ...raw, supergroup: { ...raw.supergroup, enabled: true } }));
      await wait(() => !!main.ctx.tools.get('bot_supergroup', main));
      assert.equal(entry.fiber.uid, hostFiberUid);
      assert.ok(registry.memoryKernel === memory, 'Memory kernel must remain the same');
      assert.ok(ctx.agents.get(main.id) === main, 'Bot main Agent must remain the same');
      assert.match(await readFile(editor.documentPath, 'utf8'), /supergroup:\s*\n\s*enabled: true/);
      phase = 'cancel-inflight'; console.log(`SG_RUNTIME_PHASE ${phase}`);
      await ctx.sessionController.prompt({ sessionId: main.id, requestId: 'sg-stop-inflight', mode: 'queue',
        content: [{ type: 'text', text: 'SG_STOP_TASK: ask the existing team to evaluate this synthetic release.' }] }, lifetime.signal);
      await wait(() => adapter.stopGates.length > 0);
      const stopInput = main.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user');
      const inflight = await service.forSession({ sessionId: main.id, messageId: stopInput.data.id });
      assert.ok(inflight?.group && inflight.group.deliveries.some(row => row.state === 'running'), 'a real group worker is in flight before stop');
      try { await service.cancel(inflight.work.id, inflight.work.revision); }
      catch (error) {
        if (error?.code !== 'dsh-bot/conflict') throw error;
        // Match the shipped stop UI: only a definite CAS conflict may refresh once.
        const fresh = await service.forSession({ sessionId: main.id, messageId: stopInput.data.id });
        assert.equal(fresh.work.id, inflight.work.id);
        await service.cancel(fresh.work.id, fresh.work.revision);
      }
      const stopCommitted = adapter.calls.length;
      await main.whenIdle();
      await delay(50, undefined, { signal: lifetime.signal });
      const stopped = await service.forSession({ sessionId: main.id, messageId: stopInput.data.id });
      assert.equal(stopped.work.state, 'cancelled');
      assert.ok(!stopped.group.deliveries.some(row => row.state === 'completed'), 'cancelled workers publish no completed result');
      assert.ok(!stopped.group.deliveries.some(row => ['pending', 'starting', 'running'].includes(row.state)), 'all stopped group deliveries reach a terminal state');
      assert.ok(!adapter.calls.slice(stopCommitted).some(call => call.sessionId !== main.id), 'a committed stop prevents new group worker requests');
      await save('stopped', stopped);
      await ctx.sessions.flush(main.session);
      await save('result', { status: 'PASS', groupMembers: 3, originalConversation: main.id,
        peerRequested: adapter.peerSent, expertRequested: adapter.invited, sameWorkContinued: true, existingExpertReused: true, replayZeroRequests: true,
        nativeConfigHotUpdate: true, ordinaryChatAfterDisable: true,
        directToGroupSameWork: adapter.promotion, sharedRequests: continued.work.collaboration.requests,
        privateMemoryCanaryAbsentFromWorkers: true,
        inFlightGroupStopped: true,
        realModelRequests: 0, syntheticRequests: adapter.calls.length });
      console.log('SG_RUNTIME_DONE');
    })().catch(async error => {
      await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, calls: adapter.calls });
      console.error('SG_RUNTIME_FAILED', error);
    }).finally(() => clearTimeout(timer));
    return async () => { lifetime.abort(); await work; for (const release of releases.reverse()) release(); };
  }, 'supergroup-runtime-fixture');
}
