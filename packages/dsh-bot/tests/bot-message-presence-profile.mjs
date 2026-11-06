// Native Host, real bot_message tool and messaging pipeline; model replies are scripted.
import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
export const name = 'bot-message-presence-probe';
export const inject = ['loader', 'llm', 'agents', 'dshBots', 'sessionController', 'sessions', 'webServer', 'schedule'];
const QUESTION = 'Are the release notes for 0.7 ready to publish?';
const ANSWER = 'Ready, except the migration section still needs one example.';
const ASK = 'Ask Reviewer whether the release notes are ready.';
const text = message => (Array.isArray(message?.content) ? message.content : []).filter(b => b.type === 'text').map(b => b.text).join('\n');
// The sender's own "sent" notice is history, not a new instruction to act on.
const lastInstruction = messages => messages.findLast(m => m.role === 'tool' || (m.role === 'user' && !text(m).startsWith('Sent to ')));
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), disposers = [];
    let mains = {}, bots = [], saving = Promise.resolve(), modelRequests = 0, nativeScheduleApi;
    const save = (extra = {}) => {
      const json = JSON.stringify({ bots: bots.map(b => ({ id: b.id, name: b.name })), mains, modelRequests, realModelRequests: 0, nativeScheduleApi, ...extra }, null, 2);
      saving = saving.then(async () => { const tmp = resolve(config.outputDir, 'presence.tmp'); await writeFile(tmp, json); await rename(tmp, resolve(config.outputDir, 'presence.json')); });
      return saving;
    };
    const say = function* (value, index = 0) {
      yield { type: 'block-start', index, blockType: 'text' };
      yield { type: 'text-delta', index, text: value };
      yield { type: 'block-end', index, block: { type: 'text', text: value } };
    };
    const call = function* (args, index) {
      const id = ToolCallId(randomUUID()), json = JSON.stringify(args);
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index, id, name: 'bot_message', argumentsDelta: json };
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: 'bot_message', arguments: json } };
    };
    class Adapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Presence test' }]; }
      async resolveModel(provider, id) { return { provider, id, name: 'Presence test' }; }
      async *stream(options) {
        modelRequests++;
        const who = Object.entries(mains).find(([, sessionId]) => sessionId === options.sessionId)?.[0];
        // One-shot helpers (titles) carry no tools and never belong to the scripted exchange.
        if (!who || !options.tools?.length) { yield* say('Release notes check'); yield { type: 'finish', reason: { kind: 'stop' } }; return; }
        const last = lastInstruction(options.messages), body = text(last);
        if (who === 'planner') {
          if (last?.role === 'tool') yield* say('I asked Reviewer and will pass on the answer when it arrives.');
          else if (body.includes('Mode reply.')) yield* say(`Reviewer replied: ${ANSWER}`);
          else if (body !== ASK) yield* say('Hello.');
          else {
            yield* say('I will ask Reviewer.');
            yield* call({ action: 'send', to: 'reviewer', mode: 'ask', priority: 'normal', content: QUESTION }, 1);
            yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
          }
        } else if (last?.role === 'tool') yield* say('Replied to Planner.');
        else if (!body.includes('Mode ask.')) yield* say('Hello.');
        else {
          const replyTo = body.match(/replyTo=("[^"]+")/)?.[1]; assert.ok(replyTo, 'ask relay names its reply target');
          yield* call({ action: 'reply', replyTo: JSON.parse(replyTo), content: ANSWER }, 0);
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      disposers.push(ctx.llm.registerAdapter(['dp-loopback'], new Adapter()));
      // Approval is the native gate; this isolated fixture grants each request once.
      disposers.push(ctx.on('approval/request', async () => 'allowed-once', { prepend: true }));
      await ctx.dshBots.waitUntilReady();
      for (const [id, botName, description] of [['planner', 'Planner', 'Plans releases'], ['reviewer', 'Reviewer', 'Reviews release notes']])
        bots.push(await ctx.dshBots.create({ id, name: botName, description, template: 'standard', model: { provider: 'dp-loopback', model: 'fixture' } }));
      for (const bot of bots) mains[bot.id] = (await ctx.dshBots.openConversation(bot.id)).sessionId;
      const deadline = Date.now() + 45000;
      while (!ctx.get('dshBotMessaging')) { assert.ok(Date.now() < deadline, 'messaging ready'); await delay(50, undefined, { signal: controller.signal }); }
      const agents = {};
      for (const [id, sessionId] of Object.entries(mains)) { const r = await ctx.sessionController.resolveAgent(sessionId); if ('error' in r) throw r.error; agents[id] = r.agent; }
      const prompt = async (agent, value) => { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] })); await agent.whenIdle(); };
      // A first turn also carries the native skill catalog, which messaging provenance rejects; start each chat first.
      for (const agent of Object.values(agents)) await prompt(agent, 'Hello');
      agents.planner.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: ASK }] }));
      const events = id => ctx.agents.get(id)?.session.snapshotEvents() ?? [];
      const answered = () => {
        const list = events(mains.planner), at = list.findLastIndex(e => e.type === 'user/message' && e.data.source?.kind === 'dsh-bot-message' && e.data.source.mode === 'reply');
        return at >= 0 && list.slice(at).some(e => e.type === 'turn/end');
      };
      while (!answered()) { assert.ok(Date.now() < deadline, 'reply reaches the sender and its turn ends'); await delay(50, undefined, { signal: controller.signal }); }
      for (const id of Object.values(mains)) { const agent = ctx.agents.get(id); await agent?.whenIdle(); if (agent) assert.equal(await ctx.sessions.flush(agent.session), true); }
      // A future synthetic reminder exercises the nested editor without running another task.
      const reminder = { title: 'Synthetic release review', prompt: 'Review synthetic release notes.' };
      nativeScheduleApi = typeof ctx.schedule.edit === 'function' ? 'request-target' : 'session-first';
      // rc.2 uses a session-first request; 0.2.2 exposes edit() and an explicit timing/target request.
      if (typeof ctx.schedule.edit === 'function') await ctx.schedule.create({ ...reminder,
        timing: { kind: 'after', after_seconds: 86400 }, target: { kind: 'session', sessionId: mains.planner } }, mains.planner);
      else await ctx.schedule.create(mains.planner, { ...reminder, after_seconds: 86400 });
      const sources = id => events(id).filter(e => e.type === 'user/message' && String(e.data.source?.kind).startsWith('dsh-bot-message'))
        .map(e => ({ seq: e.seq, kind: e.data.source.kind, mode: e.data.source.mode, from: e.data.source.from?.botId, to: e.data.source.to?.botId }));
      await save({ planner: sources(mains.planner), reviewer: sources(mains.reviewer), question: QUESTION, answer: ANSWER });
      console.log('B4_WEB_READY');
    })().catch(async error => {
      // Failure evidence only: event kinds and message routing state, no content beyond the scripted text.
      const trace = Object.fromEntries(Object.entries(mains).map(([id, sessionId]) => [id, (ctx.agents.get(sessionId)?.session.snapshotEvents() ?? [])
        .map(e => [e.seq, e.type, e.data?.source?.kind, e.data?.reason?.kind, e.data?.name].filter(v => v !== undefined))]));
      const rows = ctx.get('dshBotMessaging')?.store.rows().map(r => ({ mode: r.envelope.mode, delivery: r.delivery, processing: r.processing, response: r.response, error: r.lastErrorCode }));
      await writeFile(resolve(config.outputDir, 'fixture-error.txt'), `${String(error.stack)}\n${JSON.stringify({ modelRequests, trace, rows }, null, 1)}`);
      console.error('B4_WEB_FAILED', error);
    });
    return async () => { controller.abort(); for (const dispose of disposers.reverse()) dispose(); await run; };
  });
}
