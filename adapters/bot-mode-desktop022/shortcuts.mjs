import { createHash } from 'node:crypto';

/** Original desktop 0.2.2-rc.2 client, before any repository adaptation. */
export const SHORTCUTS_BASELINE_SHA256 = '9bebb512fb8c0eb784ed9b3eb7b4c041f40670988ba6e26bb10185769ed69d2d';
export const SHORTCUTS_VERSION = '0.2.2-rc.2';

function replaceOnce(source, before, after) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error('Desktop shortcuts patch anchor missing or ambiguous');
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

// Added registry policy only. The original protocol, storage, native keyboard,
// DOM arbitration, modal ownership and dispatch consumption order remain intact.
const registryMethods = String.raw`
registerCommandMode(input){
  if(!input.id||!Number.isFinite(input.priority))throw new Error('Invalid shortcut command mode');
  if(this.modes.has(input.id))throw new Error('Duplicate shortcut mode: '+input.id);
  const commands=Object.freeze(Object.fromEntries(Object.entries(input.commands).map(([id,row])=>{
    if(typeof row.resolve!=='function'||(row.label!==undefined&&typeof row.label!=='function')||(row.hidden!==undefined&&typeof row.hidden!=='boolean'))throw new Error('Invalid shortcut command mode entry');
    for(const mode of this.modes.values())if(mode.priority===input.priority&&Object.hasOwn(mode.commands,id))throw new Error('Conflicting shortcut modes: '+input.id+' and '+mode.id+' ('+id+')');
    return[id,Object.freeze({...row})];
  })));
  const mode=Object.freeze({id:input.id,priority:input.priority,commands});
  this.modes.set(mode.id,mode);
  try{this.refreshLabels()}catch(error){this.modes.delete(mode.id);this.refreshLabels();throw error}
  return()=>{if(this.modes.get(mode.id)!==mode)return;this.modes.delete(mode.id);this.refreshLabels()};
}
commandModes(id){return[...this.modes.values()].filter(mode=>Object.hasOwn(mode.commands,id)).sort((left,right)=>right.priority-left.priority)}
resolveCommandMode(id,context){
  for(const mode of this.commandModes(id)){const result=mode.commands[id].resolve(context);if(result.status!=='pass')return result}
  return{status:'pass'};
}
resolveCommand(command,context){const result=this.resolveCommandMode(command.id,context);return result.status==='pass'?command.resolve(context):result}
refreshModePresentation(){
  const ids=new Set([...this.modes.values()].flatMap(mode=>Object.keys(mode.commands)));
  this.modePresentation.set([...ids].map(id=>{
    const rows=this.commandModes(id);
    const label=rows.find(mode=>mode.commands[id].label!==undefined)?.commands[id].label;
    return{id,hidden:rows.find(mode=>mode.commands[id].hidden!==undefined)?.commands[id].hidden??false,...label===undefined?{}:{label:label()}};
  }));
}
clearCommandModes(){this.modes.clear();this.refreshLabels()}
`;

const serviceMethods = String.raw`
get commandModeSurfaces(){return['keyboard','menu',...this.modeSurfaces.keys()]}
registerCommandModeSurface(surface){
  if(!this.active||(surface!=='chat.branch'&&surface!=='workspace.blank-preset'))throw new Error('Unsupported command mode surface');
  const owner=Symbol(surface);let owners=this.modeSurfaces.get(surface);
  if(owners===undefined){owners=new Set;this.modeSurfaces.set(surface,owners)}
  owners.add(owner);this.registry.refreshLabels();
  return()=>{if(this.modeSurfaces.get(surface)!==owners||!owners.delete(owner))return;if(owners.size===0)this.modeSurfaces.delete(surface);this.registry.refreshLabels()};
}
resolveCommandMode(...args){return this.registry.resolveCommandMode(...args)}
registerCommandMode(mode){
  if(!this.active)throw new Error('Shortcut service disposed');
  const off=this.registry.registerCommandMode(mode);
  const ready=Promise.resolve();let disposed;
  return{ready,dispose:()=>disposed??=Promise.resolve().then(()=>{off()})};
}
`;

/** Pure, deliberately version-specific patch; rejects both drift and double patching. */
export function patchShortcuts(source) {
  if (typeof source !== 'string' || createHash('sha256').update(source).digest('hex') !== SHORTCUTS_BASELINE_SHA256) {
    throw new Error(`Unsupported desktop shortcuts baseline (expected ${SHORTCUTS_VERSION}, ${SHORTCUTS_BASELINE_SHA256})`);
  }
  let result = replaceOnce(source, 'var ShortcutRegistry=class{runtime;platform;', 'var ShortcutRegistry=class{runtime;platform;modes=new Map;modePresentation=(0,_deepseek_ai_dsh_client_store.createSnapshotStore)([]);');
  result = replaceOnce(result, 'refreshLabels(config=this.config.getSnapshot()){this.bindings.clear();', `${registryMethods}refreshLabels(config=this.config.getSnapshot()){this.refreshModePresentation();this.bindings.clear();`);
  result = replaceOnce(result, 'return{...row,label:command.label(),aliases:command.aliases,', `const presentation=this.commandModes(command.id);const label=presentation.find(mode=>mode.commands[command.id].label!==undefined)?.commands[command.id].label;const hidden=presentation.find(mode=>mode.commands[command.id].hidden!==undefined)?.commands[command.id].hidden??false;return{...row,hidden,label:label===undefined?command.label():label(),aliases:command.aliases,`);
  result = replaceOnce(result, 'this.state.set({config,catalog});this.refreshFixedLabels()', 'this.state.set({config,catalog:catalog.filter(row=>!row.hidden).map(({hidden,...row})=>row)});this.refreshFixedLabels()');
  result = replaceOnce(result, 'const result=command.resolve({...context,source:`menu`})', 'const result=this.resolveCommand(command,{...context,source:`menu`})');
  result = replaceOnce(result, 'const resolution=command.resolve(context)', 'const resolution=this.resolveCommand(command,context)');
  result = replaceOnce(result, 'fixedCatalog;stopSequenceMs;fixedListeners=new Set;', 'fixedCatalog;modePresentation;modeSurfaces=new Map;stopSequenceMs;fixedListeners=new Set;');
  result = replaceOnce(result, 'this.fixedCatalog=this.registry.fixedCatalog;const publish=', 'this.fixedCatalog=this.registry.fixedCatalog;this.modePresentation=this.registry.modePresentation;ctx.effect(()=>()=>{this.active=false;this.modeSurfaces.clear();this.registry.clearCommandModes()},"shortcuts: command modes");const publish=');
  result = replaceOnce(result, 'registerFixed(command){const off=this.registry.registerFixed(command);', `${serviceMethods}registerFixed(command){const off=this.registry.registerFixed(command);`);
  return result;
}
