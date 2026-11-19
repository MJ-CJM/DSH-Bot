import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:http';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'group-safety-native-fixture';
export const inject = ['loader','llm','agents','sessions','dshBots','typertGateway','sessionPersistence'];
export function apply(ctx, config) { ctx.effect(() => {
  const stop = new AbortController(), releases = [], calls = [], perSession = new Map(); let phase = 'setup';
  const capture = data => new Promise((accept,reject) => { const r=request(config.endpoint,{method:'POST',headers:{'content-type':'application/json'}},s=>{s.resume();s.on('end',accept);});r.on('error',reject);r.end(JSON.stringify(data)); });
  class Adapter extends LlmAdapter {
    async listModels(provider) { return [{provider,id:'fixture',name:'Group safety mock'}]; }
    async *stream(options) {
      const n=perSession.get(options.sessionId)??0;perSession.set(options.sessionId,n+1);
      const prompt=JSON.stringify(options.messages);
      calls.push({phase,sessionId:options.sessionId,oldPrivate:prompt.includes('OLD_APPROVED_PRIVATE'),tools:(options.tools??[]).map(t=>t.name)});
      await capture({phase,sessionId:options.sessionId,step:n});
      const tool = !n && phase==='private' ? ['bot_memory_list','{}'] : !n && phase==='memory' ? ['bot_memory_save',JSON.stringify({content:'The owner prefers jasmine tea.'})] : undefined;
      if(tool){const id=ToolCallId('fixture-'+n);yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name:tool[0],argumentsDelta:tool[1]};yield {type:'block-end',index:0,block:{type:'tool-call',id,name:tool[0],arguments:tool[1]}};yield {type:'finish',reason:{kind:'tool-calls'}};return;}
      const text=phase==='private'?'OLD_APPROVED_PRIVATE':phase==='memory'?'PRIVATE_NARRATIVE_MUST_NOT_BE_SHARED':phase==='proactive'?'PROACTIVE_NATIVE_REPLY':'FRESH_PUBLIC_REPLY';
      yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  const wait=async fn=>{for(let i=0;i<1200;i++){const value=await fn();if(value)return value;await delay(25);}throw Error('timeout '+phase);};
  const run=(async()=>{
    await ctx.loader.await();await ctx.dshBots.waitUntilReady();releases.push(ctx.llm.registerAdapter(['group-safety'],new Adapter()));
    const groups=await wait(()=>ctx.get('dshBotGroups')),peer=new Peer(ctx,{principal:{kind:'owner'},interactions:'none'});releases.push(()=>peer.dispose());
    const invoke=(method,args)=>ctx.typertGateway.invoke({namespace:'dshBot.groups',method,args,peer,signal:stop.signal});
    if((await groups.list()).length){assert.equal(calls.length,0);await writeFile(resolve(config.outputDir,'cold-result.json'),JSON.stringify({status:'PASS',modelRequests:0}));console.log('B4_WEB_READY');return;}
    const bots=[];
    for(let i=0;i<6;i++){const b=await ctx.dshBots.create({id:'safety-'+i,name:'Safety '+i,template:'minimal',model:{provider:'group-safety',model:'fixture'},memory:{enabled:true,injectLimit:0}});bots.push({botId:b.id,botCreatedAt:b.createdAt});await ctx.dshBots.memoryFor(b.id).save({content:'Private fact for '+i});}
    const make=async(name,members)=>{const g=await groups.create({operationId:crypto.randomUUID(),name,mode:'natural',members,historyConfirmed:true});return {groupId:g.id,groupCreatedAt:g.createdAt};};
    const send=async(key,text,extra={})=>{const v=await groups.view(key);const t=await invoke('send',{group:key,input:{operationId:crypto.randomUUID(),text,expectedMembershipRevision:v.group.membershipRevision,...extra}});const done=await wait(async()=>{const view=await groups.view(key);return view.turns.some(row=>row.id===t.id&&!['accepted','running'].includes(row.state))&&view;});return {view:done,turn:done.turns.find(row=>row.id===t.id),deliveries:done.deliveries.filter(row=>row.turnId===t.id)};};
    phase='private';const key=await make('Audience filtering',bots.slice(0,2)),first=await send(key,'Review old private facts');
    assert.ok(first.deliveries.every(d=>d.reasonCode==='export-approval-required'));
    const approved=first.deliveries[0],preview=await invoke('reviewExport',{group:key,deliveryId:approved.id});await invoke('decideExport',{group:key,deliveryId:approved.id,token:preview.token,allow:true});
    const recall=await invoke('recallForBot',{bot:approved.bot,input:{group:key,turnId:first.turn.id}});assert.equal(recall.items.length,1);assert.ok(recall.items[0].sources.some(s=>s.text==='OLD_APPROVED_PRIVATE'));
    let current=(await groups.view(key)).group;
    assert.equal(ctx.dshBots.memoryKernel.domain.table('flow_sessions').get(current.rootSessionId),undefined);
    await groups.edit(key,{expectedRevision:current.revision,expectedMembershipRevision:current.membershipRevision,name:current.name,mode:current.mode,members:bots.slice(0,3),historyConfirmed:true});
    phase='fresh';const fresh=await send(key,'NEW_QUESTION_FOR_NEW_MEMBER');assert.equal(fresh.deliveries.length,3);assert.ok(fresh.deliveries.every(d=>d.state==='completed'),JSON.stringify(fresh.deliveries));assert.ok(calls.filter(c=>c.phase==='fresh').every(c=>!c.oldPrivate));
    const memoryKey=await make('Six memory receipts',bots);phase='memory';const memory=await send(memoryKey,'Please remember that I prefer jasmine tea.',{memoryStatusOnly:true});
    assert.equal(memory.deliveries.length,6);assert.ok(memory.deliveries.every(d=>d.memoryWriteStatus==='saved'&&d.state==='completed'),JSON.stringify(memory.deliveries));assert.ok(!JSON.stringify(memory.view.messages).includes('PRIVATE_NARRATIVE_MUST_NOT_BE_SHARED'));assert.ok(memory.deliveries.every(d=>!d.outputMessageId&&!d.failure&&!d.exportFlowId));
    for(const bot of bots)assert.ok((await ctx.dshBots.memoryFor(bot.botId).list()).some(m=>m.content==='The owner prefers jasmine tea.'));
    await assert.rejects(groups.continueTurn(memoryKey,memory.turn.id,memory.turn.revision));
    phase='proactive';const proactiveKey=await make('Proactive exact cleanup',bots.slice(0,2)),before=await groups.view(proactiveKey);
    const records=await ctx.dshBots.list();const t=await groups.startProactiveReview(proactiveKey,{operationId:crypto.randomUUID(),text:'PROACTIVE_NATIVE_INPUT',memberIds:before.members.map(m=>m.id),expectedMembershipRevision:before.group.membershipRevision},{ticketId:'ticket-native',assignmentId:'assignment-native',provider:'group-safety',model:'fixture',botRevisions:before.members.map(m=>records.find(b=>b.id===m.bot.botId).updatedAt)},async()=>{});
    const end=await wait(async()=>{const v=await groups.view(proactiveKey);return v.turns.some(row=>row.id===t.id&&row.state==='completed')&&v;});
    const ds=end.deliveries.filter(d=>d.turnId===t.id);assert.ok(ds.every(d=>d.inputFlowId&&d.inputFlowSessionId.startsWith('group-context-')));
    const ownedCalls=new Set([t.id,...ds.flatMap(d=>[d.id,d.id+':result'])]);
    const ownedCopies=[...ctx.dshBots.memoryKernel.domain.table('flows').entries()].filter(([,row])=>ownedCalls.has(row.envelope?.binding.invocation.split('/').at(-1)));assert.equal(ownedCopies.length,5);
    const nativeBefore=JSON.stringify(end.messages);assert.equal(await groups.purgeProactiveCopies(['assignment-native']),true);assert.equal(JSON.stringify((await groups.view(proactiveKey)).messages),nativeBefore);
    const flows=ctx.dshBots.memoryOutlets;assert.ok(ownedCopies.every(([id])=>!flows.get(id).envelope));for(const d of ds)assert.equal(flows.get(d.inputFlowId).envelope,undefined);assert.equal(flows.get(end.turns.find(row=>row.id===t.id).inputFlowId).envelope,undefined);assert.equal(await groups.purgeProactiveCopies(['assignment-native']),true);
    await writeFile(resolve(config.outputDir,'result.json'),JSON.stringify({status:'PASS',checks:['approved-copy recall without root widening','new-member fresh input excludes unreadable old history','six verified memory saves with no narrative','status-only continuation refused','production proactive projected flow purge and native log preservation'],fixtureRequests:calls.length,memoryStatuses:memory.deliveries.map(d=>d.memoryWriteStatus),calls,realModelRequests:0},null,2));console.log('B4_WEB_READY');
  })().catch(async error=>{await writeFile(resolve(config.outputDir,'result.json'),JSON.stringify({status:'FAIL',phase,error:String(error.stack??error),calls},null,2));console.log('B4_WEB_FAILED');});
  return async()=>{stop.abort();await run;for(const release of releases.reverse())await release();};
});}
