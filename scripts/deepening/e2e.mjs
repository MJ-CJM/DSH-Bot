import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { webHost } from './b4-web-host.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../../packages/dsh-bot/scripts/screenshot-support.ts';
const args = process.argv.slice(2);
assert.equal(args.length, 3); assert.equal(args[0], '--suite'); assert.equal(args[2], '--mock-only');
assert.ok(['forget', 'root-warning'].includes(args[1]));
const root = process.cwd(), home = resolve(root, '.dsh-dev'); assert.equal(process.env.DSH_HOME, home);
const dir = resolve(home, 'deepening', `b4-browser-${args[1]}-rework-${Date.now()}`);
await mkdir(dir, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
let browser, host, phase = 'host-setup';
const results = [], pageErrors = [];
const states = args[1] === 'forget' ? ['preview', 'stopped', 'strong'] : ['root-warning'];
const matrix = ['en', 'zh'].flatMap(language => ['light', 'dark'].flatMap(theme => [1360, 390].flatMap(width =>
  states.map(state => ({ language, theme, width, state, status: 'FAIL', reason: 'NOT_RUN' })))));
try {
  host = await webHost(dir, args[1]);
  phase = 'browser-launch';
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const releases = await readdir(cache).catch(() => []);
  const candidates = releases.filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
    .flatMap(n => ['arm64', 'x64'].map(arch => resolve(cache, n, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell')));
  const executablePath = process.env.DSH_BOT_CHROMIUM ?? candidates.find(p => require('node:fs').existsSync(p))
    ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env, timeout: 30000 }); }
  finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
  phase = 'capture';
  const fixture = JSON.parse(await readFile(resolve(dir, 'web-fixture.json')));
  for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) for (const width of [1360, 390]) {
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`))).ui;
    const context = await browser.newContext({ colorScheme: theme, locale: language === 'en' ? 'en-US' : 'zh-CN',
      viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(20000);
      page.on('pageerror', error => pageErrors.push(String(error)));
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await installOverlayHandler(page, () => {});
      await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'b4');
      const id = `${language}-${theme}-${width}`;
      // Start at full width to navigate the native sidebar, then exercise the actual narrow shell.
      await page.setViewportSize({ width: 1360, height: 1000 });
      await page.locator(`[role="treeitem"][data-row-key="session:${fixture.sessions[id]}"]`).click();
      await page.getByRole('button', { name: 'Bots', exact: true }).click();
      const bots = page.locator('[data-bots-page]');
      await bots.getByRole('tab', { name: t['manage.title'], exact: true }).first().click();
      await bots.getByRole('tab', { name: t['manage.memoryTools'], exact: true }).click();
      for (const select of await bots.locator('select:visible').all())
        if (await select.locator(`option[value="${id}"]`).count()) await select.selectOption(id);
      await bots.getByText(`SYNTHETIC_BROWSER_TARGET_${id}`, { exact: true }).waitFor();
      await page.setViewportSize({ width, height: 1000 });
      const shot = async state => {
        const element = state === 'root-warning' ? bots.getByLabel(t['forget.rootTitle'])
          : state === 'preview' ? bots.getByRole('group', { name: t['forget.title'], exact: true }) : bots.getByRole('status').last();
        await element.scrollIntoViewIfNeeded();
        const colors = await bots.evaluate(el => {
          const style = getComputedStyle(el);
          return { background: style.backgroundColor, color: style.color };
        });
        const channels = colors.background.match(/[\d.]+/g)?.slice(0, 3).map(Number);
        assert.ok(channels?.length === 3, 'DSH page must have an opaque themed background');
        if (theme === 'dark') assert.ok(channels.reduce((a, b) => a + b, 0) < 384, 'Dark must be visibly dark');
        else assert.ok(channels.reduce((a, b) => a + b, 0) > 384, 'Light must be visibly light');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Viewport overflow');
        const file = `${id}-${state}.png`;
        await page.screenshot({ path: resolve(dir, file), fullPage: true });
        const result = { language, theme, width, state, status: 'PASS', file, colors, realDshClient: true };
        results.push(result);
        Object.assign(matrix.find(row => row.language === language && row.theme === theme && row.width === width &&
          row.state === state), result, { reason: undefined });
      };
      if (args[1] === 'root-warning') await shot('root-warning');
      else {
        await bots.getByRole('button', { name: t['actions.delete'], exact: true }).click();
        await bots.getByRole('button', { name: t['forget.preview'], exact: true }).click();
        await bots.getByRole('button', { name: t['forget.clean'], exact: true }).waitFor();
        await shot('preview');
        await bots.getByRole('button', { name: t['forget.stop'], exact: true }).click();
        await bots.getByText(t['forget.stopped'], { exact: true }).waitFor(); await shot('stopped');
        const completed = await bots.getByText(t['forget.strong'], { exact: true }).count();
        await bots.getByRole('button', { name: t['forget.retry'], exact: true }).last().click();
        await bots.getByText(t['forget.strong'], { exact: true }).nth(completed).waitFor(); await shot('strong');
      }
    } finally { await context.close(); }
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'PASS', suite: args[1], results, matrix, realModelRequests: 0 }));
  console.log(JSON.stringify({ status: 'PASS', dir, screenshots: results.length }));
} catch (error) {
  const status = phase === 'browser-launch' ? 'FAIL (environment)' : 'FAIL';
  for (const row of matrix.filter(row => row.status === 'FAIL')) row.reason = `${status}: ${phase}`;
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status, phase, matrix, error: String(error), stack: error.stack, results, pageErrors }));
  console.error(JSON.stringify({ status, phase, dir, error: String(error).split('\n')[0] })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
