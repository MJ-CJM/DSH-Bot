// Issue #30 follow-up: the group statistics bar reads like the native composer stats, and its question
// menu is the native portaled Menu with a state dot, time, status and members per question.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { webHost } from './deepening/b4-web-host.mjs';
import { openSidebarSession } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const version = process.env.DSH_BOT_DSH_BIN?.includes('native-api-rc2') ? 'rc2' : 'rc5';
const out = resolve(root, `output/playwright/group-statistics-menu/${version}`); await mkdir(out, { recursive: true });
const cache = join(homedir(), 'Library/Caches/ms-playwright');
const candidates = (await readdir(cache)).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .flatMap(n => ['arm64', 'x64'].map(a => join(cache, n, `chrome-headless-shell-mac-${a}`, 'chrome-headless-shell')));
const checks = [], errors = [], check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const questions = { en: ['Research assistant, summarize the findings.', 'How should we compare two technical approaches? Please discuss together.'],
  zh: ['只请研究助手总结一下。', '请一起讨论：我们应该怎样比较两个技术方案？'] };
let browser, page, host, stopped = true;
try {
  for (const [language, theme, width] of [['en', 'light', 1440], ['zh', 'dark', 390]]) {
    const dir = resolve(root, `.dsh-dev/group-statistics-menu/${version}-${language}-${Date.now()}`);
    host = await webHost(dir, `statistics-${language}`, undefined, resolve(root, 'packages/dsh-bot/tests/group-statistics-profile.mjs'), ['- id: ui-chat', '  config:', '    performanceUsage: detailed']);
    stopped = false;
    const fixture = JSON.parse(await readFile(resolve(dir, 'showcase.json'), 'utf8'));
    const oldTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
    try { browser = await chromium.launch({ executablePath: process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync), headless: true, chromiumSandbox: true, env: host.env }); }
    finally { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
    await installOverlayHandler(page, () => {}); await page.goto(host.url); await dismissFirstRunOverlays(page, () => {}, 'statistics-menu');
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`))).ui;
    const fill = (key, values) => t[key].replace(/\{(\w+)\}/g, (_m, name) => values[name]);
    const [latest, first] = questions[language];
    await openSidebarSession(page, fixture.rootId);
    await page.setViewportSize({ width, height: 860 });
    const bar = page.locator('[data-group-statistics-bar]'); await bar.waitFor();
    if (width >= 768) await bar.locator('[data-group-token-total]').waitFor();
    const trigger = bar.locator('button[aria-haspopup="menu"]');
    const noOverflow = () => page.evaluate(w => document.scrollingElement.scrollWidth <= w + 1, width);
    const settle = () => page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
    const flat = locator => locator.evaluate(el => { const s = getComputedStyle(el); return s.borderTopWidth === '0px' && s.borderLeftWidth === '0px' && s.backgroundColor === 'rgba(0, 0, 0, 0)'; });
    const shown = fill('statistics.latestQuestion', { title: latest });

    check(`${language}: the trigger names the followed question`, (await trigger.innerText()).trim() === shown
      && await trigger.getAttribute('aria-label') === `${t['statistics.select']}: ${shown}`);
    const state = await bar.locator('[data-statistics-status]').getAttribute('data-statistics-status');
    check(`${language}: the status reads the short group wording beside a native state dot`, (await bar.locator('[data-statistics-status]').innerText()).trim() === t[`statistics.status.${state}`]
      && await bar.locator(`[data-statistics-status] [data-state]`).count() === 1);
    if (width >= 768) {
      const usage = (await bar.locator('[data-group-usage]').innerText()).replace(/\s+/g, ' ').trim();
      check(`${language}: usage reads like the native pill: count tok · cache hit`, /^\d+(\.\d)?[KM]? tok · /.test(usage) && usage.includes(fill('statistics.cache', { percent: '' }).replace('%', '').trim()));
      check(`${language}: stat icons are drawn`, await bar.locator('[data-group-usage] svg').count() === 1 && await bar.locator('svg').count() >= 3);
    } else {
      // The question and its status stay on the first line; usage and details may wrap to a second.
      const [triggerTop, statusTop] = await Promise.all([trigger, bar.locator('[data-statistics-status]')].map(l => l.boundingBox().then(box => Math.round(box.y))));
      check(`${language}: phone width keeps the question with its status and wraps to at most two lines`, triggerTop === statusTop && (await bar.boundingBox()).height <= 52);
    }
    check(`${language}: hovering the usage names its scope: this question only`, await bar.locator('[data-group-usage]').getAttribute('title') === fill('statistics.questionScope', { count: 1, total: 1 }));
    check(`${language}: the bar's buttons are borderless native-style pills`, await flat(trigger) && await flat(bar.getByRole('button', { name: t['statistics.details'], exact: true })));
    check(`${language}: the bar fits the viewport`, await noOverflow());
    await page.screenshot({ path: join(out, `${language}-${theme}-${width}-bar.png`) });

    await trigger.click();
    const menu = page.getByRole('menu'); await menu.waitFor(); await settle();
    const rows = menu.getByRole('menuitem');
    const [menuBox, triggerBox] = [await menu.boundingBox(), await trigger.boundingBox()];
    check(`${language}: the menu is portaled out of the panel and opens upward inside the viewport`, await bar.locator('[role="menu"]').count() === 0
      && menuBox.y + menuBox.height <= triggerBox.y + 1 && menuBox.y >= 0 && menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 1);
    check(`${language}: rows are follow-latest, whole group, a separator, then newest-first questions`, await rows.count() === 4
      && (await rows.nth(0).innerText()).trim() === t['statistics.followLatest']
      && (await rows.nth(1).locator('[data-statistics-scope="group"] > span').first().innerText()) === t['statistics.wholeGroup']
      && (await rows.nth(1).locator('[data-statistics-scope="group"] > span').nth(1).innerText()) === fill('statistics.wholeGroupHint', { count: 2 })
      && await menu.locator('[role="separator"], hr, [class*="separator"]').count() >= 1
      && (await rows.nth(2).locator('[data-statistics-question] > span').first().innerText()) === latest
      && (await rows.nth(3).locator('[data-statistics-question] > span').first().innerText()) === first);
    check(`${language}: rows are flat native cells, not bordered cards`, (await rows.evaluateAll(nodes => nodes.map(n => getComputedStyle(n).borderTopWidth))).every(w => w === '0px'));
    const meta = await rows.nth(3).locator('[data-statistics-question] > span').nth(1).innerText();
    check(`${language}: each question row shows a state dot, time, status and its members`, await rows.nth(2).locator('[data-statistics-question]').count() === 1
      && await rows.nth(2).locator('[data-state]').count() === 1 && await rows.nth(3).locator('[data-state]').count() === 1
      && /\d{1,2}:\d{2}/.test(meta) && fixture.names.every(name => meta.includes(name)) && Object.keys(t).some(k => k.startsWith('statistics.status.') && meta.includes(` · ${t[k]} · `)));
    check(`${language}: the followed row carries the native trailing check`, await rows.nth(0).locator('svg[class*="check"]').count() === 1
      && await rows.nth(1).locator('svg[class*="check"]').count() === 0 && await rows.nth(2).locator('svg[class*="check"]').count() === 0);
    await page.screenshot({ path: join(out, `${language}-${theme}-${width}-menu.png`) });

    // Whole group: both questions' four member sessions, each counted once (480 + 160 tokens).
    await rows.nth(1).click(); await menu.waitFor({ state: 'detached' });
    await bar.locator('[data-group-token-total="640"]').waitFor();
    check(`${language}: whole group names itself and totals every question`, (await trigger.innerText()).trim() === t['statistics.wholeGroup']
      && await bar.getAttribute('data-statistics-scope') === 'group'
      && (await bar.locator('[data-statistics-status]').innerText()).trim() === fill('statistics.questionCount', { count: 2 }));
    check(`${language}: hovering the usage names the whole-group scope and coverage`, await bar.locator('[data-group-usage]').getAttribute('title') === fill('statistics.groupScopeHint', { questions: 2, count: 4, total: 4 }));
    check(`${language}: the whole-group bar fits the viewport`, await noOverflow());
    await page.screenshot({ path: join(out, `${language}-${theme}-${width}-group.png`) });
    await bar.getByRole('button', { name: t['statistics.details'], exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor(); await settle();
    const breakdown = dialog.locator('[data-statistics-breakdown-row]');
    const dialogBox = await dialog.boundingBox();
    check(`${language}: whole-group details state the scope and list each question`, (await dialog.innerText()).includes(t['statistics.groupScope'])
      && await breakdown.count() === 2 && (await breakdown.nth(0).innerText()).includes(latest) && (await breakdown.nth(1).innerText()).includes(first)
      && (await breakdown.allInnerTexts()).every(text => / tok · /.test(text)) && !(await dialog.innerText()).includes(t['statistics.context']));
    check(`${language}: whole-group details fit the viewport`, dialogBox.x >= 0 && dialogBox.y >= 0 && dialogBox.x + dialogBox.width <= width + 1
      && !(await dialog.evaluate(el => [el, ...el.querySelectorAll('*')].some(node => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1))));
    await page.screenshot({ path: join(out, `${language}-${theme}-${width}-group-details.png`) });
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await trigger.click(); await menu.waitFor();
    check(`${language}: the whole-group row carries the check`, await rows.nth(1).locator('svg[class*="check"]').count() === 1 && await rows.nth(0).locator('svg[class*="check"]').count() === 0);

    await rows.nth(3).click(); await menu.waitFor({ state: 'detached' });
    check(`${language}: choosing a question pins it on the trigger`, (await trigger.innerText()).trim() === first && await bar.getAttribute('data-statistics-turn') === fixture.turnId);
    await trigger.click(); await menu.waitFor();
    check(`${language}: the pinned question now carries the check`, await rows.nth(3).locator('svg[class*="check"]').count() === 1 && await rows.nth(0).locator('svg[class*="check"]').count() === 0);
    await rows.nth(0).click(); await menu.waitFor({ state: 'detached' });
    check(`${language}: follow latest returns to the newest question`, (await trigger.innerText()).trim() === shown && await bar.getAttribute('data-statistics-turn') === fixture.secondTurnId);
    check(`${language}: no horizontal overflow after selection`, await noOverflow());
    await context.close(); await browser.close(); browser = undefined; await host.stop(); stopped = true;
  }
  check('no browser errors', errors.length === 0);
  await writeFile(join(out, 'result.json'), `${JSON.stringify({ status: 'PASS', version, checks, errors }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'PASS', version, checks: checks.length, out }));
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: join(out, 'failure.png') }); await writeFile(join(out, 'failure.txt'), await page.locator('body').ariaSnapshot()); }
  await writeFile(join(out, 'result.json'), `${JSON.stringify({ status: 'FAIL', checks, errors, error: String(error.stack) }, null, 2)}\n`); throw error;
} finally { await browser?.close(); if (!stopped) await host.stop(); }
