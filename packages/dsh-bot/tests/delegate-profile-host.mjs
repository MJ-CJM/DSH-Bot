/** Test-only observer. Product services, real approval audit and local mock HTTP. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 't15-probes';
export const inject = ['loader', 'dshBots', 'dshBotAutomation', 'dshBotAutomationStores', 'dshBotSubmitter', 'dshBotReporter',
  'agents', 'sessions', 'sessionController', 'workspaceRegistry', 'tools', 'approval'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let stopping = false;
    const save = (name, value) => writeFile(resolve(config.outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
    const wait = async check => {
      const until = Date.now() + 45000;
      while (!stopping && Date.now() < until) { const result = await check(); if (result) return result; await delay(20); }
      throw new Error('T15 Host probe deadline');
    };
    const approvals = [];
    const off = ctx.on('approval/request', async request => {
      if (request.toolName !== 'bot_delegate') return 'rejected';
      approvals.push({ toolName: request.toolName, reason: request.reason, displayReason: request.displayReason });
      return request.reason.includes('T15_REJECT') ? 'rejected' : 'allowed-once';
    }, { prepend: true });
    const task = (async () => {
      await ctx.loader.await(); if (stopping) return;
      assert.equal(new URL(config.baseURL).hostname, '127.0.0.1');
      await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      const stores = ctx.dshBotAutomationStores;
      const reportInputs = agent => agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'dsh-bot-delegate');
      const createOrigin = async (botId = 'assistant') => {
        const bot = await ctx.dshBots.get(botId); const status = (await ctx.dshBots.status()).find(row => row.id === botId);
        assert.equal(status.preset.state, 'ok'); const workspace = await ctx.dshBots.ensureBotsWorkspace();
        const created = await ctx.sessionController.create({ workspaceId: workspace.workspaceId, agentPreset: status.presetId });
        const agent = ctx.agents.get(created.sessionId); assert.ok(agent); assert.equal(await ctx.sessions.flush(agent.session), true);
        return { bot, agent, workspace };
      };
      if (config.phase === 'first') {
        const { agent: origin, workspace } = await createOrigin();
        // Native approval rejection, before any queue or model side effect.
        origin.session.append('turn/start', { turn: 0 });
        const denied = await ctx.tools.execute({ agent: origin, name: 'bot_delegate', callId: ToolCallId(randomUUID()),
          arguments: { targetBotId: 'researcher', task: 'T15_REJECT' }, signal: new AbortController().signal });
        origin.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
        assert.equal(denied.isError, true); assert.equal(stores.runs.list().length, 0);
        assert.equal(approvals.length, 1); assert.ok(approvals[0].reason.includes('T15_REJECT'));
        const requestId = randomUUID();
        await ctx.sessionController.prompt({ sessionId: origin.id, requestId, mode: 'queue', content: [{ type: 'text', text: 'T15_PARENT_PRIVATE_HISTORY: delegate the public task.' }] }, new AbortController().signal);
        let run = await wait(() => stores.runs.list().find(r => r.trigger === 'delegate' && r.originSessionId === origin.id));
        run = await wait(() => { const row = stores.runs.get(run.id); return row.report?.state === 'sent' ? row : undefined; });
        await origin.whenIdle(); assert.equal(await ctx.sessions.flush(origin.session), true);
        assert.equal(run.status, 'succeeded'); assert.equal(run.snapshot.prompt, 'T15_TARGET_TASK'); assert.equal(run.botId, 'researcher');
        assert.equal(run.originBotId, 'assistant'); assert.equal(run.depth, 1); assert.equal(run.summary, '[redacted]');
        assert.equal(reportInputs(origin).length, 1); assert.equal(reportInputs(origin)[0].data.id, run.report.messageId);
        assert.ok(reportInputs(origin)[0].data.content[0].text.includes('[redacted]'));
        const target = ctx.agents.get(run.sessionId); assert.ok(target);
        const targetEvents = target.session.snapshotEvents();
        const targetInput = targetEvents.find(e => e.type === 'user/message' && e.data.source.kind === 'user');
        assert.deepEqual(targetInput.data.content, [{ type: 'text', text: 'T15_TARGET_TASK' }]);
        assert.ok(ctx.workspaceRegistry.get(workspace.workspaceId).sessionIds.includes(target.id));
        const view = await ctx.sessionController.inspect(target.id); assert.equal(view.meta.agentPreset, run.snapshot.presetId);
        const results = agent => agent.session.snapshotEvents().filter(e => e.type === 'tool/result');
        const accepted = results(origin).find(e => !e.data.message.isError);
        assert.ok(accepted.time < run.endedAt, 'tool returned before target completion');
        assert.deepEqual(JSON.parse(accepted.data.message.content[0].text), { runId: run.id, sessionId: run.sessionId, status: 'queued' });
        const originEvents = origin.session.snapshotEvents();
        const inserted = originEvents.find(e => e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => m.id === run.report.messageId));
        const firstEnd = originEvents.find(e => e.type === 'turn/end' && e.data.turn === 1);
        assert.ok(inserted.seq < firstEnd.seq, 'report queued while originating turn was still busy');
        assert.equal(firstEnd.data.reason.kind, 'completed', 'followup did not interrupt original turn');
        assert.ok(results(target).some(e => JSON.stringify(e.data).includes('automation/depth')), 'target cannot re-delegate');
        assert.ok(results(origin).some(e => JSON.stringify(e.data).includes('automation/depth')), 'report turn cannot re-delegate');
        assert.equal(stores.runs.list().length, 1, 'recursive attempts produced no runs');
        await ctx.dshBotReporter.tick(); assert.equal(reportInputs(origin).length, 1);
        await save('main-origin.json', await ctx.sessionController.inspect(origin.id));
        await save('main-target.json', view); await save('main-run.json', run); await save('approvals.json', approvals);

        // Stage safe terminal reports before cold start. These cancelled fixture
        // runs exercise the outbox, not target model execution.
        await ctx.dshBotReporter.close();
        const pending = [];
        await ctx.dshBots.create({ id: 'rebuilt', name: 'Rebuilt', template: 'minimal' });
        for (const scenario of ['cold', 'archived', 'missing', 'rebuilt']) {
          const item = await createOrigin(scenario === 'rebuilt' ? 'rebuilt' : 'assistant');
          const originSessionId = scenario === 'missing' ? `session-${randomUUID()}` : item.agent.id;
          let staged = await stores.runs.enqueue({ trigger: 'delegate', botId: 'researcher', operationId: randomUUID(),
            title: 'Cold report fixture', prompt: 'Cancelled before execution', originSessionId,
            originBotId: item.bot.id, originBotCreatedAt: item.bot.createdAt });
          staged = await stores.runs.transition(staged.id, 'cancelled', staged.revision, {}, true);
          if (scenario === 'archived') await ctx.workspaceRegistry.archiveSession(item.agent.id);
          if (scenario === 'rebuilt') { await ctx.dshBots.remove('rebuilt'); await ctx.dshBots.create({ id: 'rebuilt', name: 'New identity', template: 'minimal' }); }
          pending.push({ scenario, run: staged });
        }
        await save('pending.json', pending);
        await save('first.json', { status: 'PASS', mainRunId: run.id, pending, approvals: approvals.length });
      } else {
        const prior = JSON.parse(await readFile(resolve(config.outputDir, 'pending.json'), 'utf8'));
        const evidence = [];
        for (const { scenario, run } of prior) {
          const row = await wait(() => { const r = stores.runs.get(run.id); return r.report && r.report.state !== 'pending' ? r : undefined; });
          assert.equal(row.report.state, scenario === 'cold' ? 'sent' : 'blocked', `${scenario}: ${JSON.stringify(row.report)}`);
          if (scenario === 'cold') {
            const resolved = await ctx.sessionController.resolveAgent(row.originSessionId); assert.ok(!('error' in resolved));
            await resolved.agent.whenIdle(); assert.equal(reportInputs(resolved.agent).length, 1);
            assert.equal(await ctx.sessions.flush(resolved.agent.session), true);
            assert.ok(resolved.agent.session.snapshotEvents().some(e => e.type === 'turn/end' && e.data.reason.kind === 'completed'));
            await save(`${config.phase}-origin.json`, await ctx.sessionController.inspect(row.originSessionId));
          }
          evidence.push({ scenario, run: row });
        }
        const main = JSON.parse(await readFile(resolve(config.outputDir, 'main-run.json'), 'utf8'));
        assert.equal(stores.runs.get(main.id).report.messageId, main.report.messageId);
        assert.equal(stores.runs.get(main.id).report.attempts, 1);
        await save(`${config.phase}.json`, { status: 'PASS', evidence });
      }
      console.log('T15_DONE');
    })().catch(async error => { await save(`${config.phase}-fatal.json`, { error: String(error), stack: error.stack }); console.log('T15_FAILED'); });
    return async () => { stopping = true; off(); await task; await save(`${config.phase}-disposed.json`, { disposed: true }); };
  });
}
