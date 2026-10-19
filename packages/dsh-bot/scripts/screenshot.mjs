/**
 * Real rc.2 Web screenshots, with the installed Desktop CLI and cached Chromium.
 * Run from the repository root after scripts/pnpm check:
 *   DSH_HOME="$PWD/.dsh-dev" node scripts/screenshot.mjs
 * Default: five responsive Bots pages, two Chinese Bot-chat dialogs and two
 * Chinese native workspace lists. --workspace-only captures the latter two.
 * --extras-only keeps the Chinese editor/dialog regression surfaces.
 * --seed-only verifies committed mock assistant activity without Chromium.
 * No browser download, global install, Desktop mutation or real model calls.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { chromium } from 'playwright-core';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import WebSocket from 'ws';
import remoteContribution from 'dsh-bot/remote';
import { createClientActivityProbe } from '../tests/fixtures/client-activity-probe.mjs';
import { captureFailureEvidence, completeChatWorkspaceChoice, dismissFirstRunOverlays, installOverlayHandler, measureAvatars, readBotsLayout, readWorkspaceSessionRows, redactScreenshotText, screenshotCases, verifyAvatarContrast, verifyScreenshotActivity, verifyWorkspaceSessionRows } from './screenshot-support.ts';
import en from '../locale/en.json' with { type: 'json' };
import zh from '../locale/zh.json' with { type: 'json' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const seedOnly = process.argv.includes('--seed-only');
const extrasOnly = process.argv.includes('--extras-only');
const workspaceOnly = process.argv.includes('--workspace-only');
const mockReply = 'Mock assistant reply / 本地模拟回复：已经整理好资料、关键结论和下一步建议。打开会话即可继续讨论具体细节。';
if (process.argv.includes('--help')) {
  console.log('From the repository root: DSH_HOME="$PWD/.dsh-dev" node scripts/screenshot.mjs\nDefault: 5 Bots pages (zh/en light/dark wide + zh light narrow), 2 zh light/dark Bot-chat dialogs, and 2 zh light/dark native workspace lists. --workspace-only: 2 zh light/dark native workspace lists. --extras-only: 4 zh light/dark wide editor/Bot-chat screenshots. --seed-only: verify three loopback mock assistant sessions, previews and unread without Chromium (0 screenshots).\nUses only cached chromium_headless_shell; writes dist/screenshots/<run> and sanitized .dsh-dev/screenshots/<run> logs.');
} else {
  assert.ok([seedOnly, extrasOnly, workspaceOnly].filter(Boolean).length <= 1, 'Choose only one screenshot mode');
  assert.equal(process.cwd(), root, 'Run screenshots from the repository root');
  const home = resolve(root, '.dsh-dev');
  assert.ok(!process.env.DSH_HOME || resolve(process.env.DSH_HOME) === home, 'Only the repository .dsh-dev home is allowed');
  const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
  const output = resolve(root, 'dist/screenshots', stamp);
  const run = resolve(home, 'screenshots', stamp);
  const profile = `shot-${Date.now()}-${process.pid}`;
  const patch = resolve(run, 'profile.patch.yml');
  for (const dir of [output, run, resolve(run, 'tmp'), resolve(run, 'workspace')]) mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
    TMPDIR: resolve(run, 'tmp'), XDG_STATE_HOME: resolve(home, 'state'),
    NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'),
    pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
  };
  // Playwright creates temporary profiles in its parent process before spawning
  // Chromium, so child env alone is insufficient to keep those writes local.
  process.env.TMPDIR = env.TMPDIR;
  const secrets = new Set();
  const children = new Set();
  const shots = [];
  const browserErrors = [];
  const overlays = [];
  const contrastChecks = [];
  const workspaceChoices = [];
  const conversationChecks = [];
  const workspaceRowChecks = [];
  const failureEvidence = [];
  const sessionFixtures = [];
  let mock;
  let mockPromptsSent = 0;
  let browser;
  let activeContext;
  let activePage;
  let api;
  let failure;
  let stage = 'browser';
  let step = 'browser-launch';
  let interrupted = false;
  let prompts = 0;
  const redact = (value) => redactScreenshotText(value, secrets);
  const save = (name, value) => writeFileSync(resolve(output, name), `${redact(JSON.stringify(value, null, 2))}\n`);
  const diagnoseFailure = async () => {
    failureEvidence.push(await captureFailureEvidence(activePage, output, step, redact));
    save('failure.json', { stage, step, failure, failureEvidence });
  };
  function launch(args, name, observe = () => {}) {
    const child = spawn(resolve(root, 'scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const done = new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { children.delete(child); accept({ code, signal }); });
    });
    done.catch(() => {});
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      const line = (value) => {
        const clean = stripVTControlCharacters(value);
        observe(clean);
        appendFileSync(resolve(run, `${name}.log`), `${redact(clean)}\n`);
      };
      stream.on('data', (chunk) => {
        pending += chunk.toString();
        let index = pending.indexOf('\n');
        while (index !== -1) {
          line(pending.slice(0, index)); pending = pending.slice(index + 1);
          index = pending.indexOf('\n');
        }
      });
      stream.on('end', () => { if (pending) line(pending); });
    }
    return { child, done };
  }
  async function command(args, name) {
    step = name;
    let stdout = '';
    const job = launch(args, name, (line) => { stdout += `${line}\n`; });
    const timeout = setTimeout(() => job.child.kill('SIGKILL'), 180_000);
    try { assert.equal((await job.done).code, 0, `${name} failed; inspect sanitized log`); return stdout.trim(); }
    finally { clearTimeout(timeout); }
  }
  async function until(predicate, label, timeout = 120_000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      assert.ok(!interrupted && Date.now() < deadline, `${label} timed out or was interrupted`);
      await new Promise((accept) => setTimeout(accept, 100));
    }
  }
  function cachedBrowser() {
    const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
    const releases = readdirSync(cache).filter((name) => /^chromium_headless_shell-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
    for (const release of releases) for (const arch of ['arm64', 'x64']) {
      const executable = resolve(cache, release, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell');
      if (existsSync(executable)) return executable;
    }
    throw new Error('No cached macOS chromium_headless_shell found; no browser will be downloaded');
  }
  const onSignal = () => { interrupted = true; for (const child of children) child.kill('SIGTERM'); void browser?.close(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    assert.ok(existsSync(resolve(root, 'packages/dsh-bot/lib/client.js')), 'Build the package first');
    // Fail early when the runner sandbox cannot launch a browser. The profile
    // installation is not attempted in that case; the same script can be rerun.
    if (!seedOnly) {
      browser = await chromium.launch({ executablePath: cachedBrowser(), headless: true, chromiumSandbox: true, env, timeout: 30_000 });
      activeContext = await browser.newContext();
      activePage = await activeContext.newPage();
    }
    step = 'mock-start';
    mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: ['success', 'success', 'success'], successText: mockReply, randomSeed: 2 });
    assert.equal(new URL(mock.baseURL).hostname, '127.0.0.1');
    Object.assign(env, { DSH_BOT_MOCK_KEY: 'mock-key', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: `${mock.baseURL}/v1` });
    stage = 'profile';
    const versionOutput = await command(['--version'], 'version');
    // macOS can emit an Electron codesign diagnostic on stderr before stdout.
    assert.equal(versionOutput.split('\n').find((line) => /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(line)), '0.2.1-rc.2', 'Expected installed rc.2 CLI');
    const disabled = ['llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-telemetry-otel', 'desktop-product-telemetry'];
    writeFileSync(patch, [
      ...disabled.flatMap((id) => [`- id: ${id}`, '  disabled: true']),
      ...(mock ? [
        '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-flash', '    reasoningEffort: off',
        '- id: llm-deepseek', '  disabled: false', '  config:', '    apiKeyEnv: DSH_BOT_MOCK_KEY',
        `    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}`, '    thinking: disabled', '    reasoningEffort: off', '    maxTokens: 128',
        '- id: session-log-deepseek', '  disabled: true',
      ] : []),
      '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(run, 'storages'))}`,
      '- id: workspace-controller', '  config:', `    documentsDirectory: ${JSON.stringify(run)}`,
      '- id: dsh-bot', '  config:', '    seedExamples: false', `    dataDir: ${JSON.stringify(resolve(run, 'data'))}`, '',
    ].join('\n'));
    await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
    await command(['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'plugin-add');
    let startupUrl;
    step = 'host-start';
    let ended = false;
    const host = launch(['--profile', profile, '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'host', (line) => {
      const match = line.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
      if (match) { startupUrl = new URL(match[1]); secrets.add(startupUrl.searchParams.get('token')); }
    });
    host.done.finally(() => { ended = true; }).catch(() => {});
    await until(() => startupUrl || ended, 'Web Host readiness');
    assert.ok(startupUrl && !ended, 'Host stopped before readiness; inspect sanitized host.log');
    const origin = new URL('/', startupUrl).href;
    step = 'authenticate';
    const auth = await fetch(startupUrl, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    assert.equal(auth.status, 303, 'Startup token exchange');
    const cookiePairs = auth.headers.getSetCookie().map((value) => value.split(';', 1)[0]);
    const cookie = cookiePairs.join('; '); secrets.add(cookie);
    assert.ok(cookie, 'Authentication cookie missing');
    const cookies = cookiePairs.map((pair) => {
      const index = pair.indexOf('=');
      const value = pair.slice(index + 1); secrets.add(value);
      return { name: pair.slice(0, index), value, url: origin };
    });
    step = 'api-connect';
    api = new Context();
    await api.plugin({ apply(ctx) {
      new TypertRegistry(ctx);
      installConnection(ctx, { interactions: 'none', transport: {
        streamBaseUrl: origin,
        fetch: (input, init) => fetch(new URL(String(input), origin), {
          ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
          signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]),
        }),
        createWebSocket: (url) => new WebSocket(url, { headers: { cookie } }),
      } });
      ctx.plugin(Gateway);
    } }).await();
    await api.effect(() => api.remote.$mount(remoteContribution));
    const unwrap = (result) => { assert.equal(result.ok, true, `Remote failed: ${result.error?.code ?? ''}`); return result.value; };
    const raw = async (name, args) => unwrap(await api.connection.rpc.call('/api', name, { args }, AbortSignal.timeout(30_000)));
    step = 'seed-workspace-and-bots';
    const { workspace } = await raw('workspace/create', { request: { path: resolve(run, 'workspace') } });
    assert.ok(typeof workspace?.workspaceId === 'string' && workspace.workspaceId, 'Created workspace id missing');
    const bot = unwrap(await api.remote.dshBot.create({ id: 'shot-assistant', name: 'Atlas / 助手', description: 'Focused help. 专注解答。' }));
    const researcher = unwrap(await api.remote.dshBot.create({ id: 'shot-researcher', name: 'Research / 研究员', description: 'Explore sources, compare ideas and organize findings. 查证资料、比较思路并整理结论。' }));
    const statuses = unwrap(await api.remote.dshBot.status());
    const status = statuses.find((entry) => entry.id === bot.id);
    assert.equal(status?.preset.state, 'ok', 'Screenshot Bot preset healthy');
    if (mock) {
      for (const [index, sample] of [bot, researcher, bot].entries()) {
        step = `seed-${sample.id}`;
        const preset = statuses.find((entry) => entry.id === sample.id);
        assert.equal(preset?.preset.state, 'ok');
        const { sessionId } = await raw('session/create', { request: { workspaceId: workspace.workspaceId, agentPreset: preset.presetId } });
        const title = `${sample.name} · ${index === 2 ? '最新进展 / Latest update' : '示例对话 / Example conversation'}`;
        // Activity snapshots the public title when the assistant message commits.
        await raw('session/rename', { request: { sessionId, title } });
        const receipt = await raw('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue',
          content: [{ type: 'text', text: `为 ${sample.name} 准备一条本地模拟示例对话。` }] } });
        assert.equal(receipt.accepted, true);
        mockPromptsSent++;
        const deadline = Date.now() + 45_000;
        let values;
        let finished = false;
        do {
          const projection = await raw('session/projections', { request: { sessionId } });
          values = projection?.values;
          const list = await raw('session/list', { _request: {} });
          const summary = list.items.find((item) => item.sessionId === sessionId);
          finished = summary?.blank === false && summary.running === false && values?.sessionStats?.turns >= 1;
          if (!finished) {
            assert.ok(Date.now() < deadline && !interrupted, 'Mock turn did not finish');
            await new Promise((accept) => setTimeout(accept, 100));
          }
        } while (!finished);
        assert.equal(values.agentPreset, preset.presetId);
        // Read the older Atlas conversation to cover a real read/unread mix.
        if (index === 0) unwrap(await api.remote.dshBot.activity.markRead(sessionId));
        sessionFixtures.push({ botId: sample.id, sessionId, title, agentPreset: preset.presetId, blank: false, turns: values.sessionStats.turns, unread: index !== 0 });
      }
      assert.equal(mock.requests.length, 3, 'Only three loopback model requests');
      assert.ok(mock.requests.every((request) => request.outcome === 'completed'), 'All mock replies completed');
      const activity = unwrap(await api.remote.dshBot.activity.list());
      verifyScreenshotActivity(activity, sessionFixtures, mockReply);
      assert.equal(activity.sessions.filter((row) => row.unread).length, 2, 'Two assistant sessions remain unread');
      // Also exercise the shipped factory's plugin scope: root-context Remote
      // calls alone cannot detect missing nested Cordis service access.
      const client = await createClientActivityProbe(api.connection);
      let clientActivity;
      try {
        await client.activity.refresh();
        assert.equal(client.activity.getSnapshot().error, undefined, 'Shipped Client activity list succeeds');
        verifyScreenshotActivity(client.activity.getSnapshot(), sessionFixtures, mockReply);
        await client.activity.markRead(sessionFixtures[0].sessionId);
        assert.equal(client.activity.getSnapshot().error, undefined, 'Shipped Client markRead refetch succeeds');
        clientActivity = client.activity.getSnapshot();
        verifyScreenshotActivity(clientActivity, sessionFixtures, mockReply);
      } finally { await client.dispose(); }
      save('mock-sessions.json', { sessionFixtures, activity, clientActivity, shippedClientFactory: true,
        mockPromptsSent, requests: mock.requests.map(({ path, outcome }) => ({ path, outcome })) });
    }
    stage = seedOnly ? 'seed-validation' : 'screenshots';
    for (const { language, theme, viewport, width, height } of seedOnly || workspaceOnly ? [] : screenshotCases(extrasOnly)) {
      const copy = language === 'zh' ? zh.ui : en.ui;
      const filename = `${language}-${theme}-${viewport}`;
      step = `${filename}-new-page`;
      assert.ok(!interrupted, 'Screenshot run interrupted');
      await activeContext.close();
      const context = await browser.newContext({ viewport: { width, height }, locale: language === 'zh' ? 'zh-CN' : 'en-US', colorScheme: theme, reducedMotion: 'reduce' });
      activeContext = context;
      await context.addCookies(cookies);
      // UI exercise creates idle sessions only. All intentional prompts above
      // were sent through the local mock profile's authenticated Remote API.
      await context.route('**/api/session/prompt', (route) => { prompts++; return route.abort('blockedbyclient'); });
      const page = await context.newPage();
      activePage = page;
      page.setDefaultTimeout(30_000);
      page.on('pageerror', (error) => browserErrors.push(redact(error.message)));
      const recordOverlay = (event) => overlays.push({ language, theme, viewport, ...event });
      await installOverlayHandler(page, recordOverlay);
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      step = `${filename}-bots-navigation`;
      await dismissFirstRunOverlays(page, recordOverlay, 'new-page-language-and-theme');
      await page.getByRole('button', { name: 'Bots', exact: true }).click();
      await dismissFirstRunOverlays(page, recordOverlay, 'bots-navigation');
      const bots = page.locator('[data-bots-page]');
      const option = bots.locator(`[role="option"][data-bot-id="${bot.id}"]`);
      await option.getByText(mockReply, { exact: true }).waitFor();
      const create = bots.getByRole('button', { name: copy['bots.create'], exact: true });
      await create.waitFor();
      await page.evaluate(() => document.fonts.ready);
      if (viewport === 'wide') await option.click();
      step = `${filename}-bots-layout`;
      await page.waitForFunction((narrow) => {
        const region = document.querySelector('[data-bots-page]');
        const list = region?.querySelector('[role="listbox"]')?.getBoundingClientRect();
        const detail = region?.querySelector('[data-bot-detail]')?.getBoundingClientRect();
        return list && list.width > 0 && (narrow ? !detail || detail.width === 0 : detail && detail.width > 0 && list.right <= detail.left + 1);
      }, viewport === 'narrow');
      const layout = await page.evaluate(readBotsLayout);
      assert.deepEqual(layout.optionIds, [bot.id, researcher.id], 'Bots sorted by newest activity');
      assert.ok(layout.previews.length >= 2 && layout.previews.every((preview) => preview.textOverflow === 'ellipsis' && preview.whiteSpace === 'nowrap' && preview.overflow === 'hidden'), 'Visible previews have single-line ellipsis CSS');
      assert.ok(layout.unreadDots >= 1, 'Bots show unread assistant activity');
      if (viewport === 'wide') {
        assert.equal(layout.selectedBotId, bot.id);
        assert.equal(layout.detailBotId, bot.id);
        assert.deepEqual(layout.sessionIds, [...sessionFixtures].reverse().filter((fixture) => fixture.botId === bot.id).map((fixture) => fixture.sessionId), 'Selected Bot history sorted newest first');
      }
      const mainWidth = await bots.evaluate((element) => element.getBoundingClientRect().width);
      const bodyTheme = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim());
      const capture = async (surface, readyTarget, expectedIds) => {
        step = `${filename}-${surface}-capture`;
        await dismissFirstRunOverlays(page, recordOverlay, `before-${surface}-capture`);
        await readyTarget.click({ trial: true });
        await dismissFirstRunOverlays(page, recordOverlay, `${surface}-ready`);
        const avatars = await measureAvatars(page);
        contrastChecks.push({ language, theme, viewport, surface, avatars, expectedIds });
        save('progress.json', { overlays, workspaceChoices, conversationChecks, contrastChecks, screenshots: shots });
        verifyAvatarContrast(avatars, expectedIds);
        await page.screenshot({ path: resolve(output, `${filename}-${surface}.png`), fullPage: true, animations: 'disabled' });
        shots.push({ file: `${filename}-${surface}.png`, language, theme, viewport, width, height, surface, bodyTheme, mainWidth, avatars,
          ...(surface === 'bots' ? { layout } : {}) });
      };
      if (!extrasOnly) await capture('bots', create, [bot.id, researcher.id]);
      const detail = bots.locator(`[data-bot-detail="${bot.id}"]`);
      if (viewport === 'narrow') {
        await option.click();
        await detail.waitFor();
        const narrowDetail = await page.evaluate(readBotsLayout);
        assert.equal(narrowDetail.listVisible, false, 'Narrow selection hides the list');
        assert.equal(narrowDetail.detailVisible, true, 'Narrow selection reveals detail');
        await detail.getByRole('button', { name: copy['bots.back'], exact: true }).click();
        await option.waitFor();
        const narrowList = await page.evaluate(readBotsLayout);
        assert.equal(narrowList.listVisible, true, 'Back returns to the list');
        assert.equal(narrowList.detailVisible, false, 'Back hides detail');
        conversationChecks.push({ language, theme, viewport, kind: 'narrow-navigation', selectedBotId: bot.id, detail: narrowDetail, back: narrowList });
        await option.click();
      }
      if (extrasOnly) {
        step = `${filename}-editor-open`;
        await detail.getByRole('button', { name: copy['card.edit'], exact: true }).click();
        const editor = page.getByRole('dialog', { name: copy['editor.edit'], exact: true });
        await editor.getByRole('img', { name: copy['avatar.current'], exact: true }).scrollIntoViewIfNeeded();
        await editor.getByRole('group', { name: copy['avatar.color'], exact: true }).waitFor();
        await capture('editor', editor.getByRole('button', { name: copy['actions.close'], exact: true }), [bot.id]);
        await editor.getByRole('button', { name: copy['actions.close'], exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
      }
      if (language === 'zh' && viewport === 'wide') {
        step = `${filename}-bot-chats-open`;
        await page.getByRole('button', { name: copy['sidebar.sessions'], exact: true }).click();
        const chats = page.getByRole('dialog', { name: copy['sidebar.sessions'], exact: true });
        for (const fixture of sessionFixtures) {
          const row = chats.locator(`section[data-bot-id="${fixture.botId}"] [data-session-id="${fixture.sessionId}"]`);
          await row.getByText(mockReply, { exact: true }).waitFor();
        }
        assert.ok(await chats.locator('[data-unread]').count() > 0, 'Bot-chat dialog displays unread activity');
        await capture('bot-chats', chats.getByRole('button', { name: copy['actions.close'], exact: true }), [bot.id, researcher.id]);
        await chats.getByRole('button', { name: copy['actions.close'], exact: true }).click();
        await chats.waitFor({ state: 'hidden' });
      }
      // Exercise new-conversation after the final matrix capture so earlier
      // screenshots keep exactly the seeded history and its unread state.
      if (!extrasOnly && viewport === 'narrow') {
        step = `${filename}-start-chat`;
        await detail.getByRole('button', { name: copy['bots.newSession'], exact: true }).click();
        const conversation = page.locator('[data-conversation-content][data-conversation-session][data-content-phase="hero"]');
        const editor = conversation.getByRole('textbox');
        await dismissFirstRunOverlays(page, recordOverlay, 'after-start-chat');
        const choice = await completeChatWorkspaceChoice(page, editor, workspace.workspaceId, copy);
        workspaceChoices.push({ language, theme, viewport, workspaceId: workspace.workspaceId, outcome: choice });
        await editor.waitFor();
        await bots.waitFor({ state: 'hidden' });
        const sessionId = await conversation.getAttribute('data-conversation-session');
        assert.ok(sessionId, 'Blank session has an actual Host session id');
        const projection = await raw('session/projections', { request: { sessionId } });
        assert.equal(projection?.kind, 'sequenced');
        assert.equal(projection.values.agentPreset, status.presetId, 'New conversation uses selected Bot preset');
        conversationChecks.push({ language, theme, viewport, sessionId, workspaceId: workspace.workspaceId,
          agentPreset: projection.values.agentPreset, phase: 'hero', headerBadgeExpected: false, promptsSent: 0 });
      }
      console.log(`PASS: ${language}/${theme}/${viewport} ${extrasOnly ? 'editor/Bot-chat dialogs' : viewport === 'narrow' ? 'responsive Bots page and new conversation' : 'two-pane Bots page'} with committed mock previews/unread`);
    }
    // Opening each native conversation clears the Host's new-message state,
    // which otherwise replaces its leading slot with a status dot. Run this
    // after the existing matrix so its read/unread fixtures remain unchanged.
    for (const { language, theme, viewport, width, height } of seedOnly || extrasOnly ? [] : screenshotCases(true)) {
      const filename = `${language}-${theme}-${viewport}-workspace`;
      step = `${filename}-new-page`;
      await activeContext.close();
      const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', colorScheme: theme, reducedMotion: 'reduce' });
      activeContext = context;
      await context.addCookies(cookies);
      await context.route('**/api/session/prompt', (route) => { prompts++; return route.abort('blockedbyclient'); });
      const page = await context.newPage();
      activePage = page;
      page.setDefaultTimeout(30_000);
      page.on('pageerror', (error) => browserErrors.push(redact(error.message)));
      const recordOverlay = (event) => overlays.push({ language, theme, viewport, surface: 'workspace', ...event });
      await installOverlayHandler(page, recordOverlay);
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, recordOverlay, 'workspace-new-page');
      step = `${filename}-expand-workspace`;
      // Enter through the native tree in a fresh Client, without warming the
      // Bot metadata catalog by mounting the Bots page first.
      const group = page.locator(`[role="treeitem"][data-row-key="workspace:${workspace.workspaceId}"]`);
      await group.waitFor();
      if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
      await page.waitForFunction(() => document.documentElement.lang.startsWith('zh'));
      for (const fixture of sessionFixtures) {
        step = `${filename}-view-${fixture.botId}`;
        const row = page.locator(`[role="treeitem"][data-row-key="session:${fixture.sessionId}"]`);
        await row.click();
        await page.locator(`[data-conversation-content][data-conversation-session="${fixture.sessionId}"]`).waitFor();
        await row.locator(`[data-bot-session-leading][data-session-id="${fixture.sessionId}"] [data-bot-avatar]`).waitFor();
      }
      step = `${filename}-capture`;
      await page.mouse.move(width - 1, height - 1);
      await page.evaluate(() => document.fonts.ready);
      await dismissFirstRunOverlays(page, recordOverlay, 'before-workspace-capture');
      const rows = await page.evaluate(readWorkspaceSessionRows);
      const evidence = { language, theme, viewport, surface: 'workspace', rows, viewedSessionIds: sessionFixtures.map((fixture) => fixture.sessionId) };
      workspaceRowChecks.push(evidence);
      save('progress.json', { overlays, workspaceChoices, conversationChecks, workspaceRowChecks, contrastChecks, screenshots: shots });
      verifyWorkspaceSessionRows(rows, sessionFixtures);
      const avatars = await measureAvatars(page);
      const expectedIds = [bot.id, researcher.id];
      verifyAvatarContrast(avatars, expectedIds);
      const bodyTheme = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim());
      contrastChecks.push({ language, theme, viewport, surface: 'workspace', avatars, expectedIds });
      await page.screenshot({ path: resolve(output, `${filename}.png`), fullPage: true, animations: 'disabled' });
      shots.push({ file: `${filename}.png`, language, theme, viewport, width, height, surface: 'workspace', bodyTheme, avatars, rows });
      save('progress.json', { overlays, workspaceChoices, conversationChecks, workspaceRowChecks, contrastChecks, screenshots: shots });
      console.log(`PASS: ${language}/${theme}/${viewport} native workspace Bot session rows (16px, centered)`);
    }
    step = 'matrix-validation';
    assert.equal(prompts, 0, 'No browser model prompt attempted');
    assert.equal(browserErrors.length, 0, 'Browser page errors; inspect summary');
    assert.equal(shots.length, seedOnly ? 0 : extrasOnly ? 4 : workspaceOnly ? 2 : 9, 'Complete the requested screenshot set');
    if (!seedOnly) assert.notEqual(shots.find((shot) => shot.theme === 'light').bodyTheme, shots.find((shot) => shot.theme === 'dark').bodyTheme, 'Host theme actually changes tokens');
  } catch (error) {
    failure = redact(error instanceof Error ? error.message : error);
    await diagnoseFailure().catch((error) => { failureEvidence.push({ step, diagnosticError: redact(error) }); });
    console.error(`FAIL (${stage}): ${failure.split('\n', 1)[0]} (details in summary.json)`);
    process.exitCode = 1;
  } finally {
    await api?.fiber.dispose().catch(async (error) => {
      failure ??= redact(error); process.exitCode = 1; step = 'api-dispose';
      await diagnoseFailure().catch(() => {});
    });
    await browser?.close().catch(() => {});
    for (const child of children) child.kill('SIGTERM');
    await until(() => children.size === 0, 'Host shutdown', 10_000).catch(() => { for (const child of children) child.kill('SIGKILL'); });
    await mock?.close();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    save('summary.json', { status: failure ? 'FAIL' : 'PASS', mode: seedOnly ? 'seed-only' : extrasOnly ? 'extras-only' : workspaceOnly ? 'workspace-only' : 'matrix',
      mockPromptsSent, sessionFixtures, mockRequests: mock?.requests.map(({ path, outcome }) => ({ path, outcome })),
      stage, step, failure, failureEvidence, profile, run, prompts, browserErrors,
      overlays, workspaceChoices, conversationChecks, workspaceRowChecks, contrastChecks, screenshots: shots });
    console.log(`Evidence: ${output}`);
  }
}
