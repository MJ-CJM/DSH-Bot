#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants, existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { auditArtifact, auditInstalled, sha256 } from '../../../scripts/p34-artifact.mjs';
import en from '../locale/en.json' with { type: 'json' };
import zh from '../locale/zh.json' with { type: 'json' };
import { dismissFirstRunOverlays, installOverlayHandler } from './screenshot-support.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
assert.equal(process.cwd(), root, 'Run from the repository root');
const home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home, 'Use DSH_HOME="$PWD/.dsh-dev"');
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
const outputDir = resolve(root, 'docs/screenshots/v03', runId);
const workDir = resolve(home, 'screenshots-v03', runId);
await mkdir(outputDir, { recursive: true });
await mkdir(workDir, { recursive: true });
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]');
const matrix = [];
const screenshots = ['bots', 'bot-editor', 'connectors', 'notifications', 'collaboration', 'group-create', 'group-members', 'group-mention', 'group-round', 'management', 'memory-records', 'memory-backend', 'transfer', 'routines', 'im'];
const aliases = [];
let profile, artifactAudit, installedAudit;
const themeEvidence = [];
const sidebarEvidence = [];
const scrollEvidence = [];
for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) {
  for (const screen of screenshots) {
    matrix.push({ language, theme, screen, status: 'FAIL', reason: 'not run' });
  }
}
const narrowChecks = ['en', 'zh'].flatMap(language => ['light', 'dark'].flatMap(theme => ['group', 'management'].map(surface => ({ language, theme, surface, status: 'FAIL', reason: 'not run' }))));
const pageErrors = [];
let failure;
let browser, mock, host;
const children = new Set();
const commands = [];
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, SHELL: process.env.SHELL,
  DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: resolve(workDir, 'agents-home'),
  XDG_STATE_HOME: resolve(workDir, 'state'), TMPDIR: resolve(workDir, 'tmp'),
  pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
  V03_MOCK_KEY: 'synthetic-loopback-only', DEEPSEEK_API_KEY: '',
};
await mkdir(env.TMPDIR, { recursive: true });
const sleep = ms => new Promise(accept => setTimeout(accept, ms));
async function command(tool, args, label, live = false) {
  const child = spawn(resolve(root, 'scripts', tool), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  let closed = false;
  const done = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', code => { closed = true; children.delete(child); accept(code); });
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), live ? 900000 : 180000);
  const save = async () => {
    clearTimeout(timer);
    const code = await done;
    await writeFile(resolve(workDir, `${label}.log`), redact(output));
    commands.push({ tool, args, label, code });
    return code;
  };
  if (!live) { assert.equal(await save(), 0, `See ${label}.log`); return; }
  host = { child, save };
  const deadline = Date.now() + 120000;
  while (!closed && !/V03_SCREENSHOT_(READY|FAILED)/.test(output) && Date.now() < deadline) await sleep(100);
  assert.match(output, /V03_SCREENSHOT_READY/, `Fixture failed; see ${workDir}`);
  const url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1];
  assert.ok(url, 'No isolated Host URL');
  return url;
}
async function prepareHost() {
  mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: ['success'], repeatLast: true, successText: 'Synthetic research summary for the screenshot.' });
  if (!process.env.DSH_BOT_E2E_PACKAGE) {
    await command('pnpm', ['-F', 'dsh-bot', 'build'], 'build');
    await command('pnpm', ['-C', 'packages/dsh-bot', 'pack', '--pack-destination', workDir], 'pack');
  }
  const version = JSON.parse(await readFile(resolve(root, 'packages/dsh-bot/package.json'))).version;
  profile = `screenshots-v03-${Date.now()}-${process.pid}`;
  const artifact = process.env.DSH_BOT_E2E_PACKAGE ?? resolve(workDir, `dsh-bot-${version}.tgz`);
  artifactAudit = await auditArtifact(root, artifact, workDir);
  await command('dsh', ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await command('dsh', ['plugin', '--profile', profile, 'add', artifact], 'install');
  installedAudit = await auditInstalled(home, profile, artifactAudit);
  const patch = [
    '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(workDir, 'storages'))}`,
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(workDir, 'sessions'))}`,
    '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(workDir, 'synthetic-credentials.yaml'))}`, '    watch: false',
    '- id: dsh-bot', '  config:', '    seedExamples: false', `    dataDir: ${JSON.stringify(resolve(workDir, 'bots-data'))}`,
    '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-flash', '    reasoningEffort: off',
    '- id: llm-deepseek', '  config:', '    apiKeyEnv: V03_MOCK_KEY', `    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}`, '    thinking: disabled', '    reasoningEffort: off',
    ...['llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
    '- insert:', '    - id: bot-screenshot-fixture', `      name: ${JSON.stringify(resolve(root, 'packages/dsh-bot/tests/screenshot-profile.mjs'))}`,
    '      config:', `        outputDir: ${JSON.stringify(workDir)}`,
  ].join('\n');
  await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
  return command('dsh', ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'host', true);
}
async function capture(url) {
  for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) {
    const t = (language === 'en' ? en : zh).ui;
    const context = await browser.newContext({ colorScheme: theme, locale: language === 'en' ? 'en-US' : 'zh-CN', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => pageErrors.push(redact(error)));
      await installOverlayHandler(page, () => {});
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'v03');
      await page.getByRole('button', { name: 'Bots', exact: true }).click();
      const bots = page.locator('[data-bots-page]');
      const shot = async screen => {
        // Actionability/focus may scroll the outer Bots page to its composer.
        // Capture from the page header; the log has its own reachable scrollbar.
        await bots.locator('h1').evaluate(heading => heading.scrollIntoView({ block: 'start' }));
        const file = `${language}-${theme}-${screen}.png`;
        const path = resolve(outputDir, file);
        const bodyTheme = await page.locator('body').evaluate(body => ({ color: getComputedStyle(body).color, background: getComputedStyle(body).backgroundColor }));
        themeEvidence.push({ language, theme, screen, ...bodyTheme });
        await page.screenshot({ path, fullPage: true });
        const aliasesFor = { 'group-mention': 'group', management: 'admin', connectors: 'connectors', notifications: 'notifications' };
        if (language === 'zh' && aliasesFor[screen]) {
          const alias = resolve(root, '.codex/screens', `v03-${aliasesFor[screen]}-${theme}.png`);
          await mkdir(dirname(alias), { recursive: true });
          try { await copyFile(path, alias, constants.COPYFILE_EXCL); aliases.push({ file: relative(root, alias), source: file }); }
          catch (error) { if (error.code !== 'EEXIST') throw error; aliases.push({ file: relative(root, alias), status: 'preserved existing file', source: file }); }
        }
        Object.assign(matrix.find(row => row.language === language && row.theme === theme && row.screen === screen), { status: 'PASS', file, sha256: sha256(await readFile(path)), reason: undefined });
      };
      // Fixture turns reorder bots by recent activity; pin the seeded bot in per-bot selectors.
      const pickAssistant = async () => { for (const s of await bots.locator('select:visible').all()) { if (await s.locator('option', { hasText: 'Assistant (assistant)' }).count()) await s.selectOption({ label: 'Assistant (assistant)' }); } };
      await bots.getByText('Assistant', { exact: true }).first().waitFor();
      const fixture = JSON.parse(await readFile(resolve(workDir, 'sidebar-main-identity.json')));
      for (const fixtureRow of fixture.rows) {
        const row = page.locator(`[role="treeitem"][data-row-key="session:${fixtureRow.sessionId}"]`);
        await row.waitFor();
        await row.getByText(fixtureRow.title, { exact: true }).waitFor();
        assert.ok(!/New Session|新会话/i.test(await row.innerText()), 'Fixture must not leave blank main rows');
        sidebarEvidence.push({ language, theme, sessionId: fixtureRow.sessionId, title: fixtureRow.title, blank: false });
      }
      await shot('bots');
      await bots.getByRole('button', { name: t['bots.create'], exact: true }).click();
      const editor = page.getByRole('dialog');
      await editor.getByRole('textbox', { name: t['editor.name'], exact: true }).waitFor();
      await shot('bot-editor');
      await editor.getByRole('button', { name: t['actions.cancel'], exact: true }).click();
      await bots.getByRole('tab', { name: t['manage.title'], exact: true }).first().click();
      await shot('management');
      for (const [key, screen] of [['connectors.connectors', 'connectors'], ['notifications.notifications', 'notifications'], ['team.title', 'collaboration'], ['routine.title', 'routines'], ['im.title', 'im']]) {
        await bots.getByRole('tab', { name: t[key], exact: screen !== 'notifications' }).click();
        const panel = bots.locator('[role=tabpanel]:visible');
        await pickAssistant();
        if (screen === 'collaboration') await panel.getByText(/Review research summary · v/).first().waitFor();
        await shot(screen);
      }
      await bots.getByRole('tab', { name: t['manage.memoryTools'], exact: true }).click();
      await pickAssistant();
      await bots.getByText('Prefers clear, concise research summaries.', { exact: true }).waitFor();
      await shot('memory-records');
      await bots.getByRole('tab', { name: t['manage.transfer'], exact: true }).click(); await pickAssistant();
      await shot('transfer');
      await bots.getByRole('tab', { name: t['manage.graph'], exact: true }).click(); await pickAssistant();
      await bots.getByRole('button', { name: t['graph.read'], exact: true }).waitFor();
      await shot('memory-backend');
      await bots.getByRole('tab', { name: t['groups.title'], exact: true }).click();
      await bots.getByRole('button', { name: t['groups.create'], exact: true }).click();
      await bots.getByRole('textbox', { name: t['groups.name'], exact: true }).fill('New research group');
      const creation = bots.getByRole('form', { name: t['groups.create'], exact: true });
      await creation.locator('fieldset input[type=checkbox]').nth(0).check();
      await creation.locator('fieldset input[type=checkbox]').nth(1).check();
      await shot('group-create');
      await bots.getByRole('form', { name: t['groups.create'], exact: true }).getByRole('button', { name: t['groups.close'], exact: true }).click();
      const group = bots.getByRole('article', { name: 'Research group', exact: true });
      await group.getByRole('button', { name: t['groups.edit'], exact: true }).click();
      await shot('group-members');
      await group.getByRole('form', { name: t['groups.edit'], exact: true }).getByRole('button', { name: t['groups.close'], exact: true }).click();
      const composer = group.getByRole('textbox', { name: t['groups.message'], exact: true });
      await composer.fill('@Research Assistant Please compare these approaches.');
      const beforeMention = await group.locator('[data-group-message]').count();
      await group.getByRole('button', { name: t['groups.send'], exact: true }).click();
      await group.locator('[data-group-message]').nth(beforeMention + 1).waitFor();
      const log = group.getByRole('log');
      const scroll = await log.evaluate(element => {
        const top = element.scrollTop;
        element.scrollTop = element.scrollHeight;
        const bottom = element.scrollTop;
        element.scrollTop = 0;
        const start = element.scrollTop;
        const style = getComputedStyle(element);
        element.scrollTop = top;
        return { height: element.clientHeight, fullHeight: element.scrollHeight, bottom, start, overflowY: style.overflowY, position: style.position };
      });
      assert.ok(scroll.height > 0 && scroll.overflowY === 'auto' && scroll.start === 0);
      assert.ok(scroll.fullHeight <= scroll.height || scroll.bottom > 0, 'All messages must be reachable by scrolling');
      scrollEvidence.push({ language, theme, ...scroll });
      await shot('group-mention');
      await composer.fill('Continue with the next member in round-robin order.');
      const beforeRound = await group.locator('[data-group-message]').count();
      await group.getByRole('button', { name: t['groups.send'], exact: true }).click();
      await group.locator('[data-group-message]').nth(beforeRound + 1).waitFor();
      await shot('group-round');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Narrow-screen overflow');
      await composer.fill('Preserve this narrow-screen draft.');
      await group.getByRole('button', { name: t['groups.edit'], exact: true }).click();
      await group.getByRole('form', { name: t['groups.edit'], exact: true }).getByRole('button', { name: t['groups.close'], exact: true }).click();
      assert.equal(await composer.inputValue(), 'Preserve this narrow-screen draft.');
      await page.screenshot({ path: resolve(outputDir, `${language}-${theme}-narrow-group.png`), fullPage: true });
      Object.assign(narrowChecks.find(row => row.language === language && row.theme === theme && row.surface === 'group'), { status: 'PASS', reason: undefined });
      await bots.getByRole('tab', { name: t['manage.title'], exact: true }).first().click();
      await bots.getByRole('tab', { name: t['manage.memoryTools'], exact: true }).click();
      await bots.getByRole('tab', { name: t['manage.transfer'], exact: true }).click(); await pickAssistant();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Narrow management overflow');
      await page.screenshot({ path: resolve(outputDir, `${language}-${theme}-narrow-management.png`), fullPage: true });
      Object.assign(narrowChecks.find(row => row.language === language && row.theme === theme && row.surface === 'management'), { status: 'PASS', reason: undefined });
      assert.deepEqual(pageErrors, [], 'Browser page errors');
    } finally { await context.close(); }
  }
  for (const language of ['en', 'zh']) {
    const colors = theme => themeEvidence.find(row => row.language === language && row.theme === theme && row.screen === 'bots');
    assert.notDeepEqual(colors('light')?.background, colors('dark')?.background, 'Host theme must change');
  }
}
const seedOnly = process.argv.includes('--seed-only');
let fixtureStatus = 'NOT_RUN';
let phase = seedOnly ? 'isolated-host' : 'browser-launch';
try {
  phase = 'isolated-host';
  const url = await prepareHost();
  fixtureStatus = 'PASS';
  if (seedOnly) for (const row of matrix) row.reason = 'NOT_RUN: seed-only mode';
  else {
    phase = 'browser-launch';
    const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
    const candidates = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse().flatMap(release => ['arm64', 'x64'].map(arch => resolve(cache, release, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))) : [];
    const executablePath = candidates.find(path => existsSync(path));
    assert.ok(executablePath, 'No cached Chromium; no download attempted');
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = env.TMPDIR;
    try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env, timeout: 30000 }); }
    finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
    phase = 'capture';
    await capture(url);
  }
} catch (error) {
  const reason = redact(error);
  failure = reason;
  for (const row of matrix.filter(row => row.status === 'FAIL')) row.reason = phase === 'browser-launch' ? 'environment: Chromium launch failed' : `${phase}: ${reason.slice(0, 200)}`;
  await writeFile(resolve(outputDir, 'error.log'), reason);
  process.exitCode = 1;
} finally {
  if (host) { host.child.kill('SIGTERM'); const timer = setTimeout(() => host.child.kill('SIGKILL'), 10000); await host.save(); clearTimeout(timer); }
  for (const child of children) child.kill('SIGKILL');
  await browser?.close();
  await mock?.close();
  const result = { fixtureStatus, profile, installedAudit, artifact: artifactAudit ? { sha256: artifactAudit.sha256, path: artifactAudit.artifact } : undefined, aliases, themeEvidence, sidebarEvidence, scrollEvidence, status: !failure && matrix.every(row => row.status === 'PASS') && narrowChecks.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL', phase, outputDir, workDir, realModelRequests: 0, modelRequests: mock?.requests.length ?? 0, commands, matrix, narrowChecks, pageErrors, ...(failure ? { failure } : {}) };
  await mkdir(resolve(home, 'p34-u12-13'), { recursive: true });
  await writeFile(resolve(home, 'p34-u12-13/latest-screenshots.txt'), `${outputDir}\n`);
  await writeFile(resolve(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ status: result.status, fixtureStatus, phase, outputDir }));
}
