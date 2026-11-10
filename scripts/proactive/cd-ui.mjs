import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { openBotsPanel } from '../deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../../packages/dsh-bot/scripts/screenshot-support.ts';
const require=createRequire(resolve('packages/dsh-bot/package.json'));
const {chromium}=require('playwright-core');
export async function checkCdUI(host, dir) {
  const previous=process.env.TMPDIR;process.env.TMPDIR=host.env.TMPDIR;
  let browser;
  try {browser=await chromium.launch({executablePath:process.env.DSH_BOT_CHROMIUM??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true,env:host.env});}
  finally {if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;}
  const receipts=[];
  try {
    for(const lang of ['en','zh']) for(const theme of ['light','dark']) for(const width of [1360,390]) {
      const t=JSON.parse(await readFile(resolve(`packages/dsh-bot/locale/${lang}.json`),'utf8')).ui;
      const context=await browser.newContext({colorScheme:theme,locale:lang==='en'?'en-US':'zh-CN',viewport:{width:1360,height:950},reducedMotion:'reduce'});
      const page=await context.newPage();page.setDefaultTimeout(18000);
      const errors=[];page.on('pageerror',error=>errors.push(String(error)));
      try {
        await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
        await installOverlayHandler(page,()=>{});
        await page.goto(host.url,{waitUntil:'domcontentloaded'});await dismissFirstRunOverlays(page,()=>{},'cd-ui');
        await openBotsPanel(page,t['bots.title']);
        const bots=page.locator('[data-bots-page]:visible');
        const profile=bots.getByRole('button',{name:`${t['chat.profile']} · C/D native verification`,exact:true});
        const fallback=bots.locator('button[data-bot-id="cd-bot"]');
        await profile.or(fallback).first().waitFor();if(await profile.isVisible())await profile.click();else await fallback.click();
        const detail=page.locator('[data-bot-detail="cd-bot"]');
        await detail.getByRole('tab',{name:t['detail.work'],exact:true}).click();
        const panel=detail.locator('[data-proactive-suggestions]');
        await panel.locator('[data-document-task]').waitFor();
        assert.equal(await panel.locator('[data-document-task]').getAttribute('open'),null);
        const card=panel.locator('[data-proactive-ticket]');await card.first().waitFor();assert.equal(await card.count(),1);
        await card.getByRole('button',{name:t['proactive.openDetails'],exact:true}).click();
        await card.getByText(t['proactive.documentSnapshot'],{exact:true}).waitFor();
        await panel.locator('[data-task-outcomes] summary').click();
        await page.setViewportSize({width,height:950});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        const screenshot=`cd-${lang}-${theme}-${width}.png`;
        await page.screenshot({path:join(dir,screenshot)});
        await panel.locator('[data-document-task] summary').click();
        assert.equal(await panel.getByLabel(t['proactive.documentName'],{exact:true}).isVisible(),true);
        assert.equal(await panel.getByRole('button',{name:t['proactive.documentSubmit'],exact:true}).isEnabled(),false);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        const feedback=detail.locator('[data-feedback-workflow]');
        const candidate=feedback.locator('[data-feedback-candidate]').first();
        await candidate.getByText(t['proactive.methodEvaluation'],{exact:true}).click();
        await candidate.getByText(t['proactive.methodOutcome.improved'],{exact:true}).waitFor();
        await candidate.scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.screenshot({path:join(dir,`cd-feedback-${lang}-${theme}-${width}.png`)});
        const clipped = await detail.locator('select:visible, input:visible, textarea:visible').evaluateAll(elements => elements.filter(element => { const box=element.getBoundingClientRect(); return box.right > innerWidth + 1 || box.left < -1; }).map(element => element.outerHTML.slice(0,100)));
        assert.deepEqual(clipped,[], 'Form controls must fit the viewport, including overflow-hidden parents');
        assert.deepEqual(errors,[]);
        receipts.push({lang,theme,width,screenshot,visibleTasks:1,internalTrialsHidden:true,errors});
      } finally {await context.close();}
    }
    await writeFile(join(dir,'cd-ui.json'),JSON.stringify({status:'PASS',receipts},null,2));
  } finally {await browser.close();}
}
