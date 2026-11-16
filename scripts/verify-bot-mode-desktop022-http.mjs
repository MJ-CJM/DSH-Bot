// Read-only verification of the actual native Host HTTP bytes, not a response route.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from '../adapters/bot-mode-desktop022/archive.mjs';
const root=process.cwd(),configPath=resolve(process.argv[2]);
assert.ok(configPath.startsWith(`${root}/.dsh-dev/`));
const config=JSON.parse(await readFile(configPath));
const output=resolve(config.output);assert.ok(output.startsWith(`${root}/.dsh-dev/`));await mkdir(resolve(output,'..'),{recursive:true});
const log=await readFile(config.log,'utf8');
const url=[...log.matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/g)].at(-1)?.[1];assert.ok(url,'Native Host URL not logged');
const auth=await fetch(url,{redirect:'manual'});assert.equal(auth.status,303);await auth.body?.cancel();
const cookie=auth.headers.getSetCookie().map(row=>row.split(';')[0]).join('; ');assert.ok(cookie);
const origin=new URL(url).origin;
const response=await fetch(origin,{headers:{cookie}});assert.equal(response.status,200);
const html=await response.text();
const urls=[...new Set([...html.matchAll(/(?:src|href)="([^"]*plugins[^\"]+)"/g)].map(row=>row[1].replaceAll('&amp;','&')))];
const bodies=[];
for(const path of urls){const r=await fetch(new URL(path,origin),{headers:{cookie}});assert.ok(r.ok);if((r.headers.get('content-type')??'').includes('javascript'))bodies.push(await r.text());}
const required=['dsh-bot','@deepseek-ai/dsh-client-shortcuts','@deepseek-ai/dsh-client-ui-chat','@deepseek-ai/dsh-client-ui-workspace','@deepseek-ai/dsh-client-ui-renderer'];
const provenance=typeof config.provenance==='string'?JSON.parse(await readFile(config.provenance)):config.provenance;
const proofs=[];
for(const id of required){
  const row=provenance[id];assert.ok(row);
  const bytes=await readFile(row.path);assert.equal(sha256(bytes),row.sha256);
  const factory=bytes.toString().trimEnd().replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*$/u,'').trimEnd();
  const body=bodies.find(text=>text.includes(factory));assert.ok(body,`Actual native HTTP factory must match: ${id}`);
  proofs.push({id,factorySha256:row.sha256,responseSha256:sha256(body)});
}
const result={status:'PASS',origin,proofs,responseRewriting:false,modelRequestsSent:0};
await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
