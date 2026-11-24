import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { botDirectoryMore, openBotsPanel, openSidebarSession, selectBotDirectoryAction } from './deepening/sidebar-session.mjs';
import { auditArtifact } from './p34-artifact.mjs';
import { scratch } from './proactive/worker.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
const [mode, tarball] = process.argv.slice(2);
assert.equal(mode, '--mock-only');
const artifact = resolve(tarball);
const dir = await scratch('native-bots-browser');
console.log(dir);
const fixtureSource = resolve('scripts/bot-mode-approval-profile.mjs');
const installedRoot = resolve(dir, 'home/profiles/b4-browser/node_modules/dsh-botgroup');
const fixtureEntry = resolve(dir, 'fixture-entry.mjs');
await writeFile(fixtureEntry, `
import { apply as mount } from ${JSON.stringify(fixtureSource)};
export { inject } from ${JSON.stringify(fixtureSource)};
export function apply(ctx, config) {
  return mount(ctx, { ...config, installedRoot: ${JSON.stringify(installedRoot)}, productPackageName: 'dsh-botgroup' });
}
`);
const audit = await auditArtifact(process.cwd(), artifact, dir);
const config = ['- id: agent-default-model', '  config:', '    provider: bot-mode-local', '    model: review', '- id: dsh-bot', '  config:', '    supergroup:', '      enabled: true', '      maxRequests: 24', '      timeoutMs: 120000'];
const boot = preserveProfile => webHost(dir, 'native-bots-workspace', artifact, fixtureEntry, config, { preserveProfile, artifactAudit: audit, mockModel: false });
const read = name => readFile(resolve(dir, name + '.json'), 'utf8').then(JSON.parse);
const until = async (name, test) => {
  const deadline = Date.now() + 25000;
  do {
    const value = await read(name).catch(() => undefined);
    if (value && test(value)) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${name}`);
};
const checks = [], errors = [];
const check = (name, ok) => { assert.ok(ok, name); checks.push(name); };
const t = JSON.parse(await readFile(resolve(dir, 'unpacked/package/locale/en.json'), 'utf8')).ui;
const screenshots = [];
let host, browser, page;
try {
  host = await boot(false);
  const initial = await read('fixture');
  check('initial creation and first boot use zero model calls', (await read('calls')).length === 0 && initial.supergroupEnabled);
  await host.stop();
  host = undefined;
  host = await boot(true);
  const fixture = await read('fixture');
  check('all four untouched Bot session IDs survive a cold Host restart', JSON.stringify(fixture.sessions) === JSON.stringify(initial.sessions));
  check('cold restart dispatches zero mock calls', (await read('calls')).length === 0 && host.requests() === 0);
  const { chromium } = createRequire(resolve('packages/dsh-bot/package.json'))('playwright-core');
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const executablePath = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync);
  assert.ok(executablePath, 'No cached Chromium');
  browser = await chromium.launch({ executablePath, env: host.env, chromiumSandbox: true, headless: true });
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1360, height: 950 }, colorScheme: 'light', reducedMotion: 'reduce' });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await installOverlayHandler(page, () => {});
  await page.goto(host.url, { waitUntil: 'domcontentloaded' });
  await dismissFirstRunOverlays(page, () => {}, 'native-bots-workspace');
  const botId = 'local-assistant', sessionId = fixture.sessions[botId];
  await openBotsPanel(page, t['bots.title']);
  const panel = page.locator('[data-bots-page]:visible');
  const sections = panel.getByRole('navigation', { name: t['navigation.sections'] });
  for (const [mode, title] of [['bots', t['navigation.myBots']], ['recent', t['chat.recent']]]) {
    await sections.getByRole('button', { name: title, exact: true }).click();
    const row = panel.locator(`[data-bots-list="${mode}"] [data-directory-kind="bot"][data-directory-id="${botId}"]`);
    await row.waitFor();
    check(`${mode}: only the conversation and More buttons are shown`, await row.getByRole('button').count() === 2);
    const more = botDirectoryMore(panel, botId);
    await more.click();
    const menu = page.getByRole('menu');
    const menuLabels = await menu.getByRole('menuitem').allTextContents();
    check(`${mode}: each action has exactly one menu entry`, ['chat.pin', 'chat.profile', 'actions.delete', ...(mode === 'recent' ? ['chat.hide'] : [])]
      .every(key => menuLabels.filter(label => label.trim() === t[key]).length === 1));
    await menu.getByRole('menuitem', { name: t['chat.profile'], exact: true }).click();
    await panel.locator(`[data-bot-detail="${botId}"]`).waitFor();
    await panel.getByRole('button', { name: t['navigation.returnTo'].replace('{name}', title), exact: true }).click();
    await more.waitFor();
    await page.waitForFunction(trigger => trigger === document.activeElement, await more.elementHandle());
    check(`${mode}: opening the profile and returning restores focus to More`, true);
    await selectBotDirectoryAction(panel, botId, t['chat.pin']);
    await row.locator('[data-directory-pinned]').waitFor();
    check(`${mode}: pinned label adds no duplicate button`, await row.getByRole('button').count() === 2);
    await selectBotDirectoryAction(panel, botId, t['chat.unpin']);
    await row.locator('[data-directory-pinned]').waitFor({ state: 'detached' });
    await selectBotDirectoryAction(panel, botId, t['actions.delete']);
    const confirmation = page.getByRole('dialog');
    await confirmation.getByRole('button', { name: t['actions.cancel'], exact: true }).click();
    await confirmation.waitFor({ state: 'hidden' });
    check(`${mode}: unpin and cancel deletion preserve the same Bot`, await row.isVisible());
  }
  await sections.getByRole('button', { name: t['navigation.myBots'], exact: true }).click();
  await page.locator(`[data-directory-id="${botId}"][data-directory-kind="bot"] [data-directory-open]`).click();
  const main = page.locator(`[data-conversation-content][data-conversation-session="${sessionId}"]:visible`);
  const editor = main.locator('[contenteditable="true"]:visible').first();
  await editor.waitFor();
  check('directory opens original untouched main with its Bot identity', await main.locator(`[data-bot-composer-identity="${botId}"]`).isVisible());
  check('directory navigation makes zero model calls', (await read('calls')).length === 0);
  await editor.fill('布局审批验收');
  await editor.press('Enter');
  const approval = main.locator('[data-approval-key]');
  await approval.getByRole('button', { name: 'Reject', exact: true }).click();
  const receipt = await until('native-approval', value => value.outcome === 'rejected');
  const asked = receipt.events.find(event => event.type === 'approval/asked');
  check('first native send retains original Bot preset and exact native approval', receipt.sessionId === sessionId &&
    receipt.events.some(event => event.type === 'approval/decided' && event.data.id === asked.data.id && event.data.outcome === 'rejected') &&
    (await read('calls')).some(row => row.sessionId === sessionId && row.preset.endsWith(botId)));
  await editor.waitFor();
  await main.getByText('【本地演示】原生审批已结束：rejected。', { exact: false }).waitFor();
  await openBotsPanel(page, t['bots.title']);
  await openSidebarSession(page, sessionId);
  await main.getByText('【本地演示】原生审批已结束：rejected。', { exact: false }).waitFor();
  check('native history reopens the same main and prior response', await main.isVisible());
  await editor.fill('请协作分析这份迁移的风险并邀请专家核对。');
  await editor.press('Enter');
  const works = await until('work-state', rows => rows.some(row => row.work.originSessionId === sessionId &&
    row.work.state === 'completed' && row.work.experts.length > 0 && row.group));
  const view = works.find(row => row.work.originSessionId === sessionId && row.work.state === 'completed' && row.group);
  const card = main.locator(`[data-supergroup-work="${view.work.id}"]`);
  await card.getByRole('button', { name: t['supergroup.viewDiscussion'], exact: true }).click();
  const group = page.locator(`[data-workspace-group-composer="${view.group.group.rootSessionId}"]`);
  await group.waitFor();
  await group.getByRole('textbox', { name: t['groups.message'] }).fill('补充一个验收条件，保持当前任务。');
  await group.getByRole('button', { name: t['groups.send'], exact: true }).click();
  const continued = await until('work-state', rows => rows.some(row => row.work.id === view.work.id &&
    row.work.groupInputs.some(input => input.state === 'completed')));
  check('automatic group input resumes the exact originating work', continued.some(row => row.work.id === view.work.id &&
    row.work.originSessionId === sessionId && row.work.groupInputs.some(input => input.state === 'completed')
    && row.group?.messages.some(message => message.authorKind === 'user' && message.text === '补充一个验收条件，保持当前任务。')));
  check('native group log root never invokes a model', (await read('calls')).every(row => row.sessionId !== view.group.group.rootSessionId));
  await page.locator(`[data-group-details-opener="${view.group.group.id}"]`).click();
  const details = page.locator(`[data-group-details="${view.group.group.id}"]:visible`);
  await details.getByRole('tab', { name: t['botMode.materials'] }).click();
  await details.locator('[data-work-materials]').waitFor();
  await details.getByRole('tab', { name: t['botMode.details'] }).click();
  await details.getByRole('button', { name: t['taskSupport.openOrigin'], exact: true }).click();
  await main.waitFor();
  check('native group details return to the originating conversation', await main.isVisible());

  const directRow = page.locator(`[data-row-key="session:${sessionId}"]`);
  const directAvatar = directRow.locator(`[data-bot-session-leading] [data-bot-id="${botId}"]`);
  await directAvatar.waitFor();
  check('the ordinary Bot keeps one 16px colored avatar', await directAvatar.count() === 1 &&
    (await directAvatar.boundingBox())?.width === 16 && await directRow.locator('[data-group-session-leading]').count() === 0);

  await openBotsPanel(page, t['bots.title']);
  const botsPanel = page.locator('[data-bots-page]:visible');
  await botsPanel.getByRole('navigation', { name: t['navigation.sections'], exact: true })
    .getByRole('button', { name: t['groups.title'], exact: true }).click();
  const members = Object.keys(fixture.sessions);
  assert.equal(members.length, 4);
  async function createFixtureGroup(name) {
    await botsPanel.getByRole('button', { name: t['groups.create'], exact: true }).click();
    const create = botsPanel.getByRole('form', { name: t['groups.create'], exact: true });
    await create.getByRole('textbox', { name: t['groups.name'], exact: true }).fill(name);
    for (const member of members) await create.getByRole('checkbox', { name: new RegExp(`\\(${member}\\)$`) }).check();
    await create.getByRole('checkbox', { name: t['groups.historyConsent'], exact: true }).check();
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/dshBot.groups/create')),
      create.getByRole('button', { name: t['integrations.save'], exact: true }).click(),
    ]);
    const result = (await response.json()).result;
    assert.ok(result?.ok, JSON.stringify(result));
    await page.locator(`[data-workspace-group-composer="${result.value.rootSessionId}"]:visible`).waitFor();
    return result.value;
  }
  const original = await createFixtureGroup('Sidebar Avatar Group');
  const ordinaryComposer = page.locator('[data-workspace-group-composer]:visible');
  await ordinaryComposer.waitFor();
  const rootSession = await ordinaryComposer.getAttribute('data-workspace-group-composer');
  assert.match(rootSession ?? '', /^group-root-/);
  // Native rows may prefer a status indicator while work is active. Let the
  // ordinary group acquire a user message and return to its idle row.
  await ordinaryComposer.getByRole('textbox', { name: t['groups.message'] }).fill('Sidebar avatar visual fixture');
  await ordinaryComposer.getByRole('button', { name: t['groups.send'], exact: true }).click();
  const groupRow = page.locator(`[data-row-key="session:${rootSession}"]`);
  const mark = groupRow.locator('[data-group-session-leading] [data-group-avatar="members"]');
  const readAvatar = async (theme, expected) => {
    await page.emulateMedia({ colorScheme: theme });
    await mark.waitFor();
    await page.waitForFunction(({ rootSession, theme, expected }) => {
      const icon = document.querySelector(`[data-row-key="session:${rootSession}"] [data-group-session-leading] [data-group-avatar="members"]`);
      const nodes = [...(icon?.querySelectorAll('[data-bot-avatar]') ?? [])];
      if (nodes.length !== expected.length || nodes.some(node => !expected.includes(node.dataset.botId))) return false;
      const rgb = getComputedStyle(nodes[0]).backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      return rgb?.length === 3 && (theme === 'dark' ? rgb.reduce((sum, value) => sum + value, 0) < 384 : rgb.reduce((sum, value) => sum + value, 0) > 384);
    }, { rootSession, theme, expected });
    const facts = await mark.evaluate(node => {
      const group = node.getBoundingClientRect();
      const members = [...node.querySelectorAll('[data-bot-avatar]')].map(tile => {
        const box = tile.getBoundingClientRect();
        return { id: tile.dataset.botId, color: getComputedStyle(tile).color,
          fits: box.width > 0 && box.height > 0 && box.left >= group.left && box.right <= group.right && box.top >= group.top && box.bottom <= group.bottom };
      });
      return { width: group.width, height: group.height, members };
    });
    assert.deepEqual(facts.members.map(member => member.id).sort(), [...expected].sort());
    assert.ok(facts.width === 16 && facts.height === 16 && facts.members.every(member => member.fits), 'Avatar tiles exceed the native icon bounds');
    assert.equal(new Set(facts.members.map(member => member.color)).size, expected.length, 'Member theme colors must remain visually distinct');
    const file = `sidebar-avatar-${theme}-${expected.length}.png`;
    await groupRow.screenshot({ path: resolve(dir, file) });
    screenshots.push(file);
    return facts;
  };
  const light = await readAvatar('light', members);
  const dark = await readAvatar('dark', members);
  check('four exact member avatars fit the native 16px row in light and dark themes', light.members.length === 4 && dark.members.length === 4);
  check('member colors adapt to the native theme', light.members.some((tile, index) => tile.color !== dark.members[index]?.color));

  const groupConversation = page.locator(`[data-conversation-content][data-conversation-session="${rootSession}"]:visible`);
  await groupConversation.locator('[data-statistics-status="idle"], [data-statistics-status="completed"]').waitFor();
  await page.getByRole('tab', { name: t['groups.manage'], exact: true }).click();
  const management = page.locator('[data-group-view="dsh-bot-group-management"]:visible');
  await management.getByRole('tab', { name: t['groups.view.settings'], exact: true }).click();
  await management.getByRole('button', { name: t['groups.edit'], exact: true }).click();
  const edit = management.getByRole('form', { name: t['groups.edit'], exact: true });
  const requestsBeforeEdit = (await read('calls')).length;
  await edit.getByRole('checkbox', { name: new RegExp(`\\(${members[0]}\\)$`) }).uncheck();
  await edit.getByRole('checkbox', { name: t['groups.historyConsent'], exact: true }).check();
  const [editResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/dshBot.groups/edit')),
    edit.getByRole('button', { name: t['integrations.save'], exact: true }).click(),
  ]);
  const savedEdit = await editResponse.json();
  assert.equal(savedEdit.result?.ok, true, JSON.stringify(savedEdit));
  await edit.waitFor({ state: 'hidden' });
  const changed = await readAvatar('dark', members.slice(1));
  check('member editing refreshes the native avatar without reloading or dispatching a model',
    changed.members.length === 3 && (await read('calls')).length === requestsBeforeEdit);

  const dialog = page.getByRole('dialog');
  const deleteLabel = t['groups.delete'];
  const groupRowIn = (list, record) => list.locator(`[data-directory-kind="group"][data-directory-id="${record.id}"][data-directory-created-at="${record.createdAt}"]`);
  const openSection = async key => {
    await openBotsPanel(page, t['bots.title']);
    await sections.getByRole('button', { name: t[key], exact: true }).click();
  };
  const chooseRowAction = async (row, label) => {
    await row.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole('menu').getByRole('menuitem', { name: label, exact: true }).click();
  };
  const confirmDelete = async record => {
    assert.ok((await dialog.innerText()).includes(record.name));
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/dshBot.groups/deleteGroup')),
      dialog.getByRole('button', { name: deleteLabel, exact: true }).click(),
    ]);
    const result = (await response.json()).result;
    assert.ok(result?.ok, JSON.stringify(result));
    await dialog.waitFor({ state: 'hidden' });
  };
  await management.getByRole('button', { name: deleteLabel, exact: true }).click();
  await dialog.getByRole('button', { name: t['actions.cancel'], exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  check('cancelling from group settings keeps the same group and session', await groupRow.isVisible() && await management.isVisible());

  await openSection('groups.title');
  const duplicate = await createFixtureGroup(original.name);
  assert.equal(duplicate.name, original.name);
  assert.notEqual(duplicate.rootSessionId, original.rootSessionId);
  const duplicateSidebar = page.locator(`[data-row-key="session:${duplicate.rootSessionId}"]`);
  await openSidebarSession(page, duplicate.rootSessionId);
  await duplicateSidebar.waitFor();
  await openSection('chat.recent');
  const recent = panel.locator('[data-bots-list="recent"]');
  await groupRowIn(recent, original).waitFor();
  await groupRowIn(recent, duplicate).waitFor();
  await chooseRowAction(groupRowIn(recent, duplicate), deleteLabel);
  await dialog.getByText(duplicate.id, { exact: true }).waitFor();
  await confirmDelete(duplicate);
  await groupRowIn(recent, duplicate).waitFor({ state: 'detached' });
  await duplicateSidebar.waitFor({ state: 'hidden' });
  await groupRowIn(recent, original).waitFor();
  check('deleting from Recent removes only the selected same-name group', await groupRowIn(recent, original).isVisible());

  await openSection('groups.title');
  const directory = panel.getByRole('region', { name: t['groups.list'], exact: true });
  check('group directory preserves the other group with the same name', await groupRowIn(directory, duplicate).count() === 0 && await groupRowIn(directory, original).isVisible());
  await chooseRowAction(groupRowIn(directory, original), t['chat.profile']);
  const overview = panel.locator(`[data-group-overview="${original.id}"]`);
  await overview.getByRole('button', { name: t['card.more'], exact: true }).click();
  const [archiveResult] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/dshBot.groups/archive')),
    page.getByRole('menu').getByRole('menuitem', { name: t['groups.archive'], exact: true }).click(),
  ]);
  const archiveReceipt = (await archiveResult.json()).result;
  assert.ok(archiveReceipt?.ok, JSON.stringify(archiveReceipt));
  await directory.getByRole('button', { name: t['groups.filter'], exact: true }).click();
  await page.getByRole('menu').getByText(t['groups.filter.archived'], { exact: true }).click();
  await groupRowIn(directory, original).getByText(t['groups.archived'], { exact: true }).waitFor();
  await chooseRowAction(groupRowIn(directory, original), deleteLabel);
  await confirmDelete(original);
  await groupRowIn(directory, original).waitFor({ state: 'detached' });
  await groupRow.waitFor({ state: 'hidden' });
  check('deletion removes the archived group from the Archived filter and native sidebar', true);
  await directory.getByRole('button', { name: t['groups.filter'], exact: true }).click();
  await page.getByRole('menu').getByText(t['groups.filter.all'], { exact: true }).click();
  await groupRowIn(directory, view.group.group).waitFor();
  check('All groups excludes both deleted groups and retains the independent automatic discussion',
    await groupRowIn(directory, original).count() === 0 && await groupRowIn(directory, duplicate).count() === 0);
  await chooseRowAction(groupRowIn(directory, view.group.group), deleteLabel);
  await dialog.getByText(t['groups.deleteManaged'], { exact: true }).waitFor();
  check('the automatic discussion explains its ownership and disables deletion',
    await dialog.getByRole('button', { name: deleteLabel, exact: true }).isDisabled());
  await dialog.getByRole('button', { name: t['actions.cancel'], exact: true }).click();
  await openSection('navigation.myBots');
  for (const member of members) await panel.locator(`[data-bots-list="bots"] [data-bot-id="${member}"][data-directory-open]`).waitFor();
  check('all member Bots remain available after group deletion', true);

  assert.deepEqual(errors, []);
  check('no private mode shell mounted', await page.locator('[data-bot-mode-switch-button], [data-bot-mode-sidebar]').count() === 0);
  await writeFile(resolve(dir, 'result.json'), JSON.stringify({ status: 'PASS', artifactSha256: audit.sha256, checks, screenshots, realModelRequests: 0 }, null, 2));
  console.log('NATIVE_BOTS_BROWSER_PASS');
} catch (error) {
  if (page) {
    await writeFile(resolve(dir, 'last-snapshot.txt'), await page.locator('body').ariaSnapshot()).catch(() => {});
    await page.screenshot({ path: resolve(dir, 'failure.png') }).catch(() => {});
  }
  await writeFile(resolve(dir, 'result.json'), JSON.stringify({ status: 'FAIL', checks, errors, error: String(error.stack) }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await host?.stop();
}
