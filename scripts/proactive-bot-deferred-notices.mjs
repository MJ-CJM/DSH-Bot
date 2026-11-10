import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { frozenArtifactAudit } from './proactive/artifact-audit.mjs';

const root=process.cwd();assert.equal(process.env.DSH_HOME,resolve(root,'.dsh-dev'));
assert.equal(execFileSync(resolve(root,'scripts/dsh'),['--version'],{encoding:'utf8'}).trim(),'0.2.1-rc.2');
assert.equal(process.argv.length,3,'Pass the built tarball');
const base=resolve(root,'.dsh-dev/proactive-bot/deferred-notices');await mkdir(base,{recursive:true});
const dir=await mkdtemp(resolve(base,'host-'));
const artifactAudit=process.env.DSH_BOT_ARTIFACT_AUDIT?await frozenArtifactAudit(resolve(process.argv[2]),resolve(process.env.DSH_BOT_ARTIFACT_AUDIT),dir):undefined;
const start=()=>webHost(dir,'proactive-deferred-notices',resolve(process.argv[2]),resolve(root,'packages/dsh-bot/tests/proactive-workflow-profile.mjs'),[
 '- id: dsh-bot','  config:','    proactiveEnabled: true','    proactiveExecutionEnabled: true',
 '    proactiveProvider: dp-loopback','    proactiveModel: fixture','    proactiveNotificationPolicy: workflow-notice',
 '    proactiveNoticeConfig: {mergeWindowMs: 2000, maxBatchItems: 8, maxPending: 1000}',
 `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`,
],{offline:false,artifactAudit});
let host;
async function waitFile(name,timeout=100000){const until=Date.now()+timeout;while(Date.now()<until){const error=await readFile(resolve(dir,'workflow-error.txt'),'utf8').catch(()=>'');assert.equal(error,'');const result=await readFile(resolve(dir,name),'utf8').then(JSON.parse).catch(()=>undefined);if(result)return result;await delay(200);}throw new Error(`Timed out: ${name}`);}
try{
 host=await start();const result=await waitFile('deferred-notice-result.json');assert.equal(result.calls,3);assert.equal(host.requests(),3);assert.equal(result.records,1);assert.ok(result.recordedAt>=result.quietEndAt);
 await host.stop();host=await start();const cold=await waitFile('deferred-notice-cold.json',10000);assert.equal(cold.operationId,result.operationId);assert.equal(host.requests(),0);
 console.log(`PASS isolated Host quiet-hour delay, two-task merge, attention budget, changed-policy suppression and cold no-replay ${dir}`);
}catch(error){await writeFile(resolve(dir,'failure.txt'),String(error.stack??error));throw new Error(`Deferred notices Host fixture failed. See ${dir}`);}
finally{await host?.stop();}
