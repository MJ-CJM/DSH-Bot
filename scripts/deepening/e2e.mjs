import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
const args = process.argv.slice(2);
assert.equal(args.length, 3); assert.equal(args[0], '--suite'); assert.equal(args[2], '--mock-only');
assert.ok(['forget', 'root-warning'].includes(args[1]));
const root = process.cwd(), home = resolve(root, '.dsh-dev'); assert.equal(process.env.DSH_HOME, home);
const dir = resolve(home, 'deepening', `b4-browser-${args[1]}-${Date.now()}`);
await mkdir(dir, { recursive: true });
process.env.TMPDIR = dir;
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core'), { build } = require('esbuild');
let browser, server, launched = false;
const results = [];
try {
  await build({ entryPoints: [resolve(root, 'packages/dsh-bot/tests/deepening/b4-browser.tsx')],
    outfile: resolve(dir, 'client.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
    loader: { '.css': 'local-css' }, plugins: [{ name: 'inline-css', setup(b) {
      b.onResolve({ filter: /\.css\?inline$/ }, a => ({ path: resolve(a.resolveDir, a.path.slice(0, -7)), namespace: 'inline' }));
      b.onLoad({ filter: /.*/, namespace: 'inline' }, async a => ({ contents: `export default ${JSON.stringify(await readFile(a.path, 'utf8'))}`,
        loader: 'js' }));
    } }] });
  const executablePath = process.env.DSH_BOT_CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'],
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir } }); launched = true;
  server = createServer(async (req, res) => {
    const path = req.url?.split('?')[0];
    if (path === '/client.js' || path === '/client.css') {
      res.setHeader('content-type', path.endsWith('.js') ? 'application/javascript' : 'text/css');
      res.end(await readFile(resolve(dir, path.slice(1))));
    } else res.end('<!doctype html><html><head><link rel="stylesheet" href="/client.css"></head>'
      + '<body><div id="root"></div><script src="/client.js"></script></body></html>');
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  for (const lang of ['en', 'zh']) for (const theme of ['light', 'dark']) for (const width of [1200, 420]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/?lang=${lang}`);
    await page.waitForFunction(() => !!window.b4);
    const d = await page.evaluate(() => window.b4.dictionary);
    assert.equal(await page.getByLabel(d['forget.rootTitle']).count(), 1);
    await page.getByRole('button', { name: d['memory.add'], exact: true }).click();
    const textbox = page.locator('textarea').first(); await textbox.fill('PRESERVED_DRAFT'); await textbox.focus();
    const identity = await textbox.elementHandle();
    await page.evaluate(() => { for (let n = 0; n < 100; n++) window.b4.refresh(); });
    assert.equal(await textbox.inputValue(), 'PRESERVED_DRAFT');
    assert.equal(await identity.evaluate(el => el === document.activeElement), true);
    await page.getByRole('button', { name: d['actions.cancel'], exact: true }).click();
    await page.getByRole('button', { name: d['actions.delete'], exact: true }).click();
    await page.getByRole('button', { name: d['actions.cancel'], exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.b4.fixture.calls), []);
    await page.getByRole('button', { name: d['actions.delete'], exact: true }).click();
    await page.getByRole('button', { name: d['forget.preview'], exact: true }).click();
    await page.evaluate(() => { window.b4.fixture.fail = true; });
    await page.getByRole('button', { name: d['forget.clean'], exact: true }).click();
    await page.getByRole('alert').waitFor();
    await page.evaluate(() => { window.b4.fixture.fail = false; });
    await page.getByRole('button', { name: d['forget.preview'], exact: true }).click();
    await page.getByRole('button', { name: d['forget.stop'], exact: true }).click();
    await page.getByText(d['forget.stopped'], { exact: true }).waitFor();
    assert.equal(await page.getByText(d['forget.strong'], { exact: true }).count(), 0);
    await page.screenshot({ path: resolve(dir, `${lang}-${theme}-${width}-stopped.png`), fullPage: true });
    await page.evaluate(() => window.b4.complete());
    await page.getByText(d['forget.strong'], { exact: true }).waitFor();
    await page.evaluate(() => window.b4.dispose()); await page.close();
    results.push({ lang, theme, width, status: 'PASS', refreshes: 100, mockOnly: true });
  }
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'PASS', suite: args[1], results, realModelRequests: 0 }));
  console.log(JSON.stringify({ status: 'PASS', dir, variants: results.length }));
} catch (error) {
  const status = launched ? 'FAIL' : 'FAIL (environment)';
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status, error: String(error), stack: error.stack, results }));
  console.error(JSON.stringify({ status, dir, error: String(error) })); process.exitCode = 1;
} finally {
  await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
}
