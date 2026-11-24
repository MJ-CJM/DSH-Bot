import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
import { openBotsPanel, selectBotDirectoryAction } from './deepening/sidebar-session.mjs';
export async function verifyContinuousBrowser(host, dir) {
  const root = process.cwd(), require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
  const { chromium } = require('playwright-core'), cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const executablePath = (await readdir(cache)).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
    .flatMap(n => ['arm64', 'x64'].map(a => resolve(cache, n, `chrome-headless-shell-mac-${a}`, 'chrome-headless-shell'))).find(existsSync);
  assert.ok(executablePath); const oldTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  let browser; try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env }); }
  finally { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; }
  const errors = [], results = []; let page;
  try {
    for (const [theme, language] of [['light', 'zh'], ['dark', 'en']]) {
      const context = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', colorScheme: theme, viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
      page = await context.newPage(); page.setDefaultTimeout(20000);
      page.on('pageerror', e => errors.push(String(e))); const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`))).ui;
      await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
      await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, `continuous-${theme}`);
      await openBotsPanel(page, t['bots.title']);
      const bots = page.locator('[data-bots-page]:visible');
      await bots.getByRole('navigation', { name: t['navigation.sections'], exact: true }).getByRole('button', { name: t['navigation.myBots'], exact: true }).click();
      await bots.getByLabel(t['navigation.searchBots'], { exact: true }).fill('Continuous fixture');
      await selectBotDirectoryAction(bots, 'continuous-fixture', t['chat.profile']);
      const detail = page.locator('[data-bot-detail="continuous-fixture"]:visible');
      await detail.getByRole('tab', { name: t['detail.memory'], exact: true }).click();
      const panel = detail.locator('[data-memory-consolidation]'); await panel.locator(':scope > summary').click();
      await panel.getByRole('button', { name: t['memory.consolidation.generate'], exact: true }).waitFor();
      if (theme === 'light') {
        await panel.getByRole('checkbox').first().check();
        await panel.getByLabel(t['memory.consolidation.provider'], { exact: true }).fill('dp-loopback');
        await panel.getByLabel(t['memory.consolidation.model'], { exact: true }).fill('fixture');
        await panel.getByRole('button', { name: t['memory.consolidation.generate'], exact: true }).click();
        const candidate = panel.locator('[data-consolidation-state="proposed"]'); await candidate.waitFor();
        assert.match(await candidate.getByRole('textbox').inputValue(), /7320/);
        await candidate.getByRole('button', { name: t['memory.consolidation.accept'], exact: true }).click();
      }
      await panel.locator('[data-consolidation-state="accepted"]').waitFor();
      assert.equal(await panel.locator('[data-consolidation-state="proposed"]').count(), 0);
      await page.screenshot({ path: resolve(dir, `continuous-${theme}-${language}.png`), fullPage: true });
      results.push({ theme, language, status: 'PASS' }); await context.close();
    }
    assert.deepEqual(errors, []); await writeFile(resolve(dir, 'browser.json'), JSON.stringify({ status: 'PASS', results, errors, realModelRequests: 0 }, null, 2));
  } catch (e) { await page?.screenshot({ path: resolve(dir, 'browser-failure.png'), fullPage: true }).catch(() => {}); throw e; }
  finally { await browser.close(); }
}
