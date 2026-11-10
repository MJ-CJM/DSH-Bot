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
assert.equal(process.argv.length,4,'Pass the built tarball and --governance, --responsibilities or --observation');
const mode=process.argv[3].slice(2);assert.ok(['governance','responsibilities','observation'].includes(mode));
const base=resolve(root,`.dsh-dev/proactive-bot/${mode}`);await mkdir(base,{recursive:true});const dir=await mkdtemp(resolve(base,'host-'));
const artifactAudit=process.env.DSH_BOT_ARTIFACT_AUDIT?await frozenArtifactAudit(resolve(process.argv[2]),resolve(process.env.DSH_BOT_ARTIFACT_AUDIT),dir):undefined;
const sourceId=`ci:${createHash('sha256').update(JSON.stringify(['fixture/demo','main'])).digest('hex')}`;
let host,browser;
async function readReceipt(file) {
 const until=Date.now()+60_000;
 while(Date.now()<until){
  const error=await readFile(resolve(dir,'workflow-error.txt'),'utf8').catch(()=>'');
  assert.equal(error,'');
  const result=await readFile(resolve(dir,file),'utf8').then(JSON.parse).catch(()=>undefined);
  if(result)return result;
  await delay(100);
 }
 throw new Error(`Host fixture timed out waiting for ${file}`);
}
async function verifyObservationUi(){
 const require=createRequire(resolve(root,'packages/dsh-bot/package.json'));
 const {chromium}=require('playwright-core');
 browser=await chromium.launch({executablePath:process.env.DSH_BOT_CHROMIUM??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true,env:host.env});
 await readReceipt('observation-ready.json');
 const evidence={cases:[],refresh:[]};
 async function open(lang,theme,width){
  const t=JSON.parse(await readFile(resolve(artifactAudit?.packedRoot??resolve(root,'packages/dsh-bot'),`locale/${lang}.json`),'utf8')).ui;
  const context=await browser.newContext({colorScheme:theme,locale:lang==='zh'?'zh-CN':'en-US',viewport:{width:1360,height:950},reducedMotion:'reduce'});
  const page=await context.newPage();page.setDefaultTimeout(18_000);
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await installOverlayHandler(page,()=>{});
  await page.goto(host.url,{waitUntil:'domcontentloaded'});
  await dismissFirstRunOverlays(page,()=>{},'proactive-observation');
  await openBotsPanel(page,t['bots.title']);
  const bots=page.locator('[data-bots-page]:visible');
  const profile=bots.getByRole('button',{name:`${t['chat.profile']} · Fixture CI`,exact:true});
  const fallback=bots.locator('button[data-bot-id="fixture-ci"]');
  await profile.or(fallback).first().waitFor();
  if(await profile.isVisible())await profile.click();else await fallback.click();
  const detail=page.locator('[data-bot-detail="fixture-ci"]');
  await detail.getByRole('tab',{name:t['detail.work'],exact:true}).click();
  await page.setViewportSize({width,height:950});
  return { context,page,t,detail };
 }
 const primary=await open('en','light',1360);
 const {page,t,detail}=primary;
 const duties=detail.getByRole('region',{name:t['responsibility.title']});
 for(const value of ['off','suggest']){
  await duties.getByRole('button',{name:t['responsibility.create'],exact:true}).click();
  const picker=duties.getByRole('combobox',{name:new RegExp(`^${t['responsibility.mode']}`)});
  assert.equal(await picker.locator('option[value="auto"]').evaluate(option=>option.disabled),true);
  await picker.selectOption(value);
  await duties.getByRole('textbox',{name:t['responsibility.name'],exact:true}).fill(`Observation duty ${value}`);
  await duties.getByRole('button',{name:t['responsibility.save'],exact:true}).click();
  await duties.locator('[data-responsibility-id]').filter({hasText:`Observation duty ${value}`}).waitFor();
 }
 const live=detail.locator('[data-proactive-decision]').filter({hasText:'live-observation'});
 const readStarted=Date.now();
 await writeFile(resolve(dir,'observation-ingest'),'observe\n');
 await live.waitFor();
 const decisionId=await live.getAttribute('data-proactive-decision');
 evidence.refresh.push({kind:'suggestion',elapsedMs:Date.now()-readStarted,id:decisionId});
 async function openSidebar(surface,overviewCapture){
  const {page,t,detail}=surface;
  await detail.getByRole('button',{name:t['chat.openChat'],exact:true}).click();
  const existingSidebar=page.locator('[data-bot-panel="fixture-ci"]:visible');
  if(!overviewCapture){
   const restored=await existingSidebar.waitFor({state:'visible',timeout:2000}).then(()=>true,()=>false);
   if(restored)return existingSidebar;
  }
  const badge=page.getByRole('button',{name:t['badge.open'].replace('{name}','Fixture CI'),exact:true});
  try { await badge.click({timeout:3000}); }
  catch(error){if(!overviewCapture && await existingSidebar.isVisible())return existingSidebar;throw error;}
  const preview=page.getByRole('dialog',{name:t['botPanel.title'],exact:true});
  const panel=preview.locator('[data-bot-panel="fixture-ci"]');
  await panel.waitFor();
  const overview=panel.locator('[data-bot-panel-overview]');
  await overview.getByText(t['botPanel.taskGroup.decide'],{exact:true}).waitFor();
  if(overviewCapture){
   await page.screenshot({path:overviewCapture});
   for(const key of ['botPanel.role','botPanel.moreInfo']){
    const disclosure=overview.locator('details').filter({has:page.getByText(t[key],{exact:true})});
    assert.equal(await disclosure.getAttribute('open'),null);
    await disclosure.locator('summary').click();
    assert.ok(await disclosure.evaluate(element=>element.open));
    await disclosure.locator('summary').click();
   }
  }
  await panel.getByRole('button',{name:t['botPanel.viewTasks'],exact:true}).click();
  await panel.getByRole('button',{name:t['botPanel.openSidebar'],exact:true}).click();
  await preview.waitFor({state:'hidden'});
  return page.locator('[data-bot-panel="fixture-ci"]:visible');
 }
 async function sidebarCheck(surface,lang,theme,width){
  const {context,page,t,detail}=surface;
  const sidebar=await openSidebar(surface,resolve(dir,`observation-${lang}-${theme}-${width}-overview.png`));
  const task=sidebar.getByRole('button',{name:/live-observation/});
  await task.waitFor();
  assert.ok(await sidebar.getByRole('heading',{name:t['botPanel.taskGroup.decide'],exact:true}).isVisible());
  assert.ok(await sidebar.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  assert.equal(await sidebar.locator('[data-routine-panel]').count(),0);
  await page.screenshot({path:resolve(dir,`observation-${lang}-${theme}-${width}.png`)});
  await task.click();
  const reached=page.locator(`[data-proactive-decision="${decisionId}"]`);
  await reached.waitFor();
  try{
   await page.waitForFunction(id=>{
    const active=document.activeElement;
    if(active?.getAttribute('data-proactive-decision')!==id)return false;
    const bounds=active.getBoundingClientRect();
    return bounds.top<window.innerHeight&&bounds.bottom>0;
   },decisionId);
  }catch(error){
   const diagnostics=await reached.evaluate(el=>({
    focused:document.hasFocus(),active:document.activeElement?.outerHTML.slice(0,240),
    bounds:el.getBoundingClientRect().toJSON(),inert:!!el.closest('[inert]'),
    viewport:{width:window.innerWidth,height:window.innerHeight},
   }));
   await writeFile(resolve(dir,`observation-${lang}-${theme}-${width}-focus.json`),JSON.stringify(diagnostics,null,2));
   await page.screenshot({path:resolve(dir,`observation-${lang}-${theme}-${width}-focus.png`)});
   throw error;
  }
  const ordinaryWork=context===primary.context;
  if(ordinaryWork){
   const reopened=await openSidebar(surface);
   await reopened.getByRole('button',{name:t['botPanel.otherWork'],exact:true}).click();
   const legacy=detail.locator('[data-bot-other-work]');
   await legacy.locator('[data-routine-panel="fixture-ci"]').waitFor();
   await page.waitForFunction(()=>{
    const active=document.activeElement;
    if(!active?.hasAttribute('data-bot-other-work'))return false;
    const bounds=active.getBoundingClientRect();
    return bounds.top<window.innerHeight&&bounds.bottom>0;
   });
  }
  const memorySidebar=await openSidebar(surface);
  await memorySidebar.getByRole('tab',{name:t['botPanel.overview'],exact:true}).click();
  await memorySidebar.getByRole('heading',{name:t['botPanel.duties'],exact:true}).waitFor();
  await memorySidebar.getByRole('button',{name:t['botPanel.personalContext'],exact:true}).click();
  await detail.getByText(t['shared.contextTiming'],{exact:true}).waitFor();
  assert.ok(await detail.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  await page.screenshot({path:resolve(dir,`observation-${lang}-${theme}-${width}-personal-context.png`)});
  evidence.cases.push({lang,theme,width,decisionId,overviewDisclosures:true,ordinaryWork,personalContext:true});
  if(context!==primary.context)await context.close();
 }
 await sidebarCheck(primary,'en','light',1360);
 await sidebarCheck(await open('zh','dark',390),'zh','dark',390);
 await sidebarCheck(await open('en','dark',390),'en','dark',390);
 await sidebarCheck(await open('zh','light',1360),'zh','light',1360);
 await page.bringToFront();
 await detail.getByRole('tab',{name:t['detail.work'],exact:true}).click();
 const revokeStarted=Date.now();
 await writeFile(resolve(dir,'observation-revoke'),'revoke\n');
 await detail.locator('[data-proactive-ci-feed]').getByText(t['proactive.feed.revoked'],{exact:false}).waitFor();
 await live.waitFor({state:'detached'});
 evidence.refresh.push({kind:'source-revocation',elapsedMs:Date.now()-revokeStarted});
 const result=await readReceipt('observation-result.json');
 assert.deepEqual(result.saved,['off','suggest']);
 assert.equal(host.requests(),0);
 await writeFile(resolve(dir,'observation-ui.json'),JSON.stringify({...evidence,host:result},null,2));
 await primary.context.close();
}
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
 await panel.getByRole('button',{name:translations['responsibility.create'],exact:true}).and(panel.locator(':enabled')).waitFor();
 const modes=[];
 for(const mode of ['suggest','auto','off']){
  await rule.getByRole('button',{name:translations['responsibility.edit'],exact:true}).click();
  await writeFile(resolve(dir,'responsibility-editor.html'),await panel.innerHTML());
  await panel.getByRole('combobox',{name:new RegExp(`^${translations['responsibility.mode']}`)}).selectOption(mode);
  await panel.getByRole('button',{name:translations['responsibility.save'],exact:true}).click();
  try { await rule.getByText(new RegExp(translations[`responsibility.mode.${mode}`].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))).waitFor(); }
  catch(error){await writeFile(resolve(dir,'responsibility-save-failure.html'),await detail.innerHTML());throw error;}
  modes.push(mode);
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
  '- id: dsh-bot','  config:','    proactiveEnabled: true',
  ...(mode==='observation'?['    proactiveExecutionEnabled: false']:['    proactiveExecutionEnabled: true','    proactiveProvider: dp-loopback','    proactiveModel: fixture']),
  `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`,
  ...(mode!=='governance'?['    proactiveCiFeed: {scope: {repository: fixture/demo, branch: main, generation: 1}, intervalMs: 1000}']:[]),
  ...(mode==='governance'?[`    proactiveRepairFixture: ${JSON.stringify({id:'governance-switch',sourceId,title:'Governance artifact fixture',initial:{enabled:false,retained:'ordinary-value'},field:'enabled',expected:true,hint:'Enable the fixture switch'})}`]:[]),
 ],{offline:false,artifactAudit});
 if(mode==='observation'){
  await verifyObservationUi();
  console.log(`PASS actual isolated Host observation ${dir}`);
 }else{
 const result=await readReceipt(mode==='governance'?'governance-result.json':'responsibility-result.json');
 if(mode==='governance'){assert.ok(result.artifactRemoved&&result.repeatIdentical&&result.replayRejected);assert.ok(result.notificationBodyPurged&&result.managedEnvelopePurged&&result.ordinaryNoticePreserved);assert.equal(result.pendingBlocked,'blocked');assert.equal(result.unknownBlocked,'blocked');}
 else{assert.equal(result.calls,2);assert.equal(host.requests(),2);assert.ok(result.offHidden&&result.otherBotHidden&&result.pausePreservedGrant&&result.revokeDenied);assert.deepEqual(result.pausedObservation,{saved:['off','suggest'],automatic:'forbidden'});await verifyResponsibilityUi();assert.equal(host.requests(),2);}
 console.log(`PASS actual isolated Host ${mode} ${dir}`);
 }
}catch(error){await writeFile(resolve(dir,'failure.txt'),String(error.stack??error));throw new Error(`Policy Host fixture failed. See ${dir}`);}
finally{await browser?.close();await host?.stop();}
