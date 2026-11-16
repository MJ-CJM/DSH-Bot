import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
export const name = 'supergroup-browser-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController'];
const cases = ['en-light-1360', 'en-dark-390', 'zh-light-390', 'zh-dark-1360'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), mainCases = new Map(), childSteps = new Map(), calls = [], releases = [];
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const gate = async (name, signal) => {
      while (!await readFile(resolve(config.outputDir, name), 'utf8').catch(() => '')) {
        signal?.throwIfAborted(); lifetime.signal.throwIfAborted(); await delay(30, undefined, { signal: signal ?? lifetime.signal });
      }
    };
    class Adapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic Supergroup browser' }]; }
      async *stream(options) {
        const agent = ctx.agents.get(options.sessionId); assert.ok(agent);
        const events = agent.session.snapshotEvents(), source = events.findLast(event => event.type === 'user/message');
        const text = JSON.stringify(events.filter(event => event.type === 'user/message').map(event => event.data.content));
        const mainCase = mainCases.get(agent.id), caseId = mainCase ?? text.match(/SG_UI_CASE_([a-z]+-(?:light|dark)-\d+)/)?.[1];
        const step = childSteps.get(agent.id) ?? 0; childSteps.set(agent.id, step + 1);
        calls.push({ sessionId: agent.id, preset: agent.session.header.agentPreset, source: source?.data.source.kind, caseId, step });
        await save('calls', calls);
        let tool;
        if (mainCase && text.includes('SG_UI_CASE_')) {
          const started = events.some(event => event.type === 'tool/call' && event.data.name === 'bot_supergroup');
          if (!started) tool = { name: 'bot_supergroup', args: { action: 'start', memberIds: ['sgui-alpha', 'sgui-beta'] } };
        } else if (agent.session.header.agentPreset?.endsWith('sgui-alpha') && step === 0) {
          assert.ok(caseId, `Browser case missing from child input: ${agent.id}`);
          const reasoning = `SG_NATIVE_REASONING_${caseId}: review supplied task, identify missing migration expertise.`;
          yield { type: 'block-start', index: 0, blockType: 'reasoning' };
          yield { type: 'reasoning-delta', index: 0, text: reasoning };
          await gate(`release-expert-${caseId}.json`, options.signal);
          yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } };
          tool = { name: 'group_message', args: { action: 'request-expert', botId: 'sgui-gamma', question: `SG_UI_CASE_${caseId}: review migration risks.` } };
        } else if (agent.session.header.agentPreset?.endsWith('sgui-gamma')) {
          assert.ok(caseId);
          const reasoning = `SG_EXPERT_REASONING_${caseId}: independently verify the staged migration.`;
          yield { type: 'block-start', index: 0, blockType: 'reasoning' };
          yield { type: 'reasoning-delta', index: 0, text: reasoning };
          try { await gate(`release-result-${caseId}.json`, options.signal); }
          catch (error) { await save(`cancelled-${caseId}`, { childId: agent.id, aborted: true }); throw error; }
          yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } };
        }
        if (tool) {
          const index = mainCase ? 0 : 1, id = ToolCallId(`sgui-${crypto.randomUUID()}`), args = JSON.stringify(tool.args);
          yield { type: 'block-start', index, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index, id, name: tool.name, argumentsDelta: args };
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: tool.name, arguments: args } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        }
        const answer = mainCase ? 'SG_BROWSER_MAIN_REPLY' : 'SG_BROWSER_MEMBER_RESULT';
        const index = agent.session.header.agentPreset?.endsWith('sgui-gamma') ? 1 : 0;
        yield { type: 'block-start', index, blockType: 'text' }; yield { type: 'text-delta', index, text: answer };
        yield { type: 'block-end', index, block: { type: 'text', text: answer } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady(); assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-loopback'], new Adapter()));
      const previous = await readFile(resolve(config.outputDir, 'browser-fixture.json'), 'utf8').then(JSON.parse).catch(() => undefined);
      const existing = await ctx.dshBots.list();
      for (const id of ['sgui-alpha', 'sgui-beta', 'sgui-gamma', ...cases.map(id => `sgui-${id}`)]) {
        if (existing.some(bot => bot.id === id)) continue;
        await ctx.dshBots.create({ id, name: id, description: `Synthetic existing Bot ${id}`, template: 'minimal',
          persona: { prefix: `SG_UI_PERSONA_${id}` }, model: { provider: 'dp-loopback', model: 'fixture' }, memory: { enabled: false, injectLimit: 20 } });
      }
      const sessions = {};
      for (const id of cases) {
        let main;
        const mainDeadline = Date.now() + 45000;
        while (!main) {
          try { main = await ctx.dshBots.openConversation(`sgui-${id}`); }
          catch (error) {
            if (!String(error).includes('Main sessions are starting') || Date.now() >= mainDeadline) throw error;
            await delay(30, undefined, { signal: lifetime.signal });
          }
        }
        mainCases.set(main.sessionId, id); sessions[id] = main.sessionId;
        const { agent } = await ctx.sessionController.resolveAgent(main.sessionId); assert.ok(agent);
        if (!previous) {
          agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `SG_UI_READY_${id}` }] }));
          await agent.whenIdle(); await ctx.sessions.flush(agent.session);
        } else assert.equal(main.sessionId, previous.sessions[id], 'Cold restart must preserve exact Bot main conversation');
      }
      await save('calls', calls);
      await save('browser-fixture', { sessions, realModelRequests: 0 }); console.log('B4_WEB_READY');
      // Test-only observer writes exact public work/Group snapshots for driver
      // assertions; it never starts work or manufactures Client projection state.
      while (!lifetime.signal.aborted) {
        for (const [sessionId, id] of mainCases) {
          const agent = ctx.agents.get(sessionId);
          const input = agent?.session.snapshotEvents().findLast(event => event.type === 'user/message'
            && event.data.source.kind === 'user' && JSON.stringify(event.data.content).includes('SG_UI_CASE_'));
          if (!input) continue;
          const value = await ctx.dshBots.supergroup?.forSession({ sessionId, messageId: input.data.id });
          if (value) {
            await save(`work-${id}`, value);
            if (value.work.state === 'cancelled') {
              const childIds = [...new Set(value.group?.deliveries.flatMap(row => row.childSessionId ? [row.childSessionId] : []) ?? [])];
              if (childIds.length && childIds.every(childId => !ctx.agents.get(childId)))
                await save(`cleanup-${id}`, { workId: value.work.id, childIds, activeNativeChildren: 0 });
            }
          }
        }
        await delay(100, undefined, { signal: lifetime.signal });
      }
    })().catch(async error => {
      if (!lifetime.signal.aborted) { await save('browser-fixture-error', { error: String(error), stack: error.stack }); console.log('B4_WEB_FAILED'); }
    });
    return async () => { lifetime.abort(); await run; for (const release of releases.reverse()) release(); };
  }, 'supergroup browser fixture');
}
