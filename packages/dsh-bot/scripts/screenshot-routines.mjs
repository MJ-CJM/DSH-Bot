import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { dismissFirstRunOverlays, installOverlayHandler, screenshotCases } from './screenshot-support.ts';
import en from '../locale/en.json' with { type: 'json' };
import zh from '../locale/zh.json' with { type: 'json' };

/** Seed through public Remote/Host only; history comes from completed mock runs. */
export async function seedRoutineScreenshots({ raw, bot, mock, save, setStep = () => {} }) {
  setStep('routine-seed-create');
  let routine = await raw('dshBot.routine/create', { input: { botId: bot.id,
    title: 'Project review / 项目回顾', prompt: 'Summarize this mock project in one sentence.',
    rule: { kind: 'every', everySeconds: 3600 }, timeZone: 'UTC', enabled: false } });
  const runs = [];
  for (let index = 0; index < 2; index++) {
    setStep(`routine-seed-run-${index + 1}`);
    const accepted = await raw('dshBot.routine/runNow', { id: routine.id, operationId: globalThis.crypto.randomUUID() });
    const deadline = Date.now() + 100_000;
    for (;;) {
      const run = await raw('dshBot.run/get', { id: accepted.id });
      assert.ok(['queued', 'running', 'succeeded'].includes(run.status), `Unexpected seed Run status: ${run.status}`);
      if (run.status === 'succeeded') { runs.push(run); break; }
      assert.ok(Date.now() < deadline, 'Timed out waiting for actual succeeded seed Run');
      await new Promise(accept => setTimeout(accept, 250));
    }
  }
  setStep('routine-seed-enable');
  routine = await raw('dshBot.routine/get', { id: routine.id });
  routine = await raw('dshBot.routine/update', { id: routine.id, patch: { enabled: true }, expectedRevision: routine.revision });
  assert.ok(routine.nextRunAt > Date.now(), 'Screenshot has a future next-run time');
  const history = await raw('dshBot.run/list', { options: { routineId: routine.id, limit: 50 } });
  assert.equal(history.length, 2); assert.ok(history.every(run => run.status === 'succeeded'));
  assert.equal(mock.requests.length, 2); assert.ok(mock.requests.every(request => request.outcome === 'completed'));
  const receipt = { seedSource: 'remote-host', visualValidation: 'NOT_RUN', scheduledExecutionVerified: false,
    realModelRequests: 0, routine, runs, mockRequests: mock.requests.map(({ path, outcome }) => ({ path, outcome })) };
  save('routine-seed.json', receipt);
  return { routine, completed: runs[0], receipt };
}

/** UI is only used for reading and capturing the real seeded catalog/history. */
export async function captureRoutines({ browser, cookies, origin, raw, bot, output, root, mock, shots, save, setPage, setStep, onFailure, errors, overlays }) {
  const { routine, completed, receipt } = await seedRoutineScreenshots({ raw, bot, mock, save, setStep });
  const checks = [{ seedSource: receipt.seedSource, routineId: routine.id, runs: receipt.runs }];
  for (const { language, theme, width, height } of screenshotCases().filter(item => item.viewport === 'wide').map(item => ({ ...item, height: 1200 }))) {
    setStep(`routine-${language}-${theme}-open`);
    const t = language === 'zh' ? zh.ui : en.ui;
    const context = await browser.newContext({ viewport: { width, height }, locale: language === 'zh' ? 'zh-CN' : 'en-US', colorScheme: theme, reducedMotion: 'reduce' });
    try {
      await context.addCookies(cookies);
      // Routine requests go through their own Remote; no manual chat prompts.
      await context.route('**/api/session/prompt', route => route.abort('blockedbyclient'));
      const page = await context.newPage(); setPage(page);
      page.setDefaultTimeout(30_000);
      page.on('pageerror', error => errors.push(error.message));
      const overlay = event => overlays.push({ language, theme, surface: 'routines', ...event });
      await installOverlayHandler(page, overlay);
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, overlay, 'routines-entry');
      await page.getByRole('button', { name: 'Bots', exact: true }).click();
      const bots = page.locator('[data-bots-page]');
      await bots.locator(`[role="option"][data-bot-id="${bot.id}"]`).click();
      const detail = bots.locator(`[data-routine-panel="${bot.id}"]`);
      await detail.getByRole('button', { name: t['routine.create'], exact: true }).waitFor();
      await detail.getByRole('button', { name: t['bots.refresh'], exact: true }).click();
      await detail.locator(`[data-routine-id="${routine.id}"]`).getByRole('button', { name: t['routine.history'], exact: true }).click();
      const capture = async (surface, panel) => {
        setStep(`routine-${language}-${theme}-${surface}-capture`);
        const history = panel.locator('[data-routine-history]');
        await history.locator('[data-run-id]').first().waitFor();
        await history.getByText(t['routine.status.succeeded'], { exact: true }).first().waitFor();
        await panel.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready);
        const evidence = await panel.evaluate(element => ({ text: element.innerText, cards: element.querySelectorAll('[data-routine-id]').length,
          history: element.querySelectorAll('[data-run-id]').length, rect: element.getBoundingClientRect().toJSON() }));
        assert.equal(evidence.cards, 1); assert.equal(evidence.history, 2);
        assert.ok(evidence.rect.width > 0 && evidence.rect.height > 0);
        const bodyTheme = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim());
        const file = `v020-${language}-${theme}-${surface}.png`;
        await page.screenshot({ path: resolve(output, file), fullPage: true, animations: 'disabled' });
        shots.push({ file, language, theme, surface, bodyTheme, evidence });
        if (language === 'zh') {
          mkdirSync(resolve(root, '.codex/screens'), { recursive: true });
          copyFileSync(resolve(output, file), resolve(root, '.codex/screens', surface === 'overview' ? `v020-${theme}.png` : `v020-${theme}-detail.png`));
        }
      };
      await capture('detail', detail);
      await bots.getByRole('tab', { name: t['routine.title'], exact: true }).click();
      const overview = bots.locator('[data-routine-panel="overview"]');
      await overview.locator(`[data-routine-id="${routine.id}"]`).getByRole('button', { name: t['routine.history'], exact: true }).click();
      await capture('overview', overview);
      setStep(`routine-${language}-${theme}-history-navigation`);
      // Follow a real run's native conversation link after capturing history.
      await overview.locator('[data-routine-history]').getByRole('button', { name: t['routine.openSession'], exact: true }).last().click();
      await page.locator(`[data-conversation-content][data-conversation-session="${completed.sessionId}"]`).waitFor();
      checks.push({ language, theme, historyNavigation: true });
      save('routine-checks.json', { checks, mockRequests: mock.requests.map(({ path, outcome }) => ({ path, outcome })), realModelRequests: 0 });
      console.log(`PASS: T16 ${language}/${theme} Bot detail, overview, history and native session link`);
    } catch (error) {
      await onFailure(error); // Save the live page before closing its context.
      throw error;
    } finally { await context.close(); }
  }
  assert.equal(mock.requests.length, 2, 'Only Remote-seeded loopback requests');
  assert.ok(mock.requests.every(request => request.outcome === 'completed'));
  assert.equal((await raw('dshBot.routine/get', { id: routine.id })).enabled, true);
}

/** Separate nonvisual receipt when the browser cannot launch. Never emits PNGs. */
export async function verifyRoutineClient({ client, bot, raw, mock, save }) {
  const actions = client.routines;
  assert.ok(actions, 'Shipped Client provides Routine actions');
  const deadline = Date.now() + 30_000;
  for (;;) {
    await actions.catalog.refresh();
    if (actions.catalog.getSnapshot().status?.state === 'ready') break;
    assert.ok(Date.now() < deadline, 'Automation readiness');
    await new Promise(accept => setTimeout(accept, 100));
  }
  assert.equal(actions.catalog.getSnapshot().error, undefined);
  await actions.create({ botId: bot.id, title: 'T16 factory routine', prompt: 'T16 mock task', rule: { kind: 'every', everySeconds: 60 }, timeZone: 'UTC' });
  const routine = actions.catalog.getSnapshot().routines[0];
  assert.ok(routine);
  console.log('T16 Host-only: shipped Client created every60; waiting for scheduled completion.');
  async function wait(count) {
    const deadline = Date.now() + 100_000;
    for (;;) {
      const runs = await raw('dshBot.run/list', { options: { routineId: routine.id, limit: 50 } });
      assert.ok(!runs.some(run => ['failed', 'timed_out', 'recovery_needed'].includes(run.status)), 'Run failure');
      if (runs.filter(run => run.status === 'succeeded').length === count) return runs;
      assert.ok(Date.now() < deadline, 'Run completion timeout');
      await new Promise(accept => setTimeout(accept, 250));
    }
  }
  await wait(1);
  await actions.catalog.refresh();
  let current = actions.catalog.getSnapshot().routines[0];
  assert.equal(actions.catalog.getSnapshot().lastRuns[0]?.status, 'succeeded');
  await actions.update(current, { enabled: false });
  current = actions.catalog.getSnapshot().routines[0];
  const operationId = globalThis.crypto.randomUUID();
  await Promise.all([actions.runNow(current.id, operationId), actions.runNow(current.id, operationId)]);
  const runs = await wait(2);
  assert.equal(runs.filter(run => run.trigger === 'manual').length, 1);
  await actions.update(current, { title: 'Edited by Client' });
  await assert.rejects(actions.update(current, { title: 'Stale draft' }), error => error.code === 'automation/conflict');
  current = actions.catalog.getSnapshot().routines[0];
  const history = actions.history(current.id);
  try { await history.refresh(); assert.equal(history.getSnapshot().runs.length, 2); assert.equal(history.getSnapshot().error, undefined); }
  finally { history.dispose(); }
  await client.openSession(runs[0].sessionId);
  assert.ok(client.openedSessions.includes(runs[0].sessionId));
  await actions.remove(current);
  assert.deepEqual(actions.catalog.getSnapshot().routines, []);
  assert.equal((await raw('dshBot.run/list', { options: { routineId: routine.id } })).length, 2);
  assert.equal(mock.requests.length, 2); assert.ok(mock.requests.every(request => request.outcome === 'completed'));
  save('routine-host-only.json', { status: 'PASS', visualValidation: 'NOT_RUN', realModelRequests: 0,
    shippedClientFactory: true, gateway: true, create: true, every60: true, pause: true, runNow: true,
    sameOperationConcurrentDeduplication: true, editConflict: true, deletePreservesHistory: true, historyNavigation: true,
    runs, mockRequests: mock.requests.map(({ path, outcome }) => ({ path, outcome })) });
}
