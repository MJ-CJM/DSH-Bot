window.__ModuleLoader__.load({id:'dsh-bot-workspace-adapter-probe',factory(require){const R=require('react'),h=R.createElement;return{inject:['shortcuts','slots','sessions'],apply(ctx){
 const snapshot=()=>JSON.stringify({surfaces:ctx.shortcuts.commandModeSurfaces,phase:ctx.sessions.list.getSnapshot().phase,rows:ctx.sessions.list.getSnapshot().ids.map(id=>({id,preset:ctx.sessions.list.getSnapshot().byId[id]?.projectionValues?.agentPreset}))});
 function Probe(){const value=R.useSyncExternalStore(ctx.sessions.list.subscribe,snapshot);return h('output',{'data-workspace-policy-state':'',style:{pointerEvents:'auto',background:'var(--dsw-alias-bg-base)'}},value)}
 ctx.effect(()=>ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'workspace-preset-probe',locale:'dsh-bot'},Probe)));
}}}});
