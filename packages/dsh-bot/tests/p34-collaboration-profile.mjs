import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import TeamService from '@deepseek-ai/dsh-experimental-agent-team';
import { Peer } from '@deepseek-ai/dsh-client-connection';
export const name = 'p34-collaboration-probes';
export const inject = ['loader', 'dshBots', 'dshBotAutomation', 'dshBotCollaborationRemote', 'dshBotImRemote', 'typertGateway', 'agents', 'sessions', 'sessionController', 'subagents'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const abort = new AbortController(); let teamFiber, peer; let stopping = false;
    const save = (name, value) => writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(value, null, 2));
    const wait = async fn => { const until = Date.now() + 60000; while (!stopping && Date.now() < until) { const v = await fn(); if (v) return v; await delay(20); } throw new Error('Collaboration deadline'); };
    const run = (async () => {
      await ctx.loader.await(); await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      const first = config.phase === 'first';
      if (first) for (const id of ['alpha','beta']) await ctx.dshBots.create({ id, name: id, template: 'minimal', memory: { enabled: false, injectLimit: 20 } });
      const bots = await ctx.dshBots.list(); const keys = Object.fromEntries(bots.map(b => [b.id, { botId: b.id, botCreatedAt: b.createdAt }]));
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (namespace, method, args = {}) => ctx.typertGateway.invoke({ namespace, method, args, peer, signal: abort.signal });
      const board = key => invoke('dshBot.collaboration', 'board', { bot: key });
      assert.equal((await board(keys.alpha)).supported, false);
      await assert.rejects(() => invoke('dshBot.collaboration', 'ensure', { bot: keys.alpha, expectedRevision: 0 }));
      const im = await invoke('dshBot.im', 'status');
      assert.equal(im.installed, true); assert.equal(im.contractDetected, true); assert.equal(im.inboundSupported, false); assert.equal(im.outboundSupported, false);
      assert.equal(im.reason, 'consumer-gate-unverified'); assert.deepEqual(await ctx.get('dshIm').listBots(), []);
      teamFiber = ctx.plugin(TeamService, {}); await teamFiber.await(); const teams = ctx.get('agentTeams'); assert.ok(teams);
      const before = first ? undefined : JSON.parse(await readFile(resolve(config.outputDir, 'first-identity.json'), 'utf8'));
      const link = first ? await invoke('dshBot.collaboration', 'ensure', { bot: keys.alpha, expectedRevision: 0 }) : (await board(keys.alpha)).link;
      const mains = await Promise.all(['alpha','beta'].map(id => ctx.dshBots.openConversation(id))); const ids = mains.map(m => m.sessionId);
      assert.equal(link.leadSessionId, ids[0]); assert.equal(link.nativeTeamId, ids[0]);
      if (!first) assert.deepEqual(ids, before.ids);
      const lead = ctx.agents.get(ids[0]); assert.ok(lead);
      if (first) {
        assert.equal((await invoke('dshBot.collaboration', 'ensure', { bot: keys.alpha, expectedRevision: 1 })).id, link.id);
        await assert.rejects(() => invoke('dshBot.collaboration', 'ensure', { bot: keys.alpha, expectedRevision: 0 }));
        const child = await teams.spawnTeammate(lead, { name: 'reviewer', description: 'Role assistant inheriting alpha', prompt: [{ type: 'text', text: 'P34_TEAM_FAKE_MODEL_ONLY' }], context: 'fresh', provider: 'spawn', signal: abort.signal });
        const worker = ctx.agents.get(child.member.id); assert.ok(worker); await worker.whenIdle();
        assert.equal(worker.session.header.agentPreset, lead.session.header.agentPreset); assert.equal(worker.session.header.parentSession, lead.id);
        await wait(() => lead.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.source?.kind === 'subagent-settled'));
        await lead.whenIdle();
        await save('native-settlement', { childId: worker.id, sources: lead.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => ({ kind: e.data.source.kind, form: e.data.source.form, senderSessionId: e.data.source.senderSessionId })), leadAssistantCount: lead.session.snapshotEvents().filter(e => e.type === 'assistant/message').length });
        const task = await invoke('dshBot.collaboration', 'createTask', { bot: keys.alpha, input: { subject: 'CAS blocker', description: 'Native task' } });
        const dependent = await invoke('dshBot.collaboration', 'createTask', { bot: keys.alpha, input: { subject: 'Dependent', description: 'Blocked until blocker completes', blockedBy: [task.id] } });
        await assert.rejects(() => invoke('dshBot.collaboration', 'updateTask', { bot: keys.alpha, input: { taskId: dependent.id, expectedRevision: 1, action: 'claim' } }));
        const results = await Promise.allSettled([
          invoke('dshBot.collaboration', 'updateTask', { bot: keys.alpha, input: { taskId: task.id, expectedRevision: 1, action: 'claim' } }),
          teams.updateTask(worker, { taskId: task.id, expectedRevision: 1, action: 'claim' }),
        ]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        const current = teams.getTask(lead, task.id);
        await invoke('dshBot.collaboration', 'updateTask', { bot: keys.alpha, input: { taskId: task.id, expectedRevision: current.revision, action: 'complete' } });
        assert.equal(teams.getTask(lead, dependent.id).ready, true);
        await invoke('dshBot.collaboration', 'updateTask', { bot: keys.alpha, input: { taskId: dependent.id, expectedRevision: 1, action: 'claim' } });
        await invoke('dshBot.collaboration', 'updateTask', { bot: keys.alpha, input: { taskId: dependent.id, expectedRevision: 2, action: 'complete' } });
        const betaBoard = await board(keys.beta); assert.deepEqual(betaBoard.tasks, []); assert.equal(betaBoard.link, undefined);
        await assert.rejects(() => invoke('dshBot.collaboration', 'board', { bot: keys.alpha, sessionId: ids[1] }));
        for (const args of [
          { bot: { ...keys.alpha, botCreatedAt: keys.alpha.botCreatedAt + 1 } },
        ]) await assert.rejects(() => invoke('dshBot.collaboration', 'board', args));
        for (const input of [
          { subject: 'bad', description: 'bad', agentPreset: 'bot-beta' },
          { taskId: task.id, expectedRevision: 3, action: 'reassign', owner: 'beta' },
          { taskId: task.id, expectedRevision: 3, action: 'claim', agentId: ids[1] },
        ]) await assert.rejects(() => invoke('dshBot.collaboration', input.subject ? 'createTask' : 'updateTask', { bot: keys.alpha, input }));
        assert.equal(await ctx.sessions.flush(lead.session), true);
        await save('identity', { ids, link, childId: worker.id, inheritedPreset: worker.session.header.agentPreset });
        await save('cas', { winners: 1, blockedUntilDependencyComplete: true, crossBotDenied: true });
      } else {
        const recovered = await board(keys.alpha);
        assert.equal(recovered.tasks.length, 2); assert.ok(recovered.tasks.every(t => t.status === 'completed'));
        assert.ok(recovered.members.some(m => m.id === before.childId && m.role === 'teammate'));
        assert.equal(recovered.link.id, before.link.id);
      }
      const actual = await board(keys.alpha); await save('board', actual);
      const rootAssistantCount = ids.reduce((n, id) => n + ctx.agents.get(id).session.snapshotEvents().filter(e => e.type === 'assistant/message').length, 0);
      const leadSources = lead.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.source);
      assert.ok(leadSources.some(s => s.kind === 'subagent-settled') && leadSources.every(s => ['subagent-settled', 'runtime-context'].includes(s.kind)));
      assert.equal(ctx.agents.get(ids[1]).session.snapshotEvents().filter(e => e.type === 'assistant/message').length, 0);
      const settlement = JSON.parse(await readFile(resolve(config.outputDir, 'first-native-settlement.json')));
      assert.equal(rootAssistantCount, settlement.leadAssistantCount);
      assert.equal(actual.tasks.length, 2);
      await teamFiber.dispose(); teamFiber = undefined;
      assert.equal((await board(keys.alpha)).supported, false);
      assert.deepEqual((await Promise.all(['alpha','beta'].map(id => ctx.dshBots.openConversation(id)))).map(m => m.sessionId), ids);
      await save('result', { status: 'PASS', im, mainSessionsUnchanged: true, nativeServiceUnloadIndependent: true, cold: !first, rootAssistantCount });
      if (first) { teamFiber = ctx.plugin(TeamService, {}); await teamFiber.await(); }
      console.log('P34_COLLAB_DONE');
    })().catch(async e => { await save('failure', { error: String(e), stack: e.stack }); console.log('P34_COLLAB_FAILED'); });
    return async () => { stopping = true; abort.abort(); await run; await teamFiber?.dispose(); await peer?.dispose(); await save('disposed', { status: 'PASS' }); };
  });
}
