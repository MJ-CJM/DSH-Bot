import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Rasterize the shipped SVG assets; no image-model calls or bitmap tracing.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../packages/dsh-bot/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const executablePath = process.env.DSH_BOT_CHROMIUM;
if (!executablePath) throw new Error('Set DSH_BOT_CHROMIUM to an existing Chromium/Chrome executable');
await access(executablePath);
await mkdir(resolve(root, '.dsh-dev'), { recursive: true });
const temporary = await mkdtemp(resolve(root, '.dsh-dev/market-icon-'));
const outputs = [
  { input: 'icon.svg', output: 'assets/icon-256.png', size: 256 },
  { input: 'assets/logo.svg', output: 'assets/logo-1024.png', size: 1024 },
];
await mkdir(resolve(root, 'packages/dsh-bot/assets'), { recursive: true });
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = temporary;
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true,
    env: { ...process.env, HOME: temporary, TMPDIR: temporary } });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.route('**/*', route => route.abort());
  for (const { input, output, size } of outputs) {
    await page.setViewportSize({ width: size, height: size });
    const svg = await readFile(resolve(root, 'packages/dsh-bot', input), 'utf8');
    await page.setContent(`<style>html,body{margin:0;width:${size}px;height:${size}px;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    const target = resolve(root, 'packages/dsh-bot', output);
    await page.screenshot({ path: target, omitBackground: true });
    console.log(target);
  }
} finally {
  await browser?.close();
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
  await rm(temporary, { recursive: true, force: true });
}
