window.__ModuleLoader__.load({id:'dsh-bot-chat-adapter-probe',factory(require){
 const R=require('react'),h=R.createElement;
 return{inject:['shortcuts','slots','sessions','uiWorkspace'],apply(ctx){let mode,active=false,blocked=0;const listeners=new Set();
 const state=()=>JSON.stringify({active,blocked,surfaces:ctx.shortcuts.commandModeSurfaces,sessionIds:ctx.sessions.list.getSnapshot().ids,phase:ctx.sessions.list.getSnapshot().phase,known:!!ctx.sessions.list.getSnapshot().byId[window.__DSH_CHAT_ADAPTER_FIXTURE__]});const publish=()=>{for(const f of listeners)f()};
 const enable=async()=>{mode=ctx.shortcuts.registerCommandMode({id:'native-chat-probe',priority:100,commands:{'session.fork':{hidden:true,resolve:()=>{blocked++;publish();return{status:'blocked',reason:'bot-mode'}}}}});await mode.ready;active=true;publish()};
 const dispose=async()=>{await mode?.dispose();mode=undefined;active=false;publish()};
 function Controls(){const value=R.useSyncExternalStore(f=>{listeners.add(f);return()=>listeners.delete(f)},state);return h('section',{style:{pointerEvents:'auto',background:'var(--dsw-alias-bg-base)'}},h('button',{onClick:()=>ctx.uiWorkspace.openSession(window.__DSH_CHAT_ADAPTER_FIXTURE__)},'Open native fixture'),h('button',{onClick:enable},'Enable Chat policy'),h('button',{onClick:dispose},'Dispose Chat policy'),h('output',{'data-chat-policy-state':''},value))}
 ctx.effect(()=>ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'chat-policy-probe',locale:'dsh-bot'},Controls)));ctx.effect(()=>()=>dispose());ctx.effect(()=>ctx.sessions.list.subscribe(publish));
 }};
}});
