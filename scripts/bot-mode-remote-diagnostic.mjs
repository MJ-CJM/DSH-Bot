import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = process.cwd(), service = JSON.parse(await readFile(resolve('.dsh-dev/bot-mode-validation-a/service.json'), 'utf8'));
const out = resolve('.dsh-dev/bot-mode-remote-diagnostic', `${Date.now()}-${process.pid}`); await mkdir(out, { recursive: true });
const require = createRequire(resolve('packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
const executablePath = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
  .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync);
if (!executablePath) throw new Error('No cached Chromium');
const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
const page = await browser.newPage(), errors = []; let instrumented = 0;
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
page.on('pageerror', error => errors.push(redact(error.stack ?? error)));
page.on('console', message => { if (message.type() === 'error') errors.push(redact(message.text())); });
await page.addInitScript(() => { window.__b03RemoteDiagnostic = []; });
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.hostname !== '127.0.0.1') return route.abort();
  if (!url.pathname.includes('plugins/') || !url.search.includes('dsh-bot/client.js')) return route.continue();
  const response = await route.fetch(), body = await response.text();
  const start = body.indexOf('id: "dsh-bot", factory(require)'), end = body.indexOf('return module.exports;', start);
  if (start < 0 || end < start) return route.fulfill({ response });
  let factory = body.slice(start, end);
  factory = factory.replace('await ctx.effect(async () => await ctx.remote.$mount(SUPERGROUP_REMOTE), "dsh-bot: Supergroup Remote");', `
    window.__b03RemoteDiagnostic.push({ phase: 'mount-start', methods: SUPERGROUP_REMOTE.descriptors.map(row => row.namespace + '/' + row.method) });
    await ctx.effect(async () => await ctx.remote.$mount(SUPERGROUP_REMOTE), "dsh-bot: Supergroup Remote");
    window.__b03RemoteDiagnostic.push({ phase: 'mount-done' });
    const diagnosticRemote = ctx.get('remote.dshBotSupergroup');
    const diagnosticSettings = await diagnosticRemote.settings();
    window.__b03RemoteDiagnostic.push({ phase: 'settings-result', result: diagnosticSettings });
  `);
  factory = factory.replace('await registerSupergroup(ctx, groups, catalog, executionBridge,', `window.__b03RemoteDiagnostic.push({ phase: 'register-supergroup-start' });\n  await registerSupergroup(ctx, groups, catalog, executionBridge,`);
  const wrapper = `
const diagnosticOriginal = module.exports;
return { ...diagnosticOriginal, async apply(ctx, options) {
  window.__b03RemoteDiagnostic.push({ phase: 'apply-start' });
  setTimeout(async () => {
    const service = ctx.get('remote.dshBotSupergroup');
    window.__b03RemoteDiagnostic.push({ phase: 'timer-namespace', exists: Boolean(service) });
    if (service) try { window.__b03RemoteDiagnostic.push({ phase: 'timer-settings', result: await service.settings() }); }
    catch (error) { window.__b03RemoteDiagnostic.push({ phase: 'timer-settings-error', error: String(error), stack: error.stack }); }
  }, 5000);
  try { await diagnosticOriginal.apply(ctx, options); window.__b03RemoteDiagnostic.push({ phase: 'apply-done' }); }
  catch(error) { window.__b03RemoteDiagnostic.push({ phase: 'apply-error', error: String(error), stack: error.stack }); throw error; }
} };
`;
  instrumented++;
  return route.fulfill({ response, body: body.slice(0, start) + factory + wrapper + body.slice(end + 'return module.exports;'.length) });
});
try {
  await page.goto(service.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__b03RemoteDiagnostic?.some(row => row.phase === 'apply-done' || row.phase === 'apply-error'), { timeout: 18000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const records = await page.evaluate(() => window.__b03RemoteDiagnostic);
  const result = { instrumented, records, errors, bodyStart: (await page.locator('body').innerText()).slice(0, 1500) };
  await writeFile(resolve(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ dir: out, ...result }));
} finally { await browser.close(); }
