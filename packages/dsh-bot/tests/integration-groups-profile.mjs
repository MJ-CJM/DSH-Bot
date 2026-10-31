import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
export const name = 'p34-group-probes';
export const inject = ['loader', 'dshBots', 'dshBotAutomation', 'dshBotGroupsRemote', 'dshBotGroups', 'typertGateway', 'agents', 'sessions', 'workspaceRegistry', 'sessionController', 'subagents', 'agentDefaultModel','dshBotConnectors','sessionTitle'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const abort = new AbortController(); let stopping = false, peer;
    const save = (name, value) => writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(value, null, 2));
    const wait = async fn => { const until = Date.now() + 60000; while (!stopping && Date.now() < until) { const v = await fn(); if (v) return v; await delay(15); } throw new Error('Group probe deadline'); };
    const run = (async () => {
      await ctx.loader.await(); await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      const first = config.phase === 'first';
      if (first) for (const [id,variant,color] of [['alpha','glasses','teal'],['beta','spout','rose'],['gamma','hat','indigo']]) await ctx.dshBots.create({ id, name: id === 'gamma' ? 'Third whale' : 'Same name', template: 'minimal', persona: { prefix: `P34_GROUP_PERSONA_${id.toUpperCase()}` }, avatarVariant: variant, avatarColor: color, memory: { enabled: false, injectLimit: 20 }, ...(id === 'alpha' ? { model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' } } : {}) });
      const bots = await ctx.dshBots.list(); const keys = Object.fromEntries(bots.map(b => [b.id,{ botId: b.id, botCreatedAt: b.createdAt }]));
      if (first) for (const id of ['alpha','beta']) {
        await ctx.dshBotConnectors.saveDefinition({id:`fixture-${id}`,label:`Synthetic ${id}`,serverName:'groupfixture',transport:'streamable-http',url:id === 'alpha' ? config.mcpAlphaUrl : config.mcpBetaUrl,credentialBindings:[{destination:'header',key:'Authorization',credentialRef:`P34_GROUP_${id.toUpperCase()}_SECRET`,format:'bearer'}],enabled:true},0);
        await ctx.dshBotConnectors.saveAssignment({id:`assignment-${id}`,bot:keys[id],connectorId:`fixture-${id}`,enabled:true},0);
      }
      const mains = await Promise.all((first ? ['alpha','beta','gamma'] : ['alpha','gamma']).map(id => ctx.dshBots.openConversation(id))); const mainIds = mains.map(m => m.sessionId); if (!first) mainIds.splice(1,0,null);
      const mainTitles = mains.map(m => ctx.sessionTitle.get(ctx.agents.get(m.sessionId).session).title);
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (method,args = {}) => ctx.typertGateway.invoke({ namespace: 'dshBot.groups', method, args, peer, signal: abort.signal });
      const key = g => ({ groupId: g.id, groupCreatedAt: g.createdAt });
      let group, groupKey;
      if (first) {
        const input = { operationId: 'runtime-create', name: 'Synthetic whale group', mode: 'mention', members: [keys.alpha,keys.beta,keys.gamma], historyConfirmed: true };
        group = await invoke('create',{input}); groupKey = key(group);
        const workspace = ctx.workspaceRegistry.list().find(workspace => mainIds.every(id => workspace.sessionIds.includes(id)));
        assert.ok(workspace);
        assert.deepEqual([...workspace.sessionIds].sort(), [...mainIds].sort(), 'Group creation leaves only Bot mains in the Bots workspace');
        assert.ok(!workspace.sessionIds.includes(group.rootSessionId));
        await save('sidebar-after-group', { status: 'PASS', sessionIds: workspace.sessionIds, mainIds, groupRootId: group.rootSessionId, groupRootInBotsWorkspace: false });
        assert.equal((await invoke('create',{input})).id,group.id);
        await assert.rejects(() => invoke('create',{input:{ ...input,name:'Changed payload' }}));
        const view = () => invoke('view',{group:groupKey,page:{}});
        const current = await view(); const ids = current.members.filter(m => m.enabled).map(m => m.id);
        const send = async (operationId, memberIds, round = false, text = `P34_GROUP_ONLY ${operationId}`) => {
          const before = await view(); const input = { operationId,memberIds,round,text,expectedMembershipRevision:before.group.membershipRevision };
          const turn = await invoke('send',{group:groupKey,input}); assert.equal((await invoke('send',{group:groupKey,input})).id,turn.id);
          const after = await wait(async () => { const v = await view(); return v.turns.find(t => t.id === turn.id && !['running','accepted'].includes(t.state)) && v; });
          return { turn: after.turns.find(t => t.id === turn.id), view: after, deliveries: after.deliveries.filter(d => d.turnId === turn.id) };
        };
        await assert.rejects(() => invoke('send',{group:groupKey,input:{operationId:'bad-target',text:'P34_GROUP_ONLY @Same name',memberIds:['unknown'],expectedMembershipRevision:1}}));
        await assert.rejects(() => invoke('send',{group:groupKey,input:{operationId:'no-target',text:'P34_GROUP_ONLY @Same name',memberIds:[],expectedMembershipRevision:1}}));
        const single = await send('single',[ids[1]],false,`P34_GROUP_ONLY long ${'X'.repeat(320)}`); assert.equal(single.turn.state,'completed'); assert.equal(single.deliveries[0].bot.botId,'beta');
        const multi = await send('multi',[ids[1],ids[0]]); assert.equal(multi.turn.state,'completed'); assert.deepEqual(multi.deliveries.map(d => d.bot.botId),['alpha','beta']); assert.equal(multi.deliveries[1].contextOutputMessageIds[0], multi.deliveries[0].outputMessageId);
        let latest = multi.view.group;
        group = await invoke('edit',{group:groupKey,input:{ name: 'Synthetic whale group', mode:'round-robin',members:[keys.alpha,keys.beta,keys.gamma],expectedRevision:latest.revision,expectedMembershipRevision:latest.membershipRevision,historyConfirmed:true }});
        await assert.rejects(() => invoke('edit',{group:groupKey,input:{name:'stale',mode:'mention',members:[keys.alpha,keys.beta],expectedRevision:latest.revision,expectedMembershipRevision:latest.membershipRevision,historyConfirmed:true}}));
        const next = await send('next',[]); assert.equal(next.deliveries.length,1); assert.equal(next.deliveries[0].bot.botId,'gamma');
        const round = await send('round',[],true); assert.equal(round.turn.state,'completed'); assert.deepEqual(round.deliveries.map(d => d.bot.botId),['alpha','beta','gamma']);
        const partial = await send('partial',[ids[1]]); assert.notEqual(partial.turn.state,'completed'); assert.equal(partial.deliveries[0].state,'failed');
        const beforeCancel = await view();
        const turn = await invoke('send',{group:groupKey,input:{operationId:'cancel',text:'P34_GROUP_ONLY cancel',memberIds:[ids[0],ids[1]],expectedMembershipRevision:beforeCancel.group.membershipRevision}});
        await wait(async () => { const v = await view(); return v.deliveries.some(d => d.turnId === turn.id && d.state === 'running'); });
        const queued = await invoke('send',{group:groupKey,input:{operationId:'queued',text:'P34_GROUP_ONLY future queued input',memberIds:[ids[2]],expectedMembershipRevision:beforeCancel.group.membershipRevision}});
        await delay(150);
        let live = (await view()).turns.find(t => t.id === queued.id); await invoke('cancel',{group:groupKey,turnId:queued.id,expectedRevision:live.revision});
        live = (await view()).turns.find(t => t.id === turn.id); await invoke('cancel',{group:groupKey,turnId:turn.id,expectedRevision:live.revision});
        await wait(async () => { const v = await view(); return v.turns.every(t => !['accepted','running'].includes(t.state)) && v; });
        const final = await view();
        assert.ok(final.messages.some(m => m.speaker?.bot.botId === 'alpha' && m.speaker.avatarVariant === 'glasses'));
        assert.ok(final.deliveries.some(d => d.contextTruncated));
        assert.deepEqual((await Promise.all(['alpha','beta','gamma'].map(id => ctx.dshBots.openConversation(id)))).map(m => m.sessionId),mainIds);
        assert.deepEqual(mains.map(m => ctx.sessionTitle.get(ctx.agents.get(m.sessionId).session).title),mainTitles);
        const sessionList = await ctx.sessionController.list({});
        const statuses = await ctx.dshBots.status();
        for (const status of statuses) {
          const visible = sessionList.items.filter(row => !row.parentSessionId && row.origin !== 'subagent' && row.projections?.values?.agentPreset === status.presetId);
          assert.equal(visible.length, 1, `One visible main for ${status.id}`);
          assert.equal(visible[0].sessionId, status.mainSessionId);
        }
        await save('main-identity',{mainIds,mainTitles,groupOperationsPreservedIdsAndTitles:true,oneVisibleMainPerBot:true,groupWorkersAreNativeChildren:true});
        // Rename/delete a Bot and remove its member: history retains the original speaker snapshot.
        const alpha = await ctx.dshBots.get('alpha'); await ctx.dshBots.update('alpha',{name:'Renamed alpha'},alpha.updatedAt);
        latest = final.group; group = await invoke('edit',{group:groupKey,input:{name:latest.name,mode:'round-robin',members:[keys.alpha,keys.gamma],expectedRevision:latest.revision,expectedMembershipRevision:latest.membershipRevision,historyConfirmed:true}});
        await ctx.dshBots.remove('beta',{deleteMemories:false});
        const historic = await view(); assert.ok(historic.messages.some(m => m.speaker?.bot.botId === 'beta' && m.speaker.name === 'Same name'));
        const catalog = await invoke('list'); assert.ok(catalog.some(row => row.group.rootSessionId === group.rootSessionId));
        assert.equal(historic.unread,true); const latestSeq = historic.messages.at(-1).seq;
        assert.equal(await invoke('markRead',{group:groupKey,throughSeq:latestSeq,expectedRevision:historic.readRevision}),true);
        assert.equal((await view()).unread,false);
        await assert.rejects(() => invoke('markRead',{group:groupKey,throughSeq:latestSeq,expectedRevision:historic.readRevision}));
        await assert.rejects(() => invoke('view',{group:groupKey,page:{},sessionId:'forged-private-session'}));
        const changedMainIds = (await Promise.all(['alpha','gamma'].map(id => ctx.dshBots.openConversation(id)))).map(m => m.sessionId); assert.deepEqual(changedMainIds,[mainIds[0],mainIds[2]]);
        await save('identity',{group,mainIds,keys}); await save('view',historic);
        await save('routing',{single:single.turn,multi:multi.turn,round:round.turn,partial:partial.turn,cancelled:true,historySnapshots:true,truncated:historic.deliveries.filter(d => d.contextTruncated).length});
        // Separate root for Controller race / generation retention. Archive drains owned children and handle.
        const race = await invoke('create',{input:{operationId:'runtime-race',name:'Guard race',mode:'mention',members:[keys.alpha,keys.gamma],historyConfirmed:true}});
        await assert.rejects(() => ctx.agents.resume({resumeSessionId:race.rootSessionId,agentOptions:ctx.agentDefaultModel.currentSelection()}));
        await invoke('archive',{group:key(race),expectedRevision:race.revision}); assert.equal(ctx.agents.get(race.rootSessionId),undefined);
        const native = await ctx.sessionController.resolveAgent(race.rootSessionId); assert.ok(!('error' in native));
        const raced = await invoke('view',{group:key(race),page:{}}); assert.equal(raced.reason,'root-owned-elsewhere');
        await save('race',{rootId:race.rootSessionId,duplicateResumeRejected:true,controllerOwnedNotTakenOver:true});
      } else {
        const before = JSON.parse(await readFile(resolve(config.outputDir,'first-identity.json'),'utf8')); group = before.group; groupKey = key(group);
        assert.deepEqual(mainIds.filter((_id,i) => i !== 1),before.mainIds.filter((_id,i) => i !== 1));
        const restored = await invoke('view',{group:groupKey,page:{}}); const saved = JSON.parse(await readFile(resolve(config.outputDir,'first-view.json'),'utf8'));
        assert.deepEqual(restored.messages,saved.messages); assert.ok(restored.turns.every(t => !['running','accepted'].includes(t.state)));
        await save('view',restored); await save('cold',{sameRoot:true,sameMessages:true,noReplayedTurn:true});
      }
      const root = ctx.agents.get(group.rootSessionId); assert.ok(root);
      const receipt = await ctx.sessionController.prompt({sessionId:root.id,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:'ROOT_BYPASS_MUST_NEVER_REACH_MODEL'}]},abort.signal);
      assert.equal(receipt.accepted,true); await root.whenIdle(); assert.equal(await ctx.sessions.flush(root.session),true);
      assert.equal(root.session.snapshotEvents().filter(e => e.type === 'assistant/message').length,0);
      assert.equal(root.session.snapshotEvents().findLast(e => e.type === 'turn/end')?.data.reason.kind,'blocked');
      await save('no-model',{rootId:root.id,rootAssistantMessages:0,nativePromptBlocked:true});
      // Browser works on the live installed package before Host teardown.
      console.log('P34_GROUP_READY');
      await wait(async () => { try { return await readFile(resolve(config.outputDir,`${config.phase}-finish`),'utf8'); } catch { return false; } });
      if (first) {
        await wait(async () => (await invoke('view',{group:groupKey,page:{}})).turns.every(t => !['running','accepted'].includes(t.state)));
        await save('view', await invoke('view',{group:groupKey,page:{}}));
        const race = JSON.parse(await readFile(resolve(config.outputDir,'first-race.json'),'utf8')); const native = ctx.agents.get(race.rootId); assert.ok(native);
        const monitor = setInterval(() => { void save('close-progress',ctx.dshBotGroups.lifecycle()); },50);
        try { await ctx.dshBotGroups.close(); } finally { clearInterval(monitor); }
        assert.equal(ctx.agents.get(group.rootSessionId),undefined);
        const receipt = await ctx.sessionController.prompt({sessionId:race.rootId,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:'UNLOADED_ROOT_MUST_NEVER_REACH_MODEL'}]},abort.signal);
        assert.equal(receipt.accepted,true); await native.whenIdle();
        assert.equal(native.session.snapshotEvents().findLast(e => e.type === 'turn/end')?.data.reason.kind,'blocked');
        assert.equal(native.session.snapshotEvents().filter(e => e.type === 'assistant/message').length,0);
        const lifecycle = ctx.dshBotGroups.lifecycle(); assert.deepEqual(lifecycle,{phase:'closed',ownedRoots:0,workers:0,activations:0});
        await save('unloaded',{rootDisposed:true,retainedGenerationBlocked:true,rootAssistantMessages:0,lifecycle});
      }
      await save('result',{status:'PASS',phase:config.phase}); console.log('P34_GROUP_DONE');
    })().catch(async e => { await save('failure',{error:String(e),stack:e.stack,causes:e.errors?.map(c => ({error:String(c),stack:c.stack}))}); console.log('P34_GROUP_FAILED'); });
    return async () => { stopping = true; abort.abort(); await run; await peer?.dispose(); await save('disposed',{status:'PASS'}); };
  });
}
