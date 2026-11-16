import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

const root = process.cwd();
process.env.DSH_BOT_APPROVAL_DIR ??= '.dsh-dev/bot-mode-validation-c';
const base = resolve(root, process.env.DSH_BOT_APPROVAL_DIR);
assert.ok(base.startsWith(`${root}/.dsh-dev/bot-mode-validation-`), 'Lifecycle starts/stops only an explicitly isolated validation service');
const artifact = resolve(root, process.env.DSH_BOT_LIFECYCLE_ARTIFACT ?? '.dsh-dev/bot-mode-delivery/approved-PSd3Of/dsh-bot-0.6.6.tgz');
const expectedSha = process.env.DSH_BOT_LIFECYCLE_SHA256 ?? 'ddb986f546d6a2975b8f7a736a980c64aa048b752401af099659c318bfafce9e';
assert.ok(artifact.startsWith(`${root}/.dsh-dev/`));
assert.equal(createHash('sha256').update(await readFile(artifact)).digest('hex'), expectedSha);
const { startApproval, stopApproval } = await import('./bot-mode-approval.mjs');
const dir = resolve(base, 'lifecycle-evidence', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
process.env.TMPDIR = resolve(base, 'tmp');
await mkdir(process.env.TMPDIR, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
const executablePath = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
  .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync);
assert.ok(executablePath);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
const checks = [], errors = [], screenshots = [], apiResponses = [], factoryResponses = [];
const expectedResponses = {};
const liveReconnect = process.env.DSH_BOT_LIFECYCLE_LIVE_RECONNECT === '1';
let browser, page, peer, state, phase = 'start', stopped = false, pageOrdinal = 0;
const log = value => console.log(JSON.stringify(value));
const check = (name, condition, details) => { assert.ok(condition, details ? `${name}: ${JSON.stringify(details)}` : name); checks.push({ name, status: 'PASS', ...(details && { details }) }); log({ check: name, status: 'PASS' }); };
const waitFor = async (name, test, timeout = 45000) => { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await test()) return; } catch {} await delay(100); } throw new Error(`Timed out: ${name}`); };
const shot = async name => { const file = `${name}.png`; await page.screenshot({ path: resolve(dir, file), fullPage: true, animations: 'disabled', timeout: 5000 }); screenshots.push(file); };
const shell = target => target.locator('[data-bot-mode-sidebar]');
const chat = target => target.locator('[data-bot-mode-object="bot"]');
const select = async (target, name) => { await shell(target).getByRole('navigation').getByRole('button', { name: new RegExp(`^${name}`) }).first().click(); await waitFor(`selected ${name}`, async () => await chat(target).locator('[data-bot-mode-title]').textContent() === name); };
const openModeSettings = async target => {
  if (await shell(target).isVisible().catch(() => false)) {
    await shell(target).locator('[data-bot-mode-switch-button]').click();
    await target.getByRole('menuitem', { name: '模式设置', exact: true }).click();
  }
  else {
    const plugins = target.getByRole('button', { name: /插件|Plugins/ }).first();
    if (await plugins.isVisible().catch(() => false)) await plugins.click();
  }
  const settings = target.locator('[data-supergroup-settings]');
  if (!await settings.isVisible().catch(() => false)) {
    const entry = target.getByRole('button', { name: '查看 DSH-Bot 个人智能体', exact: true });
    await entry.waitFor({ state: 'visible' }); await entry.click();
  }
  await settings.waitFor({ state: 'visible' });
  return settings.getByRole('switch', { name: 'Supergroup 协作', exact: true });
};
const inspectNativeControls = async (target, label) => {
  const current = chat(target);
  const model = current.getByRole('button', { name: /^选择模型，当前/ });
  const permission = current.getByRole('button', { name: /^访问模式，当前/ });
  await model.waitFor(); await permission.waitFor();
  assert.ok(await model.isEnabled() && await permission.isEnabled());
  await model.click(); await target.getByRole('menu').last().waitFor({ state: 'visible' });
  check(`${label}: native model menu opens`, true); await target.keyboard.press('Escape');
  await permission.click(); await target.getByRole('menu').last().waitFor({ state: 'visible' });
  check(`${label}: native permission menu opens`, true); await target.keyboard.press('Escape');
  const composer = current.locator('[contenteditable="true"]:visible').first();
  const draft = `重连可编辑草稿-${label}`; await composer.fill(draft);
  check(`${label}: native conversation accepts an editable draft`, (await composer.textContent()) === draft);
  await composer.fill('');
};
const newPage = async context => {
  const target = await context.newPage(); target.setDefaultTimeout(20000);
  const windowName = ++pageOrdinal === 1 ? 'primary' : 'peer';
  target.on('pageerror', error => errors.push({ window: windowName, phase, at: Date.now(), message: redact(error.stack ?? error) }));
  target.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api') && response.ok()) apiResponses.push({ window: windowName, at: Date.now(), path, status: response.status() });
    if (path === '/plugins/' && /javascript/.test(response.headers()['content-type'] ?? '')) void response.text().then(body => {
      for (const [id, contents] of Object.entries(expectedResponses)) if (body.includes(contents)) factoryResponses.push({ window: windowName, id });
    }).catch(() => {});
  });
  await target.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await installOverlayHandler(target, () => {});
  await target.goto(state.url, { waitUntil: 'domcontentloaded' });
  await dismissFirstRunOverlays(target, () => {}, 'bot-mode-lifecycle');
  await shell(target).waitFor();
  await waitFor(`${windowName} actual same-package Client responses`, () => Object.keys(expectedResponses).every(id => factoryResponses.some(row => row.window === windowName && row.id === id)));
  check(`${windowName}: actual HTTP factories match all five frozen Client files`, true);
  return target;
};
try {
  state = await startApproval({ artifact, enable: true });
  check('frozen artifact SHA and independent rc.2 Host', state.artifactSha256 === expectedSha && state.version === '0.2.1-rc.2');
  const initialPid = state.pid;
  const initialFixture = await json(resolve(base, 'fixture.json'));
  await writeFile(resolve(dir, 'initial-fixture.json'), JSON.stringify(initialFixture, null, 2));
  const initialGraph = await json(resolve(base, 'client-provenance.json'));
  await writeFile(resolve(dir, 'client-graph-before-restart.json'), JSON.stringify(initialGraph, null, 2));
  assert.equal(Object.keys(initialGraph).length, 5);
  for (const [id, resource] of Object.entries(initialGraph)) {
    const bytes = await readFile(resource.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), resource.sha256);
    expectedResponses[id] = bytes.toString().trimEnd().replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*$/u, '').trimEnd();
    assert.ok(Number.isFinite(resource.mtimeMs) && Number.isFinite(resource.ctimeMs), 'Client graph must include native artifact revision metadata');
  }
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: { ...process.env, TMPDIR: resolve(base, 'tmp') } });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1360, height: 980 }, reducedMotion: 'reduce' });
  page = await newPage(context); await select(page, '通用助手');
  await inspectNativeControls(page, 'initial');
  peer = await newPage(context); await select(peer, '研究员');
  phase = 'pin-and-memory'; log({ phase });
  const researchRow = () => shell(page).locator('[data-bot-mode-row]').filter({ has: page.getByRole('button', { name: '研究员', exact: true }) });
  await researchRow().locator('[data-bot-mode-object-menu]').click();
  await page.getByRole('menuitem', { name: '置顶 研究员', exact: true }).click();
  check('pin moves selected object before ordinary activity', (await shell(page).locator('[data-bot-mode-row] .dsh-bot-mode-contact').first().textContent()).includes('研究员'));
  await researchRow().locator('[data-bot-mode-object-menu]').click();
  await page.getByRole('menuitem', { name: '取消置顶 研究员', exact: true }).click();
  await select(page, '研究员');
  await chat(page).locator('[data-bot-mode-details]').click();
  const details = page.locator('[data-bot-mode-details-panel]'); await details.waitFor();
  check('Bot details identifies current Bot and avatar', await details.locator('[data-bot-mode-profile]').getByText('研究员', { exact: true }).isVisible()
    && await details.locator('[data-bot-mode-profile] [data-bot-id="local-research"]').count() === 1);
  await details.getByRole('button', { name: '管理已保存的记忆', exact: true }).click();
  await page.locator('[data-memory-embedded]').waitFor();
  check('memory entry opens current Bot detail', (await page.locator('[data-bots-page]').textContent()).includes('研究员'));
  await shot('current-bot-memory');
  await select(page, '通用助手');
  phase = 'ui-switch-off-and-peer'; log({ phase });
  const toggle = await openModeSettings(page);
  await waitFor('switch ready', () => toggle.isEnabled());
  check('UI exposes one confirmed enabled Supergroup switch', await toggle.getAttribute('aria-checked') === 'true');
  await toggle.click();
  await waitFor('local native sidebar restored', async () => await shell(page).count() === 0);
  await waitFor('peer native sidebar restored', async () => await shell(peer).count() === 0);
  check('single UI switch disables mode across windows', await shell(page).count() === 0 && await shell(peer).count() === 0);
  await shot('mode-off-native');
  phase = 'unknown-native-session'; log({ phase });
  // Native New after mode exit uses its public action. The new durable blank
  // Session is sufficient to test unknown-object navigation without a model.
  await peer.bringToFront();
  const knownSessions = new Set(await readdir(resolve(base, 'storage/session_projcache/sessions')));
  await peer.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const ordinaryComposer = peer.locator('[contenteditable="true"]:visible').first(); await ordinaryComposer.waitFor();
  await waitFor('new ordinary Session durable identity', async () => (await readdir(resolve(base, 'storage/session_projcache/sessions'))).some(file => !knownSessions.has(file)));
  check('mode off restores native New and creates a distinct durable conversation', await ordinaryComposer.isVisible());
  await page.bringToFront();
  await waitFor('disabled switch', async () => await toggle.getAttribute('aria-checked') === 'false');
  await toggle.click();
  await waitFor('local Bot navigation restored', async () => await shell(page).isVisible());
  await waitFor('peer Bot navigation restored', async () => await shell(peer).isVisible());
  await peer.locator('[data-bot-mode-unavailable]').waitFor();
  check('unknown ordinary Session shows object guard after enabling', (await peer.locator('[data-bot-mode-unavailable]').textContent()).includes('无法核实'));
  check('unknown Session cannot display native composer in Bot mode', await peer.locator('[contenteditable="true"]:visible').count() === 0);
  await select(peer, '研究员'); await select(page, '通用助手');
  check('re-enabling keeps each window object independent', await chat(peer).locator('[data-bot-mode-title]').textContent() === '研究员' && await chat(page).locator('[data-bot-mode-title]').textContent() === '通用助手');
  phase = 'manual-group-panels-and-archive'; log({ phase });
  const groupName = `生命周期验收群 ${Date.now()}`;
  await shell(page).locator('[data-bot-mode-add-menu]').click();
  await page.getByRole('menuitem', { name: '手动建群', exact: true }).click();
  const form = page.getByRole('form', { name: '新建群聊', exact: true }); await form.waitFor();
  await form.getByRole('textbox', { name: '群名称', exact: true }).fill(groupName);
  await form.getByRole('checkbox', { name: /通用助手/ }).check();
  await form.getByRole('checkbox', { name: /研究员/ }).check();
  await form.getByRole('checkbox', { name: '我确认新成员可看到群内已有历史。', exact: true }).check();
  await form.getByRole('button', { name: '保存', exact: true }).click();
  const groupChat = page.locator('[data-bot-mode-object="group"]'); await groupChat.waitFor();
  check('manual group creation reuses public UI and native conversation', await groupChat.locator('[data-bot-mode-title]').textContent() === groupName);
  await groupChat.locator('[data-bot-mode-details]').click(); await details.waitFor();
  await details.getByRole('button', { name: '成员', exact: true }).click();
  await waitFor('real group members loaded', async () => (await details.textContent()).includes('研究员'));
  check('group members panel is reachable with real member identity', (await details.textContent()).includes('研究员'));
  await details.getByRole('button', { name: '资料', exact: true }).click();
  await waitFor('group materials scope loaded', async () => (await details.textContent()).includes('本工作共享输入'));
  check('group materials panel states existing authorized scope', (await details.textContent()).includes('本工作共享输入'));
  await shot('manual-group-materials');
  const groupRow = shell(page).locator('[data-bot-mode-row]').filter({ has: page.getByRole('button', { name: groupName, exact: true }) });
  await groupRow.locator('[data-bot-mode-object-menu]').click();
  const archive = page.getByRole('menuitem', { name: `归档 ${groupName}`, exact: true }); await waitFor('idle archive enabled', () => archive.isEnabled());
  await archive.click();
  await waitFor('archived group leaves navigation', async () => await groupRow.count() === 0);
  const storedGroup = Object.values((await json(resolve(base, 'storage/dsh_bot_groups.json'))).tables.groups).find(row => row.name === groupName);
  check('archive keeps durable group record and sets archive state', storedGroup?.archived === true);
  await select(page, '研究员');
  phase = liveReconnect ? 'live-reconnect' : 'cold-restart'; log({ phase });
  await writeFile(resolve(dir, 'bindings-before-restart.json'), await readFile(resolve(base, 'storage/dsh_bot_main_session.json')));
  const beforeProjections = {};
  for (const [bot, id] of Object.entries(initialFixture.sessions)) {
    const projection = await json(resolve(base, 'storage/session_projcache/sessions', `${id}.json`)).catch(() => undefined);
    beforeProjections[bot] = { sessionId: id, identity: projection?.record?.identity, agentPreset: projection?.record?.rows?.agentPreset?.val };
  }
  await writeFile(resolve(dir, 'main-projections-before-restart.json'), JSON.stringify(beforeProjections, null, 2));
  // This is a cold-start check, not native Client hot-module replacement.
  // Leave the old app before its Host disappears; keep the same browser tabs
  // and origin-scoped sessionStorage for precise object restoration.
  if (!liveReconnect) { await page.goto('about:blank'); await peer.goto('about:blank'); }
  await stopApproval();
  const restartBegan = Date.now();
  state = await startApproval({ artifact });
  check('cold restart uses a new independent Host process', state.pid !== initialPid);
  const restoredFixture = await json(resolve(base, 'fixture.json'));
  await writeFile(resolve(dir, 'restored-fixture.json'), JSON.stringify(restoredFixture, null, 2));
  const restoredGraph = await json(resolve(base, 'client-provenance.json'));
  await writeFile(resolve(dir, 'client-graph-after-restart.json'), JSON.stringify(restoredGraph, null, 2));
  assert.deepEqual(restoredGraph, initialGraph, 'Same artifact restart must preserve all five Client graph paths, bytes, hashes and revision timestamps');
  check('same package restart preserves five Client graph hashes and file stats', true, restoredGraph);
  await writeFile(resolve(dir, 'bindings-after-restart.json'), await readFile(resolve(base, 'storage/dsh_bot_main_session.json')));
  check('Host restores enabled mode from native persisted config', restoredFixture.supergroupEnabled === true);
  check('Host main bindings survive actual process restart', JSON.stringify(restoredFixture.sessions) === JSON.stringify(initialFixture.sessions), { before: initialFixture.sessions, after: restoredFixture.sessions });
  if (liveReconnect) {
    // An unchanged screenshot is insufficient: both original windows must
    // receive a successful API response from the newly started Host, then
    // expose their original object and native composer without navigation.
    await waitFor('both original windows reconnect to new Host API', () => ['primary', 'peer'].every(window =>
      apiResponses.some(row => row.window === window && row.at >= restartBegan)), 60000);
    for (const [window, target] of [['primary', page], ['peer', peer]]) {
      await waitFor(`${window} object and composer recover automatically`, async () =>
        await shell(target).isVisible() && await chat(target).locator('[data-bot-mode-title]').textContent() === '研究员'
        && await chat(target).locator('[contenteditable="true"]:visible').first().isVisible(), 60000);
      check(`${window} old window automatically restores Bot and native composer`, true);
      await target.bringToFront(); await inspectNativeControls(target, window);
    }
    check('both old windows receive API responses after Host restart', true,
      apiResponses.filter(row => row.at >= restartBegan));
    await shot('live-restored-bot');
  } else {
    await page.goto(state.url, { waitUntil: 'domcontentloaded' }); await shell(page).waitFor();
    await chat(page).waitFor();
    check('same window returns to exact Bot after Host restart', await chat(page).locator('[data-bot-mode-title]').textContent() === '研究员');
    await shot('cold-restored-bot');
  }
  assert.deepEqual(errors, []);
  check('fixture proves no real model providers', restoredFixture.synthetic === true && restoredFixture.realModelRequests === 0);
} catch (error) {
  checks.push({ name: phase, status: 'FAIL', error: redact(error.stack ?? error) });
  if (peer) { await peer.screenshot({ path: resolve(dir, 'peer-failure.png'), fullPage: true, timeout: 5000 }).catch(() => {}); await peer.content().then(html => writeFile(resolve(dir, 'peer-failure.html'), redact(html))).catch(() => {}); }
  if (page) { await shot('failure').catch(() => {}); await page.content().then(html => writeFile(resolve(dir, 'failure.html'), redact(html))).catch(() => {}); }
  log({ phase, error: redact(error) });
} finally {
  await browser?.close();
  try { const result = await stopApproval(); stopped = result.stopped; } catch (error) { checks.push({ name: 'stop own independent service', status: 'FAIL', error: redact(error) }); }
  const result = { status: checks.some(row => row.status === 'FAIL') ? 'FAIL' : 'PASS', phase, artifactSha256: expectedSha,
    serviceBase: base, restartMode: liveReconnect ? 'live-reconnect-without-navigation' : 'cold-start', apiResponses, factoryResponses, temporaryDirectory: process.env.TMPDIR, checks, errors, screenshots, stoppedOwnService: stopped, scope: 'Real local Browser UI lifecycle; synthetic local adapter only' };
  await writeFile(resolve(dir, 'result.json'), JSON.stringify(result, null, 2));
  log({ status: result.status, checks: checks.length, dir, stoppedOwnService: stopped });
  if (result.status !== 'PASS') process.exitCode = 1;
}
