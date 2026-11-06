import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
const root = process.cwd(), version = process.env.UI_VERSION ?? 'rc5', dir = resolve(root, `.dsh-dev/ui-completion/${version}-${Date.now()}`), out = resolve(root, `output/playwright/ui-completion/${version}`);
await mkdir(out, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const host = await webHost(dir, 'ui-completion', process.env.DSH_BOT_ARTIFACT && resolve(process.env.DSH_BOT_ARTIFACT), resolve(root, 'packages/dsh-bot/tests/group-native-api-profile.mjs'));
let browser, lastPage;
try {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const paths = (await readdir(cache)).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().flatMap(n => ['arm64', 'x64'].map(a => join(cache, n, `chrome-headless-shell-mac-${a}`, 'chrome-headless-shell')));
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath: paths.find(existsSync), headless: true, chromiumSandbox: true, env: host.env }); } finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
  const checks = [], errors = [], screenshots = [];
  for (const language of ['en', 'zh']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', locale: language === 'zh' ? 'zh-CN' : 'en-US' });
    const page = await context.newPage(); lastPage = page; page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
    await installOverlayHandler(page, () => {}); await page.goto(host.url); await dismissFirstRunOverlays(page, () => {}, 'u2');
    await openBotsPanel(page, 'Bots', () => {});
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`))).ui;
    const main = page.locator('[data-bots-page]'), click = key => main.getByRole('button', { name: t[key], exact: true }).click();
    const tab = key => main.getByRole('tab', { name: t[key], exact: true }).click();
    await main.locator('button[data-bot-id="api-alpha"]').waitFor();
    assert.equal(await main.locator('button[data-bot-id]').count(), 50);
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        const capture = async name => {
          await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, name);
          const filename = `${language}-${theme}-${width}-${name}.png`;
          await page.screenshot({ path: join(out, filename), fullPage: true, animations: 'disabled' }); screenshots.push(filename);
        };
        await capture('list');
        await main.getByRole('searchbox').fill('api-alpha');
        await main.getByRole('button', { name: `${t['chat.profile']} · api-alpha`, exact: true }).click();
        assert.equal(await page.getByRole('dialog').count(), 0);
        for (const key of ['overview', 'work', 'memory', 'settings', 'history']) {
          await tab(`detail.${key}`); await capture(key);
        }
        await tab('detail.settings');
        for (const key of ['capabilities', 'connectors', 'notifications']) { await click(`detail.${key}`); await capture(`bot-${key}`); }
        await tab('notifications.policies'); await capture('notification-policies');
        await tab('detail.memory'); await tab('manage.graph'); await capture('graph');
        await tab('manage.transfer'); await capture('export');
        const exportPanel = main.getByRole('tabpanel', { name: t['manage.export'], exact: true });
        await exportPanel.getByRole('button', { name: t['manage.export'], exact: true }).click();
        await exportPanel.getByRole('button', { name: t['manage.exportJson'], exact: false }).click(); await capture('export-json');
        const downloadPromise = page.waitForEvent('download');
        await exportPanel.getByRole('button', { name: t['manage.download'], exact: true }).click();
        const downloaded = await downloadPromise;
        const payload = await readFile(await downloaded.path());
        assert.equal(JSON.parse(payload).format, 'dsh-bot-export');
        await tab('manage.import');
        await main.locator('input[type=file]').setInputFiles({ name: 'bot.json', mimeType: 'application/json', buffer: payload });
        await main.getByRole('textbox', { name: t['manage.newId'], exact: true }).fill(`ui-${language}-${theme}-${width}`);
        await click('manage.preview');
        await main.getByRole('button', { name: t['manage.confirmImport'], exact: true }).waitFor();
        await capture('import-preview');
        await main.getByRole('textbox', { name: t['manage.document'], exact: true }).fill('');
        await main.getByRole('textbox', { name: t['manage.newId'], exact: true }).fill('');
        await tab('detail.overview'); await click('card.edit');
        await main.getByRole('textbox', { name: t['editor.description'], exact: true }).fill('Unsaved UI validation');
        await capture('editor');
        await main.getByRole('button', { name: t['navigation.returnTo'].replace('{name}', t['navigation.myBots']), exact: true }).click();
        const dialog = page.getByRole('dialog', { name: t['navigation.unsaved'], exact: true });
        await dialog.getByRole('button', { name: t['navigation.keepEditing'], exact: true }).click();
        assert.equal(await main.getByRole('textbox', { name: t['editor.description'], exact: true }).inputValue(), 'Unsaved UI validation');
        await main.getByRole('button', { name: t['navigation.returnTo'].replace('{name}', t['navigation.myBots']), exact: true }).click();
        await dialog.getByRole('button', { name: t['navigation.discardLeave'], exact: true }).click();
        assert.equal(await main.getByRole('searchbox').inputValue(), 'api-alpha');
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        assert.equal(await main.getByRole('button', { name: `${t['chat.profile']} · api-alpha`, exact: true }).evaluate(el => el === document.activeElement), true);
        await main.getByRole('searchbox').fill('');
        await click('chat.settings');
        for (const key of ['connectors.connectors', 'notifications.notifications', 'routine.title', 'team.title', 'im.title', 'manage.memoryTools']) { await tab(key); await capture(`settings-${key.split('.')[0]}`); }
        await main.locator('[data-settings-navigation]').click();
        await click('groups.title');
        const groups = main.getByRole('navigation', { name: t['groups.list'], exact: true });
        if (await groups.locator('[data-group-directory-row]').count()) await groups.locator('[data-group-directory-row]').first().click();
        await main.locator('[data-group-overview]').waitFor(); await capture('group-profile');
        if (width <= 760) {
          assert.equal(await groups.isVisible(), false);
          await main.getByRole('button', { name: t['navigation.returnTo'].replace('{name}', t['groups.title']), exact: true }).click();
          assert.equal(await groups.isVisible(), true);
        }
        await groups.getByRole('button', { name: t['groups.filter'], exact: true }).click();
        await page.getByRole('menuitem', { name: t['groups.filter.archived'], exact: true }).click();
        await groups.getByText(t['groups.noMatches'], { exact: true }).waitFor();
        await groups.getByRole('button', { name: t['groups.clearFilters'], exact: true }).click();
        await groups.locator('[data-group-directory-row]').first().waitFor();
        await click('navigation.myBots');
      }
    }
    await main.getByRole('searchbox').fill('api-alpha');
    await main.getByRole('button', { name: `${t['chat.profile']} · api-alpha`, exact: true }).click();
    await click('card.edit');
    await main.getByRole('textbox', { name: t['editor.description'], exact: true }).fill(`Verified inline save ${language}`);
    await click('editor.save');
    await page.getByText(t['bots.saveSuccess'], { exact: true }).waitFor();
    assert.equal(await main.locator('form:visible').count(), 0);
    checks.push(`${language}: native inline save and success Toast`);
    checks.push(`${language}: 50 Bots, same/long names, full-page theme/viewport matrix, inline details, native draft confirmation and list restoration`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'results.json'), JSON.stringify({ version, checks, screenshots, errors, syntheticModelRequests: host.requests(), realModelRequests: 0 }, null, 2) + '\n');
  console.log(JSON.stringify({ version, checks, screenshots: screenshots.length, out }));
} catch (error) { if (lastPage) { await writeFile(join(out, 'failure.txt'), await lastPage.locator('body').ariaSnapshot()); await lastPage.screenshot({ path: join(out, 'failure.png') }); } throw error; } finally { await browser?.close(); await host.stop(); }
