import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { frozenArtifactAudit } from './proactive/artifact-audit.mjs';
import { openBotsPanel } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

const root=process.cwd();assert.equal(process.env.DSH_HOME,resolve(root,'.dsh-dev'));
assert.equal(execFileSync(resolve(root,'scripts/dsh'),['--version'],{encoding:'utf8'}).trim(),'0.2.1-rc.2');
assert.equal(process.argv.length,4,'Pass the built tarball and --governance or --responsibilities');
const mode=process.argv[3].slice(2);assert.ok(['governance','responsibilities'].includes(mode));
const base=resolve(root,`.dsh-dev/proactive-bot/${mode}`);await mkdir(base,{recursive:true});const dir=await mkdtemp(resolve(base,'host-'));
const artifactAudit=process.env.DSH_BOT_ARTIFACT_AUDIT?await frozenArtifactAudit(resolve(process.argv[2]),resolve(process.env.DSH_BOT_ARTIFACT_AUDIT),dir):undefined;
const sourceId=`ci:${createHash('sha256').update(JSON.stringify(['fixture/demo','main'])).digest('hex')}`;
let host,browser;
async function verifyResponsibilityUi(){
 const require=createRequire(resolve(root,'packages/dsh-bot/package.json'));
 const {chromium}=require('playwright-core');
 browser=await chromium.launch({executablePath:process.env.DSH_BOT_CHROMIUM??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true,env:host.env});
 const translations=JSON.parse(await readFile(artifactAudit?resolve(artifactAudit.packedRoot,'locale/en.json'):resolve(root,'packages/dsh-bot/locale/en.json'),'utf8')).ui;
 const context=await browser.newContext({colorScheme:'light',locale:'en-US',viewport:{width:1360,height:950},reducedMotion:'reduce'});const page=await context.newPage();page.setDefaultTimeout(18000);
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await installOverlayHandler(page,()=>{});await page.goto(host.url,{waitUntil:'domcontentloaded'});await dismissFirstRunOverlays(page,()=>{},'responsibility-policy');
 await openBotsPanel(page,translations['bots.title']);const bots=page.locator('[data-bots-page]:visible');
 const profile=bots.getByRole('button',{name:`${translations['chat.profile']} · Fixture CI`,exact:true});const fallback=bots.locator('button[data-bot-id="fixture-ci"]');await profile.or(fallback).first().waitFor();if(await profile.isVisible())await profile.click();else await fallback.click();
 const detail=page.locator('[data-bot-detail="fixture-ci"]');await detail.getByRole('tab',{name:translations['detail.work'],exact:true}).click();
 const panel=detail.getByRole('region',{name:translations['responsibility.title']});const rule=panel.locator('[data-responsibility-id="host-role"]');await rule.waitFor();
 const modes=[];
 for(const mode of ['suggest','auto','off']){
  await rule.getByRole('button',{name:translations['responsibility.edit'],exact:true}).click();
  await writeFile(resolve(dir,'responsibility-editor.html'),await panel.innerHTML());
  await panel.getByRole('combobox',{name:new RegExp(`^${translations['responsibility.mode']}`)}).selectOption(mode);
  await panel.getByRole('button',{name:translations['responsibility.save'],exact:true}).click();
  await rule.getByText(new RegExp(translations[`responsibility.mode.${mode}`].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))).waitFor();modes.push(mode);
 }
 for(const theme of ['light','dark']){
  await page.emulateMedia({colorScheme:theme});await page.setViewportSize({width:390,height:950});
  await page.waitForTimeout(500);
  const bounds=await panel.boundingBox();await writeFile(resolve(dir,`responsibility-${theme}-bounds.json`),JSON.stringify({bounds,viewport:await page.viewportSize()},null,2));
  await page.screenshot({path:resolve(dir,`responsibility-${theme}-390.png`),fullPage:true});
  assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=390.5,'Responsibility panel stays within narrow viewport');
  const heading=await panel.getByRole('heading',{name:translations['responsibility.title'],exact:true}).boundingBox();
  const refresh=await panel.getByRole('button',{name:translations['responsibility.refresh'],exact:true}).boundingBox();
  assert.ok(heading&&refresh&&refresh.y>=heading.y+heading.height-0.5,'Narrow responsibility heading keeps its own readable row');
 }
 await writeFile(resolve(dir,'responsibility-ui.json'),JSON.stringify({modes,width:390,themes:['light','dark'],calls:host.requests()},null,2));
 await context.close();await browser.close();browser=undefined;
}
try{
 host=await webHost(dir,`proactive-${mode}`,resolve(process.argv[2]),resolve(root,'packages/dsh-bot/tests/proactive-workflow-profile.mjs'),[
  '- id: dsh-bot','  config:','    proactiveEnabled: true','    proactiveExecutionEnabled: true','    proactiveProvider: dp-loopback','    proactiveModel: fixture',
  `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`,
  ...(mode==='responsibilities'?['    proactiveCiFeed: {scope: {repository: fixture/demo, branch: main, generation: 1}, intervalMs: 1000}']:[]),
  ...(mode==='governance'?[`    proactiveRepairFixture: ${JSON.stringify({id:'governance-switch',sourceId,title:'Governance artifact fixture',initial:{enabled:false,retained:'ordinary-value'},field:'enabled',expected:true,hint:'Enable the fixture switch'})}`]:[]),
 ],{offline:false,artifactAudit});
 const file=mode==='governance'?'governance-result.json':'responsibility-result.json';const until=Date.now()+60000;let result;
 while(Date.now()<until){const error=await readFile(resolve(dir,'workflow-error.txt'),'utf8').catch(()=>'');assert.equal(error,'');result=await readFile(resolve(dir,file),'utf8').then(JSON.parse).catch(()=>undefined);if(result)break;await delay(100);}
 assert.ok(result,'Host fixture timed out');
 if(mode==='governance'){assert.ok(result.artifactRemoved&&result.repeatIdentical&&result.replayRejected);assert.ok(result.notificationBodyPurged&&result.managedEnvelopePurged&&result.ordinaryNoticePreserved);assert.equal(result.pendingBlocked,'blocked');assert.equal(result.unknownBlocked,'blocked');}
 else{assert.equal(result.calls,2);assert.equal(host.requests(),2);assert.ok(result.offHidden&&result.otherBotHidden&&result.pausePreservedGrant&&result.revokeDenied);await verifyResponsibilityUi();assert.equal(host.requests(),2);}
 console.log(`PASS actual isolated Host ${mode} ${dir}`);
}catch(error){await writeFile(resolve(dir,'failure.txt'),String(error.stack??error));throw new Error(`Policy Host fixture failed. See ${dir}`);}
finally{await browser?.close();await host?.stop();}
