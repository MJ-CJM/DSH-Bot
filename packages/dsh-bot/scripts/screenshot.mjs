/**
 * Real rc.2 Web screenshots, with the installed Desktop CLI and cached Chromium.
 * Run from the repository root after scripts/pnpm check:
 *   DSH_HOME="$PWD/.dsh-dev" node scripts/screenshot.mjs
 * Default: five responsive Bots pages, two Chinese Bot-chat dialogs and two
 * Chinese native workspace lists. --workspace-only captures the latter two.
 * --right-tab-only captures two Chinese conversation/Bots right-tab surfaces.
 * --extras-only keeps the Chinese editor/dialog regression surfaces.
 * --v015 captures T08i Bots/menu, directory settings, and the usable native
 * conversation with its Bots workspace/whale row in zh light/dark.
 * --home-only remains an alias for --v015.
 * --v016 captures Chinese light/dark native navigation with the shared whale,
 * verifies its geometry/paint, and publishes .codex/screens/v016-{theme}.png.
 * --seed-only verifies committed mock assistant activity without Chromium.
 * --manual-browser prepares that same Host for an external browser until stopped.
 * No browser download, global install, Desktop mutation or real model calls.
 */
import assert from 'node:assert/strict';
import { captureAvatars } from './screenshot-avatars.mjs';
import { captureRoutines, seedRoutineScreenshots, verifyRoutineClient } from './screenshot-routines.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
import { captureFailureEvidence, captureRefreshStability, dismissFirstRunOverlays, installOverlayHandler, measureAvatars, readBotsLayout, readBotsRightTab, readNavigationWhale, readWorkspaceSessionRows, redactScreenshotText, screenshotCases, verifyAvatarContrast, verifyBotsRightTab, verifyNavigationWhale, verifyRefreshStability, verifyScreenshotActivity, verifyWorkspaceSessionRows, waitForInitialBotHistory } from './screenshot-support.ts';
import en from '../locale/en.json' with { type: 'json' };
import zh from '../locale/zh.json' with { type: 'json' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const avatarOnly = process.argv.includes('--v022-avatar');
const seedOnly = process.argv.includes('--seed-only');
const extrasOnly = process.argv.includes('--extras-only');
const homeOnly = process.argv.includes('--v015') || process.argv.includes('--home-only');
const routinesSeedOnly = process.argv.includes('--v022-seed-only');
const routinesHostOnly = process.argv.includes('--v022-host-only');
const routinesOnly = process.argv.includes('--v022');
const navOnly = process.argv.includes('--v016');
const workspaceOnly = process.argv.includes('--workspace-only');
const rightTabOnly = process.argv.includes('--right-tab-only');
const manualBrowser = process.argv.includes('--manual-browser');
const mockReply = 'Mock assistant reply / 本地模拟回复：已经整理好资料、关键结论和下一步建议。打开会话即可继续讨论具体细节。';

// Observe the native rendered surface only. No Client internals, DOM rewrites,
// or injected state may turn an inert composer into a passing screenshot.
async function verifyNativeBotsConversation(page, conversation, editor, workspaceId, sessionId, avatarFixture, viewport = 'wide') {
  // Narrow layouts collapse the native sidebar. Validate their visible hero
  // below, alongside the caller's public session cwd/blank/preset checks.
  if (viewport !== 'narrow') {
    const group = page.locator(`[role="treeitem"][data-row-key="workspace:${workspaceId}"]`);
    await group.getByText('Bots', { exact: true }).waitFor();
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
    const row = page.locator(`[role="treeitem"][data-row-key="session:${sessionId}"]`);
    await row.waitFor();
    if (avatarFixture) {
      // rc.2 omits leading on blank rows. The completed fixture was viewed before
      // creating this blank session, so its native status dot is already cleared.
      const completed = page.locator(`[role="treeitem"][data-row-key="session:${avatarFixture.sessionId}"]`);
      await completed.locator(`[data-bot-session-leading] [data-bot-avatar="whale"][data-bot-id="${avatarFixture.botId}"]`).waitFor();
      verifyWorkspaceSessionRows(await page.evaluate(readWorkspaceSessionRows), [avatarFixture]);
    }
  }
  const chip = conversation.locator('button[aria-haspopup="menu"]').filter({ hasText: /^Bots$/ });
  await chip.waitFor();
  assert.equal(await chip.getAttribute('aria-expanded'), 'false', 'Native workspace picker remains closed');
  assert.equal(await page.getByRole('menu').count(), 0, 'No native workspace selection menu is open');
  assert.equal(await editor.isEnabled(), true, 'Native input is enabled');
  assert.equal(await editor.isEditable(), true, 'Native input is editable');
  const inputState = await editor.evaluate((element) => ({
    disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
    inert: element.closest('[inert]') !== null,
    readOnly: element.hasAttribute('readonly'),
  }));
  assert.deepEqual(inputState, { disabled: false, inert: false, readOnly: false });
  await editor.click({ trial: true });
  return inputState;
}

if (process.argv.includes('--help')) {
  console.log('From the repository root: DSH_HOME="$PWD/.dsh-dev" node scripts/screenshot.mjs\nDefault: 5 Bots pages (zh/en light/dark wide + zh light narrow), 2 zh light/dark Bot-chat dialogs, and 2 zh light/dark native workspace lists; plus a zh-light-wide refresh A/B pair after at least two observed polling cycles. --workspace-only: 2 zh light/dark native workspace lists. --right-tab-only: 2 zh light/dark conversation/Bots right tabs, then recent/new-session navigation checks. --v015 (alias --home-only): 6 zh light/dark T08i Bots/menu, directory settings and native conversation screenshots, asserting enabled/editable/non-inert input, Bots hero chip and Bots group with whale avatar. --v022-avatar: 2 zh light/dark avatar editor screenshots with six Bot variants, twelve palette colors, real keyboard checks and contrast measurements; publishes .codex/screens/v022-avatar-{light,dark}.png, no model requests. --v022-seed-only: verify the exact Remote/Host screenshot fixtures without a browser or PNGs. --v022-host-only: nonvisual shipped Client/Gateway/Host native every60 delivery, manual run, native edit/delete and changed-event verification with loopback mock, no PNGs. --v022: 8 en/zh light/dark native schedule overview/detail screenshots using a real native tool, every60 delivery and manual run, followed by native history navigation; publishes .codex/screens/v022-{light,dark}.png and detail variants. --v016: 2 zh light/dark native navigation screenshots, verifies adjacent Plugins/automation/Bots rows and whale paint/geometry, then publishes .codex/screens/v016-light.png and v016-dark.png; sends no model prompts. --extras-only: 4 zh light/dark wide editor/Bot-chat screenshots. --seed-only: verify three loopback mock assistant sessions, previews and unread without Chromium (0 screenshots). --manual-browser: prepare the same seeded Host without Chromium, write a private browser-access.json, and wait for its sibling manual-stop file or a shutdown signal; do not send messages in the UI (0 screenshots, no visual PASS).\nUses only cached chromium_headless_shell; writes dist/screenshots/<run> and sanitized .dsh-dev/screenshots/<run> logs.');
} else {
  assert.ok([avatarOnly, seedOnly, extrasOnly, homeOnly, navOnly, routinesOnly, routinesHostOnly, routinesSeedOnly, workspaceOnly, rightTabOnly, manualBrowser].filter(Boolean).length <= 1, 'Choose only one screenshot mode');
  assert.equal(process.cwd(), root, 'Run screenshots from the repository root');
  const home = resolve(root, '.dsh-dev');
  assert.ok(!process.env.DSH_HOME || resolve(process.env.DSH_HOME) === home, 'Only the repository .dsh-dev home is allowed');
  const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
  const output = process.env.DSH_BOT_E2E_DIR ? resolve(process.env.DSH_BOT_E2E_DIR) : resolve(root, 'dist/screenshots', stamp);
  const run = resolve(home, 'screenshots', stamp);
  const profile = `shot-${Date.now()}-${process.pid}`;
  const patch = resolve(run, 'profile.patch.yml');
  const browserAccessFile = resolve(run, 'browser-access.json');
  const manualStopFile = resolve(run, 'manual-stop');
  let manualAccessWritten = false;
  let manualStoppedBy;
  for (const dir of [output, run, resolve(run, 'tmp'), resolve(run, 'workspace')]) mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: resolve(run, 'agents-home'),
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
  const rightTabChecks = [];
  const refreshStabilityChecks = [];
  const layoutChecks = [];
  const navigationChecks = [];
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
    if (!seedOnly && !manualBrowser && !routinesHostOnly && !routinesSeedOnly) {
      browser = await chromium.launch({ executablePath: cachedBrowser(), headless: true, chromiumSandbox: true, env, timeout: 30_000 });
      activeContext = await browser.newContext();
      activePage = await activeContext.newPage();
    }
    step = 'mock-start';
    mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: routinesOnly || routinesHostOnly || routinesSeedOnly ? ['tool_call_success', 'success', 'success', 'success'] : ['success', 'success', 'success'],
      toolName: 'schedule_create', toolArguments: JSON.stringify({ title: 'Project review / 项目回顾', prompt: 'Summarize this mock project in one sentence.', every_seconds: 60 }), repeatLast: false, successText: mockReply, randomSeed: 2 });
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
      // A fresh workspace domain bootstraps historical cwd groups. Isolate
      // session logs as well so every run starts without another run's history.
      '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(run, 'sessions'))}`,
      '- id: workspace-controller', '  config:', `    documentsDirectory: ${JSON.stringify(run)}`,
      '- id: dsh-bot', '  config:', '    seedExamples: false', `    dataDir: ${JSON.stringify(resolve(run, 'data'))}`, '',
    ].join('\n'));
    await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
    await command(['plugin', '--profile', profile, 'add', process.env.DSH_BOT_E2E_PACKAGE ?? resolve(root, 'packages/dsh-bot')], 'plugin-add');
    const installedClient = resolve(home, 'profiles', profile, 'node_modules/dsh-bot/lib/client.js');
    const legacyPath = resolve(run, 'storages/dsh_bot_automation.json');
    let legacyBefore;
    if (process.env.DSH_BOT_E2E_PACKAGE && routinesHostOnly) {
      // Explicit old-format fixture, written before Host startup; never user data.
      const id = randomUUID();
      const record = { id, botId: 'old-bot', botCreatedAt: 1, title: 'Legacy 0.2.0 task', prompt: 'MUST_NOT_EXECUTE',
        rule: { kind: 'every', everySeconds: 60 }, timeZone: 'UTC', enabled: true, misfirePolicy: 'latest',
        schemaVersion: 1, revision: 1, ruleRevision: 1, createdBy: { kind: 'user' }, workspacePolicy: 'bots',
        anchorAt: 1, nextRunAt: 60001, createdAt: 1, updatedAt: 1 };
      legacyBefore = JSON.stringify({ unit: { name: 'dsh_bot_automation', version: 1 }, global: null,
        tables: { routines: { [id]: record, broken: { invalid: true } }, runs: { old: { preserved: true } }, control: { old: { preserved: true } } } }, null, 2);
      mkdirSync(dirname(legacyPath), { recursive: true }); writeFileSync(legacyPath, legacyBefore);
      save('legacy-before.json', JSON.parse(legacyBefore));
    }
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
      installConnection(ctx, { interactions: 'answer', transport: {
        streamBaseUrl: origin,
        fetch: (input, init) => fetch(new URL(String(input), origin), {
          ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
          signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]),
        }),
        createWebSocket: (url) => new WebSocket(url, { headers: { cookie } }),
      } });
      ctx.plugin(Gateway);
    } }).await();
    let unmountRemote = await api.effect(() => api.remote.$mount(remoteContribution));
    const unwrap = (result) => { assert.equal(result.ok, true, `Remote failed: ${result.error?.code ?? ''} ${result.error?.message ?? ''}`); return result.value; };
    const raw = async (name, args) => unwrap(await api.connection.rpc.call('/api', name, { args }, AbortSignal.timeout(30_000)));
    // The loopback HTTP listener can open before Loader settlement and Bot
    // storage initialization. Poll the public readiness result; no fixed delay
    // or successful HTTP status is evidence that the plugin is ready.
    step = 'bot-registry-ready';
    const readyDeadline = Date.now() + 30_000;
    for (;;) {
      const ready = await api.remote.dshBot.list();
      if (ready.ok) break;
      assert.ok(['bot/unavailable', 'gateway/service-unavailable'].includes(ready.error.code), `Bot startup failed: ${ready.error.code} ${ready.error.message}`);
      assert.ok(!ended && !interrupted && Date.now() < readyDeadline, `Bot startup did not become ready: ${ready.error.message}`);
      await new Promise((accept) => setTimeout(accept, 100));
    }
    step = 'seed-workspace-and-bots';
    const workspace = unwrap(await api.remote.dshBot.ensureBotsWorkspace());
    assert.equal(workspace.path, resolve(home, 'dsh-bot/bots'), 'Shared Bots workspace root');
    assert.deepEqual(unwrap(await api.remote.dshBot.ensureBotsWorkspace()), workspace, 'Remote workspace ensure is idempotent');
    const bot = unwrap(await api.remote.dshBot.create({ id: 'shot-assistant', name: 'Atlas / 助手', description: 'Focused help. 专注解答。' }));
    const researcher = unwrap(await api.remote.dshBot.create({ id: 'shot-researcher', name: 'Research / 研究员', description: 'Explore sources, compare ideas and organize findings. 查证资料、比较思路并整理结论。' }));
    const statuses = unwrap(await api.remote.dshBot.status());
    const status = statuses.find((entry) => entry.id === bot.id);
    assert.equal(status?.preset.state, 'ok', 'Screenshot Bot preset healthy');
    if (mock && !avatarOnly && !navOnly && !routinesOnly && !routinesHostOnly && !routinesSeedOnly) {
      for (const [index, sample] of [bot, researcher, bot].entries()) {
        step = `seed-${sample.id}`;
        const preset = statuses.find((entry) => entry.id === sample.id);
        assert.equal(preset?.preset.state, 'ok');
        const privateHome = unwrap(await api.remote.dshBot.ensureHome(sample.id));
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
          assert.equal(summary?.cwd, workspace.path, 'Seed session cwd is the shared Bots root');
          finished = summary?.blank === false && summary.running === false && values?.sessionStats?.turns >= 1;
          if (!finished) {
            assert.ok(Date.now() < deadline && !interrupted, 'Mock turn did not finish');
            await new Promise((accept) => setTimeout(accept, 100));
          }
        } while (!finished);
        assert.equal(values.agentPreset, preset.presetId);
        // Read the older Atlas conversation to cover a real read/unread mix.
        if (index === 0) unwrap(await api.remote.dshBot.activity.markRead(sessionId));
        sessionFixtures.push({ botId: sample.id, sessionId, title, agentPreset: preset.presetId, cwd: workspace.path,
          workspaceId: workspace.workspaceId, privateHome: privateHome.path, blank: false, turns: values.sessionStats.turns, unread: index !== 0 });
      }
      assert.equal(mock.requests.length, 3, 'Only three loopback model requests');
      assert.ok(mock.requests.every((request) => request.outcome === 'completed'), 'All mock replies completed');
      const activity = unwrap(await api.remote.dshBot.activity.list());
      verifyScreenshotActivity(activity, sessionFixtures, mockReply);
      assert.equal(activity.sessions.filter((row) => row.unread).length, 2, 'Two assistant sessions remain unread');
      // Also exercise the shipped factory's plugin scope: root-context Remote
      // calls alone cannot detect missing nested Cordis service access.
      await unmountRemote();
      const client = await createClientActivityProbe(api.connection, api, installedClient);
      let clientActivity;
      try {
        await client.activity.refresh();
        assert.equal(client.activity.getSnapshot().error, undefined, 'Shipped Client activity list succeeds');
        verifyScreenshotActivity(client.activity.getSnapshot(), sessionFixtures, mockReply);
        await client.activity.markRead(sessionFixtures[0].sessionId);
        assert.equal(client.activity.getSnapshot().error, undefined, 'Shipped Client markRead refetch succeeds');
        clientActivity = client.activity.getSnapshot();
        verifyScreenshotActivity(clientActivity, sessionFixtures, mockReply);
      } finally { await client.dispose(); unmountRemote = await api.effect(() => api.remote.$mount(remoteContribution)); }
      save('mock-sessions.json', { sessionFixtures, activity, clientActivity, changeStream: client.changeStream, shippedClientFactory: true,
        mockPromptsSent, requests: mock.requests.map(({ path, outcome }) => ({ path, outcome })) });
    }
    if (manualBrowser) {
      stage = 'manual-host-only';
      step = 'manual-browser-ready';
      // This is the fresh loopback Host's task-scoped launch token, not a user
      // credential. Keep it out of stdout and redacted report/log artifacts.
      // The token may be exchanged by another browser during this Host lifetime.
      writeFileSync(browserAccessFile, `${JSON.stringify({ startupUrl: startupUrl.href, origin, profile,
        workspaceId: workspace.workspaceId, sessionFixtures, stopFile: manualStopFile,
        instructions: 'Do not send messages in the UI. Only the three completed seed requests are authorized. Create manual-stop to shut down this isolated Host.',
      }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      manualAccessWritten = true;
      save('summary.json', { status: 'MANUAL_HOST_READY_ONLY', mode: 'manual-browser', visualValidation: 'NOT_RUN',
        browserAccessFile, manualStopFile, mockPromptsSent, sessionFixtures, profile, run, screenshots: [] });
      console.log(`Manual browser access file: ${browserAccessFile}`);
      console.log(`Manual stop file: ${manualStopFile}`);
      console.log('Host ready only; no screenshots or visual PASS. Do not send messages in the UI.');
      // Yield between checks so SIGINT/SIGTERM can stop children and unwind all
      // resources. An exhausted mock sequence fails requests after the seed.
      while (!interrupted && !existsSync(manualStopFile)) {
        assert.ok(!ended, 'Manual browser Host stopped unexpectedly');
        assert.equal(mock.requests.length, 3, 'Unexpected model request during manual browser verification');
        await new Promise((accept) => setTimeout(accept, 250));
      }
      manualStoppedBy = interrupted ? 'signal' : 'manual-stop';
      assert.equal(mock.requests.length, 3, 'Unexpected model request during manual browser verification');
    }
    if (routinesHostOnly) {
      stage = 'routine-host-only';
      await unmountRemote();
      const client = await createClientActivityProbe(api.connection, api, installedClient);
      try {
        await verifyRoutineClient({ client, bot, raw, mock, save, setStep: value => { step = value; } }); mockPromptsSent = mock.requests.length;
        if (legacyBefore) {
          const aggregate = await raw('dshBot.nativeSchedule/aggregate', {});
          assert.equal(aggregate.legacy.length, 1); assert.equal(aggregate.legacySkipped, 1);
          assert.equal(aggregate.legacyUnavailable, false);
          assert.equal(readFileSync(legacyPath, 'utf8'), legacyBefore);
          assert.equal((await raw('dshBot.run/list', { options: {} })).length, 1);
          save('legacy-compatibility.json', { status: 'PASS', aggregate, bytesUnchanged: true, oldRunsNotResumed: true });
        }
      }
      finally { await client.dispose(); unmountRemote = await api.effect(() => api.remote.$mount(remoteContribution)); }
    }
    if (routinesSeedOnly) {
      stage = 'routine-seed';
      await seedRoutineScreenshots({ raw, bot, mock, save, setStep: value => { step = value; } });
      mockPromptsSent = mock.requests.length;
    }
    if (routinesOnly) {
      stage = 'routine-ui';
      await captureRoutines({ browser, cookies, origin, raw, bot, output, root, mock, shots, save,
        setPage: page => { activePage = page; }, setStep: value => { step = value; },
        onFailure: async error => { failure = redact(error instanceof Error ? error.message : error); await diagnoseFailure().catch(() => {}); },
        errors: browserErrors, overlays });
      mockPromptsSent = mock.requests.length;
    }
    if (avatarOnly) {
      stage = 'avatar-ui';
      await captureAvatars({ browser, cookies, origin, remote: api.remote.dshBot, bot, researcher, output, root, shots, save,
        setPage: page => { activePage = page; }, setStep: value => { step = value; }, errors: browserErrors });
      assert.equal(mock.requests.length, 0, 'Avatar screenshots send no model requests');
    }
    stage = routinesSeedOnly ? 'routine-seed' : routinesHostOnly ? 'routine-host-only' : manualBrowser ? 'manual-host-only' : seedOnly ? 'seed-validation' : 'screenshots';
    for (const { language, theme, viewport, width, height } of navOnly ? screenshotCases(true) : []) {
      step = `v016-${theme}-new-page`;
      await activeContext.close();
      const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', colorScheme: theme, reducedMotion: 'reduce' });
      activeContext = context;
      await context.addCookies(cookies);
      await context.route('**/api/session/prompt', (route) => { prompts++; return route.abort('blockedbyclient'); });
      const page = await context.newPage();
      activePage = page;
      page.setDefaultTimeout(30_000);
      page.on('pageerror', (error) => browserErrors.push(redact(error.message)));
      const recordOverlay = (event) => overlays.push({ language, theme, viewport, surface: 'navigation', ...event });
      await installOverlayHandler(page, recordOverlay);
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, recordOverlay, 'navigation-new-page');
      await page.waitForFunction(() => document.documentElement.lang.startsWith('zh'));
      await page.getByRole('button', { name: 'Bots', exact: true }).click();
      await page.locator('[data-bots-page]').getByRole('button', { name: zh.ui['bots.create'], exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(width - 1, height - 1);
      await dismissFirstRunOverlays(page, recordOverlay, 'before-navigation-capture');
      step = `v016-${theme}-navigation-check`;
      const evidence = await page.evaluate(readNavigationWhale);
      navigationChecks.push({ language, theme, viewport, ...evidence });
      save('navigation-checks.json', navigationChecks);
      const expectedPath = readFileSync(resolve(root, 'packages/dsh-bot/icon.svg'), 'utf8').match(/<path\b[^>]*\bd="([^"]+)"/u)?.[1];
      assert.ok(expectedPath, 'Package icon must contain the shared whale path');
      verifyNavigationWhale(evidence, theme, expectedPath);
      step = `v016-${theme}-capture`;
      const file = `v016-${theme}.png`;
      await page.screenshot({ path: resolve(output, file), fullPage: true, animations: 'disabled' });
      shots.push({ file, language, theme, viewport, width, height, surface: 'navigation', bodyTheme: evidence.bodyTheme, evidence });
      console.log(`PASS: zh/${theme} adjacent native navigation rows with centered currentColor whale`);
    }
    for (const { language, theme, viewport, width, height } of avatarOnly || seedOnly || manualBrowser || navOnly || routinesOnly || routinesHostOnly || routinesSeedOnly || workspaceOnly || rightTabOnly ? [] : screenshotCases(extrasOnly || homeOnly)) {
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
      const detail = bots.locator(`[data-bot-detail="${bot.id}"]`);
      if (viewport === 'wide') {
        step = `${filename}-initial-history`;
        await waitForInitialBotHistory(detail, copy['bots.history']);
      }
      step = `${filename}-bots-layout`;
      await page.waitForFunction((narrow) => {
        const region = document.querySelector('[data-bots-page]');
        const list = region?.querySelector('[role="listbox"]')?.getBoundingClientRect();
        const detail = region?.querySelector('[data-bot-detail]')?.getBoundingClientRect();
        return list && list.width > 0 && (narrow ? !detail || detail.width === 0 : detail && detail.width > 0 && list.right <= detail.left + 1);
      }, viewport === 'narrow');
      const layout = await page.evaluate(readBotsLayout);
      // Persist exactly the sample being asserted, before any failure PNG can
      // await another frame/network response and observe a different state.
      layoutChecks.push({ step, layout });
      save('layout-checks.json', layoutChecks);
      assert.deepEqual(layout.optionIds, [bot.id, researcher.id], 'Bots sorted by newest activity');
      assert.ok(layout.previews.length >= 2 && layout.previews.every((preview) => preview.textOverflow === 'ellipsis' && preview.whiteSpace === 'nowrap' && preview.overflow === 'hidden'), 'Visible previews have single-line ellipsis CSS');
      assert.ok(layout.unreadDots >= 1, 'Bots show unread assistant activity');
      if (viewport === 'wide') {
        assert.equal(layout.selectedBotId, bot.id);
        assert.equal(layout.detailBotId, bot.id);
        // Browser rounds create blank sessions without sending messages. They
        // belong in the native sidebar, but never in the Bot's activity history.
        const previousBlankSessions = homeOnly ? conversationChecks.filter((check) => check.group === 'Bots' && check.blank === true).map((check) => check.sessionId) : [];
        for (const sessionId of previousBlankSessions) assert.equal(layout.sessionIds.includes(sessionId), false, 'Prior blank conversation stays out of Bot history');
        assert.deepEqual(layout.sessionIds, [...sessionFixtures].reverse().filter((fixture) => fixture.botId === bot.id).map((fixture) => fixture.sessionId), 'Selected Bot history contains only conversations with messages, newest first');
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
      if (homeOnly) {
        step = `${filename}-home-menu`;
        await detail.getByRole('button', { name: copy['card.more'], exact: true }).click();
        assert.equal(await detail.getByRole('button', { name: copy['bots.newSession'], exact: true }).isVisible(), true);
        await capture('v015-bots-menu', page.getByRole('menuitem', { name: copy['chat.inWorkspace'], exact: true }), [bot.id, researcher.id]);
        await page.keyboard.press('Escape');
      } else if (!extrasOnly) await capture('bots', create, [bot.id, researcher.id]);
      if (!extrasOnly && !homeOnly && language === 'zh' && theme === 'light' && viewport === 'wide') {
        step = `${filename}-refresh-stability`;
        const evidence = await captureRefreshStability(page, output, filename);
        refreshStabilityChecks.push(evidence);
        save('progress.json', { overlays, workspaceChoices, conversationChecks, refreshStabilityChecks, screenshots: shots });
        verifyRefreshStability(evidence.dom);
        assert.ok(evidence.pixelsIdentical, 'Bots A/B pixels must be identical after two real polling cycles');
      }
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
      if (extrasOnly || homeOnly) {
        step = `${filename}-editor-open`;
        await detail.getByRole('button', { name: copy['card.edit'], exact: true }).click();
        const editor = page.getByRole('dialog', { name: copy['editor.edit'], exact: true });
        await editor.getByRole('img', { name: copy['avatar.current'], exact: true }).scrollIntoViewIfNeeded();
        await editor.getByRole('group', { name: copy['avatar.color'], exact: true }).waitFor();
        if (homeOnly) {
          const home = unwrap(await api.remote.dshBot.ensureHome(bot.id));
          const section = editor.locator('[data-bot-default-cwd]');
          await section.locator('[data-effective-cwd]').filter({ hasText: workspace.path }).waitFor();
          await section.getByText(home.path, { exact: false }).waitFor();
          await section.scrollIntoViewIfNeeded();
          await capture('v015-editor', section.getByRole('button', { name: copy['editor.cwdChoose'], exact: true }), []);
        } else await capture('editor', editor.getByRole('button', { name: copy['actions.close'], exact: true }), [bot.id]);
        await editor.getByRole('button', { name: copy['actions.close'], exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
      }
      if (!homeOnly && language === 'zh' && viewport === 'wide') {
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
      if (homeOnly || !extrasOnly && viewport === 'narrow') {
        if (homeOnly) {
          // Only the current blank session is visible in the native tree. Read
          // the completed fixture first; switching away after blank creation
          // would remove the blank row and prevent native-tree return.
          step = `${filename}-read-avatar-fixture`;
          const group = page.locator(`[role="treeitem"][data-row-key="workspace:${workspace.workspaceId}"]`);
          await group.waitFor();
          if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
          const fixture = sessionFixtures[0];
          assert.ok(fixture, 'Completed Bot fixture required for the whale regression');
          const completed = page.locator(`[role="treeitem"][data-row-key="session:${fixture.sessionId}"]`);
          await completed.click();
          await page.locator(`[data-conversation-content][data-conversation-session="${fixture.sessionId}"]`).waitFor();
          await completed.locator('[data-bot-session-leading] [data-bot-avatar="whale"]').waitFor();
          await page.getByRole('button', { name: 'Bots', exact: true }).click();
          await option.click();
          await detail.waitFor();
        }
        step = `${filename}-start-chat`;
        await detail.getByRole('button', { name: copy['bots.newSession'], exact: true }).click();
        const conversation = page.locator('[data-conversation-content][data-conversation-session][data-content-phase="hero"]');
        const editor = conversation.getByRole('textbox');
        await dismissFirstRunOverlays(page, recordOverlay, 'after-start-chat');
        await editor.waitFor();
        assert.equal(await page.getByRole('dialog', { name: copy['chat.workspaceChoose'], exact: true }).count(), 0, 'Primary new session never opens a workspace chooser');
        workspaceChoices.push({ language, theme, viewport, outcome: 'Bots', workspaceId: workspace.workspaceId });
        await bots.waitFor({ state: 'hidden' });
        const sessionId = await conversation.getAttribute('data-conversation-session');
        assert.ok(sessionId, 'Blank session has an actual Host session id');
        const projection = await raw('session/projections', { request: { sessionId } });
        assert.equal(projection?.kind, 'sequenced');
        assert.equal(projection.values.agentPreset, status.presetId, 'New conversation uses selected Bot preset');
        const listing = await raw('session/list', { _request: {} });
        const createdSession = listing.items.find((row) => row.sessionId === sessionId);
        assert.equal(createdSession?.cwd, workspace.path, 'New session uses the shared Bots root');
        assert.equal(createdSession.blank, true, 'Browser-only new conversation has no messages');
        const inputState = await verifyNativeBotsConversation(page, conversation, editor, workspace.workspaceId, sessionId, homeOnly ? sessionFixtures[0] : undefined, viewport);
        conversationChecks.push({ language, theme, viewport, sessionId, cwd: workspace.path, workspaceId: workspace.workspaceId, group: 'Bots',
          agentPreset: projection.values.agentPreset, phase: 'hero', blank: createdSession.blank, inputState, sidebarChecked: viewport !== 'narrow', headerBadgeExpected: false, promptsSent: 0 });
        if (homeOnly) await capture('v015-native-session', editor, [bot.id]);
      }
      console.log(`PASS: ${language}/${theme}/${viewport} ${extrasOnly ? 'editor/Bot-chat dialogs' : viewport === 'narrow' ? 'responsive Bots page and new conversation' : 'two-pane Bots page'} with committed mock previews/unread`);
    }
    // Opening each native conversation clears the Host's new-message state,
    // which otherwise replaces its leading slot with a status dot. Run this
    // after the existing matrix so its read/unread fixtures remain unchanged.
    for (const { language, theme, viewport, width, height } of avatarOnly || seedOnly || manualBrowser || navOnly || routinesOnly || routinesHostOnly || routinesSeedOnly || extrasOnly || homeOnly || rightTabOnly ? [] : screenshotCases(true)) {
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
    for (const { language, theme, viewport, width, height } of rightTabOnly ? screenshotCases(true) : []) {
      const filename = `${language}-${theme}-${viewport}-right-tab`;
      const fixture = sessionFixtures[0];
      step = `${filename}-new-page`;
      assert.ok(fixture && !fixture.unread, 'Open only the pre-read conversation before both theme captures');
      await activeContext.close();
      const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', colorScheme: theme, reducedMotion: 'reduce' });
      activeContext = context;
      await context.addCookies(cookies);
      await context.route('**/api/session/prompt', (route) => { prompts++; return route.abort('blockedbyclient'); });
      const page = await context.newPage();
      activePage = page;
      page.setDefaultTimeout(30_000);
      page.on('pageerror', (error) => browserErrors.push(redact(error.message)));
      const recordOverlay = (event) => overlays.push({ language, theme, viewport, surface: 'right-tab', ...event });
      await installOverlayHandler(page, recordOverlay);
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, recordOverlay, 'right-tab-new-page');
      const group = page.locator(`[role="treeitem"][data-row-key="workspace:${workspace.workspaceId}"]`);
      await group.waitFor();
      if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
      await page.waitForFunction(() => document.documentElement.lang.startsWith('zh'));
      step = `${filename}-open-conversation`;
      await page.locator(`[role="treeitem"][data-row-key="session:${fixture.sessionId}"]`).click();
      await page.locator(`[data-conversation-content][data-conversation-session="${fixture.sessionId}"]`).waitFor();
      await page.getByRole('button', { name: '打开 Bots 侧栏', exact: true }).click();
      const rightTab = page.locator('[data-bots-right-tab]:visible');
      await rightTab.waitFor();
      for (const sample of [bot, researcher]) {
        await rightTab.locator(`[role="option"][data-bot-id="${sample.id}"]`).getByText(mockReply, { exact: true }).waitFor();
      }
      await rightTab.locator('[data-unread]').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(width - 1, height - 1);
      step = `${filename}-capture`;
      await dismissFirstRunOverlays(page, recordOverlay, 'before-right-tab-capture');
      const evidence = await page.evaluate(readBotsRightTab);
      verifyBotsRightTab(evidence, fixture.sessionId, [bot, researcher], mockReply);
      const avatars = await measureAvatars(page);
      const expectedIds = [bot.id, researcher.id];
      verifyAvatarContrast(avatars, expectedIds);
      const bodyTheme = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim());
      rightTabChecks.push({ language, theme, viewport, kind: 'conversation-and-right-tab', ...evidence });
      contrastChecks.push({ language, theme, viewport, surface: 'right-tab', avatars, expectedIds });
      await page.screenshot({ path: resolve(output, `${filename}.png`), fullPage: true, animations: 'disabled' });
      shots.push({ file: `${filename}.png`, language, theme, viewport, width, height, surface: 'right-tab', bodyTheme, avatars, evidence });
      save('progress.json', { overlays, workspaceChoices, conversationChecks, rightTabChecks, contrastChecks, screenshots: shots });
      console.log(`PASS: ${language}/${theme}/${viewport} native conversation and Bots right tab with previews/unread`);
      // Preserve unread fixtures until both captures exist. Only this final
      // surface exercises navigation, through UI actions and public Host reads.
      if (theme === 'dark') {
        step = `${filename}-recent-session`;
        const recent = sessionFixtures.find((value) => value.botId === researcher.id);
        assert.ok(recent, 'Research fixture exists');
        await rightTab.locator(`[role="option"][data-bot-id="${researcher.id}"]`).click();
        await page.locator(`[data-conversation-content][data-conversation-session="${recent.sessionId}"]`).waitFor();
        await page.locator(`[data-sidebar-right-panel][data-sidebar-right-session="${recent.sessionId}"] [data-bots-right-tab]`).waitFor();
        const activity = unwrap(await api.remote.dshBot.activity.list());
        assert.equal(activity.sessions.find((value) => value.sessionId === recent.sessionId)?.unread, false, 'Right-tab navigation marks the target conversation read');
        rightTabChecks.push({ language, theme, kind: 'recent-session', botId: researcher.id, sessionId: recent.sessionId, unread: false, rightTabVisible: true });
        step = `${filename}-new-session`;
        const fresh = unwrap(await api.remote.dshBot.create({ id: 'shot-no-session', name: 'Fresh / 新助手', description: 'A Bot without a previous conversation.' }));
        const freshStatus = unwrap(await api.remote.dshBot.status()).find((value) => value.id === fresh.id);
        assert.equal(freshStatus?.preset.state, 'ok');
        await rightTab.getByRole('button', { name: zh.ui['bots.refresh'], exact: true }).click();
        await rightTab.locator(`[role="option"][data-bot-id="${fresh.id}"]`).click();
        const conversation = page.locator('[data-conversation-content][data-conversation-session][data-content-phase="hero"]');
        const editor = conversation.getByRole('textbox');
        await editor.waitFor();
        assert.equal(await page.getByRole('dialog', { name: zh.ui['chat.workspaceChoose'], exact: true }).count(), 0, 'Right-tab new session never opens a workspace chooser');
        const choice = 'Bots';
        const sessionId = await conversation.getAttribute('data-conversation-session');
        assert.ok(sessionId && !sessionFixtures.some((value) => value.sessionId === sessionId), 'Bot without history creates a new Host session');
        const projection = await raw('session/projections', { request: { sessionId } });
        assert.equal(projection?.values.agentPreset, freshStatus.presetId, 'New conversation uses the clicked Bot preset');
        const listing = await raw('session/list', { _request: {} });
        assert.equal(listing.items.find((row) => row.sessionId === sessionId)?.cwd, workspace.path, 'Right-tab new session uses the shared Bots root');
        const inputState = await verifyNativeBotsConversation(page, conversation, editor, workspace.workspaceId, sessionId);
        await page.locator(`[data-sidebar-right-panel][data-sidebar-right-session="${sessionId}"] [data-bots-right-tab]`).waitFor();
        rightTabChecks.push({ language, theme, kind: 'new-session', botId: fresh.id, sessionId, agentPreset: projection.values.agentPreset, phase: 'hero', cwd: workspace.path,
          workspaceId: workspace.workspaceId, inputState, workspaceChoice: choice, rightTabVisible: true, promptsSent: 0 });
        save('progress.json', { overlays, workspaceChoices, conversationChecks, rightTabChecks, contrastChecks, screenshots: shots });
      }
    }
    step = manualBrowser ? 'manual-host-validation' : 'matrix-validation';
    if (!manualBrowser) assert.equal(prompts, 0, 'No browser model prompt attempted');
    assert.equal(browserErrors.length, 0, 'Browser page errors; inspect summary');
    assert.equal(shots.length, seedOnly || manualBrowser || routinesHostOnly || routinesSeedOnly ? 0 : routinesOnly ? 8 : homeOnly ? 6 : extrasOnly ? 4 : avatarOnly || navOnly || workspaceOnly || rightTabOnly ? 2 : 9, 'Complete the requested screenshot set');
    if (!seedOnly && !manualBrowser && !avatarOnly && !navOnly && !routinesOnly && !routinesHostOnly && !routinesSeedOnly && !extrasOnly && !homeOnly && !workspaceOnly && !rightTabOnly) assert.equal(refreshStabilityChecks.length, 1, 'Complete the additional refresh stability pair');
    if (!seedOnly && !manualBrowser && !routinesHostOnly && !routinesSeedOnly) assert.notEqual(shots.find((shot) => shot.theme === 'light').bodyTheme, shots.find((shot) => shot.theme === 'dark').bodyTheme, 'Host theme actually changes tokens');
    if (navOnly) {
      assert.equal(mockPromptsSent, 0, 'Navigation screenshots need no mock conversation');
      assert.equal(mock.requests.length, 0, 'Navigation screenshot run sent no model requests');
      step = 'v016-publish-screenshots';
      const destination = resolve(root, '.codex/screens');
      mkdirSync(destination, { recursive: true });
      for (const shot of shots) copyFileSync(resolve(output, shot.file), resolve(destination, shot.file));
    }
  } catch (error) {
    failure = redact(error instanceof Error ? error.message : error);
    if (!failureEvidence.length) await diagnoseFailure().catch((error) => { failureEvidence.push({ step, diagnosticError: redact(error) }); });
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
    if (manualAccessWritten) {
      try { unlinkSync(browserAccessFile); }
      catch (error) { failure ??= redact(error); process.exitCode = 1; }
    }
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    save('summary.json', { status: failure ? 'FAIL' : routinesSeedOnly ? 'SEED_ONLY_PASS' : routinesHostOnly ? 'HOST_ONLY_PASS' : manualBrowser ? 'MANUAL_HOST_ONLY' : 'PASS', mode: avatarOnly ? 'v022-avatar' : routinesSeedOnly ? 'v022-seed-only' : routinesHostOnly ? 'v022-host-only' : routinesOnly ? 'v022' : manualBrowser ? 'manual-browser' : seedOnly ? 'seed-only' : extrasOnly ? 'extras-only' : homeOnly ? 'v015' : navOnly ? 'v016' : workspaceOnly ? 'workspace-only' : rightTabOnly ? 'right-tab-only' : 'matrix',
      ...(routinesOnly || routinesHostOnly || routinesSeedOnly ? { realModelRequests: 0, visualValidation: shots.length === 8 ? 'PASS' : 'NOT_RUN' } : {}),
      mockPromptsSent, sessionFixtures, mockRequests: mock?.requests.map(({ path, outcome }) => ({ path, outcome })),
      stage, step, failure, failureEvidence, profile, run, prompts: manualBrowser ? null : prompts, browserErrors,
      ...(manualBrowser ? { manualHostOnly: true, visualValidation: 'NOT_RUN', browserPromptInterception: false,
        browserAccessFile, browserAccessRemoved: manualAccessWritten && !existsSync(browserAccessFile), manualStopFile, manualStoppedBy } : {}),
      overlays, workspaceChoices, conversationChecks, workspaceRowChecks, rightTabChecks, navigationChecks, refreshStabilityChecks, contrastChecks, screenshots: shots });
    console.log(`Evidence: ${output}`);
  }
}
