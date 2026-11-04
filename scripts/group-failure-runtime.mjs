import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { webHost } from './deepening/b4-web-host.mjs';
import { openSidebarSession } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const version = process.env.DSH_BOT_DSH_BIN?.includes('native-api-rc2') ? 'rc2' : 'rc5';
const dir = resolve(root, `.dsh-dev/group-failures/${version}-${Date.now()}`);
const out = resolve(root, `output/playwright/group-failures/${version}`); await mkdir(out, { recursive: true });
const host = await webHost(dir, 'failures', undefined, resolve(root, 'packages/dsh-bot/tests/group-failure-profile.mjs'));
let browser, page, stopped = false;
const checks = [], errors = [], check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const expected = {
  'Quota Partial': { code: 'QUOTA', status: 402, message: 'Insufficient Balance (request_id: fixture-partial)' },
  'Quota Silent': { code: 'QUOTA', status: 402, message: 'Insufficient Balance (request_id: fixture-silent)' },
  'Request Bot': { code: 'INVALID_REQUEST', status: 400, message: 'Model rejected the request: unsupported parameter' },
};
try {
  const receipt = JSON.parse(await readFile(resolve(dir, 'failures.json'), 'utf8')), { view } = receipt;
  const nameOf = delivery => receipt.bots.find(bot => bot.id === delivery.bot.botId)?.name;
  const same = (a, b) => a?.code === b.code && a?.status === b.status && a?.message === b.message;
  check('each failed delivery keeps the native failure facts', view.deliveries.every(d => d.state === 'failed' && d.stopReason === 'error' && same(d.failure, expected[nameOf(d)])));
  const replies = view.messages.filter(m => m.authorKind === 'bot');
  check('members that worked first keep their partial reply with the failure', replies.length === 2 && replies.every(m =>
    m.stopReason === 'error' && same(m.failure, expected[m.speaker.name]) && m.text.length > 0));
  check('a member that failed at once has no reply message', !replies.some(m => m.speaker.name === 'Quota Silent')
    && view.deliveries.find(d => nameOf(d) === 'Quota Silent')?.outputMessageId === undefined);
  check('failure detail carries provider text only, never tool output', !JSON.stringify(view.deliveries.map(d => d.failure)).includes('FAILURE_FIXTURE_READ'));
  check('non-retryable failures make no extra model requests', receipt.modelRequests === 5);

  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const candidates = (await readdir(cache)).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
    .flatMap(n => ['arm64', 'x64'].map(a => join(cache, n, `chrome-headless-shell-mac-${a}`, 'chrome-headless-shell')));
  const oldTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath: process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync), headless: true, chromiumSandbox: true, env: host.env }); }
  finally { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; }
  for (const [language, theme, width] of [['en', 'light', 1440], ['zh', 'dark', 390]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme, locale: language === 'zh' ? 'zh-CN' : 'en-US' });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
    await installOverlayHandler(page, () => {}); await page.goto(host.url); await dismissFirstRunOverlays(page, () => {}, 'failures');
    await openSidebarSession(page, receipt.group.rootSessionId);
    await page.setViewportSize({ width, height: 800 });
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`))).ui;
    const reply = name => page.locator('[data-group-message][data-group-author="bot"]', { hasText: name }).locator('[data-group-stop="error"]');
    await reply('Quota Partial').waitFor();
    const partial = await reply('Quota Partial').innerText(), request = await reply('Request Bot').innerText();
    check(`${language}: quota reply names the cause in native wording`, partial.includes(`${t['groups.partial']} · ${t['groups.failure.quota']}`)
      && partial.includes('QUOTA · 402') && !/·\s*error\s*$/.test(partial));
    check(`${language}: unknown code keeps the provider message`, request.includes('Model rejected the request: unsupported parameter') && request.includes('INVALID_REQUEST · 400'));
    const notice = page.locator('[data-group-member-failure]');
    await notice.waitFor();
    const noticeText = await notice.innerText(), turn = page.locator('[data-group-turn]');
    check(`${language}: silent member failure shown while details are folded`, await notice.count() === 1 && noticeText.includes('Quota Silent')
      && noticeText.includes(t['groups.failure.quota']) && await notice.isVisible() && await turn.locator('button[aria-expanded]').first().getAttribute('aria-expanded') === 'false');
    check(`${language}: no horizontal overflow`, await page.evaluate(w => document.scrollingElement.scrollWidth <= w + 1, width)
      && (await Promise.all([reply('Quota Partial'), reply('Request Bot'), notice].map(l => l.boundingBox()))).every(b => b && b.x >= 0 && b.x + b.width <= width + 1));
    await notice.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(out, `${language}-${theme}-${width}.png`) });
    await turn.locator('button[aria-expanded]').first().click();
    const card = page.locator('[data-group-execution-card]', { hasText: 'Quota Silent' });
    await card.waitFor();
    check(`${language}: expanded member row names the cause`, (await card.innerText()).includes(t['groups.failure.quota']));
    await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(out, `${language}-${theme}-${width}-details.png`) });
    await context.close();
  }
  await browser.close(); browser = undefined; await host.stop(); stopped = true;
  // Native evidence independent of the plugin: each child's persisted Session log, flushed at shutdown.
  const sessionFiles = (await readdir(resolve(dir, 'sessions'), { recursive: true })).filter(path => path.endsWith('session.v4.jsonl.zstd'));
  const turnEnd = async childId => {
    const path = sessionFiles.find(file => file.split('/').at(-2) === childId); if (!path) return null;
    // Session logs are append-only multi-frame zstd; Node decodes one frame per call.
    let rest = await readFile(resolve(dir, 'sessions', path)); const frames = [];
    while (rest.length) { const { buffer, engine } = zstdDecompressSync(rest, { info: true }); frames.push(buffer); if (!engine.bytesWritten) break; rest = rest.subarray(engine.bytesWritten); }
    const events = Buffer.concat(frames).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    return events.findLast(event => event.type === 'turn/end')?.data.reason ?? null;
  };
  const native = await Promise.all(view.deliveries.map(async d => ({ name: nameOf(d), reason: await turnEnd(d.childSessionId) })));
  check('native child Session logs record each LlmFailure', native.length === 3 && native.every(row => row.reason?.kind === 'error' && same(row.reason.error, expected[row.name])));
  check('no browser errors or real model calls', errors.length === 0 && receipt.realModelRequests === 0);
  await writeFile(join(out, 'result.json'), `${JSON.stringify({ status: 'PASS', version, dir, checks, errors, native, receipt }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'PASS', version, checks: checks.length, dir, out }));
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: join(out, 'failure.png') }); await writeFile(join(out, 'failure.txt'), await page.locator('body').ariaSnapshot()); }
  await writeFile(join(out, 'result.json'), `${JSON.stringify({ status: 'FAIL', dir, checks, errors, error: String(error.stack) }, null, 2)}\n`); throw error;
} finally { await browser?.close(); if (!stopped) await host.stop(); }
