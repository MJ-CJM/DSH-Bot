// Actual native Host + bot_message pipeline; one scripted adapter, no warmup turn.
import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'bot-message-first-turn-probe';
export const inject = ['loader', 'llm', 'agents', 'dshBots', 'sessionController', 'sessions'];
const FIRST = 'FIRST_TURN: Ask the reviewer whether the synthetic release is ready.';
const NEVER = 'POLICY_NEVER: Ask the reviewer whether the synthetic policy review is ready.';
const ASK = 'POLICY_ASK: Ask the reviewer whether the synthetic policy review is ready.';
const QUESTIONS = { first: 'FIRST_TURN_QUESTION: Is the synthetic release ready?', policy: 'POLICY_QUESTION: Is the synthetic policy review ready?' };
const ANSWERS = { first: 'FIRST_TURN_ANSWER: The synthetic release is ready.', policy: 'POLICY_ANSWER: The synthetic policy review is ready.' };
const text = message => (Array.isArray(message?.content) ? message.content : []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const instructions = new Set([FIRST, NEVER, ASK]);
const lastInstruction = messages => messages.findLast(message => message.role === 'tool' || (message.role === 'user' &&
  (instructions.has(text(message)) || (!text(message).startsWith('Sent to ') && /Mode (ask|reply)\./.test(text(message))))));

export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), disposers = [], mains = {}, agents = {}, bots = {}, calls = new Map(), approvals = [], modelCalls = [];
    let modelRequests = 0;
    const events = id => agents[id]?.session.snapshotEvents() ?? [];
    const sources = id => events(id).filter(event => event.type === 'user/message').map(event => ({ seq: event.seq, kind: event.data.source.kind, mode: event.data.source.mode, text: text(event.data) }));
    const save = (file, value) => writeFile(resolve(config.outputDir, file), `${JSON.stringify(value, null, 2)}\n`);
    const say = function* (value, index = 0) {
      yield { type: 'block-start', index, blockType: 'text' };
      yield { type: 'text-delta', index, text: value };
      yield { type: 'block-end', index, block: { type: 'text', text: value } };
    };
    const call = function* (sessionId, args) {
      const id = ToolCallId(randomUUID()), json = JSON.stringify(args);
      calls.set(String(id), { sessionId, args });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'bot_message', argumentsDelta: json };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bot_message', arguments: json } };
    };
    class Adapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'First-turn messaging fixture' }]; }
      async resolveModel(provider, id) { return { provider, id, name: 'First-turn messaging fixture' }; }
      async *stream(options) {
        modelRequests++;
        const who = Object.keys(mains).find(id => mains[id] === options.sessionId);
        if (!who || !options.tools?.length) { yield* say('Synthetic first-turn messaging'); yield { type: 'finish', reason: { kind: 'stop' } }; return; }
        const last = lastInstruction(options.messages), body = text(last);
        modelCalls.push({ who, sessionId: options.sessionId, instruction: last?.role === 'tool' ? 'tool-result' : body,
          sourceKinds: options.messages.filter(message => message.role === 'user').map(message => message.source?.kind).filter(Boolean),
          ...(last?.role === 'tool' ? { toolResult: body } : {}) });
        if (last?.role === 'tool') yield* say('The native tool result has been recorded.');
        else if (instructions.has(body)) {
          const family = who.startsWith('first-') ? 'first' : 'policy';
          yield* call(options.sessionId, { action: 'send', to: `${family}-reviewer`, mode: 'ask', priority: 'normal', content: QUESTIONS[family] });
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        } else if (body.includes('Mode ask.')) {
          const family = who.startsWith('first-') ? 'first' : 'policy';
          const replyTo = body.match(/replyTo=("[^"]+")/)?.[1];
          assert.ok(replyTo, 'the actual relay supplies its exact reply target');
          yield* call(options.sessionId, { action: 'reply', replyTo: JSON.parse(replyTo), content: ANSWERS[family] });
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        } else if (body.includes('Mode reply.')) yield* say(`The reviewer answered: ${body.includes(ANSWERS.first) ? ANSWERS.first : ANSWERS.policy}`);
        else throw new Error(`Unexpected model instruction for ${who}`);
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const run = (async () => {
      await ctx.loader.await();
      assert.equal(globalThis[Symbol.for('dp.loopback.guard')], true);
      assert.deepEqual(ctx.llm.listProviders(), [], 'real provider adapters are disabled');
      disposers.push(ctx.llm.registerAdapter(['dp-loopback'], new Adapter()));
      disposers.push(ctx.on('approval/request', async request => {
        let planned = calls.get(String(request.callId)), exportTarget;
        const current = Object.keys(mains).find(id => mains[id] === request.agent.session.id);
        let exact = request.toolName === 'bot_message' && planned?.sessionId === request.agent.session.id && current
          && ((planned.args.action === 'send' && planned.args.to === `${current.split('-')[0]}-reviewer`
            && planned.args.content === QUESTIONS[current.split('-')[0]] && planned.args.mode === 'ask' && planned.args.priority === 'normal')
            || (planned.args.action === 'reply' && typeof planned.args.replyTo === 'string' && planned.args.content === ANSWERS[current.split('-')[0]]));
        // Native tool execution and this plugin's native data-export gate are
        // separate approvals. The latter has no callId: verify its complete
        // serialized envelope against the exact scripted call and Bot identities.
        if (request.toolName === 'dsh_bot_export_message' && current) {
          try {
            const lines = request.reason.split('\n'), prefix = 'Authorize this exact data export to ';
            assert.ok(lines[0].startsWith(prefix) && lines[0].endsWith('?'));
            const target = JSON.parse(lines[0].slice(prefix.length, -1)), data = JSON.parse(lines[1]);
            const envelope = data.envelope;
            planned = [...calls.values()].findLast(value => value.sessionId === request.agent.session.id
              && value.args.content === envelope.content && (value.args.action === 'reply' ? envelope.mode === 'reply' && value.args.replyTo === envelope.replyTo
                : value.args.action === 'send' && value.args.to === envelope.to.botId && value.args.mode === envelope.mode));
            const from = { botId: current, botCreatedAt: bots[current].createdAt };
            const peer = bots[envelope.to.botId]; assert.ok(peer);
            const to = { botId: peer.id, botCreatedAt: peer.createdAt };
            assert.deepEqual(target, { kind: 'bot', bot: to }); assert.deepEqual(envelope.from, from); assert.deepEqual(envelope.to, to);
            assert.equal(envelope.fromSessionId, request.agent.session.id); assert.equal(envelope.toSessionId, mains[peer.id]);
            assert.ok(planned && envelope.authorizationId.startsWith('native:'));
            assert.deepEqual(data.nativeInput.source.from, from); assert.deepEqual(data.nativeInput.source.to, to);
            assert.equal(data.nativeInput.source.kind, 'dsh-bot-message'); assert.equal(data.nativeInput.source.mode, envelope.mode);
            assert.equal(data.outgoingInput.source.kind, 'dsh-bot-message-sent');
            assert.ok(text(data.nativeInput).includes(envelope.content));
            exportTarget = target; exact = true;
          } catch { exact = false; }
        }
        approvals.push({ sessionId: request.agent.session.id, callId: String(request.callId), toolName: request.toolName,
          args: planned?.args, exportTarget, exact: Boolean(exact), outcome: exact ? 'allowed-once' : 'rejected' });
        return exact ? 'allowed-once' : 'rejected';
      }, { prepend: true }));
      await ctx.dshBots.waitUntilReady();
      const skillRoot = resolve(config.outputDir, 'fixture-skills');
      await mkdir(resolve(skillRoot, 'first-turn-native-fixture'), { recursive: true });
      await writeFile(resolve(skillRoot, 'first-turn-native-fixture', 'SKILL.md'), '---\nname: first-turn-native-fixture\ndescription: Synthetic catalog presence fixture.\n---\nThis synthetic skill is only listed; do not invoke it.\n');
      for (const id of ['first-planner', 'first-reviewer', 'policy-planner', 'policy-reviewer']) {
        bots[id] = await ctx.dshBots.create({ id, name: id, description: 'Synthetic native first-turn messaging test', template: 'standard',
          skills: { extraDirs: [skillRoot] }, model: { provider: 'dp-loopback', model: 'fixture' } });
        mains[id] = (await ctx.dshBots.openConversation(id)).sessionId;
        const resolved = await ctx.sessionController.resolveAgent(mains[id]);
        if ('error' in resolved) throw resolved.error;
        agents[id] = resolved.agent;
      }
      const deadline = Date.now() + 45000;
      const until = async (condition, label) => {
        while (!condition()) { assert.ok(Date.now() < deadline, label); await delay(25, undefined, { signal: controller.signal }); }
      };
      await until(() => ctx.get('dshBotMessaging'), 'the actual messaging Host is ready');
      const rows = () => ctx.get('dshBotMessaging').store.rows();
      const prompt = async (id, value) => {
        agents[id].followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] }));
        await agents[id].whenIdle();
      };
      const answered = family => {
        const list = events(`${family}-planner`);
        const index = list.findLastIndex(event => event.type === 'user/message' && event.data.source.kind === 'dsh-bot-message'
          && event.data.source.mode === 'reply' && text(event.data).includes(ANSWERS[family]));
        return index >= 0 && list.slice(index).some(event => event.type === 'turn/end');
      };
      const turn = (id, instruction) => {
        const list = events(id), input = list.findIndex(event => event.type === 'user/message' && event.data.source.kind === 'user' && text(event.data) === instruction);
        assert.ok(input >= 0, 'the real human instruction is in the native session log');
        const start = list.slice(0, input + 1).findLast(event => event.type === 'turn/start'); assert.ok(start);
        const end = list.find(event => event.seq > start.seq && event.type === 'turn/end'); assert.ok(end);
        const owned = list.filter(event => event.seq >= start.seq && event.seq <= end.seq);
        return { start: start.seq, end: end.seq, sourceKinds: owned.filter(event => event.type === 'user/message').map(event => event.data.source.kind),
          approvals: owned.filter(event => event.type === 'approval/asked' || event.type === 'approval/decided').map(event => ({ type: event.type, ...event.data })) };
      };
      assert.equal(sources('first-planner').filter(row => row.kind === 'user').length, 0, 'no warmup human turn');
      await prompt('first-planner', FIRST); await until(() => answered('first'), 'the first human turn completes a real Bot question/reply');
      const first = turn('first-planner', FIRST);
      assert.ok(first.sourceKinds.includes('skill-catalog'), 'the first human turn includes the real native skill catalog');
      assert.ok(first.approvals.some(row => row.type === 'approval/decided' && row.outcome === 'allowed-once'));
      const policy = agents['policy-planner'].ctx.get('approval');
      assert.equal(typeof policy?.setPolicy, 'function', 'the public native policy switch exists');
      policy.setPolicy(agents['policy-planner'], 'never');
      const approvalsBeforeNever = approvals.length;
      await prompt('policy-planner', NEVER);
      const never = turn('policy-planner', NEVER);
      assert.ok(never.sourceKinds.includes('user-approval'), 'never transition uses the real native policy notice');
      assert.ok(never.approvals.some(row => row.type === 'approval/decided' && row.outcome === 'rejected'), 'never stays rejected');
      assert.equal(approvals.length, approvalsBeforeNever, 'never does not reach even an allowed-once answerer');
      assert.equal(rows().filter(row => row.envelope.from.botId === 'policy-planner').length, 0, 'never creates no message envelope');
      assert.equal(sources('policy-reviewer').filter(row => row.kind === 'dsh-bot-message').length, 0, 'never delivers nothing');
      policy.setPolicy(agents['policy-planner'], 'ask');
      await prompt('policy-planner', ASK); await until(() => answered('policy'), 'ask after a policy transition completes a real Bot question/reply');
      const ask = turn('policy-planner', ASK);
      assert.ok(ask.sourceKinds.includes('user-approval'), 'ask transition uses the real native policy notice');
      assert.ok(ask.approvals.some(row => row.type === 'approval/decided' && row.outcome === 'allowed-once'));
      assert.ok(approvals.every(row => row.exact), 'all granted requests match a specific scripted call, session, target and content');
      for (const agent of Object.values(agents)) { await agent.whenIdle(); assert.equal(await ctx.sessions.flush(agent.session), true); }
      const messageRows = rows().map(row => ({ id: row.envelope.id, mode: row.envelope.mode, from: row.envelope.from.botId, to: row.envelope.to.botId,
        content: row.envelope.content, authorizationId: row.envelope.authorizationId, delivery: row.delivery, processing: row.processing, response: row.response }));
      for (const family of ['first', 'policy']) {
        assert.equal(messageRows.filter(row => row.from === `${family}-planner` && row.to === `${family}-reviewer` && row.mode === 'ask' && row.content === QUESTIONS[family]).length, 1);
        assert.equal(messageRows.filter(row => row.from === `${family}-reviewer` && row.to === `${family}-planner` && row.mode === 'reply' && row.content === ANSWERS[family]).length, 1);
      }
      await save('first-turn.json', { status: 'PASS', mains, warmupTurns: 0, first, never, ask, approvals, messageRows, modelCalls,
        modelRequests, realModelRequests: 0, providerIds: ctx.llm.listProviders().map(provider => typeof provider === 'string' ? provider : provider.id), sources: Object.fromEntries(Object.keys(mains).map(id => [id, sources(id)])) });
      console.log('B4_WEB_READY');
    })().catch(async error => {
      await save('fixture-error.json', { status: 'FAIL', error: String(error.stack), modelRequests, approvals, modelCalls,
        trace: Object.fromEntries(Object.keys(mains).map(id => [id, events(id).map(event => ({ seq: event.seq, type: event.type,
          source: event.data?.source?.kind, outcome: event.data?.outcome, reason: event.data?.reason?.kind }))])) });
      console.error('B4_WEB_FAILED', error);
    });
    return async () => { controller.abort(); for (const dispose of disposers.reverse()) dispose(); await run; };
  }, 'dsh-bot: first-turn messaging fixture');
}
