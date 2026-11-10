import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webHost } from './deepening/b4-web-host.mjs';
import { verifyWorkspaceBrowser } from './proactive-workspace-ui.mjs';

// Historical positive fixture for the pre-N01 package. Current candidates use
// proactive-bot-execution-boundaries.mjs and require workspace execution closed.
const root=process.cwd();
assert.equal(process.env.DSH_HOME,resolve(root,'.dsh-dev'));
assert.equal(execFileSync(resolve(root,'scripts/dsh'),['--version'],{encoding:'utf8'}).trim(),'0.2.1-rc.2');
const groupRepair=process.argv[3]==='--group-repair';
assert.ok(process.argv.length===3||(process.argv.length===4&&groupRepair),'Pass the built tarball and optional --group-repair');
const base=resolve(root,'.dsh-dev/proactive-bot/workspace');
await mkdir(base,{recursive:true});
const dir=await mkdtemp(resolve(base,'host-'));
const project=resolve(dir,'fixture-project');
await mkdir(project);
await writeFile(resolve(project,'math.cjs'),'exports.add = (a, b) => a - b;\n');
await writeFile(resolve(project,'verify.cjs'),`const assert=require('node:assert/strict'),fs=require('node:fs');
assert.throws(()=>fs.writeFileSync(${JSON.stringify(resolve(project,'math.cjs'))},'SANDBOX_ESCAPE'));
fs.writeFileSync('allowed-temporary-output','inside confined workspace');
console.log('WRITE_CONFINEMENT_CONFIRMED');
${groupRepair?"const passed=require('./math.cjs').add(2,3)===5;console.log(passed?'2 + 3 = 5':'ADD_FAIL');process.exitCode=passed?0:1;":"assert.equal(require('./math.cjs').add(2,3),5);console.log('2 + 3 = 5');"}\n`);
const adapter=resolve(dir,'json-cli.cjs');
await writeFile(adapter,`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const req=JSON.parse(s);const file=req.task.files.find(f=>f.path==='math.cjs');console.log(JSON.stringify({edits:[{path:file.path,beforeDigest:file.beforeDigest,content:file.content.replace('a - b','a + b')}]}));});`);
const sourceId=`ci:${createHash('sha256').update(JSON.stringify(['fixture/demo','main'])).digest('hex')}`;
const workspace={id:'addition',title:'Engineering addition fixture',sourceId,root:project,files:[{path:'math.cjs',editable:true},{path:'verify.cjs',editable:false}],verifier:{id:'addition-test',command:process.execPath,args:['verify.cjs'],timeoutMs:10000,maxOutputBytes:65536}};
const bridge=resolve(dir,'home/profiles/b4-browser/node_modules/dsh-bot/lib/host/proactive/executors/json-command-bridge-entry.js');
const command={id:'node-workspace',label:'Node JSON fixture',command:process.execPath,args:[bridge,JSON.stringify({argv:[process.execPath,adapter],timeoutMs:8000,maxOutputBytes:65536})],timeoutMs:10000,maxOutputBytes:65536};
let host;
try {
  host=await webHost(dir,groupRepair?'proactive-group-workspace':'proactive-workspace',resolve(process.argv[2]),resolve(root,'packages/dsh-bot/tests/proactive-workflow-profile.mjs'),[
    '- id: dsh-bot','  config:','    proactiveEnabled: true','    proactiveExecutionEnabled: true',
    '    proactiveProvider: dp-loopback','    proactiveModel: fixture',
    `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`,
    `    proactiveWorkspaceRepair: ${JSON.stringify(workspace)}`,
    `    proactiveCommandExecutor: ${JSON.stringify(command)}`,
    ...(groupRepair?['    proactiveGroupRepairEnabled: true','    proactiveModelOutputTokens: 256']:[]),
  ],{offline:false});
  const result=JSON.parse(await readFile(resolve(dir,'workspace-result.json'),'utf8'));
  assert.equal(result.calls,groupRepair?5:2);assert.equal(host.requests(),result.calls);
  assert.ok(result.originalUnchanged);
  if(groupRepair) {
    assert.ok(result.staleGrantRejected);
    result.matrix=await verifyWorkspaceBrowser(root,dir,host,{groupRepair:true});
    assert.equal(host.requests(),5);
  }
  else {
    assert.ok(result.driftRejected&&result.tamperRejected);
    result.matrix=await verifyWorkspaceBrowser(root,dir,host);
    assert.equal(host.requests(),2);
  }
  await writeFile(resolve(dir,'workspace-result.json'),JSON.stringify(result,null,2));
  console.log(`PASS actual DSH ${groupRepair?'supervisor/implementer/supervisor group':'native/command'} workspace repair, native sandbox and evidence ${dir}`);
} catch(error) {
  await writeFile(resolve(dir,'failure.txt'),String(error.stack??error));
  throw new Error(`Workspace Host fixture failed. See ${dir}`);
} finally { await host?.stop(); }
