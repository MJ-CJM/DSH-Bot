import { checkCdUI } from "./proactive/cd-ui.mjs";
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { scratch } from './proactive/worker.mjs';
import { webHost } from './deepening/b4-web-host.mjs';
assert.ok(process.argv[2]);
const dir=await scratch('cd-native'), artifact=resolve(process.argv[2]);
const flags=['- id: dsh-bot','  config:','    proactiveEnabled: true','    proactiveExecutionEnabled: true','    proactiveProvider: dp-loopback','    proactiveModel: fixture','    proactiveModelDailyBudget: 100','    proactiveExecutionTimeoutMs: 30000',`    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`];
let host;
try {
  host=await webHost(dir,'cd-native',artifact,resolve('packages/dsh-bot/tests/proactive-cd-profile.mjs'),flags);
  assert.equal(JSON.parse(await readFile(join(dir,'cd-native.json'),'utf8')).status,'PASS');
  if (process.argv.includes('--ui')) await checkCdUI(host,dir);
  await host.stop();host=undefined;
  host=await webHost(dir,'cd-native',artifact,resolve('packages/dsh-bot/tests/proactive-cd-profile.mjs'),flags);
  assert.equal(JSON.parse(await readFile(join(dir,'cd-cold.json'),'utf8')).status,'PASS');
  console.log(`PASS C/D native task, method activation, transfer and cold restore ${dir}`);
} finally {await host?.stop();}
