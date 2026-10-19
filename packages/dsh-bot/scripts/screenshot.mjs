/**
 * Real rc.2 Web screenshots, with the installed Desktop CLI and cached Chromium.
 * Run from the repository root after scripts/pnpm check:
 *   DSH_HOME="$PWD/.dsh-shot" node scripts/screenshot.mjs
 * --extras-only adds the two Chinese/wide dialog surfaces using loopback mock
 * sessions; --seed-only verifies that preparation without launching Chromium.
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
import { captureFailureEvidence, completeChatWorkspaceChoice, dismissFirstRunOverlays, installOverlayHandler, measureAvatars, redactScreenshotText, verifyAvatarContrast } from './screenshot-support.ts';
import en from '../locale/en.json' with { type: 'json' };
import zh from '../locale/zh.json' with { type: 'json' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const seedOnly = process.argv.includes('--seed-only');
const extrasOnly = seedOnly || process.argv.includes('--extras-only');
if (process.argv.includes('--help')) {
  console.log('From the repository root: DSH_HOME="$PWD/.dsh-shot" node scripts/screenshot.mjs\nDefault: 16 Bots/blank-session screenshots. --extras-only: 4 zh/light+dark/wide editor/Bot-chats screenshots, two loopback mock sessions. --seed-only: verify mock preparation without Chromium (0 screenshots).\nUses only cached chromium_headless_shell; writes dist/screenshots/<run> and sanitized .dsh-shot logs.');
} else {
  assert.equal(process.cwd(), root, 'Run screenshots from the repository root');
  const home = resolve(root, '.dsh-shot');
  assert.ok(!process.env.DSH_HOME || resolve(process.env.DSH_HOME) === home, 'Only the repository .dsh-shot home is allowed');
  const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
  const output = resolve(root, 'dist/screenshots', stamp);
  const run = resolve(home, 'runs', stamp);
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
    if (extrasOnly) {
      step = 'mock-start';
      mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: ['success', 'success'], successText: '本地模拟回复：示例对话已准备好。', randomSeed: 2 });
      assert.equal(new URL(mock.baseURL).hostname, '127.0.0.1');
      Object.assign(env, { DSH_BOT_MOCK_KEY: 'mock-key', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: `${mock.baseURL}/v1` });
    }
    stage = 'profile';
    const versionOutput = await command(['--version'], 'version');
    // macOS can emit an Electron codesign diagnostic on stderr before stdout.
    assert.equal(versionOutput.split('\n').find((line) => /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(line)), '0.2.1-rc.2', 'Expected installed rc.2 CLI');
    const disabled = [...(extrasOnly ? [] : ['llm-deepseek']), 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-telemetry-otel', 'desktop-product-telemetry'];
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
      for (const sample of [bot, researcher]) {
        step = `seed-${sample.id}`;
        const preset = statuses.find((entry) => entry.id === sample.id);
        assert.equal(preset?.preset.state, 'ok');
        const { sessionId } = await raw('session/create', { request: { workspaceId: workspace.workspaceId, agentPreset: preset.presetId } });
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
        const title = `${sample.name} · 示例对话`;
        await raw('session/rename', { request: { sessionId, title } });
        sessionFixtures.push({ botId: sample.id, sessionId, title, agentPreset: preset.presetId, blank: false, turns: values.sessionStats.turns });
      }
      assert.equal(mock.requests.length, 2, 'Only two loopback model requests');
      assert.ok(mock.requests.every((request) => request.outcome === 'completed'), 'Both mock replies completed');
      save('mock-sessions.json', { sessionFixtures, mockPromptsSent, requests: mock.requests.map(({ path, outcome }) => ({ path, outcome })) });
    }
    stage = 'screenshots';
    // rc.2 collapses the sidebar to a 56px rail below 1024px. A 720px
    // viewport still leaves a 664px main pane, above Bots' 600px breakpoint.
    for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) for (const [viewport, width, height] of [['wide', 1440, 1000], ['narrow', 600, 900]]) {
      if (seedOnly || (extrasOnly && (language !== 'zh' || viewport !== 'wide'))) continue;
      const filename = `${language}-${theme}-${viewport}`;
      step = `${filename}-new-page`;
      assert.ok(!interrupted, 'Screenshot run interrupted');
      await activeContext.close();
      const context = await browser.newContext({ viewport: { width, height }, locale: language === 'zh' ? 'zh-CN' : 'en-US', colorScheme: theme, reducedMotion: 'reduce' });
      activeContext = context;
      {
        await context.addCookies(cookies);
        // Guard the harness too: UI actions must create idle sessions, never prompts.
        await context.route('**/api/session/prompt', (route) => { prompts++; return route.abort('blockedbyclient'); });
        const page = await context.newPage();
        activePage = page;
        page.setDefaultTimeout(30_000);
        page.on('pageerror', (error) => browserErrors.push(redact(error.message)));
        const recordOverlay = (event) => overlays.push({ language, theme, viewport, ...event });
        await installOverlayHandler(page, recordOverlay);
        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        step = `${filename}-bots-navigation`;
        // A new context also changes locale/theme. Handle both localized preview
        // titles and exact allowlisted actions on subsequent first-run steps.
        await dismissFirstRunOverlays(page, recordOverlay, 'new-page-language-and-theme');
        await page.getByRole('button', { name: 'Bots', exact: true }).click();
        await dismissFirstRunOverlays(page, recordOverlay, 'bots-navigation');
        const bots = page.getByRole('region', { name: 'Bots', exact: true });
        await bots.getByRole('heading', { name: bot.name, exact: true }).waitFor();
        const createText = language === 'zh' ? '新建 Bot' : 'New Bot';
        await bots.getByRole('button', { name: createText, exact: true }).waitFor();
        step = `${filename}-bots-layout`;
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction((narrow) => {
          const region = document.querySelector('[data-bots-page]');
          const cards = region?.querySelectorAll('article');
          if (!region || !cards || cards.length < 2) return false;
          const first = cards[0].getBoundingClientRect();
          const second = cards[1].getBoundingClientRect();
          return narrow ? second.top > first.top : Math.abs(second.top - first.top) < 1;
        }, viewport === 'narrow');
        const mainWidth = await bots.evaluate((element) => element.getBoundingClientRect().width);
        const cardLayouts = await bots.locator('article').evaluateAll((cards) => cards.map((card) => {
          const footer = card.querySelector('footer');
          const buttons = Array.from(footer?.querySelectorAll('button') ?? []);
          return { height: card.getBoundingClientRect().height, minHeight: getComputedStyle(card).minHeight,
            descriptionHeight: card.querySelector('p')?.getBoundingClientRect().height,
            actionsWidth: footer?.getBoundingClientRect().width,
            buttons: buttons.map((button) => ({ width: button.getBoundingClientRect().width,
              height: button.getBoundingClientRect().height, flexGrow: getComputedStyle(button).flexGrow })) };
        }));
        for (const layout of cardLayouts) {
          assert.equal(layout.buttons.length, 2, 'Card primary/secondary button group');
          assert.ok(layout.buttons.every((button) => Math.abs(button.height - 28) < 1 && button.flexGrow === '0'), 'Intrinsic-width, equal-height native sm buttons');
        }
        const bodyTheme = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim());
        let conversationEvidence;
        const capture = async (surface, readyTarget) => {
          step = `${filename}-${surface}-capture`;
          await dismissFirstRunOverlays(page, recordOverlay, `before-${surface}-capture`);
          // Trial performs normal actionability checks, invoking the installed
          // handler for a delayed notice, without starting a chat/opening detail.
          await readyTarget.click({ trial: true });
          await dismissFirstRunOverlays(page, recordOverlay, `${surface}-ready`);
          const avatars = await measureAvatars(page);
          // rc.2 hides header utilities on blank sessions, so no BotAvatar
          // is expected there. Do not mislabel missing draft chrome as a pass
          // for the real, nonblank session badge's contrast.
          const expectedIds = surface === 'blank-session' ? [] : surface === 'editor' ? [bot.id] : [bot.id, researcher.id];
          const measurement = { language, theme, viewport, surface, avatars, expectedIds };
          contrastChecks.push(measurement);
          // Persist actual measured values even if contrast or screenshot fails.
          save('progress.json', { overlays, workspaceChoices, conversationChecks, contrastChecks, screenshots: shots });
          verifyAvatarContrast(avatars, expectedIds);
          const path = resolve(output, `${filename}-${surface}.png`);
          await page.screenshot({ path, fullPage: true, animations: 'disabled' });
          shots.push({ file: `${filename}-${surface}.png`, language, theme, viewport, width, height, surface, bodyTheme, mainWidth, avatars,
            ...(conversationEvidence ? { conversationEvidence } : {}),
            ...(surface === 'bots' ? { cardLayouts } : {}) });
        };
        const card = bots.locator('article').filter({ has: page.getByRole('heading', { name: bot.name, exact: true }) });
        if (extrasOnly) {
          step = `${filename}-editor-open`;
          await card.getByRole('button', { name: zh.ui['card.edit'], exact: true }).click();
          const editor = page.getByRole('dialog', { name: zh.ui['editor.edit'], exact: true });
          const preview = editor.getByRole('img', { name: zh.ui['avatar.current'], exact: true });
          await preview.scrollIntoViewIfNeeded();
          await editor.getByRole('group', { name: zh.ui['avatar.color'], exact: true }).waitFor();
          await capture('editor', editor.getByRole('button', { name: zh.ui['actions.close'], exact: true }));
          await editor.getByRole('button', { name: zh.ui['actions.close'], exact: true }).click();
          await editor.waitFor({ state: 'hidden' });
          step = `${filename}-bot-chats-open`;
          await page.getByRole('button', { name: zh.ui['sidebar.sessions'], exact: true }).click();
          const chats = page.getByRole('dialog', { name: zh.ui['sidebar.sessions'], exact: true });
          for (const fixture of sessionFixtures) {
            await chats.locator(`section[data-bot-id="${fixture.botId}"] [data-session-id="${fixture.sessionId}"]`).waitFor();
          }
          await capture('bot-chats', chats.getByRole('button', { name: zh.ui['actions.close'], exact: true }));
          console.log(`PASS: ${language}/${theme}/${viewport} editor and Bot chats with two nonblank mock sessions`);
          continue;
        }
        const start = card.getByRole('button', { name: language === 'zh' ? '开始聊天' : 'Start chat', exact: true });
        await capture('bots', start);
        step = `${filename}-start-chat`;
        await dismissFirstRunOverlays(page, recordOverlay, 'before-start-chat');
        await start.click();
        const conversation = page.locator('[data-conversation-content][data-conversation-session][data-content-phase="hero"]');
        const editor = conversation.getByRole('textbox');
        await dismissFirstRunOverlays(page, recordOverlay, 'after-start-chat');
        step = `${filename}-workspace-choice`;
        const choice = await completeChatWorkspaceChoice(page, editor, workspace.workspaceId, language === 'zh' ? zh.ui : en.ui);
        workspaceChoices.push({ language, theme, viewport, workspaceId: workspace.workspaceId, outcome: choice });
        step = `${filename}-blank-session-ready`;
        await editor.waitFor();
        await bots.waitFor({ state: 'hidden' });
        await conversation.getByRole('button', { name: bot.name, exact: true }).waitFor();
        const sessionId = await conversation.getAttribute('data-conversation-session');
        assert.ok(sessionId, 'Blank session must have an actual Host session id');
        step = `${filename}-blank-session-projection`;
        const projection = await raw('session/projections', { request: { sessionId } });
        assert.equal(projection?.kind, 'sequenced', 'Active session projection is authoritative');
        assert.equal(projection.values.agentPreset, status.presetId, 'Blank session uses the selected Bot preset');
        conversationEvidence = { sessionId, workspaceId: workspace.workspaceId, agentPreset: projection.values.agentPreset,
          phase: 'hero', botLabel: bot.name, headerBadgeExpected: false, promptsSent: 0 };
        conversationChecks.push({ language, theme, viewport, ...conversationEvidence });
        await capture('blank-session', editor);
        console.log(`PASS: ${language}/${theme}/${viewport} Bots page and blank Bot session (no prompt)`);
      }
    }
    step = 'matrix-validation';
    assert.equal(prompts, 0, 'No model prompt attempted');
    assert.equal(browserErrors.length, 0, 'Browser page errors; inspect summary');
    assert.equal(shots.length, seedOnly ? 0 : extrasOnly ? 4 : 16, 'Complete the requested screenshot set');
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
    save('summary.json', { status: failure ? 'FAIL' : 'PASS', mode: seedOnly ? 'seed-only' : extrasOnly ? 'extras-only' : 'matrix',
      mockPromptsSent, sessionFixtures, mockRequests: mock?.requests.map(({ path, outcome }) => ({ path, outcome })),
      stage, step, failure, failureEvidence, profile, run, prompts, browserErrors,
      overlays, workspaceChoices, conversationChecks, contrastChecks, screenshots: shots });
    console.log(`Evidence: ${output}`);
  }
}
