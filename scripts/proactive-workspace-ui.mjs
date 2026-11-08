import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBotsPanel } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

export async function verifyWorkspaceBrowser(root,dir,host,{groupRepair=false}={}) {
  const require=createRequire(resolve(root,'packages/dsh-bot/package.json'));
  const {chromium}=require('playwright-core');
  const previousTmp=process.env.TMPDIR;
  process.env.TMPDIR=host.env.TMPDIR;
  let browser;
  try { browser=await chromium.launch({executablePath:process.env.DSH_BOT_CHROMIUM??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true,env:host.env}); }
  finally { if(previousTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previousTmp; }
  const matrix=[];
  try {
    for(const lang of ['en','zh'])for(const theme of ['light','dark'])for(const width of [1360,390]) {
      const t=JSON.parse(await readFile(resolve(root,`packages/dsh-bot/locale/${lang}.json`),'utf8')).ui;
      const context=await browser.newContext({colorScheme:theme,locale:lang==='en'?'en-US':'zh-CN',viewport:{width:1360,height:950},reducedMotion:'reduce'});
      try {
        const page=await context.newPage();page.setDefaultTimeout(18000);
        await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
        await installOverlayHandler(page,()=>{});
        await page.goto(host.url,{waitUntil:'domcontentloaded'});
        await dismissFirstRunOverlays(page,()=>{},'workspace-repair');
        await openBotsPanel(page,t['bots.title']);
        const bots=page.locator('[data-bots-page]:visible');
        const profile=bots.getByRole('button',{name:`${t['chat.profile']} · Fixture CI`,exact:true});
        const fallback=bots.locator('button[data-bot-id="fixture-ci"]');
        await profile.or(fallback).first().waitFor();
        if(await profile.isVisible())await profile.click();else await fallback.click();
        const detail=page.locator('[data-bot-detail="fixture-ci"]');
        await detail.getByRole('tab',{name:t['detail.work'],exact:true}).click();
        await page.setViewportSize({width,height:950});
        const panel=detail.locator('[data-proactive-suggestions]');
        const card=panel.locator('[data-proactive-decision]').filter({hasText:'preview-case'});
        await card.getByRole('button',{name:t['proactive.preview'],exact:true}).click();
        const offers=card.locator('[data-workspace-offer]');
        assert.equal(await offers.count(),2);
        await offers.first().getByRole('button',{name:t['proactive.workspacePreview'],exact:true}).click();
        await offers.first().getByText('verify.cjs',{exact:true}).waitFor();
        if(groupRepair) {
          await writeFile(resolve(dir,'group-preview-dom.html'),await offers.first().innerHTML());
          const selector=offers.first().getByRole('combobox');
          await selector.selectOption({index:1});
          await offers.first().getByText(t['proactive.groupRepairScope'],{exact:true}).waitFor();
        }
        const ticket=panel.locator('[data-proactive-ticket]').filter({hasText:'accept-case'});
        if(groupRepair) {
          const group=ticket.locator('[data-group-repair-evidence]');
          await group.getByText(t['proactive.groupRepairPlan'],{exact:true}).waitFor();
          await group.locator(':scope > p').filter({hasText:t['proactive.groupRepairImplement']}).first().waitFor();
          await group.getByText(t['proactive.groupRepairReview'],{exact:true}).waitFor();
          await group.getByRole('button',{name:t['proactive.groupRepairOpen'],exact:true}).waitFor();
        }
        await ticket.getByRole('button',{name:t['proactive.workspaceLoadEvidence'],exact:true}).click();
        await ticket.locator('[data-workspace-content]').waitFor();
        await ticket.getByText(t['proactive.workspaceDiff'],{exact:true}).click();
        await ticket.getByText('exports.add = (a, b) => a + b;',{exact:true}).first().waitFor();
        await ticket.getByRole('button',{name:t['proactive.history'],exact:true}).click();
        await ticket.locator('[data-proactive-history] > details').nth(groupRepair?0:1).waitFor();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Viewport must not overflow');
        const bounds=await panel.evaluate(element=>{const rect=element.getBoundingClientRect();return {left:rect.left,right:rect.right,viewport:innerWidth};});
        if(bounds.left<0||bounds.right>bounds.viewport+1) {
          const ancestors=await panel.evaluate(element=>{const rows=[];for(let current=element;current;current=current.parentElement){const r=current.getBoundingClientRect(),s=getComputedStyle(current);rows.push({tag:current.tagName,class:current.className,width:r.width,left:r.left,clientWidth:current.clientWidth,scrollWidth:current.scrollWidth,minWidth:s.minWidth,maxWidth:s.maxWidth,cssWidth:s.width,display:s.display,overflow:s.overflow,padding:s.padding,boxSizing:s.boxSizing});}return rows;});
          await writeFile(resolve(dir,'workspace-geometry.json'),JSON.stringify({lang,theme,width,bounds,ancestors},null,2));
          await page.screenshot({path:resolve(dir,'workspace-clipped.png')});
        }
        assert.ok(bounds.left>=0&&bounds.right<=bounds.viewport+1,`Proactive panel clipped: ${JSON.stringify(bounds)}`);
        const screenshot=`workspace-${lang}-${theme}-${width}.png`;
        await page.screenshot({path:resolve(dir,screenshot),fullPage:true});
        matrix.push({lang,theme,width,screenshot});
      } finally { await context.close(); }
    }
    return matrix;
  } finally { await browser.close(); }
}
