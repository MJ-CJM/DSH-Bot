import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { scratch } from './proactive/worker.mjs';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
const require = createRequire(resolve('packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
const dir = await scratch('setup-native');
const artifact = resolve(process.argv[2]); let host, browser;
const flags = ['- id: dsh-bot', '  config:', '    proactiveEnabled: false', '    proactiveExecutionEnabled: false', `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`];
const until = async fn => { for (let i=0;i<200;i++) { const v=await fn();if(v)return v; await delay(150); } throw new Error('Setup verification timed out'); };
const read = () => readFile(join(dir,'setup-native.json'),'utf8').then(JSON.parse).catch(()=>undefined);
try {
  host = await webHost(dir,'setup-native',artifact,resolve('packages/dsh-bot/tests/proactive-setup-profile.mjs'),flags);
  const old = process.env.TMPDIR;process.env.TMPDIR=host.env.TMPDIR;
  try { browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,env:host.env}); }
  finally { if(old===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=old; }
  const context=await browser.newContext({viewport:{width:1360,height:950},locale:'zh-CN',colorScheme:'dark'});
  let page=await context.newPage();page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await installOverlayHandler(page,()=>{});
  await page.goto(host.url,{waitUntil:'domcontentloaded'});await dismissFirstRunOverlays(page,()=>{},'setup-ui');
  let t=JSON.parse(await readFile('packages/dsh-bot/locale/zh.json','utf8')).ui;
  async function openWork() {
    await openBotsPanel(page,t['bots.title']);
    const bots=page.locator('[data-bots-page]:visible');
    const profile=bots.getByRole('button',{name:`${t['chat.profile']} · Setup verification`,exact:true});
    const fallback=bots.locator('button[data-bot-id="setup-bot"]');
    await profile.or(fallback).first().waitFor();if(await profile.isVisible())await profile.click();else await fallback.click();
    await page.locator('[data-bot-detail="setup-bot"]').getByRole('tab',{name:t['detail.work'],exact:true}).click();
  }
  const initial=await until(async()=> (await read())?.conversation ? await read() : undefined);
  await writeFile(join(dir,'initial-conversation.json'),JSON.stringify(initial));
  assert.equal(initial.conversation.main,initial.conversation.expected);
  await openWork();
  const setup=page.locator('[data-proactive-setup]');
  await setup.getByRole('button',{name:t['proactive.setup.enable'],exact:true}).waitFor();
  await page.screenshot({path:join(dir,'disabled-dark-wide.png')});
  const darkPage=page, darkTranslations=t;
  const light=await browser.newContext({viewport:{width:1360,height:950},locale:'en-US',colorScheme:'light'});
  page=await light.newPage();page.setDefaultTimeout(30000);
  page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await installOverlayHandler(page,()=>{});
  await page.goto(host.url,{waitUntil:'domcontentloaded'});await dismissFirstRunOverlays(page,()=>{},'setup-light');
  t=JSON.parse(await readFile('packages/dsh-bot/locale/en.json','utf8')).ui;
  await openWork();
  await page.getByRole('button',{name:t['proactive.setup.enable'],exact:true}).waitFor();
  for(const width of [1360,390]) {
    await page.setViewportSize({width,height:950});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:join(dir,`disabled-light-en-${width}.png`)});
  }
  await light.close();page=darkPage;t=darkTranslations;

  await setup.getByRole('button',{name:t['proactive.setup.enable'],exact:true}).click();
  await until(async()=> (await read())?.state==='ready');
  await page.getByText(t['proactive.setup.noSource'],{exact:true}).waitFor();
  // Native remount may preserve or replace the view; a reload must use saved settings.
  await page.reload();await dismissFirstRunOverlays(page,()=>{},'setup-reload');await openWork();
  await setup.getByText(t['proactive.setup.noSource'],{exact:true}).waitFor();
  await setup.locator('summary').click();
  await setup.getByLabel(t['proactive.setup.repository'],{exact:true}).fill('fixture/setup');
  await setup.getByLabel(t['proactive.setup.credential'],{exact:true}).fill('MISSING_REFERENCE');
  await setup.getByRole('button',{name:t['proactive.setup.saveSource'],exact:true}).click();
  await setup.getByText(t['proactive.setup.credential-missing'],{exact:true}).waitFor();
  await setup.getByLabel(t['proactive.setup.credential'],{exact:true}).fill('GITHUB_TOKEN');
  await page.setViewportSize({width:390,height:950});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(dir,'source-dark-narrow.png')});
  await setup.getByRole('button',{name:t['proactive.setup.saveSource'],exact:true}).click();
  const warm=await until(async()=> {const x=await read();return x?.source?.repository==='fixture/setup'&&x.feed==='ready'?x:undefined;});
  await page.getByText('fixture/setup',{exact:false}).first().waitFor();
  assert.equal(warm.conversation.main,warm.conversation.expected);assert.equal(warm.conversation.activity,true);
  assert.equal(warm.conversation.historicalVisible,true);
  await page.setViewportSize({width:1360,height:950});
  await page.screenshot({path:join(dir,'avatar-reload.png')});
  await writeFile(join(dir,'avatar-tree.txt'),await page.locator('body').ariaSnapshot());
  await page.locator(`[data-bot-session-leading][data-session-id="${warm.conversation.expected}"]`).waitFor();
  await page.locator(`[data-bot-session-leading][data-session-id="${warm.conversation.historical}"]`).waitFor();
  assert.equal(warm.directExecution,false);assert.equal(warm.modelCalls,0);assert.ok(warm.githubReads>0);
  await page.reload();await page.setViewportSize({width:1360,height:950});await dismissFirstRunOverlays(page,()=>{},'setup-connected');await openWork();
  await page.getByText('fixture/setup',{exact:false}).first().waitFor();
  await page.screenshot({path:join(dir,'connected-dark-wide.png')});
  assert.deepEqual(errors,[]);
  await browser.close();browser=undefined;
  await host.stop();host=undefined;
  // Reuse precisely the native Loader's persisted profile, without reapplying setup flags.
  host=await webHost(dir,'setup-native',artifact,resolve('packages/dsh-bot/tests/proactive-setup-profile.mjs'),flags,{preserveProfile:true});
  const cold=await until(async()=> {const x=await read();return x?.bootId!==warm.bootId&&x?.state==='ready'&&x?.source?.repository==='fixture/setup'&&x.feed==='ready'?x:undefined;});
  assert.equal(cold.conversation.main,warm.conversation.expected);assert.equal(cold.conversation.activity,true);
  assert.equal(cold.conversation.historicalVisible,true);
  assert.equal(cold.directExecution,false);assert.equal(cold.modelCalls,0);
  await writeFile(join(dir,'result.json'),JSON.stringify({status:'PASS',warm,cold,errors,realModelRequests:0},null,2));
  console.log(`PASS setup, owner Remote, native reload, source binding and cold persistence: ${dir}`);
} finally {await browser?.close();await host?.stop();}
