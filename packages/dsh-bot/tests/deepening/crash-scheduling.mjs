import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkpoint } from './crash-checkpoint.mjs';
import { crashBusiness } from './crash-business.mjs';

export async function crashScheduling(ctx, config, adapter) {
  const registry = ctx.dshBots, crash = config.phase === 'crash', file = resolve(config.outputDir, 'identity.json');
  if (crash) await registry.create({ id: 'alpha', name: 'Alpha', template: 'minimal',
    model: { provider: 'dp-b6b', model: 'fixture' }, persona: { prefix: 'Synthetic crash schedule.' } });
  if (crash && config.window.startsWith('main-')) {
    const create = ctx.sessionController.create.bind(ctx.sessionController), flush = ctx.sessions.flush.bind(ctx.sessions);
    let created;
    ctx.sessionController.create = async (...args) => {
      const result = await create(...args); created = result.sessionId;
      if (config.window === 'main-create') {
        await writeFile(file, JSON.stringify({ created, phase: 'create-returned-before-main-header-flush' }), { flag: 'wx' });
        await checkpoint(config, { phase: 'create-returned-before-main-header-flush', sessionId: created });
      }
      return result;
    };
    ctx.sessions.flush = async session => {
      const result = await flush(session);
      if (config.window === 'main-flush' && session.id === created) {
        assert.equal(result, true);
        await writeFile(file, JSON.stringify({ created, phase: 'header-flushed-before-binding' }), { flag: 'wx' });
        await checkpoint(config, { phase: 'main-header-durable-before-binding', sessionId: created });
      }
      return result;
    };
    await registry.openConversation('alpha'); throw new Error('Main-session crash checkpoint not reached');
  }
  const main = await registry.openConversation('alpha');
  const resolved = await ctx.sessionController.resolveAgent(main.sessionId); assert.ok(resolved.agent);
  const agent = resolved.agent;
  if (config.window === 'business-submission') return crashBusiness(ctx, config, adapter, agent, await registry.get('alpha'));
  if (config.window.startsWith('main-')) {
    const old = JSON.parse(await readFile(file));
    if (config.window === 'main-flush') assert.equal(main.sessionId, old.created);
    const opens = await Promise.all(Array.from({ length: 10 }, () => registry.openConversation('alpha')));
    assert.ok(opens.every(row => row.sessionId === main.sessionId));
    const list = await ctx.sessionController.list({}, new AbortController().signal);
    const eligible = list.items.filter(row => !row.parentSessionId && row.projections?.values.agentPreset === 'bot-alpha');
    assert.equal(eligible.length, 1);
    return { old, main, eligibleMainCount: 1, concurrentOpens: 10, historyInspected: false };
  }
  const schedule = ctx.get('schedule'); assert.ok(schedule, 'Native schedule service required');
  const reminders = () => agent.session.snapshotEvents().filter(event => event.type === 'user/message' &&
    JSON.stringify(event.data.source).includes('schedule'));
  if (crash) {
    let task;
    const flush = ctx.sessions.flush.bind(ctx.sessions);
    ctx.sessions.flush = async session => {
      const result = await flush(session);
      if (task && session.id === main.sessionId && reminders().length) {
        assert.equal(result, true);
        await checkpoint(config, { phase: 'native-reminder-durable-before-task-progress', scheduleId: task.id,
          sessionId: main.sessionId, occurrences: reminders().length });
      }
      return result;
    };
    task = await schedule.create(main.sessionId, { after_seconds: 1, title: 'B7 synthetic', prompt: 'B7_REMINDER_ONLY' });
    await writeFile(file, JSON.stringify({ sessionId: main.sessionId, scheduleId: task.id,
      lastConfirmedPhase: 'created', businessExecution: 'NOT_RUN: no business adapter is installed' }), { flag: 'wx' });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  const old = JSON.parse(await readFile(file)); assert.equal(main.sessionId, old.sessionId);
  const deadline = Date.now() + 10000;
  let history;
  while (Date.now() < deadline) {
    history = await schedule.history({ sessionId: main.sessionId, id: old.scheduleId, limit: 100 });
    if (history.records.length) break;
    await delay(20);
  }
  assert.ok(history?.records.length, 'Native delivery did not reconcile');
  await agent.whenIdle(); assert.equal(await ctx.sessions.flush(agent.session), true);
  assert.ok(reminders().length >= 1);
  return { ...old, nativeReceipts: history.records, reminders: reminders().length, fixtureRequests: adapter.requests,
    exactlyOnce: false, businessReplay: 'FAIL (NOT_RUN): reminder transport does not provide business deduplication' };
}
