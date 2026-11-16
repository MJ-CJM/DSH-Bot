import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

export async function verifyOpenmausBrowser(host, { root, clientBytes }) {
  const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
  const { chromium } = require('playwright-core');
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const executablePath = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync);
  assert.ok(executablePath, 'Preinstalled Chromium required');
  const originalTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  let browser;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env }); }
  finally { if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp; }
  const errors = [], checks = [], results = [];
  const receipt = JSON.parse(await readFile(resolve(host.dir, 'openmaus-host.json')));
  let currentPage;
  try {
    for (const [theme, language] of [['light', 'zh'], ['dark', 'en']]) {
      const context = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', colorScheme: theme,
        viewport: { width: 1440, height: 1050 }, acceptDownloads: true, reducedMotion: 'reduce' });
      const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(30000);
      const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`))).ui;
      const bodies = [];
      page.on('pageerror', error => errors.push(String(error.stack ?? error)));
      page.on('response', response => { if (new URL(response.url()).pathname === '/plugins/' && /javascript/.test(response.headers()['content-type'] ?? ''))
        void response.text().then(body => bodies.push(body)).catch(() => {}); });
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, `openmaus-${theme}`);
      const phaseResults = {};
      for (const [name, module, field] of [
        ['recipesRouting', './openmaus-recipes-browser.mjs', 'recipesRouting'],
        ['followupMemory', './openmaus-followup-browser.mjs', 'followupMemory'],
        ['materialsResume', './openmaus-p0-browser.mjs', 'materialsResume'],
      ]) {
        console.log(`OPENMAUS_BROWSER_PHASE ${theme}:${name}`);
        const { verifyPage } = await import(module);
        phaseResults[name] = await verifyPage({ page, t, hostReceipt: receipt.results[field], outputDir: host.dir, checks, theme, language });
        assert.ok(!phaseResults[name]?.status || phaseResults[name].status === 'PASS');
      }
      const provenance = JSON.parse(await readFile(resolve(host.dir, 'client-provenance.json')));
      for (const [id, resource] of Object.entries(provenance)) {
        const bytes = await clientBytes(resource.path);
        const expected = bytes.toString().trimEnd().replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*$/u, '').trimEnd();
        const deadline = Date.now() + 20000;
        while (!bodies.some(body => body.includes(expected))) { assert.ok(Date.now() < deadline, `Actual HTTP Client missing: ${id}`); await delay(50); }
        checks.push(`${theme}: actual HTTP Client bytes match ${id}`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No document overflow');
      await page.screenshot({ path: resolve(host.dir, `openmaus-${theme}-final.png`), fullPage: true });
      results.push({ theme, language, status: 'PASS', phases: phaseResults });
      await context.close();
    }
    assert.deepEqual(errors, []);
    const result = { status: 'PASS', checks, results, errors, realModelRequests: 0 };
    await writeFile(resolve(host.dir, 'openmaus-browser.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    await currentPage?.screenshot({ path: resolve(host.dir, 'openmaus-browser-failure.png'), fullPage: true }).catch(() => {});
    await currentPage?.content().then(html => writeFile(resolve(host.dir, 'openmaus-browser-failure.html'), html)).catch(() => {});
    await writeFile(resolve(host.dir, 'openmaus-browser.json'), JSON.stringify({ status: 'FAIL', checks, results, errors, error: String(error.stack), realModelRequests: 0 }, null, 2));
    throw error;
  } finally { await browser.close(); }
}
