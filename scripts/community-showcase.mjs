import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel, openSidebarSession, selectBotDirectoryAction } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const out = resolve(root, 'output/playwright/community-showcase'); await mkdir(out, { recursive: true });
const cache = join(homedir(), 'Library/Caches/ms-playwright');
const candidates = (await readdir(cache)).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .flatMap(n => ['arm64', 'x64'].map(a => join(cache, n, `chrome-headless-shell-mac-${a}`, 'chrome-headless-shell')));
const receipts = [];
for (const language of ['zh', 'en']) {
  const dir = resolve(root, `.dsh-dev/community-showcase/${language}-${Date.now()}`);
  const host = await webHost(dir, `showcase-${language}`, undefined, resolve(root, 'packages/dsh-bot/tests/community-showcase-profile.mjs'));
  let browser, page;
  try {
    const originalTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
    try { browser = await chromium.launch({ executablePath: process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync), headless: true, chromiumSandbox: true, env: host.env }); }
    finally { if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp; }
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
    await installOverlayHandler(page, () => {}); await page.goto(host.url); await dismissFirstRunOverlays(page, () => {}, 'showcase');
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`))).ui;
    const fixture = JSON.parse(await readFile(resolve(dir, 'showcase.json')));
    const capture = async name => {
      await page.setViewportSize({ width: 1440, height: ({ bots: 720, profile: 760, memory: 1160, group: 1160 })[name] ?? 1000 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, `${language}-${name}.png`), animations: 'disabled' });
      await writeFile(join(out, `${language}-${name}.txt`), await page.locator('body').ariaSnapshot());
    };
    await openBotsPanel(page, 'Bots'); const main = page.locator('[data-bots-page]');
    await main.locator('button[data-bot-id="research"]').waitFor(); await capture('bots');
    await selectBotDirectoryAction(main, 'research', t['chat.profile']);
    await main.getByRole('tab', { name: t['detail.overview'], exact: true }).click(); await capture('profile');
    await main.getByRole('tab', { name: t['detail.memory'], exact: true }).click();
    await main.getByText(language === 'zh' ? '回答先给结论，再列证据与来源。' : 'Start with the conclusion, then give evidence and sources.', { exact: true }).waitFor();
    await capture('memory');
    await main.getByRole('tab', { name: t['detail.work'], exact: true }).click();
    await main.getByText(language === 'zh' ? '整理调研提纲（演示）' : 'Prepare research outline (demo)', { exact: false }).waitFor();
    await capture('tasks');
    await openSidebarSession(page, fixture.mainId); await capture('conversation');
    await openSidebarSession(page, fixture.rootId);
    await page.setViewportSize({ width: 1440, height: 1160 });
    const turn = page.locator(`[data-group-turn="${fixture.turnId}"]`);
    await turn.locator(':scope > button[aria-expanded]').click();
    await page.locator('[data-group-member-process]').nth(1).waitFor();
    for (const row of await page.locator('[data-group-member-process] [data-disclosure-row]').all()) {
      if (await row.getAttribute('aria-expanded') === 'false') await row.click();
    }
    await capture('group');
    assert.deepEqual(errors, []);
    receipts.push({ language, ...fixture, screenshots: ['bots', 'profile', 'memory', 'tasks', 'conversation', 'group'], errors, hostRequests: host.requests() });
    console.log(`Captured ${language} showcase with ${host.requests()} scripted requests`);
  } catch (error) {
    if (page) { await writeFile(join(out, `${language}-failure.txt`), await page.locator('body').ariaSnapshot()); await page.screenshot({ path: join(out, `${language}-failure.png`) }); }
    throw error;
  } finally { await browser?.close(); await host.stop(); }
}
await writeFile(join(out, 'receipt.json'), JSON.stringify(receipts, null, 2) + '\n');
