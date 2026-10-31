import en from '../locale/en.json' with { type: 'json' };
import zh from '../locale/zh.json' with { type: 'json' };
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { dismissFirstRunOverlays, installOverlayHandler } from './screenshot-support.ts';
export async function captureGroups(url, outputDir, env) {
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
    for (const language of ['zh','en']) for (const theme of ['light','dark']) {
      const t = (language === 'zh' ? zh : en).ui;
      const context = await browser.newContext({ colorScheme: theme, locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
      const page = await context.newPage(); await installOverlayHandler(page,() => {}); await page.goto(url,{waitUntil:'domcontentloaded'}); await dismissFirstRunOverlays(page,() => {},'group-first');
      await page.getByRole('button',{name:'Bots',exact:true}).click(); const bots = page.locator('[data-bots-page]');
      await bots.getByRole('tab',{name:t['groups.title'],exact:true}).click();
      const group = bots.getByRole('article',{name:'Synthetic whale group'}); await group.waitFor();
      await group.getByText('P34_GROUP_FAKE_REPLY',{exact:true}).first().waitFor();
      const draft = group.getByRole('textbox',{name:t['groups.message'],exact:true}); await draft.fill('Browser draft retained'); await draft.focus();
      const timeline = group.getByRole('log'); await timeline.evaluate(el => { el.scrollTop = 10; });
      await bots.getByRole('button',{name:t['bots.refresh'],exact:true}).click();
      assert.equal(await draft.inputValue(),'Browser draft retained');
      await page.screenshot({path:resolve(outputDir,`v030-${language}-${theme}-G01.png`),fullPage:true}); shots.push(`v030-${language}-${theme}-G01.png`);
      await draft.press('@'); const picker = group.getByRole('group',{name:t['groups.targets']}); await picker.waitFor();
      await picker.getByRole('checkbox').first().check(); await picker.getByRole('button',{name:t['groups.close'],exact:true}).click();
      await draft.fill('P34_GROUP_ONLY browser mention'); await group.getByRole('button',{name:t['groups.send'],exact:true}).click();
      await group.getByText(t['groups.completed'],{exact:true}).first().waitFor();
      await group.getByRole('button',{name:t['groups.edit'],exact:true}).click();
      const editor = group.getByRole('form',{name:t['groups.edit']}); await editor.waitFor();
      await page.screenshot({path:resolve(outputDir,`v030-${language}-${theme}-G02.png`),fullPage:true}); shots.push(`v030-${language}-${theme}-G02.png`);
      await editor.getByRole('button',{name:t['groups.close'],exact:true}).click();
      await page.screenshot({path:resolve(outputDir,`v030-${language}-${theme}-G03.png`),fullPage:true}); shots.push(`v030-${language}-${theme}-G03.png`);
      await page.setViewportSize({width:390,height:844}); assert.ok(await group.isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await context.close();
    }
    return {status:'PASS',shots,languages:['zh','en'],themes:['light','dark'],narrow:true};
  } finally { await browser.close(); }
}
