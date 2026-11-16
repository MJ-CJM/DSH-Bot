import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

const root = process.cwd();
const base = resolve(root, process.env.DSH_BOT_APPROVAL_DIR ?? '.dsh-dev/bot-mode-approval');
assert.ok(base.startsWith(`${root}/.dsh-dev/`));
const out = resolve(root, process.env.DSH_BOT_SMOKE_OUT ?? `.dsh-dev/bot-mode-delivery/smoke-${Date.now()}-${process.pid}`);
assert.ok(out.startsWith(`${root}/.dsh-dev/`));
await mkdir(out, { recursive: true });
process.env.TMPDIR = resolve(base, 'tmp');
await mkdir(process.env.TMPDIR, { recursive: true });
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const state = await json(resolve(base, 'service.json'));
const resources = await json(resolve(base, 'client-provenance.json'));
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
const executablePath = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
  .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync);
assert.ok(executablePath, 'Cached Chromium required');
const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
try {
  const context = await browser.newContext({ locale: 'zh-CN', colorScheme: 'light', viewport: { width: 1360, height: 900 } });
  const page = await context.newPage(), bodies = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/plugins/' && /javascript/.test(response.headers()['content-type'] ?? ''))
      void response.text().then(body => bodies.push(body)).catch(() => {});
  });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await installOverlayHandler(page, () => {});
  await page.goto(state.url, { waitUntil: 'domcontentloaded' });
  await dismissFirstRunOverlays(page, () => {}, 'bot-mode-approval-smoke');
  const sidebar = page.locator('[data-bot-mode-sidebar]'); await sidebar.waitFor();
  await sidebar.getByRole('navigation').getByRole('button', { name: /^通用助手/ }).first().click();
  await page.waitForFunction(() => document.querySelector('[data-bot-mode-object="bot"] [data-bot-mode-title]')?.textContent === '通用助手');
  const chat = page.locator('[data-bot-mode-object="bot"]');
  await chat.locator('[contenteditable="true"]').first().waitFor();
  const matched = [];
  for (const [id, resource] of Object.entries(resources)) {
    const bytes = await readFile(resource.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), resource.sha256);
    const expected = bytes.toString().trimEnd().replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*$/u, '').trimEnd();
    assert.ok(bodies.some(body => body.includes(expected)), `Actual ${id} response must match frozen bytes`);
    matched.push({ id, sha256: resource.sha256 });
  }
  assert.deepEqual(errors, []);
  assert.equal((await json(resolve(base, 'fixture.json'))).supergroupEnabled, true);
  assert.deepEqual(await json(resolve(base, 'calls.json')), []);
  await page.screenshot({ path: resolve(out, 'final-service.png'), fullPage: true, animations: 'disabled' });
  const result = { status: 'PASS', pid: state.pid, port: new URL(state.url).port, artifactSha256: state.artifactSha256,
    outputDir: out, supergroupEnabled: true, selected: '通用助手', matched, errors, modelRequests: 0 };
  await writeFile(resolve(out, 'final-service-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
