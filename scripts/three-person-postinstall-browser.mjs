import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
import { openBotsPanel } from './deepening/sidebar-session.mjs';
export async function verifyThreePersonBrowser(host, dir, { native = false } = {}) {
  const fixture = JSON.parse(await readFile(resolve(dir, 'fixture.json'))), require = createRequire(resolve('packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
  const t = JSON.parse(await readFile(resolve(dirname(dirname(fixture.productPath)), 'locale/en.json'))).ui;
  const expected = (await readFile(fixture.productPath, 'utf8')).trimEnd().replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*$/u, '').trimEnd();
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const executablePath = (await readdir(cache)).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().flatMap(n => ['arm64','x64'].map(a => resolve(cache,n,`chrome-headless-shell-mac-${a}`,'chrome-headless-shell'))).find(existsSync); assert.ok(executablePath);
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env });
  const checks = [], screenshots = [], errors = [], bodies = [];
  const context = await browser.newContext({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('response', response => { if (new URL(response.url()).pathname === '/plugins/' && /javascript/.test(response.headers()['content-type'] ?? '')) void response.text().then(body => bodies.push(body)).catch(() => {}); });
  const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('BROWSER_CHECK ' + name); };
  const snapshot = async () => writeFile(resolve(dir,'browser-last-snapshot.txt'), await page.locator('body').ariaSnapshot());
  const shot = async name => { await page.screenshot({ path: resolve(dir,name+'.png'), fullPage: true }); await writeFile(resolve(dir,name+'.txt'),await page.locator('body').ariaSnapshot()); screenshots.push(name+'.png'); };
  const live = async predicate => { for(let n=0;n<1500;n++){const error=await readFile(resolve(dir,'observer-error.json'),'utf8').catch(()=>undefined);assert.ok(!error,error);const report=await readFile(resolve(dir,'proof-live.json'),'utf8').then(JSON.parse).catch(()=>undefined);if(report&&predicate(report))return report;await delay(30);}throw Error('Browser Host-proof timeout'); };
  const phase = async marker => live(report => report.phases[marker] && !['accepted','running'].includes(report.phases[marker].turn.state) && report.phases[marker].deliveries.length===3);
  const openGroupFromDirectory = async (screen, labels) => {
    await openBotsPanel(screen, labels['bots.title']);
    await screen.getByRole('navigation', { name: labels['navigation.sections'], exact: true })
      .getByRole('button', { name: labels['groups.title'], exact: true }).click();
    await screen.locator(`[data-directory-kind="group"][data-directory-id="${fixture.key.groupId}"] [data-directory-open]`).click();
    await screen.locator(`[data-workspace-group-composer="${fixture.sessionId}"]:visible`).waitFor();
  };
  try {
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await installOverlayHandler(page,()=>{});await page.goto(host.url,{waitUntil:'domcontentloaded'});await dismissFirstRunOverlays(page,()=>{},'three-person-postinstall');
    if (native) {
      await openGroupFromDirectory(page, t);
      check('stock DSH has no mode switch or replacement sidebar', await page.locator('[data-bot-mode-switch-button], [data-bot-mode-sidebar]').count() === 0);
    } else {
      await openBotsPanel(page,t['bots.title']);await snapshot();await page.getByRole('navigation',{name:t['navigation.sections'],exact:true}).getByRole('button',{name:t['groups.title'],exact:true}).click();
      await page.locator(`[data-group-directory-row="${fixture.key.groupId}"]`).click();const overview=page.locator(`[data-group-overview="${fixture.key.groupId}"]`);await overview.getByRole('button',{name:t['groups.open'],exact:true}).click();
      await page.locator('[data-bot-mode-switch-button]:visible').first().click();await page.getByRole('menuitem',{name:t['botMode.botMode'],exact:true}).click();
      const sidebar=page.locator('[data-bot-mode-sidebar]:visible');await sidebar.waitFor();await sidebar.getByRole('navigation').getByRole('button',{name:fixture.name,exact:true}).click();
    }
    const composer=page.locator(`[data-workspace-group-composer="${fixture.sessionId}"]`),queue=page.locator(`[data-group-export-queue="${fixture.key.groupId}"]`);await composer.waitFor();
    const queueToggle=queue.locator('button[aria-controls]').first();await queueToggle.click();
    const row = id => queue.locator(`[data-group-export-review="${id}"]`);
    const preview = async delivery => { await snapshot();await row(delivery.id).getByRole('button',{name:t['groups.export.review'],exact:true}).click();const body=row(delivery.id).locator('pre');await body.waitFor();assert.ok((await body.textContent()).includes('PRIVATE_EXPORT:'));assert.equal(await row(delivery.id).locator('img').count(),0);for(const bot of fixture.bots)assert.ok((await row(delivery.id).textContent()).includes(bot.botId)); };
    const receipt = async (delivery,kind) => { const node=row(delivery.id).locator('[data-export-receipt]');await node.waitFor();assert.equal(await node.textContent(),t['groups.export.receipt.'+kind]); };
    const policyPanel = page.locator(native ? '[data-group-details]:visible' : '[data-bot-mode-details-panel]:visible');
    const openPolicy = async botId => {
      await snapshot();
      if (native) {
        await page.locator(`[data-group-details-opener="${fixture.key.groupId}"]:visible`).click();
        await policyPanel.waitFor();
        await policyPanel.getByRole('tab', { name: t['simple.groupSettings'], exact: true }).click();
      } else {
        await page.locator('[data-bot-mode-object="group"] [data-bot-mode-details]').click();
        await policyPanel.waitFor();
        await policyPanel.locator('[data-bot-mode-tab="settings"]').click();
      }
      const settings = policyPanel.locator('[data-group-export-settings]'); await settings.waitFor();
      const row = settings.locator(`[data-export-policy-bot="${botId}"]`); await row.waitFor();
      return row;
    };
    const closePolicy = async () => policyPanel.getByRole('button',{name:t[native ? 'actions.close' : 'botMode.closeDetails'],exact:true}).click();
    const send = async text => { await snapshot();await composer.getByRole('textbox',{name:t['groups.message'],exact:true}).fill(text);await composer.getByRole('button',{name:t['groups.send'],exact:true}).click(); };
    let report=await phase('THREE_R1'),ds=report.phases.THREE_R1.deliveries;
    assert.ok(ds.every(d=>d.reasonCode==='export-approval-required'));check('all three native private replies are held before owner review');
    for(const delivery of ds){await preview(delivery);await row(delivery.id).getByRole('checkbox').check();}await shot('01-three-exact-previews');
    await queue.getByRole('button',{name:t['groups.export.batchOnce'].replace('{count}','3'),exact:true}).click();for(const delivery of ds)await receipt(delivery,'sent');
    report=await live(r=>r.phases.THREE_R1.publishedPrivateExportReplies===3);check('UI batch once publishes exactly the three reviewed replies',report.phases.THREE_R1.deliveries.every(d=>d.outputMessageId));check('one-time batch creates no automatic-export preference',report.exportApprovals.length===0);await shot('02-three-batch-once-sent');
    await send('THREE_R2: review updated private notes for this group.');report=await phase('THREE_R2');ds=report.phases.THREE_R2.deliveries;check('a new round again requires approval for all three after once',ds.every(d=>d.reasonCode==='export-approval-required'));
    const alpha=ds.find(d=>d.bot.botId==='proof-alpha');await preview(alpha);
    check('pending reply review has no persistent-always decision',await row(alpha.id).getByRole('button',{name:t['groups.export.always'],exact:true}).count()===0);
    const alphaPolicy=await openPolicy('proof-alpha');await alphaPolicy.locator('[data-export-policy-action]').click();
    await policyPanel.locator('[data-export-policy-confirm]').waitFor();
    for(const bot of fixture.bots)assert.ok((await policyPanel.locator('[data-group-export-settings]').textContent()).includes(bot.botId));
    await shot('03-alpha-policy-audience-confirmation');
    await policyPanel.locator('[data-export-policy-confirm]').click();
    report=await live(r=>r.exportApprovals.length===1&&r.exportApprovals[0].bot.botId==='proof-alpha');
    check('settings enable records the exact three-person audience',report.exportApprovals[0].members.length===3);
    check('enabling future export does not publish or alter already pending replies',report.phases.THREE_R2.publishedPrivateExportReplies===0&&report.phases.THREE_R2.deliveries.every(d=>d.reasonCode==='export-approval-required'&&!d.outputMessageId));
    await closePolicy();
    await row(alpha.id).getByRole('button',{name:t['groups.export.allow'],exact:true}).click();await receipt(alpha,'sent');
    for(const delivery of ds.filter(d=>d.id!==alpha.id)){await preview(delivery);await row(delivery.id).getByRole('checkbox').check();}await queue.getByRole('button',{name:t['groups.export.batchOnce'].replace('{count}','2'),exact:true}).click();for(const delivery of ds.filter(d=>d.id!==alpha.id))await receipt(delivery,'sent');
    report=await live(r=>r.phases.THREE_R2.publishedPrivateExportReplies===3);check('always grants only the explicitly chosen Bot in this group',report.exportApprovals.length===1&&report.exportApprovals[0].bot.botId==='proof-alpha'&&report.exportApprovals[0].members.length===3);
    await send('THREE_R3: prove the other Bots still need their own approval.');report=await phase('THREE_R3');ds=report.phases.THREE_R3.deliveries;
    check('next native round automatically publishes only alpha',ds.find(d=>d.bot.botId==='proof-alpha').state==='completed'&&report.phases.THREE_R3.publishedPrivateExportReplies===1);
    const held=ds.filter(d=>d.bot.botId!=='proof-alpha');check('other Bots remain independently held',held.length===2&&held.every(d=>d.reasonCode==='export-approval-required'&&!d.outputMessageId));await shot('04-next-round-bot-scoped-approval');
    for(const delivery of held){await row(delivery.id).getByRole('button',{name:t['groups.export.reject'],exact:true}).click();await receipt(delivery,'rejected');}
    report=await live(r=>r.phases.THREE_R3.deliveries.filter(d=>d.reasonCode==='export-rejected').length===2);check('explicitly rejected-only remainder does not publish or become a false execution failure',['completed','idle'].includes(report.phases.THREE_R3.turn.state));
    const enabledPolicy=await openPolicy('proof-alpha');await enabledPolicy.locator('[data-export-policy-action]').click();
    report=await live(r=>r.exportApprovals.length===0);
    check('disabling the policy preserves the previously published reply',report.phases.THREE_R3.publishedPrivateExportReplies===1);
    await closePolicy();await send('THREE_R4: after disabling the policy, all Bots need approval again.');
    report=await phase('THREE_R4');ds=report.phases.THREE_R4.deliveries;
    check('disabled policy restores individual approval for all three Bots',ds.every(d=>d.reasonCode==='export-approval-required'&&!d.outputMessageId));
    for(const delivery of ds){await row(delivery.id).getByRole('button',{name:t['groups.export.reject'],exact:true}).click();await receipt(delivery,'rejected');}
    const memoryChip=composer.locator('[data-group-memory-status]');
    check('memory option is not a permanent composer checkbox',await composer.getByRole('checkbox',{name:t['groups.memoryStatus.toggle'],exact:true}).count()===0&&await memoryChip.count()===0);
    const armMemory=async()=>{await composer.locator('[data-group-command-launcher]').click();await snapshot();await composer.locator('[data-group-command="memory"]').click();await memoryChip.waitFor();};
    await page.setViewportSize({width:390,height:844});
    await composer.locator('[data-group-command-launcher]').click();await shot('05a-memory-menu-narrow-light');
    await composer.locator('[data-group-command="memory"]').click();await memoryChip.waitFor();await shot('05b-memory-chip-narrow-light');
    await composer.locator('[data-group-memory-cancel]').click();
    check('memory instruction chip can be removed before sending',await memoryChip.count()===0);
    await armMemory();await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:'dark'});await shot('05-three-actual-memory-write-request');
    await send('THREE_STATUS_WRITE: remember the owner jasmine-tea preference privately and report only write status.');report=await live(r=>r.memoryProof?.length===3&&r.memoryProof.every(row=>row.status==='saved'&&row.actualStoredReceiptId&&row.matchedContent));
    check('all three native workers have successful bot_memory_save tool results and exact stored record IDs',report.memoryProof.every(row=>row.nativeSaveCalls>=1&&row.nativeSuccessfulResults>=1));
    check('memory status-only publishes no private member narrative or output envelope',!report.publishedPrivateNarrative&&report.memoryProof.every(row=>row.noOutputMessage));check('original memory readers remain private',report.privateVersionsUnchanged);
    await page.getByText(t['groups.memoryStatus.summary'].replace('{saved}','3').replace('{failed}','0').replace('{unverified}','0'),{exact:true}).waitFor();check('actual UI reports three saved, zero failed, zero unverified');check('the explicit status-only choice resets after its successful send',await memoryChip.count()===0);
    const statusTurn=report.phases.THREE_STATUS_WRITE.turn.id;check('no native member body is projected in the status-only turn',await page.locator(`[data-group-turn="${statusTurn}"] [data-group-member-process]`).count()===0);check('the visible conversation contains no private memory-write narrative',!(await page.locator('body').innerText()).includes('PRIVATE_NARRATIVE_MUST_NOT_BE_PUBLISHED'));await shot('06-three-verified-saved-status-only');
    check('actual HTTP product Client equals installed frozen package',bodies.some(body=>body.includes(expected)));
    for (const language of ['en', 'zh']) {
      const labels = JSON.parse(await readFile(resolve(dirname(dirname(fixture.productPath)), `locale/${language}.json`))).ui;
      const sample = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
      try {
        const screen = await sample.newPage(); screen.setDefaultTimeout(30000); screen.on('pageerror', error => errors.push(String(error)));
        await screen.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
        await installOverlayHandler(screen, () => {}); await screen.goto(host.url, { waitUntil: 'domcontentloaded' });
        await dismissFirstRunOverlays(screen, () => {}, 'memory-menu-sample');
        if (native) {
          await openGroupFromDirectory(screen, labels);
        } else {
          const navigation = screen.locator('[data-bot-mode-sidebar]:visible'); await navigation.waitFor();
          await writeFile(resolve(dir, `memory-${language}-navigation.txt`), await screen.locator('body').ariaSnapshot());
          await navigation.getByRole('navigation').getByRole('button', { name: fixture.name, exact: true }).click();
        }
        await screen.setViewportSize({ width: 390, height: 844 });
        const input = screen.locator(`[data-workspace-group-composer="${fixture.sessionId}"]:visible`);
        for (const theme of ['light', 'dark']) {
          await screen.emulateMedia({ colorScheme: theme });
          await input.locator('[data-group-command-launcher]').click();
          const command = input.locator('[data-group-command="memory"]'); await command.waitFor();
          assert.ok((await command.textContent()).includes(labels['groups.memoryStatus.toggle']));
          const menuName = `memory-menu-390-${language}-${theme}`;
          await screen.screenshot({ path: resolve(dir, menuName + '.png'), fullPage: true });
          await writeFile(resolve(dir, menuName + '.txt'), await screen.locator('body').ariaSnapshot()); screenshots.push(menuName + '.png');
          await command.click(); const tag = input.locator('[data-group-memory-status]'); await tag.waitFor();
          const cancel = input.locator('[data-group-memory-cancel]'), box = await cancel.boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, 'Memory cancel must stay reachable in the narrow viewport');
          const chipName = `memory-chip-390-${language}-${theme}`;
          await screen.screenshot({ path: resolve(dir, chipName + '.png'), fullPage: true });
          await writeFile(resolve(dir, chipName + '.txt'), await screen.locator('body').ariaSnapshot()); screenshots.push(chipName + '.png');
          await cancel.click(); assert.equal(await tag.count(), 0);
          check(`390px ${language} ${theme} menu and removable chip remain usable`);
          if (native) {
            await screen.locator(`[data-group-details-opener="${fixture.key.groupId}"]:visible`).click();
            const details = screen.locator('[data-group-details]:visible');
            await details.getByRole('tab', { name: labels['simple.groupSettings'], exact: true }).click();
            await details.locator('[data-group-export-settings]').waitFor();
            await details.getByRole('button', { name: labels['actions.close'], exact: true }).click();
            await details.waitFor({ state: 'hidden' });
            await input.waitFor();
            check(`390px ${language} ${theme} right-pane settings and return remain usable`);
          }
        }
      } finally { await sample.close(); }
    }
    assert.deepEqual(errors,[]);check('page errors remain zero');
    const result={status:'PASS',checks,screenshots,errors,realModelRequests:0,round3:report.phases.THREE_R3,memoryProof:report.memoryProof,privateVersionsUnchanged:report.privateVersionsUnchanged};await writeFile(resolve(dir,'browser-result.json'),JSON.stringify(result,null,2));return result;
  }catch(error){await page.screenshot({path:resolve(dir,'browser-failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(dir,'browser-result.json'),JSON.stringify({status:'FAIL',error:String(error.stack),checks,screenshots,errors,realModelRequests:0},null,2));throw error;}finally{await browser.close();}
}
