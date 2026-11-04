import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { openSidebarSession, openBotsPanel } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const version = process.env.DSH_BOT_DSH_BIN?.includes('native-api-rc2') ? 'rc2' : 'rc5';
const dir = resolve(root, `.dsh-dev/group-permissions/${version}-${Date.now()}`);
const out = resolve(root, `output/playwright/group-permissions/${version}`); await mkdir(out, { recursive: true });
const config = ['- id: permission', '  config:', '    defaultPreset: workspace-write', '    presets:',
  '      read-only:', '        sandbox: read-only', '        approval: ask', '        name: read-only',
  '      workspace-write:', '        sandbox: workspace-write', '        approval: ask', '        name: workspace-write',
  '      danger-full-access:', '        sandbox: danger-full-access', '        approval: never', '        name: danger-full-access'];
const host = await webHost(dir, 'permissions', undefined, resolve(root, 'packages/dsh-bot/tests/group-permission-profile.mjs'), config);
let browser, page, stopped = false;
const checks = [], errors = [], check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const receipt = () => readFile(resolve(dir, 'permissions.json'), 'utf8').then(JSON.parse);
try {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const candidates = (await readdir(cache)).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
    .flatMap(n => ['arm64', 'x64'].map(a => join(cache, n, `chrome-headless-shell-mac-${a}`, 'chrome-headless-shell')));
  const oldTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath: process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync), headless: true, chromiumSandbox: true, env: host.env }); }
  finally { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; }
  const initial = await receipt(), first = initial.receipts[0];
  check('real read-only worker cannot write a file', first.sandbox === 'read-only' && first.written === null);
  check('real read-only worker can read workspace file', JSON.stringify(first.read).includes('ISSUE_26_READ'));
  check('native approval rejects instead of prompting', first.approval === 'never' && first.approvalOutcome === 'rejected' && initial.approvalAnswerers === 0);
  check('model-emitted write logs native FS_SANDBOX_DENIED', initial.receipts.every(row => row.modelDenial?.code === 'FS_SANDBOX_DENIED'));
  const firstQuestion = 'Read-only permission test', secondQuestion = 'New task after selecting workspace write';
  const deniedOn = async (question, t) => {
    const message = page.locator('[data-workspace-group-message]', { hasText: question });
    const notice = message.locator('[data-group-permission-denied]'); await notice.waitFor();
    const text = await notice.innerText();
    return await page.locator('[data-group-permission-denied]').count() === 1 && text.includes('Permission Bot') && text.includes('Permission Reviewer')
      && text.includes(t['groups.permissionDenied'].split('{names}')[1].trim().slice(0, 12)) && await notice.getAttribute('role') === 'status';
  };
  for (const [language, theme, width] of [['en', 'light', 1440], ['zh', 'dark', 390]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme, locale: language === 'zh' ? 'zh-CN' : 'en-US' });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
    await installOverlayHandler(page, () => {}); await page.goto(host.url); await dismissFirstRunOverlays(page, () => {}, 'permissions');
    await openSidebarSession(page, initial.group.rootSessionId);
    await page.setViewportSize({ width, height: 800 });
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`))).ui;
    const composer = page.locator(`[data-workspace-group-composer="${initial.group.rootSessionId}"]`);
    const trigger = composer.getByRole('button', { name: new RegExp(`^${t['groups.permission']}:`) });
    await trigger.waitFor(); check(`${language}: permission entry enabled during work`, await trigger.isEnabled());
    check(`${language}: denial notice only on latest question`, await deniedOn(language === 'en' ? firstQuestion : secondQuestion, t));
    await trigger.click(); const menu = page.getByRole('menu'); await menu.getByText(t['groups.permissionApprovalScope'], { exact: true }).waitFor();
    check(`${language}: workspace and delegation explanation visible`, (await menu.innerText()).includes(initial.group.cwd) && (await menu.innerText()).includes(t['groups.permissionScope']));
    check(`${language}: guidance uses native label rows, not extra menu children`, await menu.getByRole('note').count() === 0
      && await menu.locator('button:not([role="menuitem"])').count() === 0 && await menu.getByRole('menuitem').count() >= 2);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const bounds = await menu.boundingBox(); check(`${language}: menu fits viewport`, bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= 801);
    await page.screenshot({ path: join(out, `${language}-${theme}-${width}.png`) });
    if (language === 'en') {
      await menu.getByRole('menuitem', { name: t['groups.permissionWorkspaceWrite'], exact: true }).click();
      await composer.getByRole('button', { name: `${t['groups.permission']}: ${t['groups.permissionWorkspaceWrite']}`, exact: true }).waitFor();
      await composer.locator('textarea').fill('New task after selecting workspace write');
      await composer.getByRole('button', { name: t['groups.send'], exact: true }).click();
      const deadline = Date.now() + 20000; let next;
      do { next = await receipt(); if (next.receipts.length >= initial.receipts.length + 2) break; assert.ok(Date.now() < deadline, 'fresh worker startup'); await delay(40); } while (true);
      const second = next.receipts[initial.receipts.length];
      check('new worker actually writes inside workspace', second.sandbox === 'workspace-write' && second.written === 'ISSUE_26_WRITE');
      check('workspace-write cannot write outside the group workspace', second.outsideWritten === null && second.outsideWrite.isError === true);
      check('new worker retains native never approval', second.approval === 'never' && second.approvalOutcome === 'rejected' && next.approvalAnswerers === 0);
      check('new worker model write outside workspace logs FS_SANDBOX_DENIED', second.modelDenial?.code === 'FS_SANDBOX_DENIED');
      check('denial notice moves to the new latest question', await deniedOn(secondQuestion, t)
        && await page.locator('[data-workspace-group-message]', { hasText: firstQuestion }).locator('[data-group-permission-denied]').count() === 0);
    } else {
      await menu.getByRole('menuitem', { name: t['groups.permissionFull'], exact: true }).click();
      const dialog = page.getByRole('dialog'); await dialog.waitFor();
      check('full access still requires explicit native acknowledgement', await dialog.getByRole('button', { name: t['groups.permissionFullEnable'], exact: true }).isDisabled());
      await dialog.getByRole('button', { name: t['groups.permissionCancel'], exact: true }).click();
      check('cancel preserves workspace write', await trigger.getAttribute('aria-label') === `${t['groups.permission']}: ${t['groups.permissionWorkspaceWrite']}`);
    }
    // Group creation: the cwd comes from native Workspaces (the OS picker itself is not clicked headlessly).
    await openBotsPanel(page, t['bots.title']);
    const bots = page.locator('[data-bots-page]:visible');
    await bots.getByRole('navigation', { name: t['navigation.sections'] }).getByRole('button', { name: t['groups.title'], exact: true }).click();
    await bots.getByRole('button', { name: t['groups.create'], exact: true }).click();
    const form = bots.getByRole('form', { name: t['groups.create'], exact: true });
    const field = form.getByRole('group', { name: t['groups.cwd'], exact: true }); await field.waitFor();
    check(`${language}: workspace field is top-level with default and write-scope hint`, await field.locator('xpath=ancestor::details').count() === 0
      && (await field.innerText()).includes(t['groups.workspaceDefault']) && (await field.innerText()).includes(t['groups.workspaceHint']));
    await field.getByRole('button', { name: t['groups.workspaceChoose'], exact: true }).click();
    const workspaceMenu = page.getByRole('menu'); await workspaceMenu.waitFor();
    const rows = await workspaceMenu.getByRole('menuitem').allInnerTexts();
    check(`${language}: native workspace rows and picker entry offered`, rows[0] === t['groups.workspaceUseDefault']
      && rows.some(row => row.replace(/\s/g, '') === initial.group.cwd) && rows.at(-1) === t['groups.workspaceOtherFolder']);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const menuBounds = await workspaceMenu.boundingBox();
    check(`${language}: workspace menu fits viewport`, menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width + 1 && menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= 801);
    await page.screenshot({ path: join(out, `${language}-${theme}-${width}-create-menu.png`) });
    await workspaceMenu.getByRole('menuitem').nth(rows.findIndex(row => row.replace(/\s/g, '') === initial.group.cwd)).click();
    check(`${language}: chosen workspace shown with native PathLabel`, (await field.innerText()).replace(/\s/g, '').includes(initial.group.cwd)
      && !(await field.innerText()).includes(t['groups.workspaceDefault']));
    await page.screenshot({ path: join(out, `${language}-${theme}-${width}-create.png`) });
    await context.close();
  }
  await browser.close(); browser = undefined; await host.stop(); stopped = true;
  const final = await receipt();
  check('existing worker keeps original sandbox after parent change', final.receipts[0].finalPolicy?.sandbox === 'read-only' && final.receipts[0].finalPolicy?.approval === 'never');
  check('no browser errors or real model calls', errors.length === 0 && final.realModelRequests === 0);
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: 'PASS', version, dir, checks, errors, final }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', version, checks: checks.length, dir, out }));
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: join(out, 'failure.png') }); await writeFile(join(out, 'failure.txt'), await page.locator('body').ariaSnapshot()); }
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: 'FAIL', dir, checks, errors, error: String(error.stack) }, null, 2)); throw error;
} finally { await browser?.close(); if (!stopped) await host.stop(); }
