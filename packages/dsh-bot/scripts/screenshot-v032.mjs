// Actual installed native Chat/Client; isolated synthetic Host supplied by the release runner.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { dismissFirstRunOverlays, installOverlayHandler } from './screenshot-support.ts';
export async function captureV032(url, workDir) {
  const outputDir = resolve('docs/screenshots/v032', `${Date.now()}-${process.pid}`);
  await mkdir(outputDir, { recursive: true });
  const matrix = ['en', 'zh'].flatMap(language => ['light', 'dark'].flatMap(theme => ['alpha', 'beta'].map(bot => ({ language, theme, bot, status: 'FAIL', reason: 'NOT_RUN' }))));
  const result = { status: 'FAIL', fixtureStatus: 'PASS', outputDir, matrix, narrow: matrix.map(row => ({ ...row })), errors: [] };
  let browser;
  const originalTmp = process.env.TMPDIR;
  const browserTmp = resolve(workDir, 'browser-tmp'); await mkdir(browserTmp, { recursive: true });
  process.env.TMPDIR = browserTmp;
  try {
    const candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
    if (existsSync(cache)) for (const entry of readdirSync(cache).filter(v => v.startsWith('chromium-')).sort().reverse())
      candidates.push(resolve(cache, entry, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
    const executablePath = candidates.find(existsSync); assert.ok(executablePath, 'Chromium unavailable');
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
    const identity = JSON.parse(await readFile(resolve(workDir, 'identity.json')));
    const ids = identity.mains.map(m => m.sessionId);
    for (const row of matrix) {
      const context = await browser.newContext({ colorScheme: row.theme, locale: row.language === 'en' ? 'en-US' : 'zh-CN', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        page.on('pageerror', e => result.errors.push(String(e)));
        await installOverlayHandler(page, () => {});
        await page.goto(url, { waitUntil: 'domcontentloaded' }); await dismissFirstRunOverlays(page, () => {}, 'v032');
        const id = identity.mains[row.bot === 'alpha' ? 0 : 1].sessionId;
        await page.locator(`[role="treeitem"][data-row-key="session:${id}"]`).click();
        await page.locator(`[data-conversation-content][data-conversation-session="${id}"]`).waitFor();
        const visible = await page.locator('[role="treeitem"][data-row-key^="session:"]:visible').evaluateAll(els => els.map(el => ({ id: el.getAttribute('data-row-key').slice(8), text: el.textContent })));
        assert.deepEqual(visible.map(r=>r.id).sort(), [...ids].sort()); assert.ok(visible.every(r=>!/(New Session|新会话)/.test(r.text)));
        const cards = page.locator('[data-bot-message]'); await cards.first().waitFor();
        const summary = cards.first().getByRole('button'); await summary.focus();
        assert.equal(await summary.getAttribute('aria-expanded'), 'false');
        await page.keyboard.press('Enter'); assert.equal(await summary.getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Enter'); assert.equal(await summary.getAttribute('aria-expanded'), 'false');
        assert.ok(await cards.locator('[data-bot-avatar="whale"]').count());
        assert.ok(await cards.filter({ has: page.locator('[data-message-direction="received"]') }).count() || await page.locator('[data-message-direction="received"]').count());
        if (row.bot === 'alpha') assert.ok(await page.locator('[data-message-direction="sent"]').count());
        await page.screenshot({ path: resolve(outputDir, `${row.language}-${row.theme}-${row.bot}.png`), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        assert.equal(overflow, false);
        await page.screenshot({ path: resolve(outputDir, `${row.language}-${row.theme}-${row.bot}-narrow.png`), fullPage: true });
        const narrow = result.narrow.find(r => r.language === row.language && r.theme === row.theme && r.bot === row.bot);
        Object.assign(narrow, { status: 'PASS', reason: undefined }); row.status = 'PASS'; delete row.reason;
      } finally { await context.close(); }
    }
    assert.equal(result.errors.length, 0); result.status = 'PASS';
  } catch(e) { result.failure = String(e).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]'); result.environment = /Permission denied|bootstrap|MachPort|sandbox|launch|Chromium unavailable/.test(String(e));
    for (const row of [...result.matrix, ...result.narrow]) if (row.status !== 'PASS') row.reason = result.environment ? 'Chromium launch failed (environment)' : 'NOT_RUN after browser failure'; }
  finally { if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp; await browser?.close(); await writeFile(resolve(outputDir, 'result.json'), JSON.stringify(result, null, 2)); await writeFile(resolve(workDir, 'screenshots.json'), JSON.stringify(result, null, 2)); }
  return result;
}
if (process.argv.includes('--v032')) {
  process.argv[2] = 'release'; process.env.B2B_SCREENSHOTS = '1';
  await import('../../../scripts/b2b-runtime.mjs');
}
