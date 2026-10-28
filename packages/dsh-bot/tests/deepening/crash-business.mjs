import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkpoint } from './crash-checkpoint.mjs';

/** Reuse the existing explicit runNow/RunService ledger. No second scheduler or business journal. */
export async function crashBusiness(ctx, config, adapter, agent, bot) {
  const file = resolve(config.outputDir, 'identity.json'), registry = ctx.dshBots;
  const native = ctx.get('dshBotNativeSchedules'), runs = ctx.get('dshBotRuns'), notices = ctx.get('dshBotNotifications');
  assert.ok(native && runs && notices);
  const effects = () => notices.list().filter(row => row.text === 'B7_BUSINESS_EFFECT');
  if (config.phase === 'crash') {
    // A future native reminder is explicitly run once. Automatic reminder delivery is a separate crash window.
    const task = await ctx.get('schedule').create(agent.session.id,
      { after_seconds: 3600, title: 'B7 explicit business', prompt: 'B7_BUSINESS_TASK' });
    const expected = { title: task.title, prompt: task.prompt, botCreatedAt: bot.createdAt }, operationId = randomUUID();
    await notices.savePolicy({ id: 'b7-business-policy', owner: { botId: bot.id, botCreatedAt: bot.createdAt },
      channel: 'in-app', enabled: true, timezone: 'UTC', dailyLimit: 20, cooldownSec: 0, authorization: { mode: 'ask' } }, 0, true);
    adapter.plans.set(agent.session.id, [{ name: 'bot_notify', arguments: { policyId: 'b7-business-policy', text: 'B7_BUSINESS_EFFECT' } }]);
    const off = ctx.on('approval/request', async (request, next) =>
      request.toolName === 'bot_notify' ? 'allowed-once' : next(), { prepend: true });
    const prompt = ctx.sessionController.prompt.bind(ctx.sessionController);
    ctx.sessionController.prompt = async (...args) => {
      const receipt = await prompt(...args);
      if (args[0].content.some(block => block.text === 'B7_BUSINESS_TASK')) {
        assert.equal(receipt.accepted, true); await agent.whenIdle();
        assert.equal(await ctx.sessions.flush(agent.session), true); assert.equal(effects().length, 1);
        const run = (await runs.list({ nativeScheduleId: task.id }))[0];
        assert.equal(run.step, 'submitting');
        await writeFile(file, JSON.stringify({ sessionId: agent.session.id, nativeScheduleId: task.id,
          operationId, expected, runId: run.id, effectId: effects()[0].id }, null, 2), { flag: 'wx' });
        await checkpoint(config, { phase: 'business-effect-durable-before-delivery-receipt', runId: run.id, effects: 1 });
      }
      return receipt;
    };
    try { await native.runNow(task.id, operationId, expected, true); }
    finally { ctx.sessionController.prompt = prompt; off(); }
    throw new Error('Business crash checkpoint not reached');
  }
  const old = JSON.parse(await readFile(file)); assert.equal(agent.session.id, old.sessionId);
  assert.equal(effects().length, 1); assert.equal(effects()[0].id, old.effectId);
  let prompts = 0;
  const prompt = ctx.sessionController.prompt.bind(ctx.sessionController);
  ctx.sessionController.prompt = (...args) => { prompts++; return prompt(...args); };
  const before = adapter.requests;
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      native.runNow(old.nativeScheduleId, old.operationId, old.expected, true)));
    assert.ok(results.every(row => row.id === old.runId && row.status === 'recovery_needed' && row.lastConfirmedStep === 'submitting'));
    await agent.whenIdle(); assert.equal(prompts, 0); assert.equal(adapter.requests, before);
    assert.equal(effects().length, 1); assert.equal(effects()[0].id, old.effectId);
    assert.equal((await runs.list({ nativeScheduleId: old.nativeScheduleId })).length, 1);
    return { businessReplay: 'PASS', lastConfirmedPhase: 'submitting', status: 'unknown', effects: 1,
      duplicateRequests: 10, newPrompts: prompts, newAdapterRequests: adapter.requests - before, exactlyOnce: false,
      scope: 'explicit native runNow; durable in-app notification only', memoryBlocked: registry.memoryKernel.blocked };
  } finally { ctx.sessionController.prompt = prompt; }
}
