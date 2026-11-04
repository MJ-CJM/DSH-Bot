// Issue #30: Bot-to-Bot messages stay visible in both chats, and Bot details open in the native right sidebar.
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
const version = process.env.DSH_BOT_DSH_BIN?.includes('native-api-rc2') ? 'rc2' : 'rc5';
const dir = resolve(root, `.dsh-dev/bot-presence/${version}-${Date.now()}`);
const out = resolve(root, `output/playwright/bot-presence/${version}`); await mkdir(out, { recursive: true });
const host = await webHost(dir, 'presence', undefined, resolve(root, 'packages/dsh-bot/tests/bot-message-presence-profile.mjs'));
let browser, page, stopped = false;
const checks = [], errors = [], check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
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
  for (const [language, theme, width] of [['en', 'light', 1440], ['zh', 'dark', 390]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, locale: language === 'zh' ? 'zh-CN' : 'en-US' });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(String(error)));
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
    await page.screenshot({ path: join(out, `${language}-${theme}-${width}-receiver.png`) });

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
    await reply.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(out, `${language}-${theme}-${width}-sender.png`) });
    const toggle = reply.locator('button[aria-expanded]');
    await toggle.click();
    check(`${language}: expanding a marker shows the original message`, await toggle.getAttribute('aria-expanded') === 'true' && (await reply.innerText()).includes(receipt.answer));
    check(`${language}: markers fit the viewport`, await noOverflow() && (await Promise.all([sent, reply].map(l => l.boundingBox()))).every(b => b && b.x >= 0 && b.x + b.width <= width + 1));
    await page.screenshot({ path: join(out, `${language}-${theme}-${width}-expanded.png`) });

    const selected = page.locator(`[data-row-key="session:${receipt.mains.planner}"][aria-selected="true"]`);
    await reply.locator('button[data-bot-chip="reviewer"]').click();
    const reviewerPanel = page.locator('[data-bot-panel="reviewer"]');
    await reviewerPanel.waitFor();
    check(`${language}: the peer chip opens that Bot beside the conversation`, await reviewerPanel.isVisible()
      && (await reviewerPanel.locator('h2').innerText()) === 'Reviewer' && await page.locator('[data-bot-detail]').count() === 0
      && await page.locator('[data-bots-page]:visible').count() === 0);
    check(`${language}: the panel offers the peer's chat and full settings`, await reviewerPanel.getByRole('button', { name: t['chat.openChat'], exact: true }).isVisible()
      && await reviewerPanel.getByRole('button', { name: t['botPanel.settings'], exact: true }).isVisible());
    check(`${language}: panel fits the viewport`, await noOverflow());
    // At phone width the native layout may collapse the left sidebar, which then renders no session rows;
    // the session header still names the open conversation.
    const rowShown = await page.locator(`[data-row-key="session:${receipt.mains.planner}"]`).count() > 0;
    check(`${language}: the conversation stays selected beside the panel`, rowShown ? await selected.count() === 1
      : (await page.getByRole('banner').first().innerText()).includes('Planner'));
    await page.screenshot({ path: join(out, `${language}-${theme}-${width}-panel-peer.png`) });

    // The conversation header badge opens this chat's own Bot in the same page. At phone width the
    // native right sidebar presents fullscreen over the conversation, so that flow is checked on desktop.
    const badge = page.getByRole('button', { name: fill('badge.open', { name: 'Planner' }), exact: true });
    if (width >= 600) {
      await badge.click();
      const plannerPanel = page.locator('[data-bot-panel="planner"]');
      await plannerPanel.waitFor();
      check(`${language}: the header badge navigates the same page to this chat's Bot`, await page.locator('[data-bot-panel]').count() === 1
        && await plannerPanel.locator('[data-bot-panel-current]').isVisible() && await page.locator('[data-bots-page]:visible').count() === 0);
      await plannerPanel.getByRole('tab', { name: t['botPanel.tasks'], exact: true }).click();
      check(`${language}: the tasks section reuses the routine panel for this Bot`, await plannerPanel.locator('[data-routine-panel="planner"]').isVisible()
        && await plannerPanel.getByRole('tab', { name: t['botPanel.tasks'], exact: true }).getAttribute('aria-selected') === 'true');
      await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
      await page.screenshot({ path: join(out, `${language}-${theme}-${width}-panel-own.png`) });
      await plannerPanel.getByRole('button', { name: t['botPanel.settings'], exact: true }).click();
      await page.locator('[data-bot-detail="planner"]').waitFor();
      check(`${language}: full settings still open the Bots page details`, await page.locator('[data-bot-detail="planner"]').isVisible());
    } else {
      const box = await reviewerPanel.boundingBox();
      check(`${language}: at phone width the panel uses the native fullscreen presentation`, Boolean(box && box.width >= width - 40) && await noOverflow());
    }
    await context.close();
  }
  check('no browser errors', errors.length === 0);
  await browser.close(); browser = undefined; await host.stop(); stopped = true;
  await writeFile(join(out, 'result.json'), `${JSON.stringify({ status: 'PASS', version, dir, checks, errors, receipt }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'PASS', version, checks: checks.length, dir, out }));
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: join(out, 'failure.png') }); await writeFile(join(out, 'failure.txt'), await page.locator('body').ariaSnapshot()); }
  await writeFile(join(out, 'result.json'), `${JSON.stringify({ status: 'FAIL', dir, checks, errors, error: String(error.stack) }, null, 2)}\n`); throw error;
} finally { await browser?.close(); if (!stopped) await host.stop(); }
