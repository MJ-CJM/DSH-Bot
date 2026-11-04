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
const hostVersion = process.env.DSH_BOT_DSH_BIN?.includes('native-api-rc2') ? 'rc2' : 'rc5';
const out = resolve(root, `output/playwright/group-statistics/${hostVersion}`); await mkdir(out, { recursive: true });
const cache = join(homedir(), 'Library/Caches/ms-playwright');
const candidates = (await readdir(cache)).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .flatMap(n => ['arm64', 'x64'].map(a => join(cache, n, `chrome-headless-shell-mac-${a}`, 'chrome-headless-shell')));
const receipts = [];
const variants = [['en', 'light', 'detailed'], ['zh', 'dark', 'detailed'], ['zh', 'light', 'detailed'], ['en', 'dark', 'compact']];
for (const [language, theme, mode] of process.env.DSH_BOT_STATS_COLD_ONLY === '1' ? variants.slice(0, 1) : variants) {
  const variant = `${language}-${theme}-${mode}`;
  const dir = resolve(root, `.dsh-dev/group-statistics/${language}-${Date.now()}`);
  let host = await webHost(dir, `statistics-${language}`, undefined, resolve(root, 'packages/dsh-bot/tests/group-statistics-profile.mjs'), ['- id: ui-chat', '  config:', `    performanceUsage: ${mode}`]);
  let browser, page, stopped = false;
  try {
    const originalTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
    try { browser = await chromium.launch({ executablePath: process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync), headless: true, chromiumSandbox: true, env: host.env }); }
    finally { if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp; }
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' });
    page = await context.newPage(); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => { errors.push(String(e)); console.log('PAGE_ERROR', String(e)); });
    await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
    await installOverlayHandler(page, () => {}); await page.goto(host.url); await dismissFirstRunOverlays(page, () => {}, 'showcase');
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`))).ui;
    const fixture = JSON.parse(await readFile(resolve(dir, 'showcase.json')));
    const capture = async name => {
      await page.setViewportSize({ width: 1440, height: ({ bots: 720, profile: 760, memory: 1160, group: 1160 })[name] ?? 1000 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, `${variant}-${name}.png`), animations: 'disabled' });
      await writeFile(join(out, `${variant}-${name}.txt`), await page.locator('body').ariaSnapshot());
    };
    await openSidebarSession(page, fixture.rootId);
    await page.setViewportSize({ width: 1440, height: 1160 });
    const bar = page.locator('[data-group-statistics-bar]');
    await bar.waitFor();
    assert.equal(await bar.getAttribute('data-statistics-turn'), fixture.secondTurnId);
    if (mode === 'detailed') await bar.locator('[data-group-token-total="160"]').waitFor();
    await bar.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem').filter({ hasText: language === 'en' ? 'How should we compare' : '请一起讨论' }).click();
    assert.equal(await bar.getAttribute('data-statistics-turn'), fixture.turnId);
    const turn = page.locator(`[data-group-turn="${fixture.turnId}"]`);
    await turn.locator(':scope > button[aria-expanded]').click();
    await page.locator('[data-group-member-process]').nth(1).waitFor();
    await page.locator('[data-group-member-process] [data-disclosure-row]').nth(1).waitFor();
    for (const row of await page.locator('[data-group-member-process] [data-disclosure-row]').all()) {
      if (await row.getAttribute('aria-expanded') === 'false') await row.click();
    }
    const before = host.requests();
    if (mode === 'detailed') await bar.locator('[data-group-token-total="480"]').waitFor();
    const memberStats = page.locator('[data-group-member-statistics]');
    assert.equal(await memberStats.count(), 3);
    for (const member of await memberStats.all()) {
      if (mode === 'detailed') assert.match(await member.innerText(), /160 tok/);
      else assert.doesNotMatch(await member.innerText(), /160 tok/);
      assert.match(await member.innerText(), /28.6/);
    }
    await bar.getByRole('button', { name: t['statistics.details'], exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    assert.match(await dialog.innerText(), /100/);
    assert.match(await dialog.innerText(), /40/);
    // A document-width check misses clipped portals. Exercise the actual modal,
    // long model IDs, three members, both entry points, and a short viewport.
    for (const [width, height] of [[1440, 1000], [768, 600], [390, 640]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const box = await dialog.boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, `Dialog outside viewport: ${JSON.stringify(box)}`);
      assert.equal(await dialog.evaluate(el => [el, ...el.querySelectorAll('*')].some(node => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1)), false, 'Dialog content overflows horizontally');
      const close = dialog.getByRole('button', { name: t['actions.close'], exact: true }).last();
      await close.scrollIntoViewIfNeeded();
      const closeBox = await close.boundingBox();
      assert.ok(closeBox && closeBox.y >= 0 && closeBox.y + closeBox.height <= height, 'Close button clipped');
      await dialog.getByRole('heading', { name: t['statistics.details'], exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(out, `${variant}-dialog-${width}.png`), animations: 'disabled' });
      const finalValue = dialog.locator('dd').last(); await finalValue.scrollIntoViewIfNeeded();
      const finalBox = await finalValue.boundingBox();
      assert.ok(finalBox && finalBox.y >= box.y && finalBox.y + finalBox.height <= box.y + box.height, 'Last member inaccessible');
    }
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await bar.getByRole('button', { name: t['statistics.details'], exact: true }).evaluate(el => el === document.activeElement), true);
    await memberStats.first().getByRole('button', { name: t['statistics.details'], exact: true }).click();
    await dialog.waitFor();
    const memberDialogBox = await dialog.boundingBox();
    assert.ok(memberDialogBox && memberDialogBox.x >= 0 && memberDialogBox.y >= 0 && memberDialogBox.x + memberDialogBox.width <= 390 && memberDialogBox.y + memberDialogBox.height <= 640);
    assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await page.screenshot({ path: join(out, `${variant}-member-dialog-390.png`), animations: 'disabled' });
    await dialog.getByRole('button', { name: t['actions.close'], exact: true }).last().click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await memberStats.first().getByRole('button', { name: t['statistics.details'], exact: true }).evaluate(el => el === document.activeElement), true);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, `${variant}-${width}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await capture('statistics');
    assert.equal(await bar.getAttribute('data-statistics-turn'), fixture.turnId);
    const height = (await bar.boundingBox()).height; assert.ok(height <= 40, `Desktop statistics wrapped: ${height}`);
    await page.reload(); await dismissFirstRunOverlays(page, () => {}, 'statistics-reload');
    await page.locator('[data-group-statistics-bar]').waitFor();
    if (mode === 'detailed') await page.locator('[data-group-token-total="160"]').waitFor();
    assert.equal(host.requests(), before);
    assert.deepEqual(errors, []);
    const warmRequests = host.requests();
    let coldRequests;
    if (language === 'en' && theme === 'light') {
      await browser.close(); browser = undefined; page = undefined;
      await host.stop(); stopped = true;
      host = await webHost(dir, `statistics-${language}`, undefined, resolve(root, 'packages/dsh-bot/tests/group-statistics-profile.mjs'));
      stopped = false;
      const originalTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
      try { browser = await chromium.launch({ executablePath: process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync), headless: true, env: host.env }); }
      finally { if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp; }
      page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' }); page.setDefaultTimeout(15000);
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await installOverlayHandler(page, () => {}); await page.goto(host.url); await dismissFirstRunOverlays(page, () => {}, 'statistics-cold');
      await openSidebarSession(page, fixture.rootId);
      await page.locator('[data-group-token-total="160"]').waitFor();
      coldRequests = host.requests(); assert.equal(coldRequests, 0, 'Cold reads replayed model work');
    }
    receipts.push({ language, theme, mode, ...fixture, screenshots: ['statistics', '1440', '768', '390', 'dialog-1440', 'dialog-768', 'dialog-390', 'member-dialog-390'].map(name => `${variant}-${name}.png`), errors, hostRequests: warmRequests, coldRequests });
    console.log(`Verified ${variant} statistics with ${warmRequests} scripted requests`);
  } catch (error) {
    if (page) { await writeFile(join(out, `${language}-failure.txt`), await page.locator('body').ariaSnapshot()); await page.screenshot({ path: join(out, `${language}-failure.png`) }); }
    throw error;
  } finally { await browser?.close(); if (!stopped) await host.stop(); }
}
await writeFile(join(out, process.env.DSH_BOT_STATS_COLD_ONLY === '1' ? 'cold-receipt.json' : 'receipt.json'), JSON.stringify(receipts, null, 2) + '\n');
