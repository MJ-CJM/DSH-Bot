import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { openSidebarSession, openBotsPanel } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const artifactPath = process.env.DSH_BOT_ARTIFACT ? resolve(root, process.env.DSH_BOT_ARTIFACT) : undefined;
const dir = resolve(root, '.dsh-dev/simplified-bots-ui', `${Date.now()}-${process.pid}`); await mkdir(dir, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const allMatrix = ['en', 'zh'].flatMap(language => ['light', 'dark'].flatMap(theme => [1360, 390].map(width => ({ language, theme, width }))));
// FILTER=en-light-1360,zh-dark-390 runs only explicitly named debug cases; default remains all eight.
const filter = process.env.FILTER?.trim();
const selectedIds = filter ? [...new Set(filter.split(',').map(value => value.trim()).filter(Boolean))] : undefined;
if (selectedIds) assert.ok(selectedIds.length && selectedIds.every(id => allMatrix.some(item => `${item.language}-${item.theme}-${item.width}` === id)), 'FILTER must be a comma-separated list of exact matrix IDs');
const matrix = selectedIds ? allMatrix.filter(item => selectedIds.includes(`${item.language}-${item.theme}-${item.width}`)) : allMatrix;
const coverage = { mode: selectedIds ? 'filtered-debug' : 'full', totalCases: allMatrix.length, selectedCases: matrix.length, selectedIds, hostBudgetMs: 300000 };

const results = [], pageErrors = []; let host, browser, phase = 'host';
let artifact;
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
// Configure the real native permission service only in this isolated browser
// profile. Full access is advertised to exercise its cancel-only risk dialog.
const fixtureConfig = [
  '- id: permission', '  config:', '    defaultPreset: workspace-write', '    presets:',
  '      read-only:', '        sandbox: read-only', '        approval: ask', '        name: read-only',
  '      workspace-write:', '        sandbox: workspace-write', '        approval: ask', '        name: workspace-write',
  '      danger-full-access:', '        sandbox: danger-full-access', '        approval: never', '        name: danger-full-access',
];
try {
  artifact = { version: JSON.parse(await readFile(resolve(root, 'packages/dsh-bot/package.json'), 'utf8')).version,
    clientSha256: createHash('sha256').update(await readFile(resolve(root, 'packages/dsh-bot/lib/client.js'))).digest('hex') };
  host = await webHost(dir, 'simplified-bots-ui', artifactPath, resolve(root, 'packages/dsh-bot/tests/simplified-bots-ui-profile.mjs'), fixtureConfig);
  if (artifactPath) {
    // webHost audits source→tarball→installed bytes before starting the Web profile.
    const manifest = JSON.parse(await readFile(resolve(dir, 'artifact-manifest.json'), 'utf8'));
    artifact = { ...artifact, tarball: manifest.artifact, tarballSha256: manifest.sha256,
      installedBytesVerified: true, packedClientSha256: manifest.files.find(file => file.file === 'lib/client.js')?.sha256 };
  }
  let fixture; const deadline = Date.now() + 60000;
  while (!fixture) {
    const failure = await readFile(resolve(dir, 'grok-fixture-error.json'), 'utf8').catch(() => '');
    assert.equal(failure, '', failure);
    fixture = await readFile(resolve(dir, 'grok-fixture.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    assert.ok(Date.now() < deadline, 'Grok fixture timeout'); if (!fixture) await delay(50);
  }
  phase = 'browser';
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright'), releases = await readdir(cache).catch(() => []);
  const candidates = releases.filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell')));
  const executablePath = process.env.DSH_BOT_CHROMIUM ?? candidates.find(existsSync) ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env, timeout: 30000 }); }
  finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
  phase = 'matrix';
  const matrixStartedAt = Date.now();
  for (const item of matrix) {
    const caseStartedAt = Date.now();
    const { language, theme, width } = item, id = `${language}-${theme}-${width}`;
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`), 'utf8')).ui;
    const context = await browser.newContext({ colorScheme: theme, locale: language === 'en' ? 'en-US' : 'zh-CN', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    // Observe the real browser transport without replacing the native writer.
    // A successful safe switch below is the positive control for this counter.
    const permissionRequests = [], permissionReceipts = [], permissionCatalogResponses = [], modelResponses = [], modelRequests = [], modelOperations = [];
    page.on('response', async response => {
      const path = new URL(response.url()).pathname;
      if (path.endsWith('/permissionPresets/catalog')) permissionCatalogResponses.push({ status: response.status(), body: await response.text().then(redact).catch(String) });
      else if (path.endsWith('/dshBot.groups/setModel')) modelResponses.push({ status: response.status(), body: await response.text().then(redact).catch(String) });
    });
    page.on('request', request => {
      if (request.method() !== 'POST') return;
      try {
        const body = request.postDataJSON();
        if (body?.method === 'dshBot.groups/setModel') modelRequests.push({ method: body.method, payload: body.payload, at: Date.now() });
        if (body?.method !== 'commands/execute') return;
        const line = JSON.stringify(body.payload).match(/\/permission [a-z-]+/)?.[0];
        if (line) permissionRequests.push({ method: body.method, line, at: Date.now() });
      } catch { /* Other native requests may carry binary or no JSON. */ }
    });
    page.on('pageerror', error => pageErrors.push(redact(error)));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const checks = [], screenshots = [];
    const check = (name, value = true) => { assert.ok(value, `${id}: ${name}`); checks.push(name); };
    const shot = async state => {
      check(`${state}: no viewport overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const colors = await page.evaluate(() => {
        const probe = document.createElement('div'); probe.style.backgroundColor = 'var(--dsw-alias-bg-base)'; probe.style.color = 'var(--dsw-alias-label-primary)';
        document.body.append(probe); const style = getComputedStyle(probe), result = { background: style.backgroundColor, color: style.color }; probe.remove(); return result;
      });
      const rgb = colors.background.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      check(`${state}: actual theme tokens`, rgb?.length === 3 && (theme === 'dark' ? rgb.reduce((a,b) => a+b,0) < 384 : rgb.reduce((a,b) => a+b,0) > 384));
      const file = `${id}-${state}.png`; await page.screenshot({ path: resolve(dir, file), fullPage: true }); screenshots.push({ state, file, colors });
    };
    let permissionProbeSerial = 0;
    const permissionProbe = async (sessionId, stage) => {
      const probeId = `${id}-${++permissionProbeSerial}`;
      await writeFile(resolve(dir, 'permission-probe-request.json'), JSON.stringify({ id: probeId, sessionId }));
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const error = await readFile(resolve(dir, 'permission-probe-error.json'), 'utf8').catch(() => ''); assert.equal(error, '', error);
        const receipt = await readFile(resolve(dir, `permission-probe-${probeId}.json`), 'utf8').then(JSON.parse).catch(() => undefined);
        if (receipt) { permissionReceipts.push({ stage, ...receipt, browserPermissionCommands: permissionRequests.length }); return receipt; }
        await delay(40);
      }
      assert.fail(`${id}: native permission receipt timed out (${stage})`);
    };
    // Native sidebar navigation is exercised at desktop width, then actual composition is checked at the requested matrix width.
    const openNative = async sessionId => {
      await page.setViewportSize({ width: 1360, height: 1000 }); await openSidebarSession(page, sessionId);
      await page.locator(`[data-conversation-content][data-conversation-session="${sessionId}"]:visible`).waitFor();
      await page.setViewportSize({ width, height: 1000 });
    };
    const openManagement = async () => {
      await page.setViewportSize({ width: 1360, height: 1000 }); await openBotsPanel(page, t['bots.title']);
      const panel = page.locator('[data-bots-page]:visible');
      const recent = panel.getByRole('button', { name: t['chat.recent'], exact: true }); if (await recent.isVisible()) await recent.click();
      return panel;
    };
    try {
      await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'simplified-bots-ui');
      await openNative(fixture.sessions[id]);
      check('ordinary Bot keeps native conversation and is not claimed by group composer', await page.locator('[data-workspace-group-composer]:visible').count() === 0);
      await page.locator('[contenteditable="true"]:visible').first().waitFor(); check('ordinary Bot retains its editable native composer');
      let bots = await openManagement();
      // A fresh browser context can mount the management shell before its
      // first complete Bot catalog. Take cancel baselines only after that
      // real fixture identity is present, as the create action itself does.
      await bots.locator(`button[data-bot-id="${fixture.mentionBots[0].id}"]`).waitFor();
      const beforeCreate = await bots.locator('button[data-bot-id]').count(), beforeSessions = await page.locator('[data-row-key^="session:"]').count();
      if (!await bots.locator(`summary[aria-label="${t['chat.new']}"]`).evaluate(element => element.parentElement.open)) await bots.locator(`summary[aria-label="${t['chat.new']}"]`).press('Enter');
      await bots.getByRole('button', { name: t['bots.create'], exact: true }).click();
      let createDialog = bots.locator('dialog:visible');
      check('name-only creation has a single visible required input', await createDialog.locator('input:visible[required]').count() === 1);
      check('default create keeps advanced fields collapsed', await createDialog.locator('input:visible').count() === 1 && await createDialog.locator('select:visible').count() === 0 && await createDialog.locator('details[open]').count() === 0);
      await createDialog.getByRole('textbox', { name: t['editor.name'], exact: true }).fill(`Cancel ${id}`);
      await createDialog.getByRole('button', { name: t['actions.cancel'], exact: true }).click();
      check('cancel creation adds no Bot row', await bots.locator('button[data-bot-id]').count() === beforeCreate);
      check('cancel creation adds no native session', await page.locator('[data-row-key^="session:"]').count() === beforeSessions);
      if (!await bots.locator(`summary[aria-label="${t['chat.new']}"]`).evaluate(element => element.parentElement.open)) await bots.locator(`summary[aria-label="${t['chat.new']}"]`).press('Enter');
      await bots.getByRole('button', { name: t['bots.create'], exact: true }).click();
      createDialog = bots.locator('dialog:visible');
      await createDialog.getByRole('textbox', { name: t['editor.name'], exact: true }).fill(`Name only ${id}`);
      await page.setViewportSize({ width, height: 1000 }); await shot('name-only-create');
      await createDialog.getByRole('button', { name: t['chat.createAndChat'], exact: true }).click();
      await createDialog.waitFor({ state: 'hidden' });
      check('name-only create navigates to native chat', await page.locator('[data-bots-page]:visible').count() === 0);
      check('new Bot retains native composer', await page.locator('[data-workspace-group-composer]:visible').count() === 0);
      bots = await openManagement();

      if (!await bots.locator(`summary[aria-label="${t['chat.new']}"]`).evaluate(element => element.parentElement.open)) await bots.locator(`summary[aria-label="${t['chat.new']}"]`).press('Enter');
      await bots.getByRole('button', { name: t['groups.create'], exact: true }).click();
      const form = bots.getByRole('form', { name: t['groups.create'], exact: true });
      const groupName = `Workspace ${id}`;
      await form.getByRole('textbox', { name: t['groups.name'], exact: true }).fill(groupName);
      check('new group defaults to natural', await form.locator('select').inputValue() === 'natural');
      const teammate = fixture.mentionBots[1].id;
      await form.getByRole('checkbox', { name: new RegExp(fixture.mentionBots[0].id) }).check(); await form.getByRole('checkbox', { name: new RegExp(teammate) }).check();
      await form.getByRole('checkbox', { name: t['groups.historyConsent'], exact: true }).check();
      await form.getByRole('button', { name: t['integrations.save'], exact: true }).click();
      const groupComposer = page.locator('[data-workspace-group-composer]:visible'); await groupComposer.waitFor();
      const groupRoot = await groupComposer.getAttribute('data-workspace-group-composer'); check('creation opens native workspace root directly', /^group-root-/.test(groupRoot ?? ''));
      const native = page.locator(`[data-conversation-content][data-conversation-session="${groupRoot}"]:visible`); await native.waitFor();
      check('plugin management page no longer owns conversation surface', await page.locator('[data-bots-page]:visible').count() === 0);
      await page.locator(`[data-row-key="session:${groupRoot}"]`).filter({ hasText: groupName }).waitFor({ state: 'attached' });
      await openNative(fixture.sessions[id]); await openNative(groupRoot);
      check('empty group keeps its name and reopens from the native sidebar before any user message');
      await page.setViewportSize({ width, height: 1000 });
      const permissionTrigger = () => groupComposer.getByRole('button', { name: new RegExp(`^${t['groups.permission']}:`) });
      await permissionTrigger().waitFor();
      const permissionLabel = value => ({ 'read-only': t['groups.permissionReadOnly'], 'workspace-write': t['groups.permissionWorkspaceWrite'], 'danger-full-access': t['groups.permissionFull'], auto: t['groups.permissionAuto'] })[value]
        ?? fixture.permissionCatalog.options.find(option => option.value === value)?.name ?? value;
      const initialPermission = await permissionProbe(groupRoot, 'initial');
      check('group access mode is read from the real root projection', await permissionTrigger().getAttribute('aria-label') === `${t['groups.permission']}: ${permissionLabel(initialPermission.currentValue)}`);
      const safePermission = fixture.permissionCatalog.options.find(option => ['workspace-write', 'read-only'].includes(option.value) && option.value !== initialPermission.currentValue);
      assert.ok(safePermission, `${id}: the real native catalog must provide an alternate safe preset for permission transport verification`);
      const beforeSafeCommands = permissionRequests.length;
      await permissionTrigger().click();
      check('access menu contains exactly the real native catalog entries', await page.getByRole('menu').getByRole('menuitem').count() === fixture.permissionCatalog.options.length);
      for (const option of fixture.permissionCatalog.options) check(`native access entry ${option.value} is available`, await page.getByRole('menu').getByRole('menuitem', { name: permissionLabel(option.value), exact: true }).count() === 1);
      await page.getByRole('menu').getByRole('menuitem', { name: permissionLabel(safePermission.value), exact: true }).click();
      await groupComposer.getByRole('button', { name: `${t['groups.permission']}: ${permissionLabel(safePermission.value)}`, exact: true }).waitFor();
      const safeReceipt = await permissionProbe(groupRoot, 'safe-switch');
      check('safe access switch executes exactly one real native permission command', permissionRequests.length === beforeSafeCommands + 1 && safeReceipt.permissionCommands.length === initialPermission.permissionCommands.length + 1);
      check('native permission command updates the actual root current value', safeReceipt.currentValue === safePermission.value && safeReceipt.rootModelRequests === 0);
      const riskOptions = fixture.permissionCatalog.options.filter(option => ['danger-full-access', 'auto'].includes(option.value));
      check('isolated real native catalog advertises Full access for cancel-only testing', riskOptions.some(option => option.value === 'danger-full-access'));
      for (const risk of riskOptions) {
        const auto = risk.value === 'auto', beforeRequests = permissionRequests.length, beforeModelRequests = host.requests();
        await permissionTrigger().click();
        await page.getByRole('menu').getByRole('menuitem', { name: permissionLabel(risk.value), exact: true }).click();
        const riskDialog = page.getByRole('dialog', { name: t[auto ? 'groups.permissionAutoConfirmTitle' : 'groups.permissionFullConfirmTitle'], exact: true }); await riskDialog.waitFor();
        const acknowledgement = riskDialog.getByRole('checkbox', { name: t['groups.permissionAcknowledge'], exact: true });
        const enable = riskDialog.getByRole('button', { name: t[auto ? 'groups.permissionAutoEnable' : 'groups.permissionFullEnable'], exact: true });
        check(`${risk.value}: risk confirmation starts unchecked with enable disabled`, !await acknowledgement.isChecked() && !await enable.isEnabled());
        await shot(auto ? 'permission-auto-confirmation' : 'permission-full-confirmation');
        await acknowledgement.check(); check(`${risk.value}: acknowledgement enables only the confirmation action`, await enable.isEnabled() && permissionRequests.length === beforeRequests);
        await riskDialog.getByRole('button', { name: t['groups.permissionCancel'], exact: true }).click(); await riskDialog.waitFor({ state: 'hidden' });
        const cancelled = await permissionProbe(groupRoot, `${risk.value}-cancelled`);
        check(`${risk.value}: cancel dispatches zero native permission commands`, permissionRequests.length === beforeRequests && cancelled.permissionCommands.length === safeReceipt.permissionCommands.length);
        check(`${risk.value}: cancel leaves actual root current value unchanged`, cancelled.currentValue === safePermission.value && await permissionTrigger().getAttribute('aria-label') === `${t['groups.permission']}: ${permissionLabel(safePermission.value)}`);
        check(`${risk.value}: cancel starts no model work`, cancelled.rootModelRequests === 0 && host.requests() === beforeModelRequests);
      }
      await openNative(fixture.sessions[id]); await openNative(groupRoot);
      await groupComposer.getByRole('button', { name: `${t['groups.permission']}: ${permissionLabel(safePermission.value)}`, exact: true }).waitFor();
      check('native access mode survives group reopen');
      await shot('permission-reopened');
      const writeModel = async (operation, action) => {
        const before = modelRequests.length;
        const [response] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/dshBot.groups/setModel')), action()]);
        const result = await response.json();
        check(`${operation}: one model write succeeds without conflict or retry`, result.result?.ok === true && modelRequests.length === before + 1);
        modelOperations.push({ operation, request: response.request().postDataJSON(), result, status: response.status() });
        await page.getByRole('menu').waitFor({ state: 'hidden' });
        await groupComposer.locator(`button[aria-label^="${t['groups.model']}:"][aria-busy="false"]`).waitFor();
        return result;
      };
      const readModelCalls = async () => (await readFile(resolve(dir, 'ui-model-calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(call => call.parentSession === groupRoot);
      const modelFixture = fixture.modelChoices, alternateModel = modelFixture.models[1], chosenEffort = modelFixture.efforts[1];
      const modelTrigger = () => groupComposer.getByRole('button', { name: new RegExp(`^${t['groups.model']}:`) });
      await modelTrigger().waitFor();
      check('new group starts with each Bot model', await modelTrigger().getAttribute('aria-label') === `${t['groups.model']}: ${t['groups.modelDefault']}`);
      await modelTrigger().focus(); await modelTrigger().press('Enter');
      let modelMenu = page.getByRole('menu'); await modelMenu.waitFor();
      // A native portaled Menu is initially laid out hidden while it measures;
      // its documented arrow walk enters reliably after that placement settles.
      await modelTrigger().press('ArrowDown');
      check('native model Menu receives keyboard focus', await modelMenu.evaluate(menu => menu.contains(document.activeElement)));
      await modelMenu.getByRole('menuitem', { name: new RegExp(`^${t['groups.modelGroupDefault']}`) }).first().press('Enter');
      modelMenu = page.getByRole('menu');
      await writeModel('group-default-model', () => modelMenu.getByRole('menuitem', { name: alternateModel.name, exact: true }).click());
      await groupComposer.getByRole('button', { name: `${t['groups.model']}: ${alternateModel.name}`, exact: true }).waitFor();
      check('real native menu selection changes the group model');
      await modelTrigger().click(); modelMenu = page.getByRole('menu');
      await modelMenu.getByRole('menuitem', { name: new RegExp(`^${t['groups.reasoning']}`) }).click();
      await page.getByRole('menu').getByRole('menuitem', { name: chosenEffort.name, exact: true }).waitFor();
      await shot('reasoning-menu');
      await writeModel('group-default-effort', () => page.getByRole('menu').getByRole('menuitem', { name: chosenEffort.name, exact: true }).click());
      const chosenLabel = `${t['groups.model']}: ${alternateModel.name} · ${chosenEffort.name}`;
      await groupComposer.getByRole('button', { name: chosenLabel, exact: true }).waitFor();
      check('reasoning choice uses native catalog effort label');
      await openNative(fixture.sessions[id]); await openNative(groupRoot);
      await groupComposer.getByRole('button', { name: chosenLabel, exact: true }).waitFor();
      check('model and reasoning survive native session switching without menu reload');
      await shot('model-reopened');
      const memberIds = {};
      const memberRow = botId => page.getByRole('menu').getByRole('menuitem').filter({ has: page.locator(`[data-model-bot-id="${botId}"]`) });
      const openMember = async botId => {
        await modelTrigger().click(); const row = memberRow(botId); await row.waitFor();
        const span = row.locator('[data-model-member-id]'); memberIds[botId] = await span.getAttribute('data-model-member-id');
        await row.click();
      };
      const setMemberModel = async (botId, modelName, effort, operation) => {
        await openMember(botId);
        await page.getByRole('menu').getByRole('menuitem', { name: new RegExp(`^${t['groups.model']}`) }).click();
        await writeModel(`${operation}-model`, () => page.getByRole('menu').getByRole('menuitem', { name: modelName, exact: true }).click());
        await openMember(botId);
        await page.getByRole('menu').getByRole('menuitem', { name: new RegExp(`^${t['groups.reasoning']}`) }).waitFor();
        await page.getByRole('menu').getByRole('menuitem', { name: new RegExp(`^${t['groups.reasoning']}`) }).click();
        await writeModel(`${operation}-effort`, () => page.getByRole('menu').getByRole('menuitem', { name: effort.name, exact: true }).click());
      };
      const assertMemberSources = async (expected, capture) => {
        await modelTrigger().click();
        for (const [botId, source] of Object.entries(expected)) {
          const row = memberRow(botId); await row.waitFor();
          check(`${botId}: effective model source is ${source}`, await row.locator('[data-model-member-id]').getAttribute('data-model-source') === source);
          const sourceLabel = row.getByText(source, { exact: true }); await sourceLabel.waitFor();
          check(`${botId}: source label is visibly readable without clipping`, await sourceLabel.evaluate(element => {
            const range = document.createRange(); range.selectNodeContents(element);
            const text = range.getBoundingClientRect(), bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || text.width <= 0 || text.height <= 0 ||
              text.left < 0 || text.right > innerWidth || text.top < 0 || text.bottom > innerHeight ||
              text.left < bounds.left - 1 || text.right > bounds.right + 1 || text.top < bounds.top - 1 || text.bottom > bounds.bottom + 1) return false;
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              const css = getComputedStyle(parent), box = parent.getBoundingClientRect();
              if (/(hidden|clip|auto|scroll)/.test(css.overflowX) && (text.left < box.left - 1 || text.right > box.right + 1)) return false;
              if (/(hidden|clip|auto|scroll)/.test(css.overflowY) && (text.top < box.top - 1 || text.bottom > box.bottom + 1)) return false;
            }
            const hit = document.elementFromPoint(text.left + text.width / 2, text.top + text.height / 2);
            return Boolean(hit && (element.contains(hit) || hit.contains(element)));
          }));
          check(`${botId}: same-name member keeps stable model identity`, await row.locator('[data-model-member-id]').getAttribute('data-model-member-id') === memberIds[botId]);
        }
        if (capture) await shot(capture);
        await page.keyboard.press('Escape');
      };
      const alphaId = fixture.mentionBots[0].id, betaId = fixture.mentionBots[1].id;
      await setMemberModel(alphaId, modelFixture.models[0].name, chosenEffort, 'alpha-explicit');
      await setMemberModel(betaId, modelFixture.memberModels[1].name, modelFixture.efforts[0], 'beta-explicit');
      check('same-name members have distinct stable identities', memberIds[alphaId] !== memberIds[betaId]);
      await assertMemberSources({ [alphaId]: t['groups.modelSourceMember'], [betaId]: t['groups.modelSourceMember'] }, 'member-model-sources');
      await openNative(fixture.sessions[id]); await openNative(groupRoot);
      await groupComposer.getByRole('button', { name: `${t['groups.model']}: ${t['groups.modelPerBot']}`, exact: true }).waitFor();
      await assertMemberSources({ [alphaId]: t['groups.modelSourceMember'], [betaId]: t['groups.modelSourceMember'] }, 'member-model-reopened');
      check('two member selections and source labels persist after native reopen');
      let composer = groupComposer.getByRole('textbox', { name: t['groups.message'], exact: true });
      const question = `Workspace question ${id}`; await composer.fill(`**${question}**`);
      check('plain natural message is sendable', await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).isEnabled());
      check('selected model and access controls do not intercept the Send target', await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).evaluate(button => {
        const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit !== null && button.contains(hit);
      }));
      await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).click();
      const allCards = native.locator('[data-workspace-group-message] [data-group-message]');
      const botCards = allCards.filter({ hasText: 'DP_LOOPBACK_OK' });
      await botCards.filter({ hasText: 'DP_LOOPBACK_OK' }).first().waitFor();
      // Assert the existing native row after admission; never navigate or issue a new query to repair its title.
      await page.setViewportSize({ width: 1360, height: 1000 });
      await page.locator(`[data-row-key="session:${groupRoot}"]`).filter({ hasText: groupName }).waitFor({ state: 'attached' });
      check('native sidebar session row retains group name after sending');
      await page.setViewportSize({ width, height: 1000 });
      const identities = await botCards.evaluateAll(cards => cards.map(card => card.getAttribute('data-group-message')));
      check('every Bot message has one exclusive native card', identities.length > 0 && new Set(identities).size === identities.length);
      for (const messageId of identities) check(`no duplicate renderer for ${messageId}`, await native.locator(`[data-group-message="${messageId}"]`).count() === 1);
      await page.waitForFunction(rootId => {
        const root = document.querySelector(`[data-conversation-content][data-conversation-session="${rootId}"]`);
        if (!root) return false;
        const cards = [...root.querySelectorAll('[data-workspace-group-message] [data-group-message]')].filter(card => card.textContent?.includes('DP_LOOPBACK_OK'));
        const leaves = [...root.querySelectorAll('*')].filter(el => el.textContent?.trim() === 'DP_LOOPBACK_OK' && ![...el.children].some(child => child.textContent?.trim() === 'DP_LOOPBACK_OK'));
        return cards.length > 0 && leaves.length === cards.length;
      }, groupRoot);
      check('native fallback does not render an extra copy of Bot response text');
      check('group composer has no second timeline', await groupComposer.locator('[role="log"]').count() === 0);
      // Both deterministic fixture members return text; wait for their actual native nodes before checking quotes.
      await botCards.nth(1).waitFor();
      await groupComposer.locator('[data-group-working]').first().waitFor({ state: 'hidden' });
      const modelCalls = await readModelCalls(), firstModelReceipt = await permissionProbe(groupRoot, 'member-model-worker-routes');
      const expectedMemberRoutes = { [alphaId]: { provider: modelFixture.provider, model: modelFixture.models[0].id, reasoningEffort: chosenEffort.id },
        [betaId]: { provider: modelFixture.memberProvider, model: modelFixture.memberModels[1].id, reasoningEffort: modelFixture.efforts[0].id } };
      const routeOf = call => ({ provider: call.provider, model: call.model, reasoningEffort: call.reasoningEffort });
      for (const bot of fixture.mentionBots) {
        const deliveries = firstModelReceipt.groupView.deliveries.filter(row => row.bot.botId === bot.id);
        const calls = modelCalls.filter(call => deliveries.some(row => row.childSessionId === call.sessionId));
        check(`${bot.id}: actual work received the selected provider model and effort`, calls.length > 0 && calls.every(call => JSON.stringify(routeOf(call)) === JSON.stringify(expectedMemberRoutes[bot.id])));
      }
      // Changing the group default must preserve both explicit member selections.
      await modelTrigger().click();
      await page.getByRole('menu').getByRole('menuitem', { name: new RegExp(`^${t['groups.modelGroupDefault']}`) }).click();
      await writeModel('change-group-default-preserves-members', () => page.getByRole('menu').getByRole('menuitem', { name: modelFixture.models[0].name, exact: true }).click());
      await assertMemberSources({ [alphaId]: t['groups.modelSourceMember'], [betaId]: t['groups.modelSourceMember'] });
      const defaultReceipt = await permissionProbe(groupRoot, 'group-default-preserves-members');
      check('group default edit preserves both explicit records', defaultReceipt.groupView.group.memberModelSelections.length === 2 &&
        defaultReceipt.groupView.group.memberModelSelections.every(row => JSON.stringify(row.modelSelection) === JSON.stringify(expectedMemberRoutes[row.memberId === memberIds[alphaId] ? alphaId : betaId])));
      await openMember(alphaId);
      await writeModel('reset-alpha-only', () => page.getByRole('menu').getByRole('menuitem', { name: t['groups.modelFollowGroup'], exact: true }).click());
      await assertMemberSources({ [alphaId]: t['groups.modelSourceGroup'], [betaId]: t['groups.modelSourceMember'] });
      const resetReceipt = await permissionProbe(groupRoot, 'single-member-reset');
      check('single member reset leaves the other override untouched', resetReceipt.groupView.group.memberModelSelections.length === 1 && resetReceipt.groupView.group.memberModelSelections[0].memberId === memberIds[betaId]);
      await modelTrigger().click();
      await writeModel('clear-group-default-preserves-beta', () => page.getByRole('menu').getByRole('menuitem', { name: t['groups.modelDefault'], exact: true }).click());
      await assertMemberSources({ [alphaId]: t['groups.modelSourceBot'], [betaId]: t['groups.modelSourceMember'] });
      await openMember(betaId);
      await writeModel('reset-beta-only', () => page.getByRole('menu').getByRole('menuitem', { name: t['groups.modelFollowGroup'], exact: true }).click());
      await groupComposer.getByRole('button', { name: `${t['groups.model']}: ${t['groups.modelDefault']}`, exact: true }).waitFor();
      await openNative(fixture.sessions[id]); await openNative(groupRoot);
      await groupComposer.getByRole('button', { name: `${t['groups.model']}: ${t['groups.modelDefault']}`, exact: true }).waitFor();
      await assertMemberSources({ [alphaId]: t['groups.modelSourceBot'], [betaId]: t['groups.modelSourceBot'] });
      check('clearing overrides restores each Bot model after reopen');
      await shot('model-default-restored');
      await page.waitForFunction(({ rootId, loading, missing }) => {
        const surface = document.querySelector(`[data-conversation-content][data-conversation-session="${rootId}"]`);
        const responses = surface ? [...surface.querySelectorAll('[data-group-message]')].filter(card => card.textContent?.includes('DP_LOOPBACK_OK')) : [];
        return responses.length > 0 && responses.every(card => card.querySelector('blockquote button')) && !surface.textContent.includes(loading) && !surface.textContent.includes(missing);
      }, { rootId: groupRoot, loading: t['groups.quoteLoading'], missing: t['groups.quoteUnavailable'] });
      check('existing fixture originals resolve before capture with no false unavailable quote');
      await composer.scrollIntoViewIfNeeded();
      const attachBox = await groupComposer.getByRole('button', { name: t['groups.attach'], exact: true }).boundingBox(), modelBox = await modelTrigger().boundingBox(), permissionBox = await permissionTrigger().boundingBox(), sendBox = await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).boundingBox();
      check('attachment and right-aligned send share one footer', attachBox && sendBox && sendBox.x > attachBox.x && Math.abs((attachBox.y + attachBox.height / 2) - (sendBox.y + sendBox.height / 2)) < 3);
      check('model control shares the attachment and send footer', modelBox && attachBox && sendBox && modelBox.x > attachBox.x && modelBox.x + modelBox.width <= sendBox.x && Math.abs((modelBox.y + modelBox.height / 2) - (sendBox.y + sendBox.height / 2)) < 3);
      check('access control shares the same unclipped footer', permissionBox && modelBox && sendBox && permissionBox.x >= modelBox.x + modelBox.width && permissionBox.x + permissionBox.width <= sendBox.x && permissionBox.width > 24 && Math.abs((permissionBox.y + permissionBox.height / 2) - (sendBox.y + sendBox.height / 2)) < 3);
      check('native footer controls remain inside the input frame', await groupComposer.locator('form').evaluate(form => {
        const frame = form.getBoundingClientRect(); return [...form.querySelectorAll('button[aria-haspopup="menu"],button[type="submit"]')].every(button => {
          const box = button.getBoundingClientRect(); return box.left >= frame.left && box.right <= frame.right && box.top >= frame.top && box.bottom <= frame.bottom;
        });
      }));
      check('textarea has no nested border or resize corner', await composer.evaluate(input => getComputedStyle(input).borderTopWidth === '0px' && getComputedStyle(input).resize === 'none'));
      await shot('native-group');

      await botCards.first().getByRole('button', { name: t['groups.reply'], exact: true }).click();
      await groupComposer.getByRole('button', { name: t['groups.clearReply'], exact: true }).waitFor();
      const draft = `Preserved group draft ${id}`; await composer.fill(draft);
      await openNative(fixture.sessions[id]);
      check('switching to ordinary Bot releases custom group composer', await page.locator('[data-workspace-group-composer]:visible').count() === 0);
      await openNative(groupRoot);
      composer = page.locator(`[data-workspace-group-composer="${groupRoot}"]:visible`).getByRole('textbox', { name: t['groups.message'], exact: true });
      check('draft survives native session switching', await composer.inputValue() === draft);
      check('reply target survives native session switching', await groupComposer.getByRole('button', { name: t['groups.clearReply'], exact: true }).isVisible());
      await shot('retained-draft');
      await groupComposer.getByRole('button', { name: t['groups.clearReply'], exact: true }).click();
      await openNative(fixture.sessions[id]); await openNative(groupRoot);
      composer = groupComposer.getByRole('textbox', { name: t['groups.message'], exact: true });
      check('explicitly cleared reply does not reappear after session switching', await groupComposer.getByRole('button', { name: t['groups.clearReply'], exact: true }).count() === 0);
      await botCards.first().getByRole('button', { name: t['groups.reply'], exact: true }).click();
      await composer.fill(`Quoted followup ${id}`); await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).click();
      const quotedUser = allCards.filter({ hasText: `Quoted followup ${id}` }); await quotedUser.locator('blockquote').waitFor();
      await quotedUser.locator('blockquote button').click(); await page.waitForFunction(() => document.activeElement?.hasAttribute('data-workspace-group-message')); check('sent user quote jumps through native history');
      await unlink(resolve(dir, 'release-work')).catch(() => {});
      await composer.fill(`V060_HOLD_WORK ${id}`); await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).click();
      const supplement = groupComposer.getByRole('button', { name: new RegExp(t['groups.supplement']) }).first(); await supplement.waitFor();
      check('work status follows a running native worker', await groupComposer.locator('[data-group-working]').count() > 0);
      await supplement.click(); await composer.fill(`V060 worker supplement ${id}`);
      await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).click(); await composer.waitFor();
      await page.waitForFunction(rootId => document.querySelector(`[data-workspace-group-composer="${rootId}"] textarea`)?.value === '', groupRoot);
      check('specified worker supplement is accepted without clearing context into broadcast'); await shot('running-supplement');
      await writeFile(resolve(dir, 'release-work'), 'release');
      await composer.fill('A directed @');
      const candidates = groupComposer.getByRole('listbox', { name: t['groups.targets'], exact: true }); await candidates.waitFor();
      check('native MenuSurface material is mounted', await candidates.getAttribute('data-menu-material') === 'translucent');
      check('same-name candidates distinguish Bot identities', await candidates.getByRole('option').filter({ hasText: '研究员 Researcher' }).count() === 2);
      await shot('mention-candidates');
      await composer.press('ArrowDown'); await composer.press('ArrowDown');
      check('keyboard highlight selects the exact second Bot identity', (await candidates.getByRole('option', { selected: true }).textContent()).includes(teammate));
      await composer.press('Tab');
      check('Tab picks one stable member without sending', (await composer.inputValue()).includes('@研究员 Researcher') && !await candidates.isVisible());
      await shot('mention-selection');
      check('confirmed group @ is accepted by composer', await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).isEnabled());
      const beforeMention = await allCards.count(); await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).click();
      await page.waitForFunction(({ root, before }) => document.querySelectorAll(`[data-conversation-content][data-conversation-session="${root}"] [data-workspace-group-message] [data-group-message]`).length > before, { root: groupRoot, before: beforeMention });
      await composer.fill('');
      await groupComposer.locator('input[type="file"]').setInputFiles({ name: `workspace-${id}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Synthetic workspace attachment ${id}`) });
      await groupComposer.getByText(t['groups.uploaded'], { exact: false }).waitFor();
      await openNative(fixture.sessions[id]); await openNative(groupRoot);
      composer = groupComposer.getByRole('textbox', { name: t['groups.message'], exact: true });
      await groupComposer.getByRole('list', { name: t['groups.attachments'], exact: true }).locator('li > span')
        .filter({ hasText: `workspace-${id}.txt` }).waitFor();
      await groupComposer.getByText(t['groups.uploaded'], { exact: false }).waitFor();
      check('accepted upload receipt survives switching away and back', await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).isEnabled());
      await groupComposer.getByRole('button', { name: t['groups.send'], exact: true }).click();
      await page.waitForFunction(({ rootId, name }) => {
        const root = document.querySelector(`[data-conversation-content][data-conversation-session="${rootId}"]`);
        return root && [...root.querySelectorAll('*')].some(el => el.textContent?.includes(name) &&
          !el.closest('[data-workspace-group-composer]') && !el.querySelector('[data-workspace-group-composer]'));
      }, { rootId: groupRoot, name: `workspace-${id}.txt` });
      check('pure attachment is admitted by real native upload receipt'); await shot('native-attachment');

      await page.setViewportSize({ width: 1360, height: 1000 });
      await page.getByRole('button', { name: `${t['groups.manage']} · ${groupName}`, exact: true }).click();
      const management = page.locator('[data-bots-page]:visible'); await management.waitFor();
      const groupArticle = management.getByRole('article', { name: groupName, exact: true }); await groupArticle.waitFor();
      check('plugin group page only manages and opens groups', await groupArticle.locator('textarea,[role="log"],[data-group-message]').count() === 0);
      await groupArticle.getByRole('button', { name: t['groups.open'], exact: true }).click();
      await page.locator(`[data-workspace-group-composer="${groupRoot}"]:visible`).waitFor();
      await openNative(fixture.sessions[id]); await openNative(groupRoot); check('native sidebar opens the registered group session');
      await shot('sidebar-reopened');

      bots = await openManagement(); await bots.getByRole('button', { name: groupName, exact: true }).click();
      await page.locator(`[data-workspace-group-composer="${groupRoot}"]:visible`).waitFor(); check('unified recent list opens the same native group root');

      // Exercise reversible preferences and the unchanged deletion confirmation on a dedicated new Bot.
      bots = await openManagement();
      const createdName = `Name only ${id}`, createdButton = bots.getByRole('button', { name: createdName, exact: true }); await createdButton.waitFor();
      const createdId = await createdButton.getAttribute('data-bot-id'); check('created Bot uses a generated stable identity', Boolean(createdId) && !createdId.includes(createdName));
      let recentRow = bots.locator('li').filter({ has: page.getByRole('button', { name: createdName, exact: true }) });
      const expandRow = async row => { const summary = row.locator('summary'); if (!await summary.evaluate(element => element.parentElement.open)) await summary.press('Enter'); };
      await expandRow(recentRow); await recentRow.getByRole('button', { name: t['chat.pin'], exact: true }).click();
      check('pin is reflected in recent conversations', await recentRow.getByRole('img', { name: t['chat.pinned'], exact: true }).count() === 1);
      await expandRow(recentRow); await recentRow.getByRole('button', { name: t['chat.hide'], exact: true }).click();
      check('hidden conversation leaves recent list', await createdButton.count() === 0);
      await bots.getByRole('button', { name: t['chat.hidden'], exact: true }).click(); await createdButton.waitFor();
      recentRow = bots.locator('li').filter({ has: page.getByRole('button', { name: createdName, exact: true }) }); await expandRow(recentRow); await recentRow.getByRole('button', { name: t['chat.restore'], exact: true }).click();
      await bots.getByRole('button', { name: t['chat.recent'], exact: true }).click(); await createdButton.waitFor();
      check('hidden conversation can be restored without creating another identity', await createdButton.getAttribute('data-bot-id') === createdId);
      recentRow = bots.locator('li').filter({ has: page.getByRole('button', { name: createdName, exact: true }) }); await expandRow(recentRow);
      await recentRow.getByRole('button', { name: t['actions.delete'], exact: true }).click();
      let deletion = bots.locator('dialog:visible'); await deletion.waitFor();
      check('delete retains prior data defaults', await deletion.getByRole('checkbox', { name: t['delete.memories'], exact: true }).isChecked() && !await deletion.getByRole('checkbox', { name: t['delete.home'], exact: true }).isChecked());
      await deletion.getByRole('button', { name: t['actions.cancel'], exact: true }).click();
      check('delete cancel keeps the same Bot identity', await createdButton.getAttribute('data-bot-id') === createdId);
      await expandRow(recentRow); await recentRow.getByRole('button', { name: t['actions.delete'], exact: true }).click();
      deletion = bots.locator('dialog:visible'); await page.setViewportSize({ width, height: 1000 }); await shot('delete-confirmation');
      await deletion.getByRole('button', { name: t['actions.delete'], exact: true }).click(); await deletion.waitFor({ state: 'hidden' });
      check('confirmed synthetic Bot is deleted from recent conversations', await createdButton.count() === 0);
      check('all named single-user model writes succeed without conflict or retry', modelOperations.length === 10 && modelRequests.length === modelOperations.length && modelResponses.length === modelOperations.length && modelResponses.every(response => JSON.parse(response.body).result?.ok === true));
      results.push({ ...item, status: 'PASS', durationMs: Date.now() - caseStartedAt, checks, screenshots, permissionRequests, permissionReceipts, permissionCatalogResponses, modelRequests, modelResponses, modelOperations }); await writeFile(resolve(dir, 'progress.json'), JSON.stringify(results, null, 2));
    } catch (error) {
      const file = `${id}-failure.png`; await page.screenshot({ path: resolve(dir, file), fullPage: true }).catch(() => {});
      await writeFile(resolve(dir, `${id}-failure-aria.txt`), redact(await page.locator('body').ariaSnapshot()));
      results.push({ ...item, status: 'FAIL', durationMs: Date.now() - caseStartedAt, checks, screenshots, permissionRequests, permissionReceipts, permissionCatalogResponses, modelRequests, modelResponses, modelOperations, error: redact(error), failureScreenshot: file }); throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'PASS', results, pageErrors, realModelRequests: 0, loopbackRequests: host.requests(), isolatedHost: true, chromiumSandbox: true, artifact, coverage: { ...coverage, matrixElapsedMs: Date.now() - matrixStartedAt }, sidebarNavigationWidth: 1360 }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', dir, matrixMode: coverage.mode, cases: results.length, screenshots: results.flatMap(result => result.screenshots).length }));
} catch (error) {
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'FAIL', phase, coverage, results, pageErrors, error: redact(error), stack: redact(error.stack), realModelRequests: 0, artifact }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: redact(error) })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
