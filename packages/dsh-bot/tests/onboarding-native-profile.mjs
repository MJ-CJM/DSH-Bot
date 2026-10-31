import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'onboarding-native-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let calls = 0, sideEffects = 0, agent, slowWelcome = false, enteredSlow = false;
    const caps = [];
    const releases = [], save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    class Adapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Onboarding synthetic fixture' }]; }
      async *stream(options) {
        calls++; caps.push(options.maxTokens);
        const input = agent.session.snapshotEvents().findLast(e => e.type === 'user/message' && ['user', 'dsh-bot-onboarding'].includes(e.data.source.kind));
        if (slowWelcome && input?.data.source.kind === 'dsh-bot-onboarding') {
          enteredSlow = true;
          await new Promise((_resolve,reject)=>{ const abort=()=>reject(options.signal.reason ?? new Error('aborted')); if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true}); });
        }
        if (input?.data.source.kind === 'dsh-bot-onboarding' && !agent.session.snapshotEvents().some(e => e.type === 'tool/result')) {
          const id = ToolCallId('welcome-denied'), args = '{}';
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id, name: 'onboarding_fixture', argumentsDelta: args };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'onboarding_fixture', arguments: args } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        }
        const text = input?.data.source.kind === 'dsh-bot-onboarding' ? 'Hello. What should I help with first?' : 'NORMAL_USER_REPLY';
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const timer = setTimeout(() => { void save('result', {status:'FAIL',error:'deadline'}); }, 45000);
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      if (config.cold) {
        await ctx.dshBots.waitUntilReady();
        for (let n=0;n<200&&!ctx.dshBots.onboarding;n++) await new Promise(r=>setTimeout(r,20));
        const receipt=await ctx.dshBots.onboardingStatus('onboarding-native'); assert.equal(receipt.state,'completed');
        assert.equal(ctx.agents.get(receipt.sessionId),undefined);
        const unchanged=await ctx.dshBots.startOnboarding({botId:'onboarding-native',operationId:receipt.operationId,sessionId:receipt.sessionId}); assert.equal(unchanged.state,'completed');
        assert.equal(ctx.agents.get(receipt.sessionId),undefined); assert.deepEqual(ctx.llm.listProviders(),[]);
        await save('cold-result',{status:'PASS',receipt,coldNoAgentWake:true,calls:0,realModelRequests:0}); console.log('ONBOARDING_NATIVE_DONE'); return;
      }
      releases.push(ctx.llm.registerAdapter(['dp-b6b'], new Adapter())); await ctx.dshBots.waitUntilReady();
      const operationId = randomUUID();
      const creation = {operationId,language:'en',bot:{id:'onboarding-native',name:'Onboarding native',memory:{enabled:false,injectLimit:0}}};
      const bot = await ctx.dshBots.createForChat(creation);
      assert.deepEqual(await ctx.dshBots.createForChat(creation),bot);
      const main = await ctx.dshBots.openConversation('onboarding-native'); agent = (await ctx.sessionController.resolveAgent(main.sessionId)).agent;
      releases.push(agent.ctx.tools.register({name:'onboarding_fixture',description:'Synthetic effect counter',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{sideEffects++;return 'OK';}}));
      const request = {botId:'onboarding-native',operationId,sessionId:main.sessionId};
      const started = await ctx.dshBots.startOnboarding(request); assert.ok(['submitted','completed'].includes(started.state));
      await agent.whenIdle();
      for (let n=0;n<100 && (await ctx.dshBots.onboardingStatus('onboarding-native')).state!=='completed';n++) await new Promise(r=>setTimeout(r,20));
      const receipt = await ctx.dshBots.onboardingStatus('onboarding-native'); assert.equal(receipt.state,'completed');
      const beforeRepeat=calls; await ctx.dshBots.startOnboarding(request); await ctx.dshBots.retryOnboarding(request); assert.equal(calls,beforeRepeat);
      const message=agent.session.snapshotEvents().find(e=>e.type==='user/message'&&e.data.source.kind==='dsh-bot-onboarding').data;
      const events = agent.session.snapshotEvents(); await save('events',events);
      assert.ok(events.some(e=>e.type==='user/message' && e.data.id===message.id && e.data.source.kind==='dsh-bot-onboarding'));
      assert.equal(events.filter(e=>e.type==='user/message' && e.data.source.kind==='user').length,0);
      assert.equal(sideEffects,0); assert.ok(events.some(e=>e.type==='tool/result' && e.data.message.isError));
      assert.ok(events.some(e=>e.type==='assistant/message' && JSON.stringify(e.data).includes('What should I help')));
      await ctx.sessionController.prompt({sessionId:agent.id,requestId:'after-onboarding',mode:'queue',content:[{type:'text',text:'USER_TASK'}]},new AbortController().signal); await agent.whenIdle();
      assert.ok(agent.session.snapshotEvents().some(e=>e.type==='assistant/message'&&JSON.stringify(e.data).includes('NORMAL_USER_REPLY')));
      assert.ok(await ctx.sessions.flush(agent.session));
      assert.equal(caps[0],256); assert.notEqual(caps.at(-1),256);
      const fastSessionId=agent.id;
      const slowOperationId=randomUUID(); await ctx.dshBots.createForChat({operationId:slowOperationId,language:'en',bot:{id:'slow-welcome',name:'Slow welcome',memory:{enabled:false,injectLimit:0}}});
      const slowMain=await ctx.dshBots.openConversation('slow-welcome'); agent=(await ctx.sessionController.resolveAgent(slowMain.sessionId)).agent;
      slowWelcome=true; await ctx.dshBots.startOnboarding({botId:'slow-welcome',operationId:slowOperationId,sessionId:agent.id});
      for(let n=0;n<100&&!enteredSlow;n++) await new Promise(r=>setTimeout(r,20)); assert.equal(enteredSlow,true);
      await ctx.sessionController.prompt({sessionId:agent.id,requestId:'priority-user',mode:'queue',content:[{type:'text',text:'PRIORITY_USER_TASK'}]},new AbortController().signal); await agent.whenIdle();
      await save('priority-events',agent.session.snapshotEvents());
      assert.ok(agent.session.snapshotEvents().some(e=>e.type==='turn/end'&&e.data.reason.kind==='aborted'));
      assert.ok(agent.session.snapshotEvents().some(e=>e.type==='assistant/message'&&JSON.stringify(e.data).includes('NORMAL_USER_REPLY')));
      const afterPriority=calls; await ctx.dshBots.retryOnboarding({botId:'slow-welcome',operationId:slowOperationId,sessionId:agent.id}); assert.equal(calls,afterPriority);
      const assembleCases=[];
      slowWelcome=false;
      for(const kind of ['queue','steer','attachment']) {
        const operationId=randomUUID(),botId=`assemble-${kind}`;
        await ctx.dshBots.createForChat({operationId,language:'en',bot:{id:botId,name:botId,memory:{enabled:false,injectLimit:0}}});
        const main=await ctx.dshBots.openConversation(botId);agent=(await ctx.sessionController.resolveAgent(main.sessionId)).agent;
        let entered=false,releaseGate;const gate=new Promise(resolve=>{releaseGate=resolve;});
        const off=agent.ctx.on('system-prompt/assemble',async(_a,_c,next)=>{if(!entered){entered=true;await gate;}return next();},{prepend:true});
        const before=calls;const starting=ctx.dshBots.startOnboarding({botId,operationId,sessionId:agent.id});
        for(let n=0;n<200&&!entered;n++)await new Promise(r=>setTimeout(r,10));assert.equal(entered,true);
        const content=kind==='attachment'?[{type:'image',mediaType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',name:'pixel.png'}]:[{type:'text',text:`ASSEMBLE_${kind.toUpperCase()}_USER`}];
        await ctx.sessionController.prompt({sessionId:agent.id,requestId:`assemble-${kind}-user`,mode:kind==='steer'?'steer':'queue',content},new AbortController().signal);
        releaseGate();await starting;await agent.whenIdle();off();
        const events=agent.session.snapshotEvents();await save(`assemble-${kind}-events`,events);
        assert.equal(events.filter(e=>e.type==='user/message'&&e.data.source.kind==='user').length,1);
        assert.ok(events.some(e=>e.type==='assistant/message'&&JSON.stringify(e.data).includes('NORMAL_USER_REPLY')),`${kind} user response missing`);
        assert.equal(events.filter(e=>e.type==='user/message'&&e.data.source.kind==='dsh-bot-onboarding').length,0);
        assert.equal(calls-before,1);assembleCases.push({kind,status:'PASS',userInputs:1,modelCalls:1});
      }
      const cancellationCases=[];
      for(const kind of ['timeout','close']) {
        const operationId=randomUUID(),botId=`cancel-${kind}`;
        await ctx.dshBots.createForChat({operationId,language:'en',bot:{id:botId,name:botId,memory:{enabled:false,injectLimit:0}}});
        const main=await ctx.dshBots.openConversation(botId);agent=(await ctx.sessionController.resolveAgent(main.sessionId)).agent;
        let entered=false,aborted=false;
        const off=agent.ctx.on('agent/request',async(payload,next)=>{
          entered=true;
          await new Promise((_resolve,reject)=>{const abort=()=>{aborted=true;reject(payload.signal.reason);};if(payload.signal.aborted)abort();else payload.signal.addEventListener('abort',abort,{once:true});});
          return next();
        },{prepend:true});
        const oldTimeout=ctx.dshBots.config.onboardingTimeoutMs;ctx.dshBots.config.onboardingTimeoutMs=1000;
        const before=calls;await ctx.dshBots.startOnboarding({botId,operationId,sessionId:agent.id});
        for(let n=0;n<200&&!entered;n++)await new Promise(r=>setTimeout(r,10));assert.equal(entered,true);
        if(kind==='close')await ctx.dshBots.onboarding.close();
        else {for(let n=0;n<300&&!aborted;n++)await new Promise(r=>setTimeout(r,10));}
        await agent.whenIdle();off();ctx.dshBots.config.onboardingTimeoutMs=oldTimeout;
        assert.equal(aborted,true);assert.equal(calls,before);cancellationCases.push({kind,status:'PASS',preAdmissionAbort:true,modelCalls:0});
      }
      await save('result',{status:'PASS',receipt,source:message.source,inputId:message.id,sessionId:fastSessionId,calls,caps,sideEffects,normalUserAfter:true,slowUserPriority:true,assembleCases,cancellationCases,realModelRequests:0}); console.log('ONBOARDING_NATIVE_DONE');
    })().catch(async error=>{await save('result',{status:'FAIL',error:String(error),stack:error.stack});console.log('ONBOARDING_NATIVE_FAILED');});
    return async()=>{clearTimeout(timer);await run;for(const release of releases.reverse())release();};
  });
}
