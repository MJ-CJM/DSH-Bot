import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name='onboarding-crash-profile';
export const inject=['loader','llm','agents','sessions','storageDomain','dshBots','sessionController'];
export function apply(ctx,config) {
  ctx.effect(()=>{
    const releases=[], save=(name,value)=>writeFile(resolve(config.outputDir,`${name}.json`),JSON.stringify(value,null,2));
    let calls=0,phase='loader',armed=false,barrierReached=false;
    const barrier=async value=>{
      if(barrierReached)return;barrierReached=true;
      await save('barrier',{point:config.point,pid:process.pid,calls,value,realModelRequests:0});
      console.log('ONBOARDING_CRASH_BARRIER');await new Promise(()=>{});
    };
    class Adapter extends LlmAdapter {
      async listModels(provider){return[{provider,id:'fixture',name:'Crash-only synthetic'}];}
      async *stream(){calls++;const text='CRASH_SYNTHETIC_GREETING';yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text};yield{type:'block-end',index:0,block:{type:'text',text}};yield{type:'finish',reason:{kind:'stop'}};}
    }
    const task=(async()=>{
      await ctx.loader.await();await ctx.dshBots.waitUntilReady();
      for(let n=0;n<300&&!ctx.dshBots.onboarding;n++)await new Promise(r=>setTimeout(r,10));
      assert.deepEqual(ctx.llm.listProviders(),[]);
      if(config.cold){
        const status=await ctx.dshBots.onboardingStatus('crash-bot');
        const expected=config.point==='before-receipt'?['pending']:config.point==='after-completed'?['completed']:config.point==='after-receipt'?['uncertain']:['uncertain','completed'];
        assert.ok(expected.includes(status.state),JSON.stringify(status));
        if(status.state!=='pending'){
          const again=await ctx.dshBots.retryOnboarding({botId:'crash-bot',operationId:status.operationId,sessionId:status.sessionId});assert.equal(again.state,status.state);
        }
        assert.equal(ctx.agents.list().length,0);assert.deepEqual(ctx.llm.listProviders(),[]);
        await save('cold-result',{status:'PASS',point:config.point,onboarding:status,calls,realModelRequests:0});console.log('ONBOARDING_CRASH_DONE');return;
      }
      releases.push(ctx.llm.registerAdapter(['dp-b6b'],new Adapter()));
      const bot=await ctx.dshBots.createForChat({operationId:config.operationId,language:'en',bot:{id:'crash-bot',name:'Crash fixture',memory:{enabled:false,injectLimit:0}}});
      const main=await ctx.dshBots.openConversation(bot.id);
      const table=ctx.storageDomain.get('dsh_bot_onboarding').table('receipts');
      const originalPut=table.put.bind(table),originalUpdate=table.update.bind(table),originalFlush=ctx.sessions.flush.bind(ctx.sessions);
      table.put=async(id,value)=>{
        if(armed&&value.state==='dispatching'&&config.point==='before-receipt')await barrier(value);
        const result=await originalPut(id,value);
        if(armed&&value.state==='dispatching'&&config.point==='after-receipt')await barrier(value);
        if(armed&&value.state==='completed'&&config.point==='after-completed')await barrier(value);
        return result;
      };
      table.update=async(id,updater)=>{
        const predicted=updater(table.get(id));
        if(armed&&predicted.state==='submitted'&&config.point==='before-submitted')await barrier(predicted);
        const result=await originalUpdate(id,updater);
        if(armed&&result.state==='completed'&&config.point==='after-completed')await barrier(result);
        return result;
      };
      ctx.sessions.flush=async session=>{
        const matches=armed&&session.id===main.sessionId&&session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.source.kind==='dsh-bot-onboarding');
        if(matches&&config.point==='before-native-flush')await barrier({sessionId:session.id});
        const result=await originalFlush(session);
        if(matches&&config.point==='after-native-flush')await barrier({sessionId:session.id});
        return result;
      };
      armed=true;phase='dispatch';await ctx.dshBots.startOnboarding({botId:bot.id,operationId:config.operationId,sessionId:main.sessionId});
      await new Promise(()=>{});
    })().catch(async error=>{await save('result',{status:'FAIL',phase,error:String(error),stack:error.stack});console.log('ONBOARDING_CRASH_FAILED');});
    return async()=>{for(const release of releases.reverse())release();if(!barrierReached)await task;};
  });
}
