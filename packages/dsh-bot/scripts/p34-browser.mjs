import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { dismissFirstRunOverlays, installOverlayHandler } from './screenshot-support.ts';
export async function captureP34(url, outputDir, env) {
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  let executablePath;
  for (const release of readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()) {
    for (const arch of ['arm64','x64']) {
      const candidate = resolve(cache, release, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell');
      if (existsSync(candidate)) { executablePath = candidate; break; }
    }
    if (executablePath) break;
  }
  if (!executablePath) throw new Error('No cached browser; no download attempted');
  const temporaryRoot = resolve(outputDir, 'browser-tmp'); await mkdir(temporaryRoot, { recursive: true });
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = temporaryRoot;
  let browser;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: { ...env, TMPDIR: temporaryRoot }, timeout: 30000 }); }
  finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
  const shots = [], errors = [];
  try {
    for (const theme of ['light','dark']) {
      const context = await browser.newContext({ colorScheme: theme, locale: 'en-US', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
      const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message));
      await installOverlayHandler(page, () => {}); await page.goto(url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'p34-first-open');
      await page.getByRole('button', { name: 'Bots', exact: true }).click();
      const bots = page.locator('[data-bots-page]');
      await bots.getByRole('tab', { name: 'Management', exact: true }).first().click();
      await bots.getByRole('tab', { name: 'Connectors', exact: true }).click();
      await bots.getByText('Credential reference', { exact: true }).waitFor();
      await page.screenshot({ path: resolve(outputDir, `${theme}-connectors.png`), fullPage: true }); shots.push(`${theme}-connectors.png`);
      await bots.getByRole('tab', { name: /Notifications/ }).click();
      await bots.getByText('P34_PRODUCT_REPORT', { exact: true }).waitFor();
      await bots.getByText('System notifications: current host unsupported', { exact: true }).waitFor();
      await page.screenshot({ path: resolve(outputDir, `${theme}-notifications.png`), fullPage: true }); shots.push(`${theme}-notifications.png`);
      await context.close();
    }
    assert.deepEqual(errors, []); return { status: 'PASS', shots, themes: ['light','dark'], language: 'en', errors };
  } finally { await browser.close(); }
}
