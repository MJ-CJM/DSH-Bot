import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_SHA256, MARKER, patchBotModeWorkspace } from '../adapters/bot-mode-workspace/patch.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function buildBotModeWorkspaceAdapter({output=resolve(root,'.dsh-dev/bot-mode-adapter/workspace-package')}={}){
 assert.ok(resolve(output).startsWith(`${root}/.dsh-dev/`));const r=createRequire(resolve(root,'.dsh-dev/proactive-bot/host-runtime/package.json')),c=createRequire(r.resolve('@deepseek-ai/dsh/package.json'));
 const original=dirname(c.resolve('@deepseek-ai/dsh-client-ui-workspace/package.json'));const metadata=JSON.parse(await readFile(resolve(original,'package.json'),'utf8'));assert.equal(metadata.version,'0.2.1-rc.2');
 const client=patchBotModeWorkspace(await readFile(resolve(original,'lib/client.js')));await mkdir(output,{recursive:true});await cp(original,output,{recursive:true,dereference:true});await writeFile(resolve(output,'lib/client.js'),client);await unlink(resolve(output,'lib/client.js.map')).catch(e=>{if(e.code!=='ENOENT')throw e;});
 const receipt={baseline:'0.2.1-rc.2',marker:MARKER,package:output,originalPackage:await realpath(original),originalClientSha256:BASELINE_SHA256,sha256:createHash('sha256').update(client).digest('hex'),bytes:Buffer.byteLength(client),metadataChanged:false,surfaces:['workspace.blank-preset'],sourceTag:'dsh-v0.2.1-rc.2',scope:'Implicit native blank reuse calls existing restoreBlank; explicit preset requests and default creation unchanged'};
 await writeFile(resolve(output,'adapter-manifest.json'),JSON.stringify(receipt,null,2));return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildBotModeWorkspaceAdapter(),null,2));
