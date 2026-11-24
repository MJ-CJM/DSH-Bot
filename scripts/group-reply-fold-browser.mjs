import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { openSidebarSession } from './deepening/sidebar-session.mjs';
import { auditArtifact } from './p34-artifact.mjs';
import { scratch } from './proactive/worker.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
const [mode, archive, frozenManifest] = process.argv.slice(2);
assert.equal(mode, '--mock-only');
assert.ok(archive, 'Provide the packaged candidate');
const dir = await scratch('group-reply-fold');
console.log(dir);
const artifact = resolve(archive);
const audit = frozenManifest ? JSON.parse(await readFile(frozenManifest)) : await auditArtifact(process.cwd(), artifact, dir);
const t = JSON.parse(execFileSync('tar',['-xOf', artifact, 'package/locale/zh.json'],{encoding:'utf8'})).ui;
const checks = [], metrics = {}, pageErrors = [], consoleErrors = [];
const pass = (name, condition = true) => { assert.ok(condition, name); checks.push(name); console.log('PASS', name); };
const frames = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const scrollBox = el => {
  let container = el;
  while (container && !(/auto|scroll/.test(getComputedStyle(container).overflowY) && container.scrollHeight > container.clientHeight + 1)) container = container.parentElement;
  if (!container) throw Error('No scrollable conversation');
  const rect = el.getBoundingClientRect(), box = container.getBoundingClientRect();
  return { y: rect.y, top: box.top, bottom: box.bottom, height: rect.height, scroll: container.scrollTop, remaining: container.scrollHeight - container.clientHeight - container.scrollTop };
};
let browser, host, page;
try {
  host = await webHost(dir, 'native-bots-workspace', artifact, resolve('packages/dsh-bot/tests/group-reply-fold-profile.mjs'),
    ['- id: agent-default-model', '  config:', '    provider: fold-offline', '    model: fixture'], { artifactAudit: audit, mockModel: false });
  const { rootSession } = JSON.parse(await readFile(resolve(dir, 'fixture.json')));
  const { chromium } = createRequire(resolve('packages/dsh-bot/package.json'))('playwright-core');
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const binary = (await readdir(cache)).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
    .flatMap(n=>['arm64','x64'].map(arch=>resolve(cache,n,'chrome-headless-shell-mac-'+arch,'chrome-headless-shell'))).find(existsSync);
  browser = await chromium.launch({ executablePath: binary, env: host.env, chromiumSandbox: true });
  const context = await browser.newContext({ locale:'zh-CN', viewport:{ width:1280, height:760 }, colorScheme:'light', reducedMotion:'reduce' });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', entry => { if(entry.type()==='error'||entry.type()==='warning') consoleErrors.push(entry.text().replace(/([?&]token=)[^ &]+/g, '$1[redacted]')); });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await installOverlayHandler(page,()=>{});
  await page.goto(host.url,{waitUntil:'domcontentloaded'});
  await dismissFirstRunOverlays(page,()=>{},'native-bots-workspace');
  await page.getByRole('navigation').getByRole('button', {name:t['bots.title'],exact:true}).waitFor();
  await openSidebarSession(page,rootSession);
  const composer = page.locator('[data-workspace-group-composer="'+rootSession+'"]:visible');
  const input = composer.getByRole('textbox',{name:t['groups.message'],exact:true});
  const native = page.locator('[data-conversation-content][data-conversation-session="'+rootSession+'"]:visible');
  const replies = native.locator('[data-group-author=bot]');
  const byBot = (id, n = 0) => replies.filter({has:page.locator('[data-bot-id="'+id+'"]')}).nth(n);
  const tools = native.locator('[data-group-reply-tools]');
  const toggle = area => area.locator('[data-group-reply-toggle]');
  const selected = area => toggle(area).getAttribute('aria-expanded');
  const summary = area => area.locator('[data-group-reply-preview]');
  const keyboardToggle = async (area, key) => {
    await toggle(area).focus();
    await page.keyboard.press(key);
    await frames(page);
  };
  const contentHidden = area => toggle(area).evaluate(button => {
    const body = document.getElementById(button.getAttribute('aria-controls'));
    if (!body) throw Error('Missing disclosure target');
    return body.hidden;
  });
  const disclosureColor = area => toggle(area).evaluate(node => getComputedStyle(node).color);
  const oneLine = area => summary(area).evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
    return rects.length > 0 && rects.every(rect => Math.abs(rect.top - rects[0].top) < 1);
  });
  const send = async text => {
    await input.fill(text);
    await composer.getByRole('button',{name:t['groups.send'],exact:true}).click();
  };
  const gate = ordinal => writeFile(resolve(dir,'release-'+ordinal),'publish the delayed local response');
  const first=byBot('reader-alpha'),second=byBot('reader-beta'),short=byBot('reader-short'),late=byBot('reader-late');
  const questionIntro = '请所有成员汇报迁移准备情况。';
  const questionEnd = '每份回复里再说明一项还需要我确认的决定。';
  await send(questionIntro + '\n\n' + questionEnd);
  await first.waitFor(); await second.waitFor(); await short.waitFor();
  pass('three independent real Bot deliveries visible before the fourth responds');
  const firstId=await first.getAttribute('data-group-message');
  const question = native.locator('[data-group-author=user]').first();
  pass('owner question defaults open with its full body', await selected(question) === 'true' &&
    !await contentHidden(question) && await question.getByText(questionEnd, { exact: true }).isVisible());
  await keyboardToggle(question, 'Space');
  pass('owner question collapses to one keyboard-accessible line', await selected(question) === 'false' &&
    await contentHidden(question) && await oneLine(question) &&
    (await summary(question).innerText()).includes(questionIntro) &&
    await toggle(question).evaluate(button => button === document.activeElement));
  assert.equal(await selected(first),'false');assert.equal(await selected(second),'false');
  pass('multimember long replies default collapsed');
  pass('short reply defaults open',await short.getByText('已就绪。',{exact:true}).isVisible() &&
    await selected(short) === 'true' && !await contentHidden(short));
  await toggle(short).click();
  pass('short reply can collapse independently', await selected(short) === 'false' &&
    await contentHidden(short) && await oneLine(short) && await summary(short).innerText() === '已就绪。' &&
    await selected(question) === 'false');
  await keyboardToggle(short, 'Enter');
  pass('short reply reopens by keyboard', await selected(short) === 'true' && !await contentHidden(short));
  const preview=first.locator('[data-group-reply-preview]');
  pass('preview selects published conclusion past heading',(await preview.innerText()).includes('reader-alpha-1'));
  const previewBox=await preview.evaluate(el=>({h:el.getBoundingClientRect().height,line:parseFloat(getComputedStyle(el).lineHeight)}));
  pass('collapsed preview fits a single line',!Number.isFinite(previewBox.line)||previewBox.h<=previewBox.line+2);
  metrics.lightColor = await disclosureColor(first);
  await first.screenshot({ path: resolve(dir, 'light-collapsed-reply.png') });
  await toggle(first).click();await toggle(second).click();
  pass('two independently expanded replies remain open',await selected(first)==='true'&&await selected(second)==='true');
  const marker=page.getByText('reader-alpha-1 阅读锚点 12。核对步骤、版本和责任人后，记录本项的验收结果。',{exact:true});
  await marker.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
  await delay(450);
  const before=await marker.evaluate(scrollBox);
  assert.ok(before.y>=before.top&&before.y<before.bottom&&before.remaining>200,'reader positioned above bottom');
  // Track each frame, to detect both momentary jumps and the finally settled position.
  await marker.evaluate(el => {
    const samples = [];
    let frame;
    const measure = () => {
      samples.push(el.getBoundingClientRect().y);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.__stopFoldMeasurements = () => {
      cancelAnimationFrame(frame);
      return samples;
    };
  });
  await gate(1);await late.waitFor({state:'attached'});
  await delay(2000);
  const after=await marker.evaluate(scrollBox);
  const samples = await page.evaluate(() => window.__stopFoldMeasurements());
  assert.ok(samples.length > 1, 'sampling spans the incoming reply');
  metrics.reading={before,after,samples:samples.length,maxShift:Math.max(...samples.map(y=>Math.abs(y-before.y)))};
  pass('late real reply keeps reading anchor within two CSS pixels',Math.abs(after.y-before.y)<=2 && metrics.reading.maxShift<=2);
  pass('late reply preserves explicitly open siblings and starts collapsed',await selected(first)==='true'&&await selected(second)==='true'&&await selected(late)==='false');
  pass('new reply keeps the owner question collapsed and the short reply open',
    await selected(question) === 'false' && await selected(short) === 'true');
  await keyboardToggle(question, 'Enter');
  pass('expanding the question restores the second paragraph', await selected(question) === 'true' &&
    !await contentHidden(question) && await question.getByText(questionEnd, { exact: true }).isVisible());
  await first.locator('[data-group-reply-collapse]').click();
  await frames(page);await delay(300);
  const header=toggle(first);const anchor=await header.evaluate(scrollBox);metrics.footer=anchor;
  pass('footer collapse focuses same header and keeps it within viewport',await selected(first)==='false'&&await header.evaluate(el=>el===document.activeElement)&&anchor.y>=anchor.top-2&&anchor.y+anchor.height<=anchor.bottom+2);
  const batch = tools.first().getByRole('button');
  await batch.click();
  pass('expand whole round opens all published replies', await selected(first) === 'true' &&
    await selected(second) === 'true' && await selected(short) === 'true' && await selected(late) === 'true');
  await batch.click();
  pass('collapse whole round closes short and long replies while keeping the question open',
    await selected(first) === 'false' && await selected(second) === 'false' && await selected(short) === 'false' &&
    await selected(late) === 'false' && await selected(question) === 'true');
  await send('@reader-alpha 请单独提供迁移结论。');
  const single=byBot('reader-alpha',1);
  await single.getByText('reader-alpha-2 阅读锚点 34。核对步骤、版本和责任人后，记录本项的验收结果。',{exact:true}).waitFor();
  pass('single explicit @ long reply defaults open', await selected(single) === 'true' && !await contentHidden(single));
  pass('single-reply round has only the per-message disclosure', await tools.count() === 1);
  await toggle(single).click();
  pass('single explicit @ reply can collapse to one line', await selected(single) === 'false' &&
    await contentHidden(single) && await oneLine(single) && (await summary(single).innerText()).includes('reader-alpha-2'));
  await keyboardToggle(single, 'Space');
  pass('single explicit @ reply can reopen', await selected(single) === 'true' &&
    await single.getByText('reader-alpha-2 阅读锚点 34。核对步骤、版本和责任人后，记录本项的验收结果。',{exact:true}).isVisible());
  await send('再来一轮，全员分别汇报准备。');
  const newestShort=byBot('reader-short',1),last=byBot('reader-late',1);
  await newestShort.waitFor();await byBot('reader-beta',1).waitFor();
  await newestShort.evaluate(el=>{let n=el;while(n&&!(/auto|scroll/.test(getComputedStyle(n).overflowY)&&n.scrollHeight>n.clientHeight+1))n=n.parentElement;if(!n)throw Error('missing scroller');n.scrollTop=n.scrollHeight;});
  await delay(350);metrics.bottomBefore=await newestShort.evaluate(scrollBox);
  assert.ok(metrics.bottomBefore.remaining<5);
  await gate(2);await last.waitFor({state:'attached'});await delay(600);
  metrics.bottomAfter=await last.evaluate(scrollBox);
  pass('reader already following bottom sees the arriving reply',metrics.bottomAfter.remaining<6 && metrics.bottomAfter.y<metrics.bottomAfter.bottom);
  await send('问下 Jarvis 迁移是否就绪？');
  const guest = byBot('reader-jarvis');
  const guestBadge = guest.locator('[data-group-guest-author="reader-jarvis"]');
  await guestBadge.waitFor();
  pass('committed guest answer defaults open with its real attribution', await selected(guest) === 'true' &&
    await guest.getByText('Jarvis', { exact: true }).isVisible() && await guestBadge.innerText() === t['groups.guest.author']);
  await toggle(guest).click();
  pass('collapsing a guest answer keeps its name, guest badge and single-line answer preview',
    await contentHidden(guest) && await oneLine(guest) && (await summary(guest).innerText()).includes('reader-jarvis-1') &&
    await guest.getByText('Jarvis', { exact: true }).isVisible() && await guestBadge.isVisible());
  await keyboardToggle(guest, 'Enter');
  pass('expanding a guest answer restores the signed response', await selected(guest) === 'true' &&
    await guest.getByText('reader-jarvis-1 阅读锚点 34。核对步骤、版本和责任人后，记录本项的验收结果。', { exact: true }).isVisible());
  await page.screenshot({path:resolve(dir,'light.png')});
  await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:960,height:720});
  await page.reload({waitUntil:'domcontentloaded'});
  // At this width the official shell collapses the sidebar and restores the open conversation itself.
  await native.waitFor();
  await first.waitFor();
  pass('historical replies after reload bind to their original message IDs',await first.getAttribute('data-group-message')===firstId&&await selected(first)==='false');
  metrics.darkColor = await disclosureColor(first);
  pass('the dark theme changes the disclosure text color', metrics.lightColor !== metrics.darkColor);
  await first.screenshot({ path: resolve(dir, 'dark-collapsed-reply.png') });
  await toggle(first).focus();await page.keyboard.press('Enter');
  pass('history toggles by keyboard in dark theme',await selected(first)==='true');
  await page.screenshot({path:resolve(dir,'dark.png')});
  await writeFile(resolve(dir, 'request-public-followup'), 'exercise the synthetic owner-approved follow-up');
  const followup = native.locator('[data-group-author=proactive]').filter({ hasText: '请补充本轮的确认结果。' });
  await followup.waitFor();
  const receiptFile = resolve(dir, 'public-followup.json');
  const deadline = Date.now() + 5000;
  while (!existsSync(receiptFile) && Date.now() < deadline) await delay(30);
  const ownerReceipt = JSON.parse(await readFile(receiptFile));
  pass('published owner follow-up is bound to the actual committed root input',
    await followup.getAttribute('data-group-message') === ownerReceipt.messageId && await selected(followup) === 'true');
  await keyboardToggle(followup, 'Enter');
  pass('published owner follow-up collapses to its own one-line preview',
    await contentHidden(followup) && await oneLine(followup) && await summary(followup).innerText() === '请补充本轮的确认结果。');
  assert.deepEqual(pageErrors,[]);assert.equal(host.requests(),0);
  await writeFile(resolve(dir,'result.json'),JSON.stringify({status:'PASS',sha256:audit.sha256,checks,metrics,realModelRequests:0},null,2));
} catch(error) {
  if(page) {
    await writeFile(resolve(dir,'snapshot.txt'),await page.locator('body').ariaSnapshot()).catch(()=>{});
    await page.screenshot({path:resolve(dir,'failure.png')}).catch(()=>{});
  }
  await writeFile(resolve(dir,'failure.json'),JSON.stringify({checks,metrics,pageErrors,consoleErrors,stack:error.stack},null,2));
  throw error;
} finally {await browser?.close();await host?.stop();}
