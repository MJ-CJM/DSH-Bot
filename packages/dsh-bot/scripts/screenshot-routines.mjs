import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { dismissFirstRunOverlays, installOverlayHandler, screenshotCases } from './screenshot-support.ts';
import en from '../locale/en.json' with { type: 'json' };
import zh from '../locale/zh.json' with { type: 'json' };
const wait = async (check, label, timeout = 100_000) => {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; assert.ok(Date.now() < deadline, label); await new Promise(r => setTimeout(r, 200)); }
};
const recordOf = ({ sessionId, status, lastDelivery, ...record }) => record;
/** Actual model tool invocation, native timer, persisted delivery, and main-session delivery. */
export async function seedRoutineScreenshots({ raw, bot, mock, save, setStep = () => {} }) {
  setStep('native-seed-create-session');
  await wait(async () => (await raw('dshBot.automation/status', {})).state === 'ready', 'Aggregation readiness');
  const statuses = await raw('dshBot/status', {});
  const preset = statuses.find(r => r.id === bot.id);
  await raw('dshBot/ensureBotsWorkspace', {});
  const [main, same] = await Promise.all([raw('dshBot/openConversation', { botId: bot.id }), raw('dshBot/openConversation', { botId: bot.id })]);
  assert.deepEqual(main, same); const { sessionId } = main;
  assert.equal((await raw('dshBot/status', {})).find(row => row.id === bot.id).mainSessionId, sessionId);
  assert.equal((await raw('session/projections', { request: { sessionId } })).values.title, bot.name);
  const accepted = await raw('session/prompt', { request: { sessionId, requestId: crypto.randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Create the native schedule specified by the local mock fixture.' }] } });
  assert.equal(accepted.accepted, true);
  let task = await wait(async () => (await raw('schedule/catalog', {})).find(r => r.sessionId === sessionId), 'Native tool did not create task');
  const aggregate = await raw('dshBot.nativeSchedule/aggregate', {});
  assert.ok(aggregate.bindings.some(r => r.nativeScheduleId === task.id && r.botId === bot.id && r.botCreatedAt === bot.createdAt));
  setStep('native-wait-real-every60-delivery');
  const history = await wait(async () => {
    const value = await raw('schedule/history', { request: { id: task.id, sessionId, limit: 50 } });
    return value.records?.length ? value : undefined;
  }, 'No native every60 delivery');
  await wait(async () => {
    const list = await raw('session/list', { _request: {} });
    return mock.requests.length >= 3 && list.items.find(r => r.sessionId === sessionId)?.running === false;
  }, 'Native delivery model turn did not finish');
  task = (await raw('schedule/catalog', {})).find(r => r.id === task.id);
  const edited = await raw('schedule/update', { request: { id: task.id, sessionId, expected: recordOf(task), change: { kind: 'every', every_seconds: 3600 } } });
  assert.equal(edited.updated, true);
  task = (await raw('schedule/catalog', {})).find(r => r.id === task.id);
  setStep('native-manual-run');
  const operationId = crypto.randomUUID();
  const request = { id: task.id, operationId, expected: { title: task.title, prompt: task.prompt, botCreatedAt: bot.createdAt }, approved: true };
  const [a,b] = await Promise.all([raw('dshBot.nativeSchedule/runNow', request), raw('dshBot.nativeSchedule/runNow', request)]);
  assert.equal(a.id, b.id);
  const completed = await wait(async () => {
    const run = await raw('dshBot.run/get', { id: a.id });
    assert.ok(['queued', 'running', 'delivered'].includes(run.status), JSON.stringify(run));
    return run.status === 'delivered' ? run : undefined;
  }, 'Manual prompt was not delivered');
  const projection = await raw('session/projections', { request: { sessionId: completed.sessionId } });
  const manualTitle = projection.values.title;
  assert.equal(manualTitle, bot.name);
  assert.equal(completed.sessionId, sessionId);
  await wait(async () => mock.requests.length === 4 && mock.requests.every(r => r.outcome === 'completed')
    && !(await raw('session/list', { _request: {} })).items.find(row => row.sessionId === sessionId)?.running, 'Shared conversation mock completion');
  assert.equal((await raw('session/list', { _request: {} })).items.filter(row => row.projections?.values?.agentPreset === preset.presetId).length, 1);
  const renamed = await raw('dshBot/update', { id: bot.id, patch: { name: `${bot.name} renamed` } });
  assert.equal((await raw('session/projections', { request: { sessionId } })).values.title, renamed.name);
  await raw('session/rename', { request: { sessionId, title: 'Greeting' } });
  await wait(async () => (await raw('session/projections', { request: { sessionId } })).values.title === renamed.name, 'Title invariant repair');
  await raw('dshBot/update', { id: bot.id, patch: { name: bot.name } });
  assert.equal((await raw('schedule/catalog', {})).find(r => r.id === task.id).scheduledAt, task.scheduledAt);
  assert.equal(mock.requests.length, 4); assert.ok(mock.requests.every(r => r.outcome === 'completed'));
  const receipt = { seedSource: 'native-tool-timer-and-main-delivery', visualValidation: 'NOT_RUN', realModelRequests: 0,
    task, history, completed, manualTitle, idempotentRunId: a.id, mockRequests: mock.requests.map(({ path, outcome }) => ({ path, outcome })) };
  save('native-seed.json', receipt);
  return { routine: task, completed: { sessionId }, receipt };
}
export async function captureRoutines({ browser, cookies, origin, raw, bot, output, root, mock, shots, save, setPage, setStep, onFailure, errors, overlays }) {
  const { routine, completed } = await seedRoutineScreenshots({ raw, bot, mock, save, setStep });
  for (const { language, theme, width, height } of screenshotCases().filter(r => r.viewport === 'wide').map(r => ({ ...r, height: 1200 }))) {
    const t = language === 'zh' ? zh.ui : en.ui;
    const context = await browser.newContext({ viewport: { width, height }, locale: language === 'zh' ? 'zh-CN' : 'en-US', colorScheme: theme, reducedMotion: 'reduce' });
    try {
      await context.addCookies(cookies);
      const page = await context.newPage(); setPage(page); page.setDefaultTimeout(30_000);
      page.on('pageerror', error => errors.push(error.message));
      const overlay = event => overlays.push({ language, theme, ...event });
      await installOverlayHandler(page, overlay); await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, overlay, 'native-entry');
      await page.getByRole('button', { name: 'Bots', exact: true }).click();
      const bots = page.locator('[data-bots-page]');
      // Selecting with arrows keeps management visible; activating a Bot opens its main conversation.
      await bots.getByRole('listbox').press('Home');
      await bots.locator(`[data-bot-detail="${bot.id}"]`).waitFor();
      const detail = bots.locator(`[data-routine-panel="${bot.id}"]`);
      const capture = async (surface, panel) => {
        setStep(`v022-${language}-${theme}-${surface}`);
        await panel.locator(`[data-routine-id="${routine.id}"]`).getByRole('button', { name: t['routine.history'], exact: true }).click();
        await panel.locator('[data-delivery-id]').first().waitFor();
        await panel.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready);
        const evidence = await panel.evaluate(el => ({ text: el.innerText, tasks: el.querySelectorAll('[data-routine-id]').length, deliveries: el.querySelectorAll('[data-delivery-id]').length }));
        assert.equal(evidence.tasks, 1); assert.ok(evidence.deliveries >= 1); assert.ok(evidence.text.includes(t['native.deliveryHint']));
        const bodyTheme = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim());
        const file = `v022-${language}-${theme}-${surface}.png`;
        await page.screenshot({ path: resolve(output, file), fullPage: true, animations: 'disabled' });
        shots.push({ file, language, theme, surface, bodyTheme, evidence });
        if (language === 'zh') { mkdirSync(resolve(root, '.codex/screens'), { recursive: true });
          copyFileSync(resolve(output, file), resolve(root, '.codex/screens', surface === 'detail' ? `v022-${theme}.png` : `v022-${theme}-schedules.png`)); }
      };
      await capture('detail', detail);
      await bots.getByRole('tab', { name: t['routine.title'], exact: true }).click();
      const overview = bots.locator('[data-routine-panel="overview"]'); await capture('overview', overview);
      await overview.getByRole('button', { name: t['routine.openSession'], exact: true }).click();
      await page.locator(`[data-conversation-content][data-conversation-session="${completed.sessionId}"]`).waitFor();
    } catch (error) { await onFailure(error); throw error; } finally { await context.close(); }
  }
}
/** Same actual Host fixture followed by shipped Client/Gateway native reads and writes. */
export async function verifyRoutineClient({ client, bot, raw, mock, save, setStep }) {
  const seeded = await seedRoutineScreenshots({ raw, bot, mock, save, setStep });
  const actions = client.routines;
  await actions.catalog.refresh();
  let task = actions.catalog.getSnapshot().routines.find(r => r.id === seeded.routine.id); assert.ok(task, JSON.stringify(actions.catalog.getSnapshot()));
  const before = actions.catalog.getSnapshot(); await actions.catalog.refresh(); assert.equal(actions.catalog.getSnapshot(), before);
  const history = actions.history(task); await history.refresh(); assert.equal(history.getSnapshot().records.length, 1); history.dispose();
  await actions.update(task, { title: 'Client edited native task' });
  assert.equal((await raw('schedule/catalog', {})).find(r => r.id === task.id).title, 'Client edited native task');
  // Native page mutation -> schedule/changed -> shipped Client automatic refresh.
  const current = (await raw('schedule/catalog', {})).find(r => r.id === task.id);
  await raw('schedule/update', { request: { id: current.id, sessionId: current.sessionId, expected: recordOf(current), title: 'Edited externally' } });
  await wait(async () => actions.catalog.getSnapshot().routines.find(r => r.id === current.id)?.title === 'Edited externally', 'Changed push did not refresh Client', 10000);
  task = actions.catalog.getSnapshot().routines.find(r => r.id === current.id);
  await actions.remove(task); assert.equal((await raw('schedule/catalog', {})).length, 0);
  await actions.catalog.refresh(); assert.deepEqual(actions.catalog.getSnapshot().routines, []);
  save('native-client.json', { status: 'PASS', visualValidation: 'NOT_RUN', sameTaskId: task.id, history: 'native delivery', pushRefresh: true, structuralStability: true, deletion: true });
}
