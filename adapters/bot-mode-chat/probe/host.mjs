import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const sdk=createRequire(resolve(process.cwd(),'packages/dsh-bot/package.json'));
const {LlmAdapter,createUserMessage}=await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-llm')));
export const inject=['loader','llm','sessionController','sessions','webServer','dshBots'];
export function apply(ctx,config){let target;ctx.on('webserver/index-inject',table=>table.push({kind:'global',name:'__DSH_CHAT_ADAPTER_FIXTURE__',value:target}));
 return ctx.effect(()=>{let off;const run=(async()=>{await ctx.loader.await();assert.deepEqual(ctx.llm.listProviders(),[]);
 class Adapter extends LlmAdapter{async listModels(provider){return[{provider,id:'fixture',name:'Chat branch synthetic fixture'}]}async *stream(){const text='CHAT_ADAPTER_NATIVE_ASSISTANT';yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text};yield{type:'block-end',index:0,block:{type:'text',text}};yield{type:'finish',reason:{kind:'stop'}};}}
 off=ctx.llm.registerAdapter(['dp-loopback'],new Adapter());
 await ctx.dshBots.waitUntilReady();await ctx.dshBots.create({id:'native-chat-test',name:'Native Chat Test Bot',template:'minimal',model:{provider:'dp-loopback',model:'fixture'},memory:{enabled:false,injectLimit:20}});
 const main=await ctx.dshBots.openConversation('native-chat-test');target=main.sessionId;
 const {agent}=await ctx.sessionController.resolveAgent(main.sessionId);assert.ok(agent);agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'CHAT_ADAPTER_SEED'}]}));await agent.whenIdle();await ctx.sessions.flush(agent.session);
 await writeFile(resolve(config.outputDir,'fixture.json'),JSON.stringify({sessionId:target,realModelRequests:0}));console.log('B4_WEB_READY');})().catch(async e=>{await writeFile(resolve(config.outputDir,'fixture-error.json'),JSON.stringify({error:String(e),stack:e.stack}));console.log('B4_WEB_FAILED')});return async()=>{await run;off?.()}});
}
