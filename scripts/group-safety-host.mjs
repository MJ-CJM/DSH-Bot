import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';
const [artifact, manifest] = process.argv.slice(2).filter(value => !value.startsWith('--'));
const runtime = process.argv.includes('--rc2') ? 'rc2' : 'rc3';
assert.ok(artifact);
process.env.DSH_BOT_DSH_BIN = runtime === 'rc2' ? resolve('.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh')
 : '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const dir = await scratch(`group-safety-${runtime}`); console.log(dir);
let host, artifactAudit = manifest ? JSON.parse(await readFile(manifest,'utf8')) : undefined;
try {
 host=await webHost(dir,'group-safety',resolve(artifact),resolve('packages/dsh-bot/tests/group-safety-profile.mjs'),[],{artifactAudit});
 artifactAudit??=JSON.parse(await readFile(join(dir,'artifact-manifest.json'),'utf8'));
 const report=JSON.parse(await readFile(join(dir,'result.json'),'utf8'));assert.equal(report.status,'PASS');assert.equal(report.fixtureRequests,host.requests());console.log('GROUP_SAFETY_HOST_PASS',report.checks);
 await host.stop();host=undefined;
 host=await webHost(dir,'group-safety',resolve(artifact),resolve('packages/dsh-bot/tests/group-safety-profile.mjs'),[],{preserveProfile:true,artifactAudit});
 assert.equal(JSON.parse(await readFile(join(dir,'cold-result.json'),'utf8')).status,'PASS');assert.equal(host.requests(),0);console.log('COLD_PASS');
 await writeFile(join(dir,'verified.json'),JSON.stringify({status:'PASS',runtime,artifact:resolve(artifact),sha256:artifactAudit.sha256,checks:report.checks,memoryStatuses:report.memoryStatuses,coldRequests:host.requests()},null,2));
} finally {await host?.stop();}
