import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { webHost } from './b4-web-host.mjs';
import { openSidebarSession, openBotsPanel } from './sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../../packages/dsh-bot/scripts/screenshot-support.ts';
const args = process.argv.slice(2);
assert.equal(args.length, 3); assert.equal(args[0], '--suite'); assert.equal(args[2], '--mock-only');
assert.ok(['forget', 'root-warning', 'memory-list', 'memory-conflicts'].includes(args[1]));
const root = process.cwd(), home = resolve(root, '.dsh-dev'); assert.equal(process.env.DSH_HOME, home);
const dir = resolve(home, 'deepening', `b4-browser-${args[1]}-rework-${Date.now()}`);
await mkdir(dir, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
let browser, host, phase = 'host-setup';
const diagnostics = [];
const redact = text => text.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
const results = [], pageErrors = [];
const states = args[1] === 'forget' ? ['preview', 'stopped', 'strong'] : [args[1]];
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
      viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    let page;
    const id = `${language}-${theme}-${width}`;
    try {
      page = await context.newPage(); page.setDefaultTimeout(20000);
      page.on('pageerror', error => pageErrors.push(String(error)));
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await installOverlayHandler(page, () => {});
      await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'b4');
      // Start at full width to navigate the native sidebar, then exercise the actual narrow shell.
      await page.setViewportSize({ width: 1360, height: 1000 });
      await openSidebarSession(page, fixture.sessions[id]);
      await page.locator(`[data-conversation-content][data-conversation-session="${fixture.sessions[id]}"]:visible`).waitFor();
      await openBotsPanel(page, t['bots.title'], async failure => {
        const saved = { id, step: 'bots-panel', ...failure, error: redact(failure.error) };
        diagnostics.push(saved);
        try {
          await writeFile(resolve(dir, `${id}-panel-attempt-${failure.attempt}-aria.txt`), redact(await page.locator('body').ariaSnapshot()));
          await page.screenshot({ path: resolve(dir, `${id}-panel-attempt-${failure.attempt}.png`), fullPage: true, timeout: 5000 });
        } catch (error) { saved.captureError = redact(String(error)); }
      });
      const bots = page.locator('[data-bots-page]');
      await bots.getByRole('tab', { name: t['manage.title'], exact: true }).and(page.locator(':visible:enabled')).first().click();
      await bots.getByRole('tab', { name: t['manage.memoryTools'], exact: true }).click();
      for (const select of await bots.locator('select:visible').all())
        if (await select.locator(`option[value="${id}"]`).count()) await select.selectOption(id);
      await bots.getByText(`SYNTHETIC_BROWSER_TARGET_${id}`, { exact: true }).waitFor();
      await page.setViewportSize({ width, height: 1000 });
      const shot = async state => {
        const element = state.startsWith('memory-') ? bots.locator('[data-shared-memory-panel]:visible')
          : state === 'root-warning' ? bots.getByLabel(t['forget.rootTitle'])
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
      if (args[1].startsWith('memory-')) {
        await bots.getByRole('tab', { name: t['shared.scope.shared'], exact: true }).and(page.locator(':visible:enabled')).click();
        const managed = bots.locator('[data-shared-memory-panel]:visible');
        if (args[1] === 'memory-conflicts') {
          await managed.getByRole('tab', { name: t['shared.conflicts'], exact: true }).click();
          await managed.getByText('SYNTHETIC_CONFLICT_A', { exact: true }).first().waitFor();
        } else {
          await managed.getByText('SYNTHETIC_SHARED_STABLE', { exact: true }).waitFor();
          await managed.getByRole('button', { name: t['memory.edit'], exact: true }).first().click();
          const editor = managed.getByRole('textbox', { name: t['shared.content'], exact: true });
          await editor.fill('SYNTHETIC_UNSAVED_DRAFT');
          const row = managed.locator('[data-memory-id]').first();
          const handle = await row.elementHandle();
          for (let i = 0; i < 100; i++) {
            await managed.getByRole('button', { name: t['shared.refresh'], exact: true }).click();
          }
          assert.equal(await editor.inputValue(), 'SYNTHETIC_UNSAVED_DRAFT');
          assert.ok(await row.evaluate((element, previous) => element === previous, handle));
          await editor.focus(); assert.ok(await editor.evaluate(element => document.activeElement === element));
        }
        await shot(args[1]);
      } else if (args[1] === 'root-warning') await shot('root-warning');
      else {
        await bots.getByRole('button', { name: t['actions.delete'], exact: true }).click();
        await bots.getByRole('button', { name: t['forget.preview'], exact: true }).click();
        await bots.getByRole('button', { name: t['forget.clean'], exact: true }).waitFor();
        await shot('preview');
        await bots.getByRole('button', { name: t['forget.stop'], exact: true }).click();
        await bots.getByText(t['forget.stopped'], { exact: true }).waitFor(); await shot('stopped');
        await bots.getByRole('button', { name: t['forget.retry'], exact: true }).last().click();
        await bots.getByText(t['forget.stopped'], { exact: true }).waitFor({ state: 'hidden' });
        assert.equal(await bots.getByText(t['forget.strong'], { exact: true }).count(), 1);
        await shot('strong');
      }
    } catch (error) {
      // Capture before closing the failed context, including native blank-session/overlay state.
      const saved = { id, error: redact(String(error)), url: page ? redact(page.url()) : undefined };
      if (page && !page.isClosed()) {
        for (const [suffix, save] of [
          ['failure.png', () => page.screenshot({ path: resolve(dir, `${id}-failure.png`), fullPage: true, timeout: 5000 })],
          ['failure.html', async () => writeFile(resolve(dir, `${id}-failure.html`), redact(await page.content()))],
          ['failure-aria.txt', async () => writeFile(resolve(dir, `${id}-failure-aria.txt`), redact(await page.locator('body').ariaSnapshot()))],
        ]) {
          try { await save(); saved[suffix] = true; } catch (captureError) { saved[suffix] = String(captureError); }
        }
      }
      diagnostics.push(saved); throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'PASS', suite: args[1], results, matrix, diagnostics,
    realModelRequests: 0, cliFixtureReadyMs: host?.startupMs }));
  console.log(JSON.stringify({ status: 'PASS', dir, screenshots: results.length }));
} catch (error) {
  const environment = phase === 'browser-launch' || phase === 'host-setup' && ['EPERM', 'EACCES'].includes(error.code);
  const status = environment ? 'FAIL (environment)' : 'FAIL';
  for (const row of matrix.filter(row => row.status === 'FAIL')) row.reason = `${status}: ${phase}`;
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status, phase, matrix,
    error: redact(String(error)), stack: redact(error.stack ?? ''), results, pageErrors, diagnostics, cliFixtureReadyMs: host?.startupMs }));
  console.error(JSON.stringify({ status, phase, dir, error: String(error).split('\n')[0] })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
