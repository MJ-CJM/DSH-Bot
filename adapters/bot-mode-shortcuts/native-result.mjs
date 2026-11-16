import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=process.cwd(),base=resolve(root,'.dsh-dev/bot-mode-native');
const read=async name=>JSON.parse(await readFile(resolve(base,name),'utf8'));
const prepared=await read('prepare.json'), fixture=await read('fixture.json'), provenance=await read('served-adapter.json');
const rows=(await readFile(resolve(prepared.instance,'renderer-probe.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const activeIndex=rows.findIndex(row=>row.active&&row.native&&row.runtime==='desktop'&&JSON.stringify(row.calls)==='["new","archive"]'&&row.blocked===1);
assert.ok(activeIndex>=0,'Actual native renderer must record New/Archive handlers and blocked Fork');
const active=rows[activeIndex];assert.ok(!active.workspaces.archivedSessionIds.includes(fixture.sessionId));
assert.ok(!active.catalog.some(row=>row.id==='session.fork'));
const restoredIndex=rows.findIndex((row,i)=>i>activeIndex&&!row.active&&row.catalog.some(entry=>entry.id==='session.fork'));
assert.ok(restoredIndex>activeIndex);
const archivedIndex=rows.findIndex((row,i)=>i>restoredIndex&&!row.active&&row.workspaces.archivedSessionIds.includes(fixture.sessionId));assert.ok(archivedIndex>restoredIndex);
assert.equal(provenance.factoryExact,true);assert.equal(provenance.factorySha256,prepared.adapterClientSha256);
assert.equal(fixture.adapterClientSha256,prepared.adapterClientSha256);assert.equal(fixture.adapterClientPath,prepared.adapterClientPath);
assert.equal(fixture.processExecutable,prepared.executable);assert.equal(fixture.clientVersion,'0.2.2-rc.2');
assert.equal(sha(await readFile('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')),prepared.originalArchiveSha256);
const noKeybindingFile=!existsSync(resolve(prepared.userData,'keybindings.json'));assert.ok(noKeybindingFile,'Test must not create native persistent binding preferences');
const result={status:'PASS',scope:'Actual isolated Electron keyboard command-mode adapter and disposal; not complete Bot-mode desktop UI acceptance',
 desktopVersion:fixture.clientVersion,adapterSourceBaseline:prepared.adapterSourceBaseline,sessionId:fixture.sessionId,
 evidence:{fixture:'fixture.json',servedFactory:'served-adapter.json',preparation:'prepare.json',renderer:'instance/renderer-probe.jsonl',activeIndex,restoredIndex,archivedIndex},
 checks:[
 {name:'Independent actual Electron window, original app still present',status:'PASS',evidence:'CUA inventory and getApp(com.deepseek.dsh.botmode.isolated); root agent observed both applications'},
 {name:'Real native composer keys route New/Archive and block hidden Fork',status:'PASS',keys:['super+n','alt+super+f','shift+super+a'],evidence:{activeIndex,calls:active.calls,blocked:active.blocked,mainNotArchived:true}},
 {name:'Actual native preload and desktop runtime',status:'PASS',evidence:{native:active.native,runtime:active.runtime}},
 {name:'Awaited mode disposal restores labels, Fork catalog, and native New',status:'PASS',evidence:'Root CUA observed native New hero after Dispose then super+n; original label/catalog restoration in renderer rows',restoredIndex},
 {name:'After reopening same Bot, native Archive archives exact main Session',status:'PASS',evidence:{archivedIndex,sessionId:fixture.sessionId}},
 {name:'Actual served factory matches built adapter',status:'PASS',factorySha256:provenance.factorySha256,responseSha256:provenance.responseSha256},
 {name:'Native keybinding preference file not created',status:'PASS',path:resolve(prepared.userData,'keybindings.json')},
 {name:'Original application archive unchanged; no system protocol registration in copy',status:'PASS',originalArchiveSha256:prepared.originalArchiveSha256,protocolRegistration:prepared.protocolRegistration},
 ],
 realModelRequests:fixture.realModelRequests,
 separateGates:[
 {name:'Complete final Bot-mode product desktop UI',status:'FAIL',reason:'NOT_RUN: this native fixture uses the frozen earlier product plus independent adapter controls'},
 {name:'Native menu, deep links, cold-start product routing, IME/terminal/modal multi-window matrix',status:'FAIL',reason:'NOT_RUN: this scope proves actual native keyboard bridge and disposal only; menu resolver algorithm has separate unit coverage'},
 ],
 historicalFailures:['First copy startup failed because changed CFBundleName broke Helper lookup; fixed by preserving internal name','Initial native fixture get(nonexistent) threw; replaced with public status check','Absolute Host Loader path did not replace native Client bytes; directly adapted copy asar and updated its runtime inventory','Existing native main-session cold restoration initially busy; fixture now waits for classified busy to clear without treating it as success'],
};
await writeFile(resolve(base,'native-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,scope:result.scope,checks:result.checks.length,rows:rows.length,output:resolve(base,'native-result.json')},null,2));
