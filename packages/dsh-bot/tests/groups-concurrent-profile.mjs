import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'concurrent-groups-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'fileUploads', 'attachments', 'subagents', 'typertGateway'];
class GroupAdapter extends LlmAdapter {
  calls = []; gates = new Map();
  async listModels(provider) { return [{provider,id:'fixture',name:'Synthetic concurrency'}]; }
  async *stream(options) {
    const input = JSON.stringify(options); this.calls.push({sessionId:options.sessionId,input});
    if (!input.includes('FOLLOWUP_EXACT')) await new Promise(resolve => { this.gates.set(options.sessionId, resolve); options.signal?.addEventListener('abort', resolve, {once:true}); });
    options.signal?.throwIfAborted();
    const text = input.includes('FOLLOWUP_EXACT') ? 'FOLLOWUP_RESULT' : 'INITIAL_RESULT';
    yield {type:'block-start',index:0,blockType:'text'};
    yield {type:'text-delta',index:0,text};
    yield {type:'block-end',index:0,block:{type:'text',text}};
    yield {type:'finish',reason:{kind:'stop'}};
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), adapter = new GroupAdapter(), releases = [];
    let phase = 'loader', debugView;
    let step = '';
    const save = (name,value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value,null,2));
    const mark = async name => { phase=name;console.log(`CONCURRENT_GROUP_PHASE ${name}`); };
    const timer=setTimeout(()=>controller.abort(),45000);
    const wait=async check=>{for(;;){controller.signal.throwIfAborted();const v=await check();if(v)return v;await delay(20,undefined,{signal:controller.signal});}};
    const run=(async()=>{
      await ctx.loader.await();assert.deepEqual(ctx.llm.listProviders(),[]);
      releases.push(ctx.llm.registerAdapter(['dp-b6b'],adapter)); await ctx.dshBots.waitUntilReady();
      const groups=await wait(()=>ctx.get('dshBotGroups'));const keys=[];
      const peer=new Peer(ctx,{principal:{kind:'owner'},interactions:'none'}); releases.push(()=>peer.dispose());
      const send=(group,input)=>ctx.typertGateway.invoke({namespace:'dshBot.groups',method:'send',args:{group,input},peer,signal:controller.signal});
      if(config.cold) {
        await mark('cold-schema-and-retry');
        const list=await groups.list();assert.equal(list.length,1);const g=list[0].group;
        const group={groupId:g.id,groupCreatedAt:g.createdAt},v=await groups.view(group);
        const t=v.turns.find(t=>t.operationId==='work-b'),receipt=t.followups.find(r=>r.operationId==='exact-b');
        const retry=await send(group,{operationId:'exact-b',text:'FOLLOWUP_EXACT',expectedMembershipRevision:1,followup:{turnId:t.id,deliveryId:receipt.deliveryId}});
        assert.equal(retry.followups.find(r=>r.operationId==='exact-b').state,'accepted');assert.equal(adapter.calls.length,0);
        assert.equal(v.messages.filter(m=>m.text==='FOLLOWUP_EXACT').length,1);
        const nativeUser=ctx.agents.get(g.rootSessionId).session.snapshotEvents().find(e=>e.type==='user/message'&&e.data.id===t.inputMessageId);
        assert.equal(nativeUser.data.source.kind,'user');assert.deepEqual(nativeUser.data.source.group,group);assert.equal(nativeUser.data.source.turnId,t.id);
        await save('cold-result',{status:'PASS',strictRegistration:true,preservedHistory:true,idempotentRetry:true,modelRequests:0});console.log('CONCURRENT_GROUP_DONE');return;
      }
      for(const id of ['alpha','beta']){const b=await ctx.dshBots.create({id,name:id,template:'minimal',model:{provider:'dp-b6b',model:'fixture'}});keys.push({botId:id,botCreatedAt:b.createdAt});}
      const g=await groups.create({operationId:'concurrent',name:'Concurrency',mode:'natural',members:keys,historyConfirmed:true});
      const key={groupId:g.id,groupCreatedAt:g.createdAt},view=()=>groups.view(key),members=(await view()).members;
      debugView=view;
      await mark('native-api-spike');
      const t=await send(key,{operationId:'spike',text:'SPIKE_A',memberIds:[members[0].id],expectedMembershipRevision:1});
      const d=await wait(async()=>{const v=await view();return v.deliveries.find(d=>d.turnId===t.id&&d.state==='running')});
      await wait(()=>adapter.calls.length===1);
      const receipt=await ctx.subagents.prompt({requestId:'spike-followup',parentSessionId:g.rootSessionId,childSessionId:d.childSessionId,mode:'continuable',delivery:'steer',content:[{type:'text',text:'FOLLOWUP_EXACT'}]},controller.signal);
      assert.ok(receipt.messageId); for(const release of adapter.gates.values())release();
      const done=await wait(async()=>{const v=await view();return v.turns.find(x=>x.id===t.id&&!['accepted','running'].includes(x.state))&&v});
      assert.ok(adapter.calls.some(c=>c.input.includes('FOLLOWUP_EXACT')));assert.ok(done.messages.some(m=>m.text.includes('FOLLOWUP_RESULT')));
      assert.equal(adapter.calls.some(c=>c.sessionId===g.rootSessionId),false);
      await save('spike',{status:'PASS',receipt,rootModelRequests:0,realModelRequests:0});
      await mark('two-independent-workers'); adapter.gates.clear();
      const before=adapter.calls.length;
      const a=await send(key,{operationId:'work-a',text:'INDEPENDENT_A',memberIds:[members[0].id],expectedMembershipRevision:1});
      const b=await send(key,{operationId:'work-b',text:'INDEPENDENT_B',memberIds:[members[1].id],expectedMembershipRevision:1});
      await wait(()=>adapter.calls.length===before+2);
      const both=await view();assert.equal(both.deliveries.filter(d=>[a.id,b.id].includes(d.turnId)&&d.state==='running').length,2);
      const c=await send(key,{operationId:'work-c',text:'FUTURE_C',memberIds:[members[0].id],expectedMembershipRevision:1});
      assert.equal(adapter.calls.length,before+2);assert.equal((await view()).turns.find(t=>t.id===c.id).state,'accepted');
      assert.ok(adapter.calls.slice(before).every(call=>!call.input.includes('FUTURE_C')));
      await mark('exact-supplement');
      await ctx.dshBots.update(both.deliveries.find(d=>d.turnId===b.id).bot.botId, {persona:{prefix:'LIVE_GROUP_ROLE'}});
      const target=both.deliveries.find(d=>d.turnId===b.id);
      const input={operationId:'exact-b',text:'FOLLOWUP_EXACT',expectedMembershipRevision:1,followup:{turnId:b.id,deliveryId:target.id}};
      step='send-followup'; const accepted=await send(key,input);assert.equal(accepted.followups[0].state,'accepted');
      const requestCount=adapter.calls.length;await send(key,input);assert.equal(adapter.calls.length,requestCount);
      step='release-b'; adapter.gates.get(target.childSessionId)();
      await wait(async()=>{const v=await view();return v.turns.find(t=>t.id===b.id&&t.state==='completed')});
      step='b-done'; const bCalls=adapter.calls.filter(c=>c.sessionId===target.childSessionId);assert.ok(bCalls.some(c=>c.input.includes('FOLLOWUP_EXACT')));assert.ok(bCalls.some(c=>c.input.includes('LIVE_GROUP_ROLE')));
      const da=both.deliveries.find(d=>d.turnId===a.id);assert.ok(adapter.calls.filter(c=>c.sessionId===da.childSessionId).every(c=>!c.input.includes('FOLLOWUP_EXACT')));
      await wait(()=>adapter.calls.length>=before+4);
      await mark('cancel-single-chain');
      const current=await view();await groups.cancel(key,a.id,current.turns.find(t=>t.id===a.id).revision);
      adapter.gates.get(da.childSessionId)?.();
      await wait(async()=>{const v=await view();return v.turns.find(t=>t.id===a.id&&t.state==='cancelled')});
      const dc=(await view()).deliveries.find(d=>d.turnId===c.id);assert.equal(dc.state,'running');adapter.gates.get(dc.childSessionId)();
      await wait(async()=>{const v=await view();return v.turns.find(t=>t.id===c.id&&t.state==='completed')});
      const final=await view();assert.equal(final.messages.filter(m=>m.text==='FOLLOWUP_EXACT').length,1);
      assert.equal(final.messages.filter(m=>m.turnId===b.id&&m.text==='FOLLOWUP_RESULT').length,1);
      assert.equal(adapter.calls.some(c=>c.sessionId===g.rootSessionId),false);
      await save('concurrent-view',final);await save('adapter',adapter.calls);
      await save('result',{status:'PASS',phase,nativePrompt:true,twoConcurrentTurns:true,boundedThird:true,exactSupplement:true,idempotentRetry:true,singleChainCancel:true,rootModelRequests:0,realModelRequests:0}); console.log('CONCURRENT_GROUP_DONE');
    })().catch(async error=>{await save('failure-adapter',adapter.calls); if(debugView)await save('failure-view',await debugView()); await save('result',{status:'FAIL',phase,step,error:String(error),stack:error.stack});console.log('CONCURRENT_GROUP_FAILED');});
    return async()=>{clearTimeout(timer);controller.abort();for(const release of adapter.gates.values())release();await run;for(const off of releases.reverse())off();};
  });
}
