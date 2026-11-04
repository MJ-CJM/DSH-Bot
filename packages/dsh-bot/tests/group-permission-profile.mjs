// Native Host, public APIs and real file tools; all responses are scripted.
import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'group-permission-probe';
export const inject = ['loader', 'llm', 'agents', 'dshBots', 'permissionPresets', 'webServer'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), disposers = [], receipts = [];
    let group, approvalAnswerers = 0, saving = Promise.resolve();
    const modelToolStep = new Set();
    const save = () => { const json = JSON.stringify({ group, receipts, approvalAnswerers, realModelRequests: 0 }, null, 2); saving = saving.then(async () => { const tmp = resolve(config.outputDir, 'permissions.tmp'); await writeFile(tmp, json); await rename(tmp, resolve(config.outputDir, 'permissions.json')); }); return saving; };
    class Adapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Permission test' }]; }
      async resolveModel(provider, id) { return { provider, id, name: 'Permission test' }; }
      async *stream(options) {
        await fetch(config.endpoint, { method: 'POST', body: JSON.stringify({ sessionId: options.sessionId }) });
        const agent = ctx.agents.get(options.sessionId); assert.ok(agent);
        // First step: a model-emitted write outside the workspace, so the native loop logs a real tool/result denial.
        if (!modelToolStep.has(options.sessionId)) {
          modelToolStep.add(options.sessionId);
          const id = ToolCallId(randomUUID()), args = JSON.stringify({ file_path: resolve(config.outputDir, `model-outside-${agent.id}.txt`), content: 'MUST_NOT_WRITE' });
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        try {
        const file = resolve(group.cwd, `permission-${options.sessionId}.txt`);
        const call = async (name, args) => {
          try { return await agent.ctx.get('tools').execute({ agent, name, arguments: args, callId: ToolCallId(randomUUID()), signal: options.signal }); }
          catch (error) { return { error: String(error) }; }
        };
        const read = await call('read', { file_path: resolve(group.cwd, 'seed.txt') });
        const write = await call('write', { file_path: file, content: 'ISSUE_26_WRITE' });
        const outsideFile = resolve(config.outputDir, `outside-workspace-${agent.id}.txt`);
        const outsideWrite = await call('write', { file_path: outsideFile, content: 'MUST_NOT_WRITE' });
        const approval = await agent.ctx.get('approval').request({ agent, toolName: 'issue-26-probe', reason: 'Synthetic approval policy check', signal: options.signal });
        const policy = () => ({ sandbox: agent.session.snapshotEvents().findLast(e => e.type === 'sandbox/mode')?.data.mode,
          approval: agent.session.snapshotEvents().findLast(e => e.type === 'approval/policy')?.data.policy });
        const modelDenial = agent.session.snapshotEvents().findLast(e => e.type === 'tool/result')?.data.error ?? null;
        receipts.push({ childId: agent.id, ...policy(), read, write, approvalOutcome: approval, modelDenial,
          written: await readFile(file, 'utf8').catch(() => null), outsideWrite, outsideWritten: await readFile(outsideFile, 'utf8').catch(() => null) });
        await save();
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        yield { type: 'reasoning-delta', index: 0, text: 'Synthetic task held for access mode verification.' };
        try { await delay(180000, undefined, { signal: options.signal }); }
        finally { const row = receipts.find(row => row.childId === agent.id); Object.assign(row, { finalPolicy: policy() }); await save(); }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Synthetic task.' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        } catch (error) { if (!options.signal.aborted) await writeFile(resolve(config.outputDir, `stream-error-${agent.id}.txt`), String(error.stack)); throw error; }
      }
    }
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      disposers.push(ctx.llm.registerAdapter(['dp-loopback'], new Adapter()));
      disposers.push(ctx.on('approval/request', () => { approvalAnswerers++; return 'rejected'; }));
      await ctx.dshBots.waitUntilReady();
      const bot = await ctx.dshBots.create({ id: 'permission-bot', name: 'Permission Bot', template: 'standard', model: { provider: 'dp-loopback', model: 'fixture' } });
      const secondBot = await ctx.dshBots.create({ id: 'permission-reviewer', name: 'Permission Reviewer', template: 'standard', model: { provider: 'dp-loopback', model: 'fixture' } });
      const groups = ctx.get('dshBotGroups'); assert.ok(groups);
      group = await groups.create({ operationId: 'permission-group', name: 'Permission test group', mode: 'natural', historyConfirmed: true,
        members: [bot, secondBot].map(b => ({ botId: b.id, botCreatedAt: b.createdAt })) });
      await writeFile(resolve(group.cwd, 'seed.txt'), 'ISSUE_26_READ');
      ctx.permissionPresets.set(ctx.agents.get(group.rootSessionId).session, 'read-only');
      await groups.send({ groupId: group.id, groupCreatedAt: group.createdAt }, { operationId: 'first', text: 'Read-only permission test', expectedMembershipRevision: 1 });
      const deadline = Date.now() + 30000;
      while (receipts.length < 2) { assert.ok(Date.now() < deadline); await delay(30, undefined, { signal: controller.signal }); }
      await save(); console.log('B4_WEB_READY');
    })().catch(async error => { await writeFile(resolve(config.outputDir, 'fixture-error.txt'), String(error.stack)); console.error('B4_WEB_FAILED', error); });
    return async () => { controller.abort(); for (const dispose of disposers.reverse()) dispose(); await run; };
  });
}
