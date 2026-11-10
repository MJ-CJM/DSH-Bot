import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel, openSidebarSession } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const dir = resolve(root, '.dsh-dev/group-execution-ui', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
let host, browser, page, phase = 'host'; const errors = [], checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const checkUniqueConversationTabs = async (stage, t) => {
  for (const delay of [0, 100, 1000]) {
    if (delay) await page.waitForTimeout(delay);
    const labels = (await page.locator('[data-conversation-tabs]:visible [role="tab"]').allTextContents()).map(label => label.trim());
    const count = pattern => labels.filter(label => pattern.test(label)).length;
    check(`${stage} keeps one chat and management tab at ${delay}ms`, count(/^(?:Chat|对话)$/) === 1 && count(/^trajectory$|^轨迹$/i) <= 1 && labels.filter(label => label === t['groups.manage']).length === 1);
  }
};
try {
  host = await webHost(dir, 'group-api', process.env.DSH_BOT_ARTIFACT && resolve(process.env.DSH_BOT_ARTIFACT), resolve(root, 'packages/dsh-bot/tests/group-native-api-profile.mjs'), ['- id: agent-default-model', '  config:', '    provider: dp-b6b', '    model: fixture']);
  const fixture = JSON.parse(await readFile(resolve(dir, 'ui-fixture.json'), 'utf8'));
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const candidates = (await readdir(cache).catch(() => [])).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell')));
  const executablePath = process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync) ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
  const beforeTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env }); }
  finally { if (beforeTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = beforeTmp; }
  const matrix = ['en', 'zh'].flatMap(language => ['light', 'dark'].flatMap(theme => [1360, 390].map(width => ({ language, theme, width }))));
  if (process.env.DSH_BOT_UI_CASE) assert.ok(matrix.some(({ language, theme, width }) => `${language}-${theme}-${width}` === process.env.DSH_BOT_UI_CASE));
  for (const { language, theme, width } of matrix) {
    const id = `${language}-${theme}-${width}`;
    if (process.env.DSH_BOT_UI_CASE && process.env.DSH_BOT_UI_CASE !== id) continue;
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`), 'utf8')).ui;
    const context = await browser.newContext({ colorScheme: theme, locale: language === 'en' ? 'en-US' : 'zh-CN', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(`${phase}: ${error}`));
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') errors.push(`${phase}: ${message.text()}`); });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    phase = `${id}:open`; await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
    await dismissFirstRunOverlays(page, () => {}, 'group-api'); await openSidebarSession(page, fixture.rootId);
    await page.setViewportSize({ width, height: 1000 });
    const composer = page.locator('[data-workspace-group-composer]');
    const draft = composer.locator('textarea:visible'); await draft.fill(`draft-${id}`);
    const question = page.locator(`[data-workspace-group-message="${fixture.inputMessageId}"]`);
    const secondQuestion = page.locator(`[data-workspace-group-message="${fixture.secondInputMessageId}"]`);
    const execution = question.locator(`[data-group-turn="${fixture.turnId}"]`);
    const disclosure = execution.locator(':scope > button[aria-expanded]');
    await disclosure.waitFor();
    await secondQuestion.locator(`[data-group-turn="${fixture.secondTurnId}"]`).waitFor();
    check(`${id}: each question owns exactly its execution`, await question.locator('[data-group-turn]').count() === 1 && await secondQuestion.locator('[data-group-turn]').count() === 1);
    check(`${id}: composer contains no task list or status bars`, await composer.locator('[data-group-turn],[data-group-execution-card],[data-group-working]').count() === 0);
    check(`${id}: execution defaults to a collapsed line`, await disclosure.getAttribute('aria-expanded') === 'false');
    const composerHeight = (await composer.boundingBox()).height;
    const card = execution.locator('[data-group-execution-card]').filter({ hasText: 'api-alpha' }).last();
    const count = host.requests();
    phase = `${id}:expand`; await disclosure.click();
    check(`${id}: disclosure does not grow the composer`, Math.abs((await composer.boundingBox()).height - composerHeight) < 2);
    const inline = card.locator('[data-group-member-process]');
    await inline.getByText('Synthetic native reasoning', { exact: true }).waitFor();
    await inline.locator('[data-disclosure-row]').click();
    await inline.locator('.markdown-body, [class*="markdown"], p').filter({ hasText: 'Synthetic native reasoning' }).first().waitFor();
    check(`${id}: official reasoning is embedded under the correct member`, await inline.getAttribute('data-group-member-process') === fixture.childId);
    const human = await question.locator('[data-group-author="user"]').boundingBox();
    const bot = await page.locator('[data-group-author="bot"]').first().boundingBox();
    const frame = await question.boundingBox();
    check(`${id}: user right and bots left`, human.x > bot.x + 10 && Math.abs(human.x + human.width - frame.x - frame.width) < 8);
    check(`${id}: inline process remains left`, (await inline.boundingBox()).x < human.x);
    check(`${id}: message and reasoning fit the viewport`, await question.evaluate(el => el.scrollWidth <= el.clientWidth + 2));
    await page.screenshot({ path: resolve(dir, `${id}-inline.png`), fullPage: true });
    await disclosure.click(); check(`${id}: user can collapse execution`, await disclosure.getAttribute('aria-expanded') === 'false');
    await disclosure.focus(); await disclosure.press('Enter');
    check(`${id}: keyboard can expand execution`, await disclosure.getAttribute('aria-expanded') === 'true');
    await card.getByRole('button', { name: t['execution.viewDetails'], exact: true }).click();
    const embedded = page.locator(`[data-group-execution="${fixture.childId}"]`);
    await embedded.locator(`[data-conversation-content][data-conversation-session="${fixture.childId}"]`).waitFor();
    check(`${id}: native factory bound to exact child`, await embedded.getAttribute('data-group-execution') === fixture.childId);
    check(`${id}: no visible child composer`, await embedded.locator('[contenteditable="true"]:visible,textarea:visible').count() === 0);
    await embedded.getByText('Native result 2', { exact: false }).waitFor();
    await embedded.locator('[data-turn-process]').first().click();
    await embedded.locator('[data-process-activity="tools"]').click();
    await embedded.locator('[data-disclosure-row]').filter({ hasText: 'Synthetic native reasoning' }).first().click();
    await embedded.getByText('Synthetic native reasoning', { exact: true }).first().waitFor();
    await page.screenshot({ path: resolve(dir, `${id}.png`), fullPage: true });
    await writeFile(resolve(dir, `${id}-text.txt`), await embedded.innerText());
    check(`${id}: native reasoning present`, (await embedded.innerText()).includes('Synthetic native reasoning'));
    check(`${id}: native tool present`, (await embedded.innerText()).includes('group_message'));
    const background = await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor);
    await writeFile(resolve(dir, `${id}-theme.txt`), background);
    phase = `${id}:collapse`; await page.locator('[data-dockkit-tab-close]').last().click();
    check(`${id}: collapsed view unmounted`, await page.locator('[data-group-execution]').count() === 0);
    check(`${id}: group draft preserved`, await draft.inputValue() === `draft-${id}`);
    await card.getByRole('button', { name: t['execution.viewDetails'], exact: true }).click(); await embedded.locator('[data-conversation-content]').waitFor();
    check(`${id}: viewing and reopening do not execute models`, host.requests() === count);
    if (language === 'zh' && theme === 'dark' && width === 1360) {
      await page.locator('[data-dockkit-tab-close]').last().click();
      phase = `${id}:live`; await draft.fill('UI_LIVE_TRACE');
      await composer.getByRole('button', { name: t['groups.send'], exact: true }).click();
      const liveQuestion = page.locator('[data-workspace-group-message]').filter({ has: page.locator('[data-group-author="user"]', { hasText: 'UI_LIVE_TRACE' }) });
      await liveQuestion.locator('[data-group-turn] > button[aria-expanded]').click();
      const liveProcess = liveQuestion.locator('[data-group-member-process]');
      await liveProcess.nth(1).waitFor();
      for (const process of await liveProcess.all()) {
        const childId = await process.getAttribute('data-group-member-process');
        await process.getByText(`Live reasoning ${childId}`, { exact: true }).first().waitFor();
      }
      for (const process of await liveProcess.all()) {
        const childId = await process.getAttribute('data-group-member-process');
        await process.getByText(`Live reasoning ${childId} — streamed update`, { exact: true }).first().waitFor();
      }
      check('live concurrent reasoning follows each actual child', await liveProcess.count() === 2);
      const liveCount = host.requests();
      const liveCard = liveQuestion.locator('[data-group-execution-card]').first();
      const memberMenu = liveCard.getByRole('button', { name: new RegExp(t['execution.memberActions'].replace('{name}', '.+')) });
      await memberMenu.click(); await page.getByRole('menu').waitFor();
      await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'hidden' });
      check('native member menu supports Escape without stopping a task', host.requests() === liveCount);
      await draft.fill('Keep this supplement draft');
      await memberMenu.click(); await page.getByRole('menuitem', { name: t['groups.supplement'], exact: true }).click();
      check('member supplement focuses existing composer without sending', await draft.evaluate(el => el === document.activeElement) && await draft.inputValue() === 'Keep this supplement draft' && host.requests() === liveCount);
      await memberMenu.click(); await page.getByRole('menuitem', { name: t['execution.stopMember'], exact: true }).click();
      await liveCard.getByText(t['execution.memberStopped'], { exact: true }).waitFor();
      check('member stop leaves the other member running', await liveQuestion.locator('[data-group-execution-card]').filter({ hasText: t['groups.running'] }).count() === 1);

      await liveProcess.first().locator('[data-disclosure-row]').click();
      await liveQuestion.scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(dir, 'live-members.png'), fullPage: true });
      const liveDisclosure = liveQuestion.locator('[data-group-turn] > button[aria-expanded]');
      await liveDisclosure.click(); check('folding releases inline member views', await liveProcess.count() === 0);
      await liveDisclosure.click(); await liveProcess.nth(1).waitFor();
      check('reopening live reasoning does not execute models', host.requests() === liveCount);
      await liveQuestion.getByRole('button', { name: t['execution.stopTurn'], exact: true }).click();
    }
    const viewRequestCount = host.requests();
    const executionClose = page.locator('[data-rightbar-col] [data-dockkit-tab-close]:visible');
    if (await executionClose.count()) await executionClose.last().click();
    const managementTab = page.getByRole('tab', { name: t['groups.manage'], exact: true });
    if (await managementTab.isVisible()) {
      await managementTab.click();
    } else {
      await page.getByRole('button', { name: language === 'zh' ? '更多会话视图' : 'More conversation views', exact: true }).click();
      await page.getByRole('menuitem', { name: t['groups.manage'], exact: true }).click();
    }
    const management = page.locator('[data-group-view="dsh-bot-group-management"]');
    const members = management.locator('[data-group-member]');
    await members.first().waitFor();
    check('native members view shows real member configuration', await members.count() === 2);
    check(`${id}: management content is inset from the native view edge`, await management.evaluate(element => {
      const bounds = element.getBoundingClientRect(), content = element.querySelector('[data-group-overview]').getBoundingClientRect();
      return content.left - bounds.left >= 15 && bounds.right - content.right >= 15;
    }));
    await page.screenshot({ path: resolve(dir, 'group-members.png'), fullPage: true });
    phase = `${id}:management-activity`;
    await management.getByRole('tab', { name: t['groups.view.activity'], exact: true }).click();
    const runButton = management.locator(`[data-group-activity="${fixture.turnId}"]`).getByRole('button', { name: t['groups.viewRun'], exact: true });
    const statistics = management.locator('[data-group-statistics-bar]');
    const statisticsFor = turnId => management.locator(`[data-group-statistics-bar][data-statistics-scope="question"][data-statistics-turn="${turnId}"]`);
    await runButton.click();
    await statisticsFor(fixture.turnId).waitFor();
    check(`${id}: native run view focuses the selected question and scopes statistics without executing models`,
      await management.locator('[data-group-activity-focus]').getAttribute('data-group-activity-focus') === fixture.turnId && host.requests() === viewRequestCount);
    check(`${id}: management statistics retain borderless native-style pills`, await statistics.locator('button[aria-haspopup="dialog"]').evaluate(element => {
      const style = getComputedStyle(element);
      return ['flex', 'inline-flex'].includes(style.display) && parseFloat(style.borderTopWidth) === 0 && parseFloat(style.borderRadius) >= 6;
    }));
    await page.screenshot({ path: resolve(dir, 'group-runs.png'), fullPage: true });
    await statistics.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem').filter({ has: page.locator(`[data-statistics-question="${fixture.secondTurnId}"]`) }).click();
    await statisticsFor(fixture.secondTurnId).waitFor();
    check(`${id}: the question menu can manually scope statistics to the second run`, host.requests() === viewRequestCount);
    await runButton.click();
    await statisticsFor(fixture.turnId).waitFor();
    check(`${id}: viewing the first run again restores its statistics scope without executing models`, host.requests() === viewRequestCount);

    phase = `${id}:management-settings`;
    await management.getByRole('tab', { name: t['groups.view.settings'], exact: true }).click();
    const editGroup = management.getByRole('button', { name: t['groups.edit'], exact: true });
    await editGroup.waitFor();
    await page.screenshot({ path: resolve(dir, `${id}-group-management-settings.png`), fullPage: true });
    await editGroup.click();
    const editor = management.getByRole('form', { name: t['groups.edit'], exact: true });
    await editor.waitFor();
    check(`${id}: native management settings opens the editor for the selected group`, await editor.getByRole('textbox', { name: t['groups.name'], exact: true }).inputValue() === fixture.groupName);
    check(`${id}: reused editor controls retain their themed base styling`, await editor.getByRole('textbox', { name: t['groups.name'], exact: true }).evaluate(element => {
      const style = getComputedStyle(element);
      return parseFloat(style.borderRadius) >= 6 && parseFloat(style.paddingLeft) >= 8 && style.boxSizing === 'border-box';
    }));
    await page.screenshot({ path: resolve(dir, `${id}-group-management-editor.png`), fullPage: true });
    if (width === 390) {
      check(`${id}: native management settings and the group editor fit the viewport`, await management.evaluate(element =>
        element.scrollWidth <= element.clientWidth + 1 && document.scrollingElement.scrollWidth <= innerWidth + 1));
    }
    await editor.getByRole('button', { name: t['groups.close'], exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    check(`${id}: cancelling native group editing returns to settings without executing models`, await editGroup.isVisible() && host.requests() === viewRequestCount);
    if (id === 'en-light-1360') {
      await checkUniqueConversationTabs('active management view', t);
      await page.getByRole('tab', { name: 'Chat', exact: true }).click();
      await openBotsPanel(page, 'Bots');
      const botsPage = page.locator('[data-bots-page]:visible');
      await botsPage.getByRole('button', { name: t['groups.title'], exact: true }).click();
      phase = `${id}:directory-search`;
      const search = botsPage.getByRole('searchbox', { name: t['groups.search'], exact: true });
      await search.waitFor();
      check(`${id}: the directory search has one native wrapper border`, await search.evaluate(input =>
        getComputedStyle(input).borderTopWidth === '0px' && parseFloat(getComputedStyle(input.parentElement).borderTopWidth) > 0));
      await search.fill(fixture.groupName);
      await botsPage.locator('[data-group-directory-row]').filter({ hasText: fixture.groupName }).waitFor();
      const clear = botsPage.getByRole('button', { name: t['detail.clearSearch'], exact: true });
      await clear.waitFor();
      await page.screenshot({ path: resolve(dir, `${id}-group-directory-search.png`), fullPage: true });
      await search.press('Tab');
      check(`${id}: Tab reaches the directory search clear button`, await clear.evaluate(element => element === document.activeElement));
      await page.keyboard.press('Enter');
      check(`${id}: Enter clears the directory search and restores input focus`, await search.inputValue() === '' && await search.evaluate(element => element === document.activeElement));
      await search.fill(fixture.groupName);
      await search.press('Escape');
      check(`${id}: Escape clears the directory search and keeps input focus`, await search.inputValue() === '' && await search.evaluate(element => element === document.activeElement));
      phase = `${id}:directory-run`;
      await botsPage.locator('[data-group-directory-row]').first().click();
      const directoryOverview = botsPage.locator('[data-group-overview]');
      await directoryOverview.getByRole('tab', { name: t['groups.view.activity'], exact: true }).click();
      await directoryOverview.locator(`[data-group-activity="${fixture.turnId}"]`).getByRole('button', { name: t['groups.viewRun'], exact: true }).click();
      await page.waitForFunction(id => document.activeElement?.getAttribute('data-workspace-group-message') === id, fixture.inputMessageId);
      await page.waitForFunction(() => {
        const rect = document.activeElement?.querySelector('[data-group-turn]')?.getBoundingClientRect();
        return rect && rect.top >= 0 && rect.bottom <= innerHeight;
      });
      const inlineRun = page.locator(`[data-workspace-group-message="${fixture.inputMessageId}"] [data-group-turn="${fixture.turnId}"]`);
      await inlineRun.waitFor();
      check('directory activity focuses the exact inline question without executing models', host.requests() === viewRequestCount);
      check('directory activity preserves the native Chat view', await page.getByRole('tab', { name: 'Chat', exact: true }).getAttribute('aria-selected') === 'true');
      await checkUniqueConversationTabs('cold directory run', t);
      await page.screenshot({ path: resolve(dir, 'group-directory-run.png'), fullPage: true });
      await page.getByRole('tab', { name: t['groups.manage'], exact: true }).click();
      await page.getByRole('tab', { name: t['groups.view.members'], exact: true }).click();
      const followupMember = page.locator('[data-group-member]').filter({ hasText: 'api-alpha' });
      phase = `${id}:ask-draft`;
      await followupMember.getByRole('button', { name: t['execution.memberActions'].replace('{name}', 'api-alpha'), exact: true }).click();
      await page.getByRole('menuitem', { name: t['groups.askInChat'], exact: true }).click();
      await page.waitForFunction(rootId => [...document.querySelectorAll('[data-conversation-content]')]
        .some(element => element.checkVisibility() && element.getAttribute('data-conversation-session') !== rootId), fixture.rootId);
      const privateContent = page.locator('[data-conversation-content]:visible').last();
      check('follow-up opens the Bot conversation rather than the group root', await privateContent.getAttribute('data-conversation-session') !== fixture.rootId);
      const privateDraft = page.locator('[contenteditable="true"]:visible').first();
      await privateDraft.waitFor();
      await page.waitForFunction(rootId => [...document.querySelectorAll('[contenteditable="true"]')].some(element =>
        element.checkVisibility() && element.textContent?.includes('bot_group_recall') && element.textContent.includes(rootId)), fixture.rootId);
      check('follow-up draft keeps the group source reference outside the copied transcript', !(await privateDraft.innerText()).includes('UI_TRACE'));
      check('follow-up initializes a native draft without executing models', host.requests() === viewRequestCount);
      await page.screenshot({ path: resolve(dir, 'group-ask-draft.png'), fullPage: true });
      await privateDraft.press('ControlOrMeta+A'); await privateDraft.press('Backspace');
      check('clearing the follow-up draft does not send it', host.requests() === viewRequestCount);
      phase = `${id}:ask-return`;
      await openSidebarSession(page, fixture.rootId);
      await page.getByRole('tab', { name: 'Chat', exact: true }).click();
      const imageQuestion = page.locator('[data-workspace-group-message]').filter({ has: page.locator('[data-group-author="user"]', { hasText: 'UI_IMAGE_PREVIEW' }) });
      const openImage = imageQuestion.getByRole('button', { name: t['groups.openAttachment'].replace('{name}', 'ui-preview.png'), exact: true });
      await openImage.waitFor();
      const previewRequests = host.requests();
      await openImage.click();
      const imageDialog = page.getByRole('dialog', { name: t['groups.imagePreview'], exact: true });
      await imageDialog.waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] img')].some(image => image.complete && image.naturalWidth > 0));
      await page.screenshot({ path: resolve(dir, 'group-image-preview.png'), fullPage: true });
      await page.keyboard.press('Escape'); await imageDialog.waitFor({ state: 'hidden' });
      check('native image preview loads the actual attachment without new model requests', host.requests() === previewRequests);
    }
    await context.close(); page = undefined;
  }
  check('browser reports no uncaught errors', errors.length === 0);
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'PASS', checks, errors, modelRequestsAfter: host.requests(), fixture }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', dir }));
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(dir, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(resolve(dir, 'failure-text.txt'), await page.locator('body').innerText().catch(() => '')); await writeFile(resolve(dir, 'failure-dom.html'), await page.locator('body').innerHTML().catch(() => '')); }
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'FAIL', phase, error: String(error), errors, checks }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', phase, error: String(error), dir })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
