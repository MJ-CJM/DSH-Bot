import en from '../locale/en.json' with { type: 'json' };
import zh from '../locale/zh.json' with { type: 'json' };
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { dismissFirstRunOverlays, installOverlayHandler } from './screenshot-support.ts';
export async function captureManagement(url, outputDir, env) {
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  let executablePath;
  for (const release of readdirSync(cache)
    .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
    .sort()
    .reverse()) {
    for (const arch of ['arm64', 'x64']) {
      const candidate = resolve(cache, release, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell');
      if (existsSync(candidate)) {
        executablePath = candidate;
        break;
      }
    }
    if (executablePath) break;
  }
  if (!executablePath) throw new Error('No cached browser; no download attempted');
  const temporaryRoot = resolve(outputDir, 'browser-tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporaryRoot;
  let browser;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      chromiumSandbox: true,
      env: { ...env, TMPDIR: temporaryRoot },
      timeout: 30000,
    });
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
  const shots = [];
  try {
    for (const language of ['zh', 'en'])
      for (const theme of ['light', 'dark']) {
        const t = (language === 'zh' ? zh : en).ui;
        const context = await browser.newContext({
          colorScheme: theme,
          locale: language === 'zh' ? 'zh-CN' : 'en-US',
          viewport: { width: 1360, height: 1000 },
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        await installOverlayHandler(page, () => {});
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await dismissFirstRunOverlays(page, () => {}, 'management-first');
        await page.getByRole('button', { name: 'Bots', exact: true }).click();
        const bots = page.locator('[data-bots-page]');
        await bots.getByRole('tab', { name: t['manage.title'], exact: true }).click();
        const management = bots.getByRole('region', {
          name: t['manage.memoryTools'],
          exact: true,
        });
        await management.getByRole('tab', { name: t['manage.graph'], exact: true }).click();
        await management.getByRole('button', { name: t['graph.read'], exact: true }).click();
        await management.getByText('Alpha likes oolong tea', { exact: false }).first().waitFor();
        await page.screenshot({
          path: resolve(outputDir, `u09-${language}-${theme}-graph.png`),
          fullPage: true,
        });
        shots.push(`u09-${language}-${theme}-graph.png`);
        await management.getByRole('tab', { name: t['manage.transfer'], exact: true }).click();
        const draft = management.getByRole('textbox', {
          name: t['manage.document'],
          exact: true,
        });
        await draft.fill('Keep this draft during polling');
        await draft.focus();
        await bots.locator('header').first().getByRole('button', { name: t['bots.refresh'], exact: true }).click();
        assert.equal(await draft.inputValue(), 'Keep this draft during polling');
        await page.screenshot({
          path: resolve(outputDir, `u09-${language}-${theme}-transfer.png`),
          fullPage: true,
        });
        shots.push(`u09-${language}-${theme}-transfer.png`);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await management.isVisible());
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        await page.screenshot({
          path: resolve(outputDir, `u09-${language}-${theme}-narrow.png`),
          fullPage: true,
        });
        shots.push(`u09-${language}-${theme}-narrow.png`);
        await context.close();
      }
    return {
      status: 'PASS',
      shots,
      languages: ['zh', 'en'],
      themes: ['light', 'dark'],
      narrow: true,
    };
  } finally {
    await browser.close();
  }
}
