import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { dismissFirstRunOverlays, installOverlayHandler } from './screenshot-support.ts';
export async function captureCollaboration(url, outputDir, env) {
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright'); let executablePath;
  for (const release of readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()) {
    for (const arch of ['arm64','x64']) { const candidate = resolve(cache,release,`chrome-headless-shell-mac-${arch}`,'chrome-headless-shell'); if (existsSync(candidate)) { executablePath = candidate; break; } }
    if (executablePath) break;
  }
  if (!executablePath) throw new Error('No cached browser; no download attempted');
  const temporaryRoot = resolve(outputDir,'browser-tmp'); await mkdir(temporaryRoot,{recursive:true});
  const previous = process.env.TMPDIR; process.env.TMPDIR = temporaryRoot; let browser;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: { ...env, TMPDIR: temporaryRoot }, timeout: 30000 }); }
  finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  const shots = [];
  try {
    for (const theme of ['light','dark']) {
      const context = await browser.newContext({ colorScheme: theme, locale: 'en-US', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
      const page = await context.newPage(); await installOverlayHandler(page,() => {}); await page.goto(url,{waitUntil:'domcontentloaded'}); await dismissFirstRunOverlays(page,() => {},'collaboration-first');
      await page.getByRole('button',{name:'Bots',exact:true}).click(); const bots = page.locator('[data-bots-page]');
      await bots.getByRole('tab',{name:'Collaboration',exact:true}).click();
      await bots.getByText(/CAS blocker/).waitFor();
      await page.screenshot({path:resolve(outputDir,`${theme}-team-board.png`),fullPage:true}); shots.push(`${theme}-team-board.png`);
      await bots.getByRole('tab',{name:'IM channels',exact:true}).click();
      assert.equal(await bots.getByRole('button',{name:'Bind channel (unsupported)',exact:true}).isDisabled(),true);
      await page.screenshot({path:resolve(outputDir,`${theme}-im-gated.png`),fullPage:true}); shots.push(`${theme}-im-gated.png`); await context.close();
    }
    return {status:'PASS',shots,language:'en',themes:['light','dark']};
  } finally { await browser.close(); }
}
