import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBotsPanel } from './deepening/sidebar-session.mjs';

/** Actual shipped Client and Remote only; the caller owns Host/browser lifecycle and locale/theme matrix. */
export async function verifyPage({ page, t, hostReceipt, outputDir, checks }) {
  const receipt = hostReceipt.recipes ?? hostReceipt;
  const groupId = receipt.group.groupId;
  const prefix = `recipes-${Date.now()}`;
  const screenshots = [];
  const check = (name, value = true) => { assert.ok(value, name); if (Array.isArray(checks)) checks.push(name); };
  const shot = async name => {
    const path = resolve(outputDir, `${prefix}-${name}.png`);
    await page.screenshot({ path, fullPage: true }); screenshots.push(path);
  };
  // Use the published mode switcher when this run begins in Bot mode.
  await page.locator('[data-bot-mode-switch][data-mode-known]:not([data-mode-state="starting"])').first().waitFor();
  const botSidebar = page.locator('[data-bot-mode-sidebar]:visible');
  if (await botSidebar.count()) {
    await page.locator('[data-bot-mode-switch-button]:visible').click();
    await page.getByRole('menuitem', { name: t['botMode.standardMode'], exact: true }).click();
    await botSidebar.waitFor({ state: 'hidden' });
  }
  await openBotsPanel(page, t['bots.title']);
  const panel = page.locator('[data-bots-page]:visible');
  await panel.getByRole('navigation', { name: t['navigation.sections'], exact: true })
    .getByRole('button', { name: t['groups.title'], exact: true }).click();
  await panel.locator(`[data-group-directory-row="${groupId}"]`).click();
  const overview = panel.locator(`[data-group-overview="${groupId}"]`);
  await overview.waitFor();
  await overview.getByRole('button', { name: t['card.more'], exact: true }).click();
  await page.getByRole('menuitem', { name: t['teams.title'], exact: true }).click();
  let dialog = overview.locator('[data-team-recipes]'); await dialog.waitFor();
  const name = `Browser recipe ${prefix}`;
  await dialog.getByLabel(t['teams.name'], { exact: true }).fill(name);
  await dialog.getByRole('button', { name: t['teams.capture'], exact: true }).click();
  await dialog.locator('[data-team-preview]').waitFor();
  check('real Remote captures and previews a v1 team', (await dialog.locator('[data-team-preview] select').count()) === 2);
  const selects = dialog.locator('[data-team-preview] select');
  const firstValue = await selects.nth(0).inputValue(), secondValue = await selects.nth(1).inputValue();
  await selects.nth(0).selectOption(secondValue);
  await dialog.getByRole('button', { name: t['teams.capture'], exact: true }).click({ trial: true });
  check('duplicate role mapping blocks apply', !await dialog.getByRole('button', { name: t['teams.apply'], exact: true }).isEnabled());
  await selects.nth(1).selectOption(firstValue);
  await dialog.getByRole('button', { name: t['teams.apply'], exact: true }).click({ trial: true });
  check('manual role remapping resolves to unique existing Bots');
  await shot('mapping');
  // Capture current preferences again so subsequent export/import/apply preserves the original mapping.
  await dialog.getByRole('button', { name: t['teams.capture'], exact: true }).click();
  await dialog.locator('[data-team-preview]').waitFor();
  await dialog.getByRole('button', { name: t['teams.save'], exact: true }).click();
  await dialog.getByText(t['simple.savedTeams'], { exact: true }).click();
  await dialog.getByRole('button', { name, exact: true }).waitFor();
  check('real Remote persists the optional recipe');
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: t['teams.export'], exact: true }).click();
  const download = await downloadPromise, exportPath = resolve(outputDir, `${prefix}-export.json`);
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  check('download contains only portable allowed keys', JSON.stringify(Object.keys(exported).sort()) === JSON.stringify(['format', 'mode', 'name', 'onDemand', 'roles', 'version']));
  check('download has no private history, memory, credentials, paths or execution authority',
    !/"(?:history|memories|credentials|persona|cwd|rootSessionId|approval|authority)"/.test(JSON.stringify(exported)));
  await dialog.locator('[data-team-advanced] > summary').click();
  await dialog.locator('textarea').fill(JSON.stringify({ ...exported, version: 99 }));
  await dialog.getByRole('button', { name: t['teams.preview'], exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  check('unknown imported version is rejected by the shipped Client', await dialog.locator('[data-team-preview]').count() === 0);
  await shot('version-rejected');
  await dialog.locator('input[type=file]').setInputFiles(exportPath);
  await dialog.locator('[data-team-preview]').waitFor();
  check('exported JSON imports through actual file input');
  await dialog.getByRole('button', { name: t['teams.apply'], exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  check('apply returns to the current ordinary group');
  // Reopen the menu: persistence is read back through a new component/Remote request.
  await overview.getByRole('button', { name: t['card.more'], exact: true }).click();
  await page.getByRole('menuitem', { name: t['teams.title'], exact: true }).click();
  dialog = overview.locator('[data-team-recipes]'); await dialog.getByText(t['simple.savedTeams'], { exact: true }).click(); await dialog.getByRole('button', { name, exact: true }).waitFor();
  check('saved recipe survives closing and reopening the actual menu');
  await dialog.getByRole('button', { name: t['groups.close'], exact: true }).click();
  await overview.getByRole('tab', { name: t['groups.view.settings'], exact: true }).click();
  const toggle = overview.getByRole('checkbox', { name: t['teams.onDemand'], exact: true });
  const before = await toggle.isChecked(); await toggle.click();
  await toggle.waitFor({ state: 'visible' });
  await assertEnabled(toggle);
  check('ordinary group preference toggles through actual Remote', await toggle.isChecked() === !before);
  await shot('on-demand-setting');
  await toggle.click(); await assertEnabled(toggle);
  await overview.getByRole('tab', { name: t['groups.view.activity'], exact: true }).click();
  const audit = overview.locator('[data-group-routing]'); await audit.first().waitFor();
  check('actual Host selection and request counts are visible in group activity', (await audit.count()) >= 6);
  await shot('routing-audit');
  const groupName = await overview.locator('h3').first().innerText();
  await page.locator('[data-bot-mode-switch-button]:visible').click();
  await page.getByRole('menuitem', { name: t['botMode.botMode'], exact: true }).click();
  await botSidebar.waitFor();
  await botSidebar.getByRole('navigation').getByRole('button', { name: groupName, exact: true }).click();
  await page.locator('[data-bot-mode-details]').click();
  const drawer = page.locator('[data-bot-mode-details-panel]');
  await drawer.locator('[data-bot-mode-tab="settings"]').click();
  const direct = drawer.locator(`[data-group-overview="${groupId}"]`);
  const directToggle = direct.getByRole('checkbox', { name: t['teams.onDemand'], exact: true });
  await directToggle.waitFor();
  check('Bot drawer reuses the current group preference without a separate configuration copy', await directToggle.isChecked() === before);
  await directToggle.click(); await assertEnabled(directToggle);
  check('Bot drawer saves ordinary group routing directly', await directToggle.isChecked() === !before);
  await directToggle.click(); await assertEnabled(directToggle);
  await direct.getByRole('button', { name: t['teams.title'], exact: true }).click();
  const directRecipe = direct.locator('[data-team-recipes]');
  await directRecipe.locator('[data-team-preview]').waitFor();
  check('Bot drawer automatically previews current team with JSON editing collapsed', !await directRecipe.locator('textarea').isVisible());
  await shot('bot-direct-team');
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 640, height: 900 });
  await drawer.waitFor();
  check('Bot team drawer fits a narrow screen without page overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot('bot-direct-team-narrow');
  await page.setViewportSize(originalViewport);
  await directRecipe.getByRole('button', { name: t['groups.close'], exact: true }).click();
  await drawer.locator('[data-bot-mode-tab="tasks"]').click();
  await drawer.locator('[data-follow-up="detail"]').waitFor();
  check('Group follow-up is available directly in the Bot conversation drawer');
  await shot('bot-direct-followup');
  await drawer.getByRole('button', { name: t['botMode.closeDetails'], exact: true }).click();
  await botSidebar.locator('[data-bot-mode-settings]').click();
  await panel.waitFor();
  await panel.locator('[data-settings-navigation]').click();
  const directory = panel.getByRole('navigation', { name: t['navigation.sections'], exact: true });
  await directory.getByRole('button', { name: t['groups.title'], exact: true }).waitFor();
  check('Advanced settings retain visible navigation to Bots and groups');
  await botSidebar.locator('[data-bot-mode-settings]').click();
  await panel.locator('[data-bots-list="bots"]').waitFor();
  check('Direct work-management entry exits retained settings without requiring a mode switch');
  await shot('bot-work-management');
  return { status: 'PASS', exportPath, screenshots, groupId, realModelRequests: 0 };
}
async function assertEnabled(locator) {
  // Playwright's trial click waits for React's in-flight Remote update to re-enable the control.
  await locator.click({ trial: true });
}
