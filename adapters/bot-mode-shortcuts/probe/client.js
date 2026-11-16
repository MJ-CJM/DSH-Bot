window.__ModuleLoader__.load({id:"dsh-bot-mode-adapter-probe",factory(require){var module={exports:{}};

module.exports = { inject:['shortcuts','slots','sessions','workspaces'], async apply(ctx){
 const R=require('react'), h=R.createElement, listeners=new Set();
 let handle, record={active:false,calls:[],blocked:0,runtime:ctx.shortcuts.runtime,native:!!window.dshDesktop?.keyboard};
 const publish=()=>{for(const f of listeners)f();console.info(`DSH_BOT_NATIVE_PROBE ${snapshot()}`)};
 const snapshot=()=>JSON.stringify({...record,catalog:ctx.shortcuts.catalog.getSnapshot().filter(r=>/^session\.(new|fork|archive)$/.test(r.id)),workspaces:ctx.workspaces.list.getSnapshot()});
 const install=async()=>{handle=ctx.shortcuts.registerCommandMode({id:'adapter.browser-test',priority:200,commands:Object.fromEntries(['new','archive','fork'].map(id=>[`session.${id}`,{label:()=> `Bot ${id}`,hidden:id==='fork',resolve:()=>{if(id==='fork'){record.blocked++;publish();return {status:'blocked',reason:'test-bot-mode'}}return {status:'handled',run:()=>{record.calls.push(id);publish()}}}}]))});await handle.ready;record.active=true;publish()};
 const dispose=async()=>{await handle?.dispose();handle=undefined;record.active=false;publish()};
 function Controls(){const state=R.useSyncExternalStore(f=>{listeners.add(f);return()=>listeners.delete(f)},snapshot);return h('div',{'data-adapter-controls':'',style:{pointerEvents:'auto',background:'var(--dsw-alias-bg-base)'}},h('button',{onClick:install},'Enable adapter test'),h('button',{onClick:dispose},'Dispose adapter test'),h('output',{'data-adapter-state':'',style:{display:'none'}},state),h('pre',{'data-adapter-visible':''},`Native bridge: ${record.native}; runtime: ${record.runtime}; mode: ${record.active}; calls: ${record.calls.join(', ')}; blocked Fork: ${record.blocked}`))}
 ctx.effect(()=>ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'adapter.browser-test-controls',locale:'dsh-bot'},Controls)));
 ctx.effect(()=>{const off=ctx.workspaces.list.subscribe(publish);return async()=>{off();await dispose()}});
}};
return module.exports;
}});
