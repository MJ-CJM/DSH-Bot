import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'native-tools-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'schedule'];
const ambient = new Set(['runtime-context', 'time-context', 'agent-instructions', 'tmux-context']);
class NativeAdapter extends LlmAdapter {
  getAgent; steps; calls = [];
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic real native tools fixture' }]; }
  async *stream(options) {
    const agent = this.getAgent(options.sessionId); assert.ok(agent);
    const input = agent.session.snapshotEvents().findLast(e => e.type === 'user/message' && !ambient.has(e.data.source.kind));
    this.calls.push({ sessionId: options.sessionId, kind: input?.data.source.kind });
    const inputText = input?.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (!agent.session.header.parentSession && input?.data.source.kind !== 'schedule' && input?.data.source.kind !== 'dsh-bot-delegate') {
      const count = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').length;
      const afterSchedule = inputText === 'NATIVE_AFTER_SCHEDULE_SELF_DELEGATE';
      const alreadyDelegated = agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call' && block.name === 'bot_delegate'));
      const step = afterSchedule ? (!alreadyDelegated ? this.delegateStep : undefined) : this.steps[count];
      if (step) {
        const definition = agent.ctx.tools.get(step.name, agent); assert.ok(definition, `Real native provider missing: ${step.name}`);
        const schema = agent.ctx.tools.schemas(agent).find(tool => tool.name === step.name); assert.ok(schema);
        // Native published schemas are retained in the receipt; argument fields must actually be declared.
        for (const key of Object.keys(step.args)) assert.ok(Object.hasOwn(definition.parameters.properties ?? definition.parameters, key), `${step.name}.${key} missing in native public parameters`);
        const id = ToolCallId(`native-smoke-${count}`), args = JSON.stringify(step.args);
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: args };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: args } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
    }
    const text = agent.session.header.parentSession ? 'NATIVE_POST_SCHEDULE_CHILD_RESPONSE' : input?.data.source.kind === 'schedule' ? 'NATIVE_SCHEDULE_RESPONSE' : 'NATIVE_TOOLS_COMPLETE';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), releases = [], adapter = new NativeAdapter();
    let phase = 'loader', agent, approvals = 0;
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const mark = async name => { phase = name; console.log(`NATIVE_TOOLS_PHASE ${name}`); await save('progress', { phase }); };
    const wait = async check => { for (;;) { lifetime.signal.throwIfAborted(); const value = await check(); if (value) return value; await delay(20, undefined, { signal: lifetime.signal }); } };
    const timer = setTimeout(() => lifetime.abort(new Error(`Native tools deadline: ${phase}`)), 60000);
    let path; const text = 'REAL_NATIVE_FILE_BYTES\n';
    const command = "printf 'REAL_NATIVE_PROCESS_OUTPUT'";
    const defineSteps = workdir => { adapter.steps = [
      { name: 'write', args: { file_path: path, content: text } },
      { name: 'read', args: { file_path: path } },
      { name: 'bash', args: { command, description: 'Print one synthetic native process marker', workdir } },
      { name: 'schedule_create', args: { title: 'Synthetic future task', prompt: 'NATIVE_SCHEDULE_TASK', after_seconds: 3600 } },
    ]; };
    adapter.delegateStep = { name: 'bot_delegate', args: { targetBotId: 'native-smoke', task: 'NATIVE_POST_SCHEDULE_CHILD', title: 'Synthetic post-schedule child' } };
    adapter.getAgent = id => ctx.agents.get(id);
    const approved = new Set();
    releases.push(ctx.on('tools/pre-execute', async (exec, next) => {
      if (!agent || exec.agent !== agent) return next();
      const matching = [...adapter.steps, adapter.delegateStep].find(step => step.name === exec.name && JSON.stringify(step.args) === JSON.stringify(exec.arguments));
      if (!matching) return { kind: 'deny', reason: 'Fixture denies all unspecified tool arguments' };
      const decision = await next(); if (decision.kind === 'deny' || decision.kind === 'cancel') return decision;
      approved.add(exec.name); return { kind: 'ask', reason: `Synthetic exact invocation: ${exec.name}` };
    }, { prepend: true }));
    releases.push(ctx.on('approval/request', async request => {
      if (request.agent === agent && approved.delete(request.toolName)) { approvals++; return 'allowed-once'; }
      return 'rejected';
    }, { prepend: true }));
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter)); await ctx.dshBots.waitUntilReady();
      await wait(() => ctx.dshBots.mainSessions);
      const workspace = await ctx.dshBots.ensureBotsWorkspace();
      path = resolve(workspace.path, `native-artifact-${config.outputDir.split('/').at(-1)}.txt`); defineSteps(workspace.path);
      await ctx.dshBots.create({ id: 'native-smoke', name: 'Synthetic native smoke', template: 'standard',
        model: { provider: 'dp-b6b', model: 'fixture' }, memory: { enabled: false, injectLimit: 0 } });
      const main = await ctx.dshBots.openConversation('native-smoke'); agent = (await ctx.sessionController.resolveAgent(main.sessionId)).agent; assert.ok(agent);
      const definitions = ['write', 'read', 'bash', 'schedule_create'].map(name => {
        const definition = agent.ctx.tools.get(name, agent); assert.ok(definition, `Real native provider missing: ${name}`); return { name, parameters: definition.parameters };
      }); await save('native-schemas', definitions);
      await mark('native-tools');
      await ctx.sessionController.prompt({ sessionId: agent.id, requestId: 'synthetic-native-tools', mode: 'queue', content: [{ type: 'text', text: 'NATIVE_TOOLS_START' }] }, lifetime.signal);
      await agent.whenIdle();
      const events = agent.session.snapshotEvents(); await save('tool-events', events);
      assert.equal(await readFile(path, 'utf8'), text);
      const results = events.filter(event => event.type === 'tool/result'); assert.equal(results.length, 4);
      for (const event of results) assert.equal(event.data.message.isError, false, JSON.stringify(event.data));
      assert.ok(JSON.stringify(results[1].data.message.content).includes('REAL_NATIVE_FILE_BYTES'));
      assert.ok(JSON.stringify(results[2].data.message.content).includes('REAL_NATIVE_PROCESS_OUTPUT')); assert.equal(approvals, 4);
      const labels = { beforeSchedule: ctx.dshBots.memoryOutlets.label(agent.id) }; await save('labels', labels);
      await mark('future-schedule');
      const tasks = await ctx.schedule.list({ sessionId: agent.id }); assert.equal(tasks.length, 1); const task = tasks[0];
      assert.ok(Date.parse(task.scheduledAt) > Date.now() + 3000000);
      // Public CAS update explicitly arms the native timer; there is no public schedule.runNow API.
      const changed = await ctx.schedule.update({ sessionId: agent.id, id: task.id, expected: task, change: { kind: 'at', at: new Date(Date.now() + 1200).toISOString() } }, lifetime.signal);
      assert.equal(changed.updated, true);
      const receipt = await wait(async () => {
        const history = await ctx.schedule.history({ sessionId: agent.id, id: task.id, limit: 10 }); return history.records?.[0];
      });
      await wait(() => agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('NATIVE_SCHEDULE_RESPONSE')));
      await agent.whenIdle();
      await mark('native-outcome-projection');
      const projection = await ctx.sessionController.projections({ sessionId: agent.id }, lifetime.signal);
      const outcomes = projection?.values.dshBotRoutineOutcomes; assert.ok(outcomes, 'Real product outcome projection missing');
      const outcome = outcomes.find(row => row.messageId === receipt.messageId); assert.ok(outcome); assert.equal(outcome.state, 'responded');
      labels.afterSchedule = ctx.dshBots.memoryOutlets.label(agent.id); await save('labels', labels);
      await mark('post-schedule-human-self-delegate');
      await ctx.sessionController.prompt({ sessionId: agent.id, requestId: 'synthetic-post-schedule-human', mode: 'queue', content: [{ type: 'text', text: 'NATIVE_AFTER_SCHEDULE_SELF_DELEGATE' }] }, lifetime.signal);
      await agent.whenIdle();
      labels.afterHuman = ctx.dshBots.memoryOutlets.label(agent.id); await save('labels', labels);
      const afterEvents = agent.session.snapshotEvents(); await save('post-schedule-events', afterEvents);
      const delegateResult = afterEvents.filter(event => event.type === 'tool/result').at(-1);
      assert.equal(delegateResult?.data.message.isError, false, JSON.stringify(delegateResult?.data));
      await wait(() => agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'dsh-bot-delegate' && JSON.stringify(event.data).includes('NATIVE_POST_SCHEDULE_CHILD_RESPONSE')));
      await agent.whenIdle();
      await save('schedule-history', { task, changed, receipt }); await save('projection', projection);
      await save('result', { status: 'PASS', template: 'standard', realNativeTools: ['write', 'read', 'bash', 'schedule_create'], exactApprovals: approvals,
        actualFileBytes: Buffer.byteLength(text), processOutputVerified: true, postScheduleHumanSelfDelegate: true, nativeScheduleMessageId: receipt.messageId, nativeOutcome: outcome,
        actualAdapterCalls: adapter.calls.length, realModelRequests: 0 }); console.log('NATIVE_TOOLS_DONE');
    })().catch(async error => { await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, calls: adapter.calls, realModelRequests: 0 }); console.log('NATIVE_TOOLS_FAILED'); });
    return async () => { clearTimeout(timer); lifetime.abort(); await run; for (const release of releases.reverse()) release(); };
  });
}
