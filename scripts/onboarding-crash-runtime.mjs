import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
import { auditArtifact, auditInstalled } from './p34-artifact.mjs';
const root=process.cwd(),home=resolve(root,'.dsh-dev');assert.equal(process.env.DSH_HOME,home);assert.deepEqual(process.argv.slice(2),['--mock-only']);
const artifactPath=process.env.DSH_BOT_ARTIFACT?resolve(root,process.env.DSH_BOT_ARTIFACT):undefined;
const base=resolve(home,'onboarding-crash',`${Date.now()}-${process.pid}`);await mkdir(base,{recursive:true});
const results=[];
for(const point of ['before-receipt','after-receipt','before-native-flush','after-native-flush','before-submitted','after-completed']){
  const dir=resolve(base,point);await mkdir(dir,{recursive:true});
  const run=await runner(dir,0,'ONBOARDING_CRASH');run.env.DSH_HOME=home;
  const profile=`onboarding-crash-${point}-${Date.now()}`,operationId=randomUUID();let child;
  try{
    await run.command(['--profile',profile,'--from-default-profile','web','--dump-config'],'initialize');
    await run.command(['plugin','--profile',profile,'add',artifactPath??resolve(root,'packages/dsh-bot')],'install');
    if(artifactPath)await auditInstalled(home,profile,await auditArtifact(root,artifactPath,dir));
    const patch=cold=>mockProfilePatch(dir,'packages/dsh-bot/tests/onboarding-crash-profile.mjs',{outputDir:dir,point,operationId,cold});
    await writeFile(resolve(home,'profiles',profile,'cordis.patch.yml'),patch(false));
    let output='';child=spawn(resolve(root,'scripts/dsh'),['--profile',profile,'--no-open','--host','127.0.0.1','--port','0'],{cwd:root,env:run.env,stdio:['ignore','pipe','pipe']});
    const exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;});
    let receipt;
    for(let n=0;n<1000;n++){
      try{receipt=JSON.parse(await readFile(resolve(dir,'barrier.json'),'utf8'));break;}catch{}
      if(output.includes('ONBOARDING_CRASH_FAILED'))throw new Error(output);await delay(25);
    }
    assert.ok(receipt,'No durable barrier receipt');assert.equal(receipt.pid,child.pid);
    child.kill('SIGKILL');const killed=await exited;assert.equal(killed.signal,'SIGKILL');
    await writeFile(resolve(dir,'hot-host.log'),output);await writeFile(resolve(dir,'kill.json'),JSON.stringify({pid:child.pid,...killed,point}));
    await writeFile(resolve(home,'profiles',profile,'cordis.patch.yml'),patch(true));
    await run.command(['--profile',profile,'--no-open','--host','127.0.0.1','--port','0'],'cold-host',true);
    const cold=JSON.parse(await readFile(resolve(dir,'cold-result.json'),'utf8'));assert.equal(cold.status,'PASS');results.push({point,status:'PASS',coldState:cold.onboarding.state,hotCalls:receipt.calls});
  }catch(error){results.push({point,status:'FAIL',error:String(error)});process.exitCode=1;}
  finally{child?.kill('SIGKILL');run.stop();await writeFile(resolve(dir,'commands.json'),JSON.stringify(run.commands,null,2));}
}
await writeFile(resolve(base,'summary.json'),JSON.stringify({results,realModelRequests:0},null,2));console.log(JSON.stringify({dir:base,results}));
