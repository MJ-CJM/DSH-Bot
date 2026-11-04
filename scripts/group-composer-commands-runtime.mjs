// Issue #30 follow-up: the group composer offers the native-style '/' menu and add button, backed by native services.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const dir = resolve(root, `.dsh-dev/group-composer/${version}-${Date.now()}`);
const out = resolve(root, `output/playwright/group-composer/${version}`); await mkdir(out, { recursive: true });
const host = await webHost(dir, 'composer', undefined, resolve(root, 'packages/dsh-bot/tests/group-composer-commands-profile.mjs'));
let browser, page, stopped = false;
const checks = [], errors = [], check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
// Observe an event without leaving an unhandled rejection behind if a later step fails first.
const expect = promise => { promise.catch(() => {}); return promise; };
const settle = () => page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
const noDialog = () => page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 0);
const EXPECTED = ['file', 'model', 'permission', 'export', 'feedback'];
try {
  const receipt = JSON.parse(await readFile(resolve(dir, 'composer.json'), 'utf8'));
  const native = receipt.rootCommands.map(row => row.name).sort();
  check('the Host offers the group root exactly export, feedback and permission', JSON.stringify(native) === JSON.stringify(['export', 'feedback', 'permission']));
  check('scripted model only', receipt.realModelRequests === 0);

  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const candidates = (await readdir(cache)).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
    .flatMap(n => ['arm64', 'x64'].map(a => join(cache, n, `chrome-headless-shell-mac-${a}`, 'chrome-headless-shell')));
  const oldTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath: process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync), headless: true, chromiumSandbox: true, env: host.env }); }
  finally { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; }
  for (const [language, theme, width] of [['en', 'light', 1440], ['zh', 'dark', 390]]) {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 }, colorScheme: theme, locale: language === 'zh' ? 'zh-CN' : 'en-US' });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(String(error))); page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') console.error(`[${language}] console.${message.type()}: ${message.text()}`); });
    await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
    await installOverlayHandler(page, () => {}); await page.goto(host.url); await dismissFirstRunOverlays(page, () => {}, 'composer');
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`))).ui;
    await openSidebarSession(page, receipt.group.rootSessionId);
    await page.setViewportSize({ width, height: 860 });
    const composer = page.locator(`[data-workspace-group-composer="${receipt.group.rootSessionId}"]`);
    const input = composer.locator('textarea'); await input.waitFor();
    const menu = composer.locator('[data-group-command-menu]');
    const rows = () => menu.locator('[role="option"]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-group-command')));
    const noOverflow = () => page.evaluate(w => document.scrollingElement.scrollWidth <= w + 1, width);
    const fits = async locator => { const box = await locator.boundingBox(); return Boolean(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0); };
    const typeCommand = async text => { await input.fill(''); await input.pressSequentially(text); await menu.waitFor(); };
    const messages = () => page.locator('[data-workspace-group-message]').count();
    const before = await messages();

    check(`${language}: the placeholder names @ and /`, await input.getAttribute('placeholder') === t['groups.pickCommands']);
    await typeCommand('/');
    await page.waitForFunction(() => document.querySelectorAll('[data-group-command-menu] [role="option"]').length === 5);
    check(`${language}: '/' lists Add and Commands sections like the native menu`, await menu.getAttribute('aria-label') === t['groups.commands']
      && JSON.stringify(await menu.locator('[role="group"]').evaluateAll(n => n.map(g => g.getAttribute('aria-label')))) === JSON.stringify([t['groups.commandsAdd'], t['groups.commands']]));
    check(`${language}: rows are file, model, access, download log and feedback; no goal, plan or compact`, JSON.stringify(await rows()) === JSON.stringify(EXPECTED)
      && !/\b(goal|plan|compact)\b/.test(await menu.innerText()));
    check(`${language}: the command menu fits the viewport`, await fits(menu) && await noOverflow());
    await settle(); await page.screenshot({ path: join(out, `${language}-${theme}-${width}-menu.png`) });
    await input.press('Escape');

    const download = expect(page.waitForEvent('download', { timeout: 30000 }));
    await typeCommand('/exp'); await input.press('Enter');
    const zip = join(out, `${language}-export.zip`); await (await download).saveAs(zip);
    const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
    check(`${language}: download log exports the group root and every member sub-session`, entries.some(e => /^session(\.v\d+)?\.jsonl$/.test(e))
      && entries.filter(e => /^subagents\/[^/]+\/session(\.v\d+)?\.jsonl$/.test(e)).length === 2);
    check(`${language}: the command token leaves the draft and nothing is sent`, await input.inputValue() === '' && await messages() === before);
    const exportDialog = page.getByRole('dialog'); await exportDialog.waitFor(); await settle();
    check(`${language}: the native download dialog reports the export`, (await exportDialog.innerText()).includes('ZIP'));
    await page.screenshot({ path: join(out, `${language}-${theme}-${width}-export.png`) });
    await page.keyboard.press('Escape'); await noDialog();

    await typeCommand('/feed'); await input.press('Enter');
    const feedback = page.getByRole('dialog'); await feedback.waitFor(); await settle();
    check(`${language}: feedback opens the native Session feedback form`, await feedback.isVisible() && !(await feedback.innerText()).includes('ZIP')
      && await feedback.locator('button, input, textarea, [role="radio"], [role="checkbox"]').count() >= 4 && await fits(feedback));
    await page.screenshot({ path: join(out, `${language}-${theme}-${width}-feedback.png`) });
    await page.keyboard.press('Escape'); await noDialog();

    await composer.getByRole('button', { name: t['groups.addOrCommand'], exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-group-command-menu] [role="option"]').length === 5);
    check(`${language}: the add button opens the same menu and keeps typing in the composer`, JSON.stringify(await rows()) === JSON.stringify(EXPECTED)
      && await input.evaluate(el => el === document.activeElement));
    await input.press('Escape');

    await typeCommand('/mod'); await input.press('Enter');
    const modelTrigger = composer.locator(`button[aria-label^="${t['groups.model']}:"]`);
    await page.getByRole('menu').waitFor();
    check(`${language}: model opens the group model menu`, await modelTrigger.getAttribute('aria-expanded') === 'true');
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'hidden' });

    await typeCommand('/perm'); await input.press('Enter');
    const permissionMenu = page.getByRole('menu'); await permissionMenu.getByText(t['groups.permissionApprovalScope'], { exact: true }).waitFor();
    check(`${language}: access opens the group access menu with its workspace boundary`, (await permissionMenu.innerText()).includes(receipt.group.cwd) && await fits(permissionMenu));
    await settle(); await page.screenshot({ path: join(out, `${language}-${theme}-${width}-permission.png`) });
    await page.keyboard.press('Escape'); await permissionMenu.waitFor({ state: 'hidden' });

    const chooser = expect(page.waitForEvent('filechooser'));
    await typeCommand('/fi'); await input.press('Enter');
    check(`${language}: file opens the group's file picker`, (await chooser).isMultiple());

    await input.fill(''); await input.pressSequentially('@');
    const members = composer.locator('[role="listbox"]'); await members.waitFor();
    check(`${language}: @ still lists group members`, await members.getAttribute('aria-label') === t['groups.targets']
      && (await members.innerText()).includes('Planner') && await menu.count() === 0);
    await input.press('Escape');
    await input.fill(''); await input.pressSequentially('see a/b /');
    await page.waitForTimeout(300);
    check(`${language}: an inline '/' stays plain text`, await menu.count() === 0);

    const bare = expect(page.waitForEvent('download', { timeout: 30000 }));
    await typeCommand('/export'); await input.press('Escape'); await menu.waitFor({ state: 'detached' });
    await input.press('Enter'); await bare;
    check(`${language}: a bare /export with the menu dismissed runs the command, not a message`, await input.inputValue() === '' && await messages() === before);
    await page.keyboard.press('Escape');
    check(`${language}: no horizontal overflow`, await noOverflow());
    await context.close();
  }
  check('no browser errors', errors.length === 0);
  await browser.close(); browser = undefined; await host.stop(); stopped = true;
  await writeFile(join(out, 'result.json'), `${JSON.stringify({ status: 'PASS', version, dir, checks, errors, receipt }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'PASS', version, checks: checks.length, dir, out }));
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: join(out, 'failure.png') }); await writeFile(join(out, 'failure.txt'), await page.locator('body').ariaSnapshot()); }
  await writeFile(join(out, 'result.json'), `${JSON.stringify({ status: 'FAIL', dir, checks, errors, error: String(error.stack) }, null, 2)}\n`); throw error;
} finally { await browser?.close(); if (!stopped) await host.stop(); }
