import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
import TeamService from '@deepseek-ai/dsh-experimental-agent-team';

export const name = 'supergroup-native-profile';
export const inject = ['loader', 'llm', 'dshBots', 'agents', 'sessions', 'subagents', 'agentPresets'];

class SyntheticAdapter extends LlmAdapter {
  calls = [];
  async listModels(provider) {
    return ['fixture-alpha', 'fixture-beta', 'fixture-gamma'].map(id => ({ provider, id, name: id }));
  }
  async *stream(options) {
    const input = JSON.stringify(options), first = !this.calls.some(call => call.sessionId === options.sessionId);
    const call = { sessionId: options.sessionId, model: options.model, input };
    this.calls.push(call);
    if (first && input.includes('SG_NATIVE_TASK_')) await new Promise(accept => {
      call.release = accept; options.signal?.addEventListener('abort', accept, { once: true });
    });
    options.signal?.throwIfAborted();
    const text = 'SG_NATIVE_SYNTHETIC_RESULT';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), adapter = new SyntheticAdapter(), releases = [], assertions = [];
    const preparations = [], childIds = [];
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const timer = setTimeout(() => lifetime.abort(new Error('Supergroup native deadline')), 65000);
    let teamFiber, lead, neutralHandle, botLead, phase = 'loader';
    const mark = value => { phase = value; console.log(`SG_NATIVE_PHASE ${phase}`); };
    const ok = (name, condition) => { assert.ok(condition, name); assertions.push(name); };
    const blocks = text => [{ type: 'text', text }];
    const wait = async check => { for (;;) { lifetime.signal.throwIfAborted(); const value = await check(); if (value) return value; await delay(15, undefined, { signal: lifetime.signal }); } };
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      const bots = [];
      for (const suffix of ['alpha', 'beta', 'gamma']) bots.push(await ctx.dshBots.create({ id: `sg-native-${suffix}`,
        name: suffix, template: 'minimal', persona: { prefix: `SG_NATIVE_PERSONA_${suffix.toUpperCase()}` },
        model: { provider: 'dp-b6b', model: `fixture-${suffix}` }, memory: { enabled: false, injectLimit: 20 } }));
      const mains = await Promise.all(bots.map(bot => ctx.dshBots.openConversation(bot.id)));
      lead = ctx.agents.get(mains[0].sessionId); assert.ok(lead);
      botLead = lead;
      const beta = ctx.agents.get(mains[1].sessionId), gamma = ctx.agents.get(mains[2].sessionId);
      const presets = [lead, beta, gamma].map(agent => agent.session.header.agentPreset);
      ok('three existing Bots have distinct public presets', new Set(presets).size === 3);
      teamFiber = ctx.plugin(TeamService, {}); await teamFiber.await();
      const teams = ctx.get('agentTeams'); assert.ok(teams);
      const spawn = (caller, name, provider = 'spawn', extras = {}) => teams.spawnTeammate(caller, {
        name, description: `SG native ${name}`, prompt: blocks(`SG_NATIVE_TASK_${name}`), context: 'fresh',
        provider, signal: lifetime.signal, ...extras });
      mark('real-bot-guard-negative');
      let botGuardError;
      await assert.rejects(() => spawn(botLead, 'real-bot-beta'), error => {
        botGuardError = { name: error.name, code: error.code, message: error.message };
        return /checked results|background task has ended/.test(error.message);
      });
      ok('real Bot Team child fails existing checked-continuation guard', true);
      const botRoster = teams.listMembers(botLead);
      ok('failed real Bot spawn never publishes a live child', botRoster.filter(row => row.role === 'teammate').every(row => !ctx.agents.get(row.id)));
      // This independent public preset isolates upstream Team behavior. It is
      // deliberately not represented as a successfully bound long-term Bot.
      const neutralPreset = 'sg-native-neutral';
      releases.push(await ctx.agentPresets.register({ id: neutralPreset, name: 'Native mechanism fixture', plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'SG_NATIVE_NEUTRAL_PERSONA', complete: true, includeRuntimeContext: false } },
      ] }));
      neutralHandle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: process.cwd(), agentPreset: neutralPreset },
        agentOptions: { provider: 'dp-b6b', model: 'fixture-alpha' }, signal: lifetime.signal,
        setup: async scope => { await ctx.agentPresets.mount(scope, neutralPreset); } });
      lead = neutralHandle.agent;
      await lead.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: blocks('PRIVATE_PARENT') }), { surfaceOp: 'append' });
      await ctx.sessions.flush(lead.session);
      mark('native-inheritance');
      const first = await spawn(lead, 'beta'); childIds.push(first.member.id);
      const worker = ctx.agents.get(first.member.id); await wait(() => adapter.calls.some(call => call.sessionId === worker.id && call.release));
      ok('naming teammate beta does not bind existing beta Bot', worker.session.header.agentPreset === neutralPreset && worker.session.header.agentPreset !== presets[1]);
      ok('native child retains exact parent ownership', worker.session.header.parentSession === lead.id);
      ok('fresh child excludes private parent conversation', !worker.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.content?.some(block => block.text?.includes('PRIVATE_PARENT'))));
      mark('provider-prepare-boundary');
      releases.push(ctx.subagents.registerProvider({ name: 'sg-native-prepare', inheritsParentContext: false,
        capabilities: { agentPreset: true, agentOptions: true, outputSchema: true, depthLimit: true },
        agentRouteDefaults: { provider: 'dp-b6b', model: 'fixture-gamma' },
        async prepareContinuable(request) {
          preparations.push({ keys: Object.keys(request).sort(), sessionId: request.sessionId, parentId: request.parent.id, cwd: request.cwd });
          // Deliberately unsupported fields prove that JS extensions do not become a public bridge.
          return { agentPreset: presets[2], agentOptions: { provider: 'dp-b6b', model: 'fixture-gamma' } };
        } }));
      const second = await spawn(lead, 'gamma', 'sg-native-prepare', {
        agentPreset: presets[2], agentOptions: { provider: 'dp-b6b', model: 'fixture-gamma' } });
      childIds.push(second.member.id);
      const secondWorker = ctx.agents.get(second.member.id); await wait(() => adapter.calls.some(call => call.sessionId === secondWorker.id && call.release));
      ok('Team request and provider extensions cannot select another Bot preset', secondWorker.session.header.agentPreset === neutralPreset);
      ok('provider preparation receives creation data without preset or model selection capability', preparations.length === 1 && !preparations[0].keys.includes('agentPreset'));
      await wait(() => adapter.calls.some(call => call.sessionId === secondWorker.id));
      ok('provider route defaults cannot override Team inherited model', adapter.calls.filter(call => childIds.includes(call.sessionId)).every(call => call.model === 'fixture-alpha'));
      mark('lead-only-and-messaging');
      await assert.rejects(() => spawn(worker, 'forbidden-expert'), error => error.code === 'TEAM_LEAD_REQUIRED');
      ok('ordinary teammate cannot add experts', true);
      const direct = await teams.sendMessage(worker, { target: 'gamma', content: blocks('SG_NATIVE_DIRECT_PEER'), signal: lifetime.signal });
      const sources = [worker, secondWorker].map(agent => ({ id: agent.id, initial: agent.session.snapshotEvents().find(event => event.type === 'user/message')?.data.source }));
      const roster = teams.listMembers(lead);
      for (const call of adapter.calls) call.release?.();
      await wait(() => secondWorker.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === direct.messageId));
      const directEvent = secondWorker.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === direct.messageId);
      ok('native peer delivery retains exact agent-message relay author', directEvent.data.source.kind === 'agent-message'
        && directEvent.data.source.form === 'relay' && directEvent.data.source.senderSessionId === worker.id);
      await secondWorker.whenIdle();
      await wait(() => lead.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source?.kind === 'subagent-settled'));
      await lead.whenIdle();
      ok('Lead can add later teammate in a single native roster', roster.length === 3 && childIds.every(id => roster.some(member => member.id === id)));
      ok('unbound existing expert main sessions receive no model requests', adapter.calls.every(call => ![beta.id, gamma.id].includes(call.sessionId)));
      mark('external-provider-negative');
      let startCalls = 0;
      releases.push(ctx.subagents.registerProvider({ name: 'sg-native-external', inheritsParentContext: false,
        capabilities: { agentPreset: true, agentOptions: true, outputSchema: true, depthLimit: true },
        async start() { startCalls++; throw new Error('Must not reach external backend'); } }));
      await assert.rejects(() => spawn(lead, 'external-bridge', 'sg-native-external'), error => error.code === 'UNSUPPORTED_CAPABILITY');
      ok('Team reserved identity rejects start-only external provider before execution', startCalls === 0);
      ok('native initial prompt source remains user and cannot express Supergroup machine provenance', sources.every(row => row.initial?.kind === 'user'));
      mark('cleanup');
      await ctx.subagents.drainChildren(lead, childIds);
      ok('public drain releases both native children', childIds.every(id => !ctx.agents.get(id)));
      await save('result', { status: 'PASS', route: 'NATIVE_TEAMS_REJECTED_FOR_EXISTING_BOT_IDENTITY', assertions,
        identityBinding: 'FAIL', nativeRosterAndPeerMessaging: 'PASS', nativePositiveScope: 'independent public preset, not Bot identity', botGuardError, botRoster,
        preparations, sources, direct: { messageId: direct.messageId, source: directEvent.data.source },
        bots: bots.map((bot, index) => ({ id: bot.id, createdAt: bot.createdAt, preset: presets[index], mainSessionId: mains[index].sessionId })),
        children: childIds, roster, settlement: lead.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'subagent-settled').map(event => ({ id: event.data.id, source: event.data.source })),
        calls: adapter.calls.map(({ input, release, ...call }) => call), realModelRequests: 0 });
      console.log('SG_NATIVE_DONE');
    })().catch(async error => { await save('result', { status: 'FAIL', phase, assertions, error: String(error), stack: error.stack }); console.log('SG_NATIVE_FAILED'); });
    return async () => {
      clearTimeout(timer); lifetime.abort(); for (const call of adapter.calls) call.release?.(); await run;
      if (lead) await ctx.subagents.drainChildren(lead, childIds);
      await teamFiber?.dispose();
      await neutralHandle?.dispose();
      for (const off of releases.reverse()) off();
      await save('disposed', { status: 'PASS', nativeChildrenReleased: childIds.every(id => !ctx.agents.get(id)), nativeServiceReleased: !ctx.get('agentTeams') });
    };
  });
}
