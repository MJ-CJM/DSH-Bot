import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {writeFile,appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const r=createRequire(resolve(process.cwd(),'packages/dsh-bot/package.json'));
const{LlmAdapter}=await import(pathToFileURL(r.resolve('@deepseek-ai/dsh-llm')));
export const inject=['loader','llm','dshBots'];
export function apply(ctx,config){return ctx.effect(()=>{let release,pending=Promise.resolve();
 const off=ctx.on('agent-preset/selected',(sessionId,agentPreset)=>{pending=pending.then(()=>appendFile(resolve(config.outputDir,'selected-events.jsonl'),`${JSON.stringify({sessionId,agentPreset})}\n`))});
 const run=(async()=>{await ctx.loader.await();await ctx.dshBots.waitUntilReady();assert.deepEqual(ctx.llm.listProviders(),[]);
 class Adapter extends LlmAdapter{async listModels(provider){return[{provider,id:'fixture',name:'Workspace no-request fixture'}]}stream(){throw Error('No model turn is expected in blank-preset test');}}
 release=ctx.llm.registerAdapter(['dp-loopback'],new Adapter());const existing=await ctx.dshBots.list();const sessions={};
 for(const id of['reserved-one','reserved-two','reserved-three','reserved-never-open']){if(!existing.some(bot=>bot.id===id))await ctx.dshBots.create({id,name:id,template:'minimal',model:{provider:'dp-loopback',model:'fixture'},memory:{enabled:false,injectLimit:20}});let main;for(let n=0;n<150;n++){try{main=await ctx.dshBots.openConversation(id);break}catch(e){if(!String(e).includes('Main sessions are starting'))throw e;await new Promise(a=>setTimeout(a,100));}}assert.ok(main);sessions[id]=main.sessionId;}
 await writeFile(resolve(config.outputDir,'fixture.json'),JSON.stringify({sessions,realModelRequests:0}));console.log('B4_WEB_READY');})().catch(async e=>{await writeFile(resolve(config.outputDir,'fixture-error.json'),JSON.stringify({error:String(e),stack:e.stack}));console.log('B4_WEB_FAILED')});
 return async()=>{off();await run;await pending;release?.()};});}
