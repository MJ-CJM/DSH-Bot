import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { scratch } from './proactive/worker.mjs';
import { webHost } from './deepening/b4-web-host.mjs';
assert.ok(process.argv[2]);
const dir = await scratch('ordinary-models'), artifact = resolve(process.argv[2]);
const start = () => webHost(dir,'model-regression',artifact,resolve('packages/dsh-bot/tests/proactive-model-profile.mjs'));
let host;
try {
  host=await start(); assert.equal(JSON.parse(await readFile(join(dir,'routing.json'),'utf8')).status,'PASS');
  await host.stop(); host=await start();
  assert.equal(JSON.parse(await readFile(join(dir,'cold-routing.json'),'utf8')).status,'PASS');
  console.log(`PASS ordinary model precedence and cold restore ${dir}`);
} finally { await host?.stop(); }
