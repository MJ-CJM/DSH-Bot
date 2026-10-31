/** R03: real Web Host, native spawn and settlement, local mock HTTP only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'r03-probes';
export const inject = ['loader', 'dshBots', 'dshBotAutomation', 'dshBotAutomationStores', 'subagents',
  'agents', 'sessions', 'sessionController', 'tools', 'approval'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let stopping = false;
    const save = (name, value) => writeFile(resolve(config.outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
    const wait = async check => {
      const until = Date.now() + 60000;
      while (!stopping && Date.now() < until) { const result = await check(); if (result) return result; await delay(20); }
      throw new Error('R03 Host probe deadline');
    };
    const approvals = []; const lifecycle = [];
    const offStart = ctx.on('subagent/start', info => { lifecycle.push({ type: 'start', ...info }); });
    const offEnd = ctx.on('subagent/end', info => { lifecycle.push({ type: 'end', ...info }); });
    const off = ctx.on('approval/request', async request => {
      if (request.toolName !== 'bot_delegate') return 'rejected';
      approvals.push({ toolName: request.toolName, reason: request.reason, displayReason: request.displayReason });
      return request.reason.includes('R03_REJECT') ? 'rejected' : 'allowed-once';
    }, { prepend: true });
    const task = (async () => {
      await ctx.loader.await(); if (stopping) return;
      assert.equal(new URL(config.baseURL).hostname, '127.0.0.1');
      await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      await ctx.dshBots.update('researcher', { persona: { prefix: 'R03_TARGET_PERSONA: You are the target research Bot.' } });
      const status = (await ctx.dshBots.status()).find(row => row.id === 'assistant');
      const targetStatus = (await ctx.dshBots.status()).find(row => row.id === 'researcher');
      assert.equal(status.preset.state, 'ok'); assert.equal(targetStatus.preset.state, 'ok');
      await ctx.dshBots.ensureBotsWorkspace();
      const created = await ctx.dshBots.openConversation('assistant');
      const origin = ctx.agents.get(created.sessionId); assert.ok(origin);
      origin.session.append('turn/start', { turn: 0 });
      const denied = await ctx.tools.execute({ agent: origin, name: 'bot_delegate', callId: ToolCallId(randomUUID()),
        arguments: { targetBotId: 'researcher', task: 'R03_REJECT' }, signal: new AbortController().signal });
      origin.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
      assert.equal(denied.isError, true); assert.equal((await ctx.subagents.listChildren(origin.id)).length, 0);
      assert.equal(approvals.length, 1);
      await ctx.sessionController.prompt({ sessionId: origin.id, requestId: randomUUID(), mode: 'queue',
        content: [{ type: 'text', text: 'R03_PARENT_PRIVATE_HISTORY: delegate the target task.' }] }, new AbortController().signal);
      const report = await wait(() => origin.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.source.kind === 'subagent-settled'));
      await origin.whenIdle();
      const child = (await ctx.subagents.listChildren(origin.id))[0]; assert.ok(child);
      const view = await ctx.sessionController.inspect(child.id);
      assert.equal(view.meta.agentPreset, targetStatus.presetId);
      assert.equal(view.meta.parentSession, origin.id); assert.equal(view.meta.origin, 'subagent');
      assert.equal(view.meta.isSeeded, false); assert.equal(view.meta.delegationDepth, 1);
      assert.ok(JSON.stringify(report.data).includes('R03_TARGET_COMPLETED'));
      assert.equal(origin.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'subagent-settled').length, 1);
      const accepted = origin.session.snapshotEvents().find(e => e.type === 'tool/result' && !e.data.message.isError);
      assert.ok(accepted); assert.deepEqual(JSON.parse(accepted.data.message.content[0].text), { childId: child.id, status: 'accepted' });
      assert.equal(ctx.dshBotAutomationStores.runs.list().length, 0, 'no duplicate local execution or outbox');
      assert.equal(await ctx.sessions.flush(origin.session), true);
      await save('origin.json', await ctx.sessionController.inspect(origin.id));
      await save('target.json', view); await save('approvals.json', approvals); await save('lifecycle.json', lifecycle);
      const activities = await ctx.dshBots.listActivity();
      const mains = await ctx.dshBots.status();
      assert.ok(!activities.sessions.some(row => row.sessionId === child.id));
      assert.ok(!mains.some(row => row.mainSessionId === child.id));
      assert.equal(mains.find(row => row.id === 'assistant').mainSessionId, origin.id);
      assert.equal(mains.find(row => row.id === 'researcher').mainSessionId, undefined);
      await save('host-result.json', { status: 'PASS', origin: origin.id, child: child.id, presetId: targetStatus.presetId,
        nativeReport: report.data, localRuns: 0, childHiddenFromBots: true, mainSessionId: origin.id });
      console.log('R03_DONE');
    })().catch(async error => { await save('fatal.json', { error: String(error), stack: error.stack }); console.log('R03_FAILED'); });
    return async () => { stopping = true; off(); offStart(); offEnd(); await task; await save('disposed.json', { disposed: true }); };
  });
}
