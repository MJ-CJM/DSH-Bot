import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel, openSidebarSession } from './deepening/sidebar-session.mjs';
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
  await botsPanel.getByRole('button', { name: t['groups.create'], exact: true }).click();
  const create = botsPanel.getByRole('form', { name: t['groups.create'], exact: true });
  const members = Object.keys(fixture.sessions);
  assert.equal(members.length, 4);
  await create.getByRole('textbox', { name: t['groups.name'], exact: true }).fill('Sidebar Avatar Group');
  for (const member of members) await create.getByRole('checkbox', { name: new RegExp(`\\(${member}\\)$`) }).check();
  await create.getByRole('checkbox', { name: t['groups.historyConsent'], exact: true }).check();
  await create.getByRole('button', { name: t['integrations.save'], exact: true }).click();
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
