import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';
import { sha256 } from './p34-artifact.mjs';
import { verifyThreePersonBrowser } from './three-person-postinstall-browser.mjs';
const args = process.argv.slice(2);
const artifact = resolve(args[0]);
const native = args.includes('--native');
const compat = native ? undefined : resolve(args[1]);
const option = name => args.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const expected = option('--expected-sha');
assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'Supply --expected-sha=<reviewed tgz SHA-256>');
assert.equal(sha256(await readFile(artifact)), expected);
const precheck = args.includes('--precheck');
process.env.DSH_BOT_DSH_BIN ??= '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const dir=await scratch(precheck ? 'three-person-precheck' : 'three-person-postinstall');console.log(dir);
let dailyProof;
if (!precheck) {
 const dailyDir = resolve(option('--daily-dir') ?? '.dsh-dev/daily-small-group-delivery-20261117');
 const installed=JSON.parse(await readFile(join(dailyDir,'installed.json'))),prepared=JSON.parse(await readFile(join(dailyDir,'prepared.json')));
 assert.equal(installed.status,'PASS');assert.equal(installed.artifactSha256,expected);
 const dailyClient=await readFile(join(prepared.paths.home,'profiles/desktop/node_modules/dsh-botgroup/lib/client.js'));
 const frozenClient=execFileSync('/usr/bin/tar',['-xOf',artifact,'package/lib/client.js'],{maxBuffer:30*1024*1024});
 assert.deepEqual(dailyClient,frozenClient,'Daily installed client differs from the exact tested package');
 dailyProof={status:'PASS',artifactSha256:expected,dailyInstallationReceipt:join(dailyDir,'installed.json'),dailyInstalledClientSha256:sha256(dailyClient),frozenClientSha256:sha256(frozenClient),dailyClientMatchesArtifact:true,dailyUiMutations:0};
 await writeFile(join(dir,'daily-byte-link.json'),JSON.stringify(dailyProof,null,2));
}
const fixture=join(dir,'fixture-entry.mjs');await writeFile(fixture,`export {inject,apply} from ${JSON.stringify(resolve('packages/dsh-bot/tests/three-person-postinstall-profile.mjs'))};\n`);
let host,proof;
try{
 host=await webHost(dir,'three-person-postinstall',artifact,fixture,[],{compatArtifact:compat,offline:true});
 proof=JSON.parse(await readFile(join(dir,'artifact-manifest.json')));
 const browser=await verifyThreePersonBrowser(host,dir,{native});assert.equal(browser.status,'PASS');
 const live=JSON.parse(await readFile(join(dir,'proof-live.json')));assert.equal(live.memoryProof.length,3);assert.ok(live.memoryProof.every(row=>row.status==='saved'&&row.matchedContent&&row.actualStoredReceiptId));
 const nativeRequests=live.calls.length;assert.equal(nativeRequests,host.requests());await host.stop();host=undefined;
 host=await webHost(dir,'three-person-postinstall',artifact,fixture,[],{preserveProfile:true,artifactAudit:proof});const cold=JSON.parse(await readFile(join(dir,'cold-result.json')));assert.equal(cold.status,'PASS');assert.equal(host.requests(),0);
 await writeFile(join(dir,'verified.json'),JSON.stringify({status:'PASS',artifactSha256:expected,mode:precheck?'predeployment':'postinstall',afterDailyInstall:!precheck,dailyClientMatchesArtifact:dailyProof?.dailyClientMatchesArtifact??null,browserChecks:browser.checks.length,nativeModelCalls:nativeRequests,coldNativeModelCalls:0,realModelRequests:0,memoryProof:live.memoryProof,threeRoundApprovalProof:{round1:live.phases.THREE_R1,round2:live.phases.THREE_R2,round3:live.phases.THREE_R3},policyRevokeProof:live.phases.THREE_R4,privateVersionsUnchanged:live.privateVersionsUnchanged,publishedPrivateNarrative:live.publishedPrivateNarrative},null,2));console.log(precheck?'THREE_PERSON_PRECHECK_PASS':'THREE_PERSON_POSTINSTALL_PASS');
}catch(error){await writeFile(join(dir,'runner-error.json'),JSON.stringify({error:String(error.stack)},null,2));throw error;}finally{await host?.stop();}
