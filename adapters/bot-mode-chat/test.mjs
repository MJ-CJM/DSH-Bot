import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { BASELINE_SHA256, PATCHES, patchBotModeChat } from './patch.mjs';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'../..'),r=createRequire(resolve(root,'.dsh-dev/proactive-bot/host-runtime/package.json'));
const native=createRequire(r.resolve('@deepseek-ai/dsh/package.json'));
const baseline=await readFile(native.resolve('@deepseek-ai/dsh-client-ui-chat/client'));
const patched=patchBotModeChat(baseline);
function forkBody(source) {
 const start=source.indexOf('forkAt: (seq) => {')+'forkAt: '.length;assert.ok(start>20);
 const begin=source.indexOf('{',start);let depth=0,quote,escaped=false;
 for(let i=begin;i<source.length;i++){const c=source[i];if(quote){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c===quote)quote=undefined;continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c==='{')depth++;else if(c==='}'&&--depth===0)return source.slice(start,i+1);}
 throw Error('Missing native fork closure');
}
function fixture(){let resolution={status:'pass'},rows=[];const forked=[],opened=[];let handled=0;
 const policy={modePresentation:{getSnapshot:()=>rows,subscribe:()=>()=>{}},resolveCommandMode:()=>resolution};
 const ctx={shortcuts:policy,sessions:{fork:request=>{forked.push(request);return Promise.resolve('native-child')}},uiWorkspace:{openSession:id=>opened.push(id)},get:()=>undefined};
 const fork=runInNewContext(`(${forkBody(patched)})`,{ctx,sessionId:'exact-native-session',document:{activeElement:null},chat:{getSnapshot:()=>({timeline:{turns:new Map()}})}});
 return{policy,fork,forked,opened,setMode(value){rows=value?[{id:'session.fork',hidden:true}]:[];resolution=value?{status:'blocked',reason:'bot-mode'}:{status:'pass'};},setHandled(){resolution={status:'handled',run:()=>handled++};},handled:()=>handled};
}
function render(source,policy,fork){const a=source.indexOf('const TurnTailNodeView ='),b=source.indexOf('//#endregion',a);const component=source.slice(a,b);
 const jsx=(type,props)=>({type,props});
 const globals={react:{memo:fn=>fn,useSyncExternalStore:(_subscribe,snapshot)=>snapshot()},react_jsx_runtime:{jsx,jsxs:jsx},MessageIconActions:'MessageIconActions',TurnUsagePanel:'TurnUsagePanel',TurnTailNodeView_module_css_default:{root:'native-root',actions:'native-actions'},assistantText:()=> 'native assistant text',lastContent:()=>undefined,hasAssistantReplyContent:()=>true,testPolicy:policy};
 const helper=source.includes('__dshBotUseBranchHidden')?`${PATCHES[0][1].slice(PATCHES[0][1].indexOf('\n'))}\n__dshBotChatShortcutPolicy=testPolicy;\n`:'';
 const run=runInNewContext(`${helper}${component}\nTurnTailNodeView;`,globals);
 return run({node:{location:{kind:'turn',turn:4},data:{turn:4,seq:77,branchUnavailable:false,tokenUsage:{input:3},closing:{finalNode:{seq:77,messageId:'exact-message'},time:123,blocks:[]}}},openFile:()=>{},forkAt:fork,renderSlot:slot=>slot==='conversation.chat.assistant-actions'?'native feedback':'native tail',t:x=>x,useAccess:()=>true,useChat:select=>select({timeline:{turnOrder:[4]}}),usePerformanceUsage:()=> 'detailed'}).props.children[1].props;
}
test('hash-pinned patch rejects drift and preserves every non-Branch byte',()=>{
 assert.equal(BASELINE_SHA256.length,64);assert.throws(()=>patchBotModeChat(Buffer.from('drift')),/Unexpected/);
 let reverse=patched;for(const [anchor,replacement]of [...PATCHES].reverse())reverse=reverse.replace(replacement,anchor);
 assert.equal(reverse,baseline.toString().replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/u,'\n'));
});
test('native footer hides only Branch and off preserves native copy/time/usage/feedback',()=>{
 const f=fixture();const original=render(baseline.toString(),f.policy,f.fork),off=render(patched,f.policy,f.fork);
 for(const key of Object.keys(original).filter(key=>key!=='onBranch'))assert.equal(JSON.stringify(off[key]),JSON.stringify(original[key]));
 assert.equal(typeof off.onBranch,'function');f.setMode(true);const active=render(patched,f.policy,f.fork);assert.equal(active.onBranch,undefined);
 assert.equal(active.text,'native assistant text');assert.equal(active.time,123);assert.equal(active.extraActions,'native feedback');assert.equal(active.usageAction.type,'TurnUsagePanel');
 f.setMode(false);assert.equal(typeof render(patched,f.policy,f.fork).onBranch,'function');
});
test('a captured native Branch callback rechecks current mode; off forks exact seq once',async()=>{
 const f=fixture(),captured=render(patched,f.policy,f.fork).onBranch;f.setMode(true);captured();assert.equal(f.forked.length,0);
 f.setMode(false);captured();await Promise.resolve();assert.equal(f.forked.length,1);assert.equal(f.forked[0].atSeq,77);assert.equal(f.forked[0].sessionId,'exact-native-session');assert.deepEqual(f.opened,['native-child']);
});
test('handled action executes mode exactly once without native fork',()=>{const f=fixture();f.setHandled();f.fork(19);assert.equal(f.handled(),1);assert.equal(f.forked.length,0);});
