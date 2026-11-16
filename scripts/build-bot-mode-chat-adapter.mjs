import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_SHA256, MARKER, patchBotModeChat } from '../adapters/bot-mode-chat/patch.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Always read the immutable original rc.2 runtime, even when target runtime is already adapted. */
export async function buildBotModeChatAdapter({output=resolve(root,'.dsh-dev/bot-mode-adapter/chat-package')}={}) {
 assert.ok(resolve(output).startsWith(`${root}/.dsh-dev/`));
 const r=createRequire(resolve(root,'.dsh-dev/proactive-bot/host-runtime/package.json'));
 const native=createRequire(r.resolve('@deepseek-ai/dsh/package.json'));
 const original=dirname(native.resolve('@deepseek-ai/dsh-client-ui-chat/package.json'));
 const metadata=JSON.parse(await readFile(resolve(original,'package.json'),'utf8'));assert.equal(metadata.version,'0.2.1-rc.2');
 const before=await readFile(resolve(original,'lib/client.js'));const client=patchBotModeChat(before);
 await mkdir(output,{recursive:true});await cp(original,output,{recursive:true,dereference:true});
 await writeFile(resolve(output,'lib/client.js'),client);
 await unlink(resolve(output,'lib/client.js.map')).catch(error=>{if(error.code!=='ENOENT')throw error;});
 metadata.dsh.client.inject=[...new Set([...metadata.dsh.client.inject,'@deepseek-ai/dsh-client-shortcuts'])];
 await writeFile(resolve(output,'package.json'),JSON.stringify(metadata,null,2));
 const receipt={baseline:'0.2.1-rc.2',marker:MARKER,package:output,originalPackage:await realpath(original),originalClientSha256:BASELINE_SHA256,sha256:sha(client),bytes:Buffer.byteLength(client),metadataChanged:true,
  surfaces:['chat.branch'],sourceTag:'dsh-v0.2.1-rc.2',scope:'Native branch visibility plus invoke-time exact-seq guard; all other native actions unchanged'};
 await writeFile(resolve(output,'adapter-manifest.json'),JSON.stringify(receipt,null,2));return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildBotModeChatAdapter(),null,2));
