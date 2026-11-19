import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
import { openBotsPanel } from './deepening/sidebar-session.mjs';
export async function verifyGroupExportBrowser(host, dir, report, { botMode = false } = {}) {
  const require = createRequire(resolve('packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const executablePath = (await readdir(cache)).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
    .flatMap(n => ['arm64', 'x64'].map(a => resolve(cache, n, `chrome-headless-shell-mac-${a}`, 'chrome-headless-shell'))).find(existsSync);
  assert.ok(executablePath);
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env });
  const errors = [], checks = [];
  try {
    for (const [index, theme, language] of [[0,'light','zh'],[1,'dark','en']]) {
      const context = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', colorScheme: theme, viewport: { width: 1440, height: 1050 } });
      const page = await context.newPage(); page.setDefaultTimeout(20000);
      page.on('pageerror', e => errors.push(String(e)));
      const t = JSON.parse(await readFile(resolve(`packages/dsh-bot/locale/${language}.json`))).ui;
      await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
      await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'group-export');
      await openBotsPanel(page, t['bots.title']);
      const panel = page.locator('[data-bots-page]:visible');
      await panel.getByRole('navigation', { name: t['navigation.sections'], exact: true }).getByRole('button', { name: t['groups.title'], exact: true }).click();
      await panel.locator(`[data-group-directory-row="${report.ui.key.groupId}"]`).click();
      const overview = panel.locator(`[data-group-overview="${report.ui.key.groupId}"]`);
      if (index === 0) {
        await writeFile(resolve(dir, 'export-settings-before.txt'), await page.locator('body').ariaSnapshot());
        await overview.getByRole('tab', { name: t['groups.view.settings'], exact: true }).click();
        const settings = overview.locator('[data-group-export-settings]');
        await settings.locator('[data-export-policy-bot="export-alpha"] [data-export-policy-action]').click();
        await settings.locator('[data-export-policy-confirm]').waitFor();
        for (const botId of ['export-alpha', 'export-beta']) assert.ok((await settings.textContent()).includes(botId));
        await page.screenshot({ path: resolve(dir, `export-settings-${theme}-${language}.png`), fullPage: true });
        await settings.locator('[data-export-policy-confirm]').click();
        await settings.locator('[data-export-policy-bot="export-alpha"]').getByRole('button', { name: t['groups.export.disable'], exact: true }).waitFor();
      }
      await overview.getByRole('button', { name: t['groups.open'], exact: true }).click();
      if (botMode && index === 1) {
        await page.locator('[data-bot-mode-switch-button]:visible').click();
        await page.getByRole('menuitem', { name: t['botMode.botMode'], exact: true }).click();
        const sidebar = page.locator('[data-bot-mode-sidebar]:visible'); await sidebar.waitFor();
        await sidebar.getByRole('navigation').getByRole('button', { name: 'Export review browser', exact: true }).click();
      }
      const queue = page.locator(`[data-group-export-queue="${report.ui.key.groupId}"]:visible`);
      await queue.locator('button[aria-expanded="false"]').first().click();
      const review = page.locator(`[data-group-export-review="${report.ui.deliveries[index]}"]:visible`);
      await review.getByRole('button', { name: t['groups.export.review'], exact: true }).click();
      await review.locator('pre').waitFor();
      assert.ok((await review.locator('pre').textContent()).includes('PRIVATE_REVIEW_REPLY'));
      assert.equal(await review.locator('img').count(), 0);
      assert.ok((await review.textContent()).includes('export-alpha'));
      assert.ok((await review.textContent()).includes('export-beta'));
      await page.screenshot({ path: resolve(dir, `export-${theme}-${language}.png`), fullPage: true });
      assert.equal(await review.getByRole('button', { name: t['groups.export.always'], exact: true }).count(), 0);
      if (index === 0) {
        assert.equal(await queue.locator('[data-export-receipt]').count(), 0, 'Enabling future policy must leave existing pending replies unpublished');
        checks.push({ settingsEnable: 'PASS', existingPendingUnchanged: true });
      }
      await review.getByRole('button', { name: t[index === 0 ? 'groups.export.allow' : 'groups.export.reject'], exact: true }).click();
      await queue.locator(`[data-export-receipt="${report.ui.deliveries[index]}"]`).waitFor();
      if (botMode && index === 1) {
        const composer = page.locator(`[data-workspace-group-composer="${report.ui.sessionId}"]:visible`);
        await composer.getByRole('textbox', { name: t['groups.message'], exact: true }).fill('Continue after the approved reply');
        await composer.getByRole('button', { name: t['groups.send'], exact: true }).click();
        await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-workspace-group-composer] textarea'))
          .some(input => input.getClientRects().length > 0 && input.value === ''));
        assert.equal(await composer.getByRole('textbox', { name: t['groups.message'], exact: true }).inputValue(), '');
        assert.equal(await composer.getByRole('alert').count(), 0);
        // Execution details may be collapsed, so absence of a running node is not completion.
        // A new review button can appear only after the native private-read worker has finished.
        await queue.getByRole('button', { name: t['groups.export.review'], exact: true }).first().waitFor();
        await writeFile(resolve(dir, 'export-bot-settings-before.txt'), await page.locator('body').ariaSnapshot());
        await page.locator('[data-bot-mode-object="group"] [data-bot-mode-details]').click();
        const details = page.locator('[data-bot-mode-details-panel]:visible');
        await details.locator('[data-bot-mode-tab="settings"]').click();
        const policy = details.locator('[data-export-policy-bot="export-alpha"]');
        await policy.getByRole('button', { name: t['groups.export.disable'], exact: true }).click();
        await policy.getByRole('button', { name: t['groups.export.policyEnable'], exact: true }).waitFor();
        await page.screenshot({ path: resolve(dir, `export-settings-${theme}-${language}.png`), fullPage: true });
        await details.getByRole('button', { name: t['botMode.closeDetails'], exact: true }).click();
        checks.push({ botModeSend: 'PASS', privateReadRequiresReview: true, revokeInBotMode: 'PASS' });
      }
      checks.push({ theme, language, collapsedReview: true, legacyFirstClick: index === 0, outcome: index === 0 ? 'settings-policy-and-exact-once' : 'rejected', plaintextOnly: true });
      await context.close();
    }
    for (const batch of botMode ? report.multi ?? [] : []) {
      const narrow = batch.deliveries.length === 6;
      const language = narrow ? 'en' : 'zh';
      const t = JSON.parse(await readFile(resolve(`packages/dsh-bot/locale/${language}.json`))).ui;
      const context = await browser.newContext({ locale: narrow ? 'en-US' : 'zh-CN', colorScheme: narrow ? 'dark' : 'light',
        viewport: { width: narrow ? 390 : 1280, height: 800 } });
      const page = await context.newPage(); page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'group-export-batch');
      const selector = page.locator('[data-bot-mode-sidebar]:visible');
      if (narrow) {
        await page.getByRole('button', { name: t['botMode.backToList'], exact: true }).click();
      } else if (await selector.count() === 0) {
        await page.locator('[data-bot-mode-switch-button]:visible').first().click();
        await page.getByRole('menuitem', { name: t['botMode.botMode'], exact: true }).click();
      }
      await selector.getByRole('navigation').getByRole('button', { name: batch.name, exact: true }).click();
      const queue = page.locator(`[data-group-export-queue="${batch.key.groupId}"]:visible`);
      const toggle = queue.getByRole('button', { name: t['groups.export.queueCount'].replace('{count}', String(batch.deliveries.length)), exact: true });
      await toggle.click();
      const rows = batch.deliveries.map(id => queue.locator(`[data-group-export-review="${id}"]`));
      const verifyReceipt = async (id, code) => {
        const receipt = queue.locator(`[data-export-receipt="${id}"]`);
        await receipt.waitFor();
        assert.equal(await receipt.textContent(), t[`groups.export.receipt.${code}`]);
      };
      await rows[0].getByRole('button', { name: t['groups.export.review'], exact: true }).click();
      await rows[0].getByRole('button', { name: t['groups.export.allow'], exact: true }).click();
      await verifyReceipt(batch.deliveries[0], 'sent');
      assert.equal(await queue.locator('button[aria-controls]').first().getAttribute('aria-expanded'), 'true');
      const toSend = narrow ? rows.slice(1, -1) : rows.slice(1);
      for (const row of toSend) {
        await row.getByRole('button', { name: t['groups.export.review'], exact: true }).click();
        await row.getByRole('checkbox').check();
      }
      await queue.getByRole('button', { name: t['groups.export.batchOnce'].replace('{count}', String(toSend.length)), exact: true }).click();
      for (const id of batch.deliveries.slice(1, narrow ? -1 : undefined)) await verifyReceipt(id, 'sent');
      if (narrow) {
        await rows.at(-1).getByRole('button', { name: t['groups.export.reject'], exact: true }).click();
        await verifyReceipt(batch.deliveries.at(-1), 'rejected');
      }
      assert.equal(await queue.locator('[data-export-receipt]').count(), batch.deliveries.length);
      await page.screenshot({ path: resolve(dir, `batch-${batch.deliveries.length}-${language}.png`), fullPage: true });
      checks.push({ batchSize: batch.deliveries.length, retainedPanel: true, mixedReject: narrow, viewport: page.viewportSize() });
      await context.close();
    }
    assert.deepEqual(errors, []); await writeFile(resolve(dir, 'browser.json'), JSON.stringify({ status: 'PASS', checks, errors }, null, 2));
  } catch (e) {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      await writeFile(resolve(dir, 'browser-failure.txt'), (await page.locator('body').innerText()).slice(0,30000));
      await page.screenshot({ path: resolve(dir, 'browser-failure.png'), fullPage: true });
    }
    throw e;
  } finally { await browser.close(); }
}
