// Issue #30: Bot-to-Bot messages stay visible in both chats, and Bot details use a compact native preview, with an explicit native sidebar action.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { webHost } from './deepening/b4-web-host.mjs';
import { openSidebarSession } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const version = process.env.DSH_BOT_DSH_BIN?.includes('native-api-rc2') ? 'rc2' : 'local-runtime';
const dir = resolve(root, `.dsh-dev/bot-presence/${version}-${Date.now()}`);
const out = resolve(root, `output/playwright/bot-presence/${version}-${Date.now()}`); await mkdir(out, { recursive: true });
const host = await webHost(dir, 'presence', undefined, resolve(root, 'packages/dsh-bot/tests/bot-message-presence-profile.mjs'));
let browser, page, stopped = false;
const checks = [], errors = [], warnings = [], limitations = [], check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
try {
  const receipt = JSON.parse(await readFile(resolve(dir, 'presence.json'), 'utf8'));
  const kinds = rows => rows.map(r => `${r.kind}:${r.mode}:${r.from}>${r.to}`);
  check('sender log has its ask notice and the reply', JSON.stringify(kinds(receipt.planner)) === JSON.stringify(['dsh-bot-message-sent:ask:planner>reviewer', 'dsh-bot-message:reply:reviewer>planner']));
  check('receiver log has the ask and its reply notice', JSON.stringify(kinds(receipt.reviewer)) === JSON.stringify(['dsh-bot-message:ask:planner>reviewer', 'dsh-bot-message-sent:reply:reviewer>planner']));
  check('scripted model only', receipt.realModelRequests === 0);

  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const candidates = (await readdir(cache)).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
    .flatMap(n => ['arm64', 'x64'].map(a => join(cache, n, `chrome-headless-shell-mac-${a}`, 'chrome-headless-shell')));
  const oldTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath: process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync), headless: true, chromiumSandbox: true, env: host.env }); }
  finally { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; }
  for (const [language, theme, width] of ['en', 'zh'].flatMap(language => ['light', 'dark'].flatMap(theme => [1440, 390].map(width => [language, theme, width])))) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, locale: language === 'zh' ? 'zh-CN' : 'en-US' });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(String(error)));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); else if (['warning', 'warn'].includes(msg.type())) warnings.push(msg.text()); });
    await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
    await installOverlayHandler(page, () => {}); await page.goto(host.url); await dismissFirstRunOverlays(page, () => {}, 'presence');
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`))).ui;
    const fill = (key, values) => t[key].replace(/\{(\w+)\}/g, (_m, name) => values[name]);
    const marker = (direction, mode) => page.locator(`[data-bot-message][data-message-direction="${direction}"][data-message-mode="${mode}"]`);
    const shown = async locator => await locator.isVisible() && (await locator.innerText()).trim().length > 0
      && await locator.evaluate(el => !el.closest('[hidden], [data-step-process] [hidden]'));
    const noOverflow = () => page.evaluate(w => document.scrollingElement.scrollWidth <= w + 1, width);

    await openSidebarSession(page, receipt.mains.reviewer);
    await page.setViewportSize({ width, height: 860 });
    const ask = marker('received', 'ask'), replied = marker('sent', 'reply');
    await ask.waitFor();
    check(`${language}: receiver shows the incoming ask as its Turn input`, await shown(ask)
      && (await ask.innerText()).includes(t['messages.receivedFrom']) && (await ask.innerText()).includes('Planner') && (await ask.innerText()).includes(t['messages.ask']));
    check(`${language}: receiver keeps its reply notice visible after the Turn folds`, await shown(replied) && (await replied.innerText()).includes(t['messages.repliedTo']));
    await page.screenshot({ animations: 'disabled', path: join(out, `${language}-${theme}-${width}-receiver.png`) });

    await page.setViewportSize({ width: 1440, height: 860 });
    await openSidebarSession(page, receipt.mains.planner);
    await page.setViewportSize({ width, height: 860 });
    const sent = marker('sent', 'ask'), reply = marker('received', 'reply');
    await reply.waitFor();
    check(`${language}: sender shows "sent to" and the reply, each with the peer chip`, await shown(sent) && await shown(reply)
      && (await sent.innerText()).includes(t['messages.sentTo']) && (await reply.innerText()).includes(t['messages.replyFrom'])
      && await sent.locator('[data-bot-chip="reviewer"]').isVisible() && await reply.locator('[data-bot-chip="reviewer"]').isVisible());
    check(`${language}: no message renders as an empty placeholder`, (await page.locator('[data-bot-message]').evaluateAll(nodes => nodes.map(n => n.innerText.trim()))).every(Boolean));
    check(`${language}: completed Turns are folded while the markers stay visible`, await page.locator('[data-step-process] [hidden], [data-step-process][hidden]').count() > 0);
    await reply.scrollIntoViewIfNeeded(); await page.screenshot({ animations: 'disabled', path: join(out, `${language}-${theme}-${width}-sender.png`) });
    const toggle = reply.locator('button[aria-expanded]');
    await toggle.click();
    check(`${language}: expanding a marker shows the original message`, await toggle.getAttribute('aria-expanded') === 'true' && (await reply.innerText()).includes(receipt.answer));
    check(`${language}: markers fit the viewport`, await noOverflow() && (await Promise.all([sent, reply].map(l => l.boundingBox()))).every(b => b && b.x >= 0 && b.x + b.width <= width + 1));
    await page.screenshot({ animations: 'disabled', path: join(out, `${language}-${theme}-${width}-expanded.png`) });

    const peerChip = reply.locator('button[data-bot-chip="reviewer"]');
    const before = await reply.boundingBox();
    await peerChip.click();
    const dialog = page.getByRole('dialog', { name: t['botPanel.title'], exact: true });
    const reviewerPanel = dialog.locator('[data-bot-panel="reviewer"]');
    await reviewerPanel.waitFor();
    check(`${language}/${theme}/${width}: the peer opens a compact preview of the correct Bot`, await reviewerPanel.isVisible()
      && (await reviewerPanel.locator('h2').innerText()) === 'Reviewer' && await page.locator('[data-bot-detail]').count() === 0
      && await page.locator('[data-bots-page]:visible').count() === 0);
    const after = await reply.boundingBox();
    check(`${language}/${theme}/${width}: opening the preview does not resize or move the conversation`, before && after
      && Math.abs(before.width - after.width) < 1 && Math.abs(before.x - after.x) < 1);
    const box = await dialog.boundingBox();
    check(`${language}/${theme}/${width}: preview width is bounded by 420px and native viewport margins`, box
      && box.width <= 421 && box.x >= 23 && box.x + box.width <= width - 23 && box.y >= 23 && box.y + box.height <= 837);
    check(`${language}/${theme}/${width}: dialog owns focus`, await dialog.evaluate(el => el.contains(document.activeElement)));
    check(`${language}/${theme}/${width}: peer preview offers chat and full settings`, await reviewerPanel.getByRole('button', { name: t['chat.openChat'], exact: true }).isVisible()
      && await reviewerPanel.getByRole('button', { name: t['botPanel.settings'], exact: true }).isVisible());
    check(`${language}/${theme}/${width}: compact content has no horizontal overflow`, await noOverflow()
      && await reviewerPanel.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.screenshot({ animations: 'disabled', path: join(out, `${language}-${theme}-${width}-preview-peer.png`) });
    await page.setViewportSize({ width, height: 360 });
    const scroll = await dialog.evaluate(el => {
      const region = [...el.querySelectorAll('div')].find(node => getComputedStyle(node).overflowY === 'auto' && node.scrollHeight > node.clientHeight);
      if (!region) return null;
      region.scrollTop = region.scrollHeight;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, scrollTop: region.scrollTop, overflow: region.scrollWidth > region.clientWidth + 1 };
    });
    check(`${language}/${theme}/${width}: short windows scroll inside the preview within native viewport margins`, scroll
      && scroll.scrollTop > 0 && scroll.top >= 23 && scroll.bottom <= 337 && !scroll.overflow);
    await page.screenshot({ animations: 'disabled', path: join(out, `${language}-${theme}-${width}-preview-short.png`) });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    check(`${language}/${theme}/${width}: Escape closes and restores focus to the peer chip`, await peerChip.evaluate(el => document.activeElement === el));
    await page.setViewportSize({ width, height: 860 });

    const badge = page.getByRole('button', { name: fill('badge.open', { name: 'Planner' }), exact: true });
    await badge.click();
    const plannerPanel = dialog.locator('[data-bot-panel="planner"]');
    await plannerPanel.waitFor();
    check(`${language}/${theme}/${width}: header badge opens the current Bot`, await plannerPanel.locator('[data-bot-panel-current]').isVisible());
    await plannerPanel.getByRole('tab', { name: t['botPanel.tasks'], exact: true }).click();
    check(`${language}/${theme}/${width}: task content remains available`, await plannerPanel.locator('[data-routine-panel="planner"]').isVisible());
    if (receipt.nativeScheduleApi === 'session-first') {
      const editTask = plannerPanel.locator('[data-routine-id]').getByRole('button', { name: t['card.edit'], exact: true });
      await editTask.click();
      const taskDialog = page.getByRole('dialog', { name: t['routine.edit'], exact: true });
      await taskDialog.waitFor();
      check(`${language}/${theme}/${width}: task editor opens above the preview`, await taskDialog.evaluate(el => el.contains(document.activeElement)));
      check(`${language}/${theme}/${width}: nested editor loads its own chrome styles`, await taskDialog.locator('header').evaluate(el =>
        getComputedStyle(el).display === 'flex' && parseFloat(getComputedStyle(el).paddingLeft) >= 16));
      await page.screenshot({ animations: 'disabled', path: join(out, `${language}-${theme}-${width}-nested-task-editor.png`) });
      await page.keyboard.press('Escape');
      await taskDialog.waitFor({ state: 'hidden' });
      check(`${language}/${theme}/${width}: nested Escape keeps the preview and restores editor-trigger focus`, await dialog.isVisible()
        && await editTask.evaluate(el => el === document.activeElement));
    } else {
      // The existing task aggregation expects catalog.sessionId. Newer Hosts moved it to target.sessionId.
      // Do not rewrite fixture records or pretend this unrelated compatibility check passed.
      limitations.push({ case: `${language}/${theme}/${width}`, status: 'FAIL', check: 'native routine catalog and nested editor',
        reason: 'New request-target Schedule API is not mapped by the existing Bot routine aggregation.',
        visibleRoutineCount: await plannerPanel.locator('[data-routine-id]').count() });
    }
    await plannerPanel.getByRole('tab', { name: t['botPanel.messages'], exact: true }).click();
    check(`${language}/${theme}/${width}: message section is selectable`, await plannerPanel.getByRole('tab', { name: t['botPanel.messages'], exact: true }).getAttribute('aria-selected') === 'true');
    await page.screenshot({ animations: 'disabled', path: join(out, `${language}-${theme}-${width}-preview-messages.png`) });
    await plannerPanel.getByRole('button', { name: t['botPanel.settings'], exact: true }).click();
    await page.locator('[data-bot-detail="planner"]').waitFor();
    check(`${language}/${theme}/${width}: full settings close the preview and open the existing page`, !await dialog.isVisible()
      && await page.locator('[data-bot-detail="planner"]').isVisible());

    await page.setViewportSize({ width: 1440, height: 860 });
    await openSidebarSession(page, receipt.mains.planner);
    await page.setViewportSize({ width, height: 860 });
    await badge.click();
    await plannerPanel.waitFor();
    await plannerPanel.getByRole('tab', { name: t['botPanel.tasks'], exact: true }).click();
    await plannerPanel.getByRole('button', { name: t['botPanel.openSidebar'], exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const sidebarPanel = page.locator('[data-bot-panel="planner"]');
    await sidebarPanel.waitFor();
    check(`${language}/${theme}/${width}: explicit sidebar action preserves the selected Bot and section`, await sidebarPanel.getByRole('tab', { name: t['botPanel.tasks'], exact: true }).getAttribute('aria-selected') === 'true'
      && await sidebarPanel.locator('[data-routine-panel="planner"]').isVisible() && await noOverflow());
    await page.screenshot({ animations: 'disabled', path: join(out, `${language}-${theme}-${width}-sidebar-opt-in.png`) });
    await context.close();
  }
  check('no browser errors', errors.length === 0);
  check('no browser warnings', warnings.length === 0);
  await browser.close(); browser = undefined; await host.stop(); stopped = true;
  const status = limitations.length ? 'PASS_WITH_LIMITATIONS' : 'PASS';
  await writeFile(join(out, 'result.json'), `${JSON.stringify({ status, scope: 'Bot preview layout', version, dir, checks, errors, warnings, limitations, receipt }, null, 2)}\n`);
  console.log(JSON.stringify({ status, version, checks: checks.length, limitations: limitations.length, dir, out }));
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ animations: 'disabled', path: join(out, 'failure.png') }); await writeFile(join(out, 'failure.txt'), await page.locator('body').ariaSnapshot()); }
  await writeFile(join(out, 'result.json'), `${JSON.stringify({ status: 'FAIL', dir, checks, errors, warnings, limitations, error: String(error.stack) }, null, 2)}\n`); throw error;
} finally { await browser?.close(); if (!stopped) await host.stop(); }
