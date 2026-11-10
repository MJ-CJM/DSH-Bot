import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

const root = process.cwd();
assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const hostVersion = execFileSync(resolve(root, 'scripts/dsh'), ['--version'], { encoding: 'utf8' }).trim();
assert.equal(hostVersion, '0.2.1-rc.2', 'Select the isolated rc.2 CLI with DSH_BOT_DSH_BIN');
assert.ok(process.argv[2], 'Pass the built tarball');
const artifact = resolve(process.argv[2]);
const crash = process.argv[3] === '--crash';
const repair = process.argv[3] === '--repair';
const noticeUnknown = process.argv[3] === '--notice-unknown';
const notice = process.argv[3] === '--notice' || noticeUnknown;
const groupFailure = process.argv[3] === '--group-failure';
const groupArtifact = process.argv[3] === '--group-artifact';
const groupFollowUpChanged = process.argv[3] === '--group-follow-up-member-changed';
const groupFollowUpCold = process.argv[3] === '--group-follow-up-cold';
const groupFollowUpRevoked = process.argv[3] === '--group-follow-up-revoked';
const groupFollowUpLate = process.argv[3] === '--group-follow-up-late';
const groupFollowUp = process.argv[3] === '--group-follow-up' || groupFollowUpChanged || groupFollowUpCold || groupFollowUpRevoked || groupFollowUpLate;
const group = process.argv[3] === '--group' || groupFailure || groupFollowUp || groupArtifact;
assert.ok(process.argv.length === 3 || crash || repair || notice || group);
const base = resolve(root, '.dsh-dev/proactive-bot/workflow');
await mkdir(base, { recursive: true });
const dir = await mkdtemp(resolve(base, 'browser-'));
const fixture = resolve(root, 'packages/dsh-bot/tests/proactive-workflow-profile.mjs');
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
const flags = [
  '- id: dsh-bot', '  config:', '    proactiveEnabled: true', '    proactiveExecutionEnabled: true',
  '    proactiveProvider: dp-loopback', '    proactiveNotificationPolicy: workflow-notice', '    proactiveModel: fixture',
  '    proactiveNoticeConfig: {mergeWindowMs: 0, maxBatchItems: 8, maxPending: 1000}',
  `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`,
];
const scope = { repository: 'fixture/demo', branch: 'main', generation: 1 };
const sourceDigest = createHash('sha256').update(JSON.stringify([scope.repository, scope.branch])).digest('hex');
const external = { submits: 0, modelFields: [], cancel: 0, mode: 'success' };
const runs = new Map();
const json = (res, value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
async function mockRoute(req, res) {
  if (req.method === 'GET' && req.url === '/v1/capabilities') return json(res, {
    version: 1, operation: 'propose-json-repair', submit: true, get: true, events: true,
    cancel: true, artifacts: external.mode !== 'unsupported', preset: false, agentOptions: false, depthLimit: false, continuation: false,
  });
  if (req.method === 'POST' && req.url === '/v1/runs') {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.operation, 'propose-json-repair');
    assert.deepEqual(Object.keys(input.fixture).sort(), ['field', 'hint', 'initial']);
    assert.deepEqual(input.fixture.initial, { enabled: false, retained: 'sentinel' });
    const run = { inputId: input.inputId, runId: `fixture-${++external.submits}`, state: 'running' };
    external.modelFields.push(Object.keys(input.fixture).sort());
    runs.set(run.runId, { run, mode: external.mode });
    return json(res, run);
  }
  const [, id, method] = req.url.match(/^\/v1\/runs\/([^/]+)(?:\/(events|artifacts|cancel))?$/) ?? [];
  const { run, mode } = runs.get(id);
  if (method === 'cancel') { external.cancel++; return json(res, { ...run, state: 'cancelled' }); }
  if (mode === 'disconnect') { req.socket.destroy(); return; }
  if (!method) return json(res, { ...run, state: mode === 'hold' ? 'running' : 'completed' });
  const identity = { runId: run.runId, inputId: run.inputId };
  if (method === 'events') return json(res, { ...identity, events: [{ seq: 1, state: 'running' }, { seq: 2, state: 'completed' }] });
  return json(res, { ...identity, ...(mode === 'misbound' ? { inputId: '00000000-0000-4000-8000-000000000000' } : {}), revision: 1, edit: { field: 'enabled', value: true }, units: 3, unit: 'fixture-operation' });
}
const start = () => webHost(dir, crash ? 'proactive-crash' : repair ? 'proactive-repair' : noticeUnknown ? 'proactive-notice-unknown' : notice ? 'proactive-notice'
    : groupFollowUpLate ? 'proactive-group-follow-up-late' : groupFollowUp ? 'proactive-group-follow-up'
      : groupArtifact ? 'proactive-group-artifact' : groupFailure ? 'proactive-group-failure' : group ? 'proactive-group' : 'proactive-workflow',
  artifact, fixture, endpoint => [...flags,
    ...(group ? ['    proactiveGroupReviewEnabled: true'] : []),
    ...(groupFollowUp || groupArtifact ? ['    proactiveGroupFollowUpEnabled: true'] : []),
    ...(notice ? ['    proactiveExternalNotificationPolicy: workflow-external'] : []),
    ...(repair || (group && !groupFailure) ? [
      `    proactiveRepairFixture: ${JSON.stringify({ id: 'switch', sourceId: `ci:${sourceDigest}`, title: 'Feature switch fixture', initial: { enabled: false, retained: 'sentinel' }, field: 'enabled', expected: true, hint: 'Enable the feature switch' })}`,
    ] : []),
    ...(repair ? [`    proactiveExternalExecutor: ${JSON.stringify(endpoint)}`, '    proactiveModelDailyBudget: 2'] : []),
    ...(repair || groupFollowUp || groupArtifact ? [`    proactiveCiFeed: ${JSON.stringify({ scope, intervalMs: 1000 })}`] : []),
  ], { offline: false, ...(repair ? { mockRoute } : {}) });
const translations = {};
for (const lang of ['en', 'zh']) {
  translations[lang] = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${lang}.json`), 'utf8')).ui;
}
const all = ['en', 'zh'].flatMap(lang => ['light', 'dark'].flatMap(theme =>
  [1360, 390].map(width => ({ lang, theme, width }))));
const primary = groupFollowUp && process.env.DSH_BOT_NARROW_ZH === '1' ? all.at(-1) : all[0];
let host, browser;
const evidence = { dir, primary, matrix: [], actions: [] };
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
const readEvidence = () => readFile(resolve(dir, 'workflow-evidence.json'), 'utf8').then(JSON.parse);
async function awaitEvidence(predicate) {
  const deadline = Date.now() + 20000;
  do {
    const error = await readFile(resolve(dir, 'workflow-error.txt'), 'utf8').catch(() => '');
    assert.equal(error, '');
    const observed = await readEvidence().catch(() => undefined);
    if (observed && predicate(observed)) return observed;
    await delay(125);
  } while (Date.now() < deadline);
  throw new Error('Native workflow evidence timed out');
}

async function open(item) {
  const { lang, theme, width } = item;
  const t = translations[lang];
  const context = await browser.newContext({ colorScheme: theme, locale: lang === 'en' ? 'en-US' : 'zh-CN',
    viewport: { width: 1360, height: 950 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(18000);
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await installOverlayHandler(page, () => {});
  await page.goto(host.url, { waitUntil: 'domcontentloaded' });
  await dismissFirstRunOverlays(page, () => {}, 'proactive-workflow');
  await openBotsPanel(page, t['bots.title']);
  const bots = page.locator('[data-bots-page]:visible');
  const profile = bots.getByRole('button', { name: `${t['chat.profile']} · Fixture CI`, exact: true });
  const fallback = bots.locator('button[data-bot-id="fixture-ci"]');
  await profile.or(fallback).first().waitFor();
  if (await profile.isVisible()) await profile.click(); else await fallback.click();
  const detail = page.locator('[data-bot-detail="fixture-ci"]');
  await detail.getByRole('tab', { name: t['detail.work'], exact: true }).click();
  await page.setViewportSize({ width, height: 950 });
  const panel = detail.locator('[data-proactive-suggestions]');
  await panel.getByRole('button', { name: t['proactive.refresh'], exact: true }).waitFor();
  return { page, context, panel, t };
}

try {
  host = await start();
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = host.env.TMPDIR;
  try {
    browser = await chromium.launch({
      executablePath: process.env.DSH_BOT_CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true, chromiumSandbox: true, env: host.env,
    });
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
  }
  for (const item of crash || repair || notice || group ? [] : all) {
    const { page, panel, context, t } = await open(item);
    try {
      const cards = panel.locator('[data-proactive-decision]');
      await cards.nth(2).waitFor();
      assert.equal(await cards.count(), 3);
      assert.equal(await panel.getByRole('heading', { name: t['proactive.title'], exact: true }).count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const screenshot = `${item.lang}-${item.theme}-${item.width}.png`;
      await page.screenshot({ path: resolve(dir, screenshot) });
      evidence.matrix.push({ ...item, cards: 3, screenshot });
    } finally { await context.close(); }
  }
  assert.equal(host.requests(), 0);
  const { panel, context, page, t } = await open(primary);
  const card = name => panel.locator('[data-proactive-decision]').filter({ hasText: name });
  const click = async (where, key) => {
    if (key === 'proactive.pause' || key === 'proactive.resume') {
      const summary = where.getByText(t['followUp.advancedExecution'], { exact: true });
      await summary.waitFor();
      where = summary.locator('..');
      if (await where.getAttribute('open') === null) await summary.click();
    }
    const details = where.getByRole('button', { name: t['proactive.openDetails'], exact: true });
    if (key !== 'proactive.refresh' && key !== 'proactive.openDetails' && await details.count() === 1 && await details.isEnabled()) await details.click();
    await where.getByRole('button', { name: t[key], exact: true }).click();
  };
  const requestRework = async ticket => {
    await click(ticket, 'proactive.rework');
    await ticket.getByLabel(t['proactive.reworkCriterion'], {exact:true}).fill('Required CI outcome');
    await ticket.getByLabel(t['proactive.reworkActual'], {exact:true}).fill('The prior delivery does not satisfy the requested outcome.');
    await ticket.getByLabel(t['proactive.reworkExpected'], {exact:true}).fill('Correct the failing check and retain unrelated fields.');
    await click(ticket, 'proactive.reworkSubmit');
  };
  const refresh = async (surface = {panel,page}) => {
    const latest = await awaitEvidence(value => value.work && value);
    await click(surface.panel, 'proactive.refresh');
    for (const row of latest.work) await surface.page.waitForFunction(({id,revision}) => {
      const element = document.querySelector(`[data-proactive-ticket="${id}"]`);
      return element && Number(element.getAttribute('data-work-revision')) >= revision;
    }, { id: row.ticketId, revision: row.revision });
  };
  const ciFact = (attempt, conclusion, overrides = {}) => ({
    repository: scope.repository, branch: scope.branch, job: 'accept-case', runId: '1',
    commit: 'b'.repeat(40), observedAt: new Date().toISOString(), attempt, conclusion, ...overrides,
  });
  const publishFacts = async (before, after, rows) => {
    await publish({ complete: true, before, after, rows });
    return awaitEvidence(value => value.ciCheckpoint?.checkpoint === after);
  };
  const replaceReviewer = async () => {
    const marker = resolve(dir, 'reviewer-replaced');
    await writeFile(resolve(dir, 'replace-reviewer'), 'replace');
    const deadline = Date.now() + 10000;
    while (!(await readFile(marker, 'utf8').catch(() => ''))) {
      assert.ok(Date.now() < deadline, 'Fixture membership did not change');
      await delay(100);
    }
  };
  const publish = async page => {
    const inbox = resolve(host.env.DSH_HOME, 'dsh-bot-proactive/ci-inbox');
    await mkdir(inbox, { recursive: true });
    const staging = resolve(inbox, 'pending-page');
    await writeFile(staging, JSON.stringify(page));
    await rename(staging, resolve(inbox, `${sourceDigest}.json`));
  };
  const verifyFollowUp = async expectedCalls => {
    const followed = await awaitEvidence(value => value.work[0]?.groupReview?.followUp?.state === 'linked' &&
      value.groupFollowUpResult?.turn.state === 'completed');
    const follow = followed.groupFollowUpResult;
    assert.equal(followed.calls, expectedCalls);
    assert.equal(host.requests(), expectedCalls);
    assert.equal(follow.deliveries.length, 1);
    assert.equal(follow.deliveries[0].bot.botId, 'fixture-reviewer');
    assert.equal(follow.turn.proactive.followUp.predecessorTurnId, evidence.groupReview.turn.id);
    assert.equal(follow.turn.proactive.assignmentId, evidence.groupReview.turn.proactive.assignmentId);
    assert.deepEqual(follow.childSources, ['dsh-bot-group-proactive']);
    const fact = followed.work[0].groupReview.followUp.fact;
    assert.equal(fact.attempt, 2);
    assert.equal(fact.conclusion, 'success');
    const repeat = await publishFacts('workflow-new-fact', 'workflow-after-follow-up', [ciFact(2, 'success'), ciFact(3, 'failure')]);
    assert.equal(repeat.calls, expectedCalls);
    evidence.groupFollowUp = { ...follow, fact, calls: repeat.calls };
  };
  if (repair) {
    await publish({ complete: true, before: 'missing-page', after: 'skip', rows: [] });
    await awaitEvidence(value => value.status.localFeed === 'invalid' && value.status.snapshot.suggestionCount === 0);
    await publish({
      complete: true, before: null, after: 'repair-1',
      rows: ['native-case', 'external-case', 'unsupported-case', 'disconnect-case', 'docs', 'docs', 'misbound-case', 'cancel-case'].map((job, i) => ({
        repository: scope.repository, branch: scope.branch, job, runId: String(i + 1), commit: 'd'.repeat(40),
        observedAt: new Date().toISOString(), attempt: i === 5 ? 2 : 1, conclusion: 'failure',
      })),
    });
    const feed = await awaitEvidence(value => value.status.localFeed === 'ready' && value.status.snapshot.suggestionCount === 8);
    assert.equal(feed.calls, 0);
    assert.equal(host.requests(), 0);
    await refresh();
    const native = card('native-case');
    const ticket = panel.locator('[data-proactive-ticket]').filter({ hasText: 'native-case' });
    await click(native, 'proactive.preview');
    await click(native, 'proactive.repairNative');
    const failed = await awaitEvidence(value => value.work.some(row => row.repairEvidence?.verification.exitCode === 1));
    const first = failed.work[0];
    await refresh();
    await click(ticket, 'proactive.openDetails');
    const approve = ticket.getByRole('button', { name: t['proactive.approve'], exact: true });
    await approve.and(panel.locator(':disabled')).waitFor();
    await requestRework(ticket);
    const passed = await awaitEvidence(value => value.work.some(row => row.generation === 2 && row.repairEvidence?.verification.exitCode === 0));
    const second = passed.work.find(row => row.ticketId === first.ticketId);
    assert.notEqual(second.assignmentId, first.assignmentId);
    const after = resolve(host.env.DSH_HOME, 'dsh-bot-proactive/repair-artifacts', second.assignmentId, 'after.json');
    const intact = await readFile(after);
    assert.deepEqual(JSON.parse(intact), { enabled: true, retained: 'sentinel' });
    await writeFile(after, '{}');
    await refresh();
    await click(ticket, 'proactive.approve');
    await panel.getByText(t['proactive.stale'], { exact: true }).waitFor();
    await writeFile(after, intact);
    await click(ticket, 'proactive.approve');
    await ticket.getByText(t['proactive.state.accepted'], { exact: true }).waitFor();
    const externalCase = async (job, mode, state) => {
      external.mode = mode;
      await click(card(job), 'proactive.preview');
      await click(card(job), 'proactive.repairExternal');
      const result = await awaitEvidence(value => value.work.some(row => row.title.includes(job) && row.state === state));
      assert.equal(result.calls, 2);
      await refresh();
      return result.work.find(row => row.title.includes(job));
    };
    const outside = await externalCase('external-case', 'success', 'delivered');
    assert.equal(outside.externalEvidence.units, 3);
    assert.equal(outside.repairEvidence.verification.exitCode, 0);
    assert.equal(outside.sessionId, undefined);
    await externalCase('unsupported-case', 'unsupported', 'denied');
    assert.equal(external.submits, 1);
    const unknown = await externalCase('disconnect-case', 'disconnect', 'unknown');
    assert.equal(unknown.externalRunId, 'fixture-2');
    assert.equal(external.submits, 2);
    assert.equal(external.cancel, 1);
    const misbound = await externalCase('misbound-case', 'misbound', 'unknown');
    assert.equal(misbound.externalRunId, 'fixture-3');
    assert.equal(misbound.repairEvidence, undefined);
    external.mode = 'hold';
    await click(card('cancel-case'), 'proactive.preview');
    await click(card('cancel-case'), 'proactive.repairExternal');
    await awaitEvidence(value => value.work.some(row => row.externalRunId === 'fixture-4' && row.state === 'sent'));
    await refresh();
    const cancelTicket = panel.locator('[data-proactive-ticket]').filter({ hasText: 'cancel-case' });
    await click(cancelTicket, 'proactive.cancel');
    const cancelled = await awaitEvidence(value => external.cancel === 2 &&
      value.work.some(row => row.externalRunId === 'fixture-4' && row.state === 'unknown'));
    assert.equal(cancelled.calls, 2);
    assert.equal(host.requests(), 2);
    const docs = card(' docs ');
    const docsAttempt = attempt => docs.filter({ hasText: t['proactive.reason'].replace('{attempt}', String(attempt)) });
    await click(docsAttempt(2), 'proactive.feedbackPropose');
    const rejected = panel.locator('[data-proactive-rule]');
    await click(rejected, 'proactive.feedback.evaluate');
    await rejected.getByText(t['proactive.rule.rejected'], { exact: true }).waitFor();
    await click(docsAttempt(1), 'proactive.feedbackPropose');
    const rules = await awaitEvidence(value => value.status.snapshot.feedbackRules.length === 2);
    const candidate = rules.status.snapshot.feedbackRules.find(rule => rule.attempt === 1);
    const rule = panel.locator(`[data-proactive-rule="${candidate.id}"]`);
    await click(rule, 'proactive.feedback.evaluate');
    await click(rule, 'proactive.feedback.adopt');
    await rule.getByText(t['proactive.rule.adopted'], { exact: true }).waitFor();
    await docs.nth(1).waitFor({ state: 'detached' });
    assert.equal(await docs.count(), 1);
    evidence.actions.push(first, second, outside, unknown, misbound, cancelled.work.find(row => row.externalRunId === 'fixture-4'));
    evidence.feed = feed.status.localFeed;
    evidence.external = external;
    await context.close();
    await host.stop();
    host = await start();
    const cold = await awaitEvidence(value => value.calls === 0 && value.work.some(row => row.state === 'accepted') &&
      value.status.snapshot.feedbackRules.some(row => row.state === 'adopted') && value.status.snapshot.suggestionCount === 1);
    assert.equal(cold.work.find(row => row.ticketId === second.ticketId).repairEvidence.artifactDigest, second.repairEvidence.artifactDigest);
    assert.equal(cold.work.find(row => row.ticketId === unknown.ticketId).externalRunId, unknown.externalRunId);
    assert.equal(external.submits, 4);
    assert.equal(host.requests(), 0);
    evidence.cold = cold;
    const restored = await open(all[0]);
    await restored.panel.locator('[data-proactive-rule]').filter({ hasText: t['proactive.rule.adopted'] })
      .getByRole('button', { name: t['proactive.feedback.revoke'], exact: true }).click();
    await restored.panel.locator('[data-proactive-decision]').filter({ hasText: ' docs ' }).nth(1).waitFor();
    const feedback = await awaitEvidence(value => value.status.snapshot.feedbackRules.some(rule => rule.state === 'revoked'));
    evidence.feedback = feedback.status.snapshot.feedbackRules;
    const sourcePanel = restored.panel.locator('[data-proactive-ci-feed]');
    await click(sourcePanel, 'proactive.feedRevoke');
    await click(sourcePanel, 'proactive.feedRevokeConfirm');
    await sourcePanel.getByText(t['proactive.feed.revoked'], { exact: false }).waitFor();
    await publish({ complete: true, before: 'repair-1', after: 'blocked-by-revocation', rows: [ciFact(2, 'failure')] });
    await delay(1200);
    const revoked = await awaitEvidence(value => value.status.localFeed === 'revoked');
    assert.equal(revoked.ciCheckpoint.checkpoint, 'repair-1');
    assert.equal(revoked.ciCheckpoint.revoked, true);
    assert.equal(revoked.calls, 0);
    assert.equal(host.requests(), 0);
    evidence.sourceRevocation = revoked.ciCheckpoint;
    await restored.context.close();
  } else if (crash) {
    await click(card('accept-case'), 'proactive.preview');
    await click(card('accept-case'), 'proactive.accept');
    const sent = await awaitEvidence(value => value.calls === 1 && value.work[0]?.state === 'sent');
    evidence.actions.push(sent.work[0]);
    assert.equal(host.requests(), 1);
    await host.crash();
    await context.close();
    await host.stop();
    host = await start();
    const cold = await awaitEvidence(value => value.calls === 0 && value.work[0]?.state === 'unknown');
    assert.equal(cold.work[0].assignmentId, sent.work[0].assignmentId);
    assert.equal(cold.work[0].sessionId, sent.work[0].sessionId);
    assert.equal(host.requests(), 0);
    evidence.cold = cold;
  } else {
  await click(card('observe-case'), 'proactive.observe');
  await card('observe-case').getByRole('button', { name: t['proactive.observe'], exact: true }).and(panel.locator(':disabled')).waitFor();
  await click(card('dismiss-case'), 'proactive.dismiss');
  await card('dismiss-case').waitFor({ state: 'detached' });
  assert.equal(host.requests(), 0);
  await click(panel, 'proactive.pause');
  await panel.getByRole('button', { name: t['proactive.resume'], exact: true }).waitFor();
  const paused = await awaitEvidence(value => value.status.snapshot?.executionControl.paused === true);
  assert.equal(paused.calls, 0);
  assert.equal(await card('accept-case').getByRole('button', { name: t['proactive.preview'], exact: true }).count(), 0);
  await click(panel, 'proactive.resume');
  const resumed = await awaitEvidence(value => value.status.snapshot?.executionControl.paused === false &&
    value.status.snapshot.executionControl.revision > paused.status.snapshot.executionControl.revision);
  assert.equal(resumed.calls, 0);
  await click(card('accept-case'), 'proactive.preview');
  await click(card('accept-case'), group && !groupFailure ? 'proactive.repairNative' : 'proactive.accept');
  await card('accept-case').waitFor({ state: 'detached' });
  const first = await awaitEvidence(value => value.calls === 1 && value.checked[0]?.state === 'delivered');
  // The notice pump commits asynchronously. Rework changes the current
  // assignment fence, so establish the first delivery before replacing it.
  const firstNotice = await awaitEvidence(value => value.notices?.length === 1 &&
    value.work.some(row => row.assignmentId === first.checked[0].assignmentId && row.notice?.state === 'recorded'));
  await refresh();
  const ticket = panel.locator('[data-proactive-ticket]');
  await requestRework(ticket);
  const second = await awaitEvidence(value => value.calls === 2 && value.checked[0]?.generation === 2);
  assert.equal(second.checked[0].ticketId, first.checked[0].ticketId);
  assert.notEqual(second.checked[0].assignmentId, first.checked[0].assignmentId);
  assert.notEqual(second.checked[0].evidenceDigest, first.checked[0].evidenceDigest);
  // Accepting before notification delivery legitimately suppresses that notice.
  // This fixture checks both delivery attempts, so establish the second receipt first.
  await awaitEvidence(value => value.notices?.length === 2 && value.work.some(row =>
    row.assignmentId === second.checked[0].assignmentId && row.notice?.state === 'recorded'));
  if (group && !groupFailure) {
    assert.equal(first.checked[0].repairEvidence.verification.exitCode, 1);
    assert.equal(second.checked[0].repairEvidence.verification.exitCode, 0);
  }
  await refresh();
  if (groupArtifact) {
    const review = ticket.locator('[data-proactive-group-review]');
    const select = () => review.getByRole('button', { name: /^Fixture reviewers · fixture-ci \+ fixture-reviewer$/ }).click();
    const after = resolve(host.env.DSH_HOME, 'dsh-bot-proactive/repair-artifacts', second.checked[0].assignmentId, 'after.json');
    const intact = await readFile(after);
    await click(review, 'proactive.groupReview');
    await writeFile(after, '{}');
    await select();
    await review.getByText(t['proactive.groupFailed'], { exact: true }).waitFor();
    assert.equal(host.requests(), 2);
    await writeFile(after, intact);
    await click(review, 'proactive.groupReview');
    await select();
    await review.getByText(second.checked[0].repairEvidence.artifactDigest, { exact: false }).waitFor();
    const changeModel = async model => {
      await writeFile(resolve(dir, 'change-group-model'), model);
      const deadline = Date.now() + 10000;
      while (await readFile(resolve(dir, 'group-model-changed'), 'utf8').catch(() => '') !== model) {
        assert.ok(Date.now() < deadline, 'Group model update receipt'); await delay(50);
      }
    };
    await changeModel('fixture');
    await click(review, 'proactive.groupConfirm');
    await review.getByText(t['proactive.groupFailed'], { exact: true }).waitFor();
    assert.equal(host.requests(), 2, 'Changing a role model invalidates the old approval without dispatch');
    await changeModel('reviewer-fixture');
    await click(review, 'proactive.groupReview'); await select();
    evidence.modelChangeInvalidatesApproval = true;
    const target = review.getByRole('button', { name: t['proactive.groupFollowUpChoose'].replace('{bot}', 'fixture-reviewer'), exact: true });
    await target.click();
    await target.and(review.locator('[aria-pressed="true"]')).waitFor();
    await click(review, 'proactive.groupConfirm');
    const technical = await awaitEvidence(value => value.groupResult?.turn.state === 'completed' &&
      value.checked[0]?.groupReview?.state === 'linked');
    assert.equal(technical.checked[0].state, 'delivered');
    assert.equal(technical.checked[0].groupReview.evidenceDigest, second.checked[0].evidenceDigest);
    assert.equal(host.requests(), 4);
    assert.equal(technical.groupResult.groupMemberCount, 4);
    assert.deepEqual(technical.groupResult.modelRoutes.map(row => row.model), ['fixture', 'reviewer-fixture']);
    evidence.groupReview = technical.groupResult;
    const cost = await awaitEvidence(value => value.taskCost?.attempts === 2 && value.taskCost.unknownMeasurements === 4);
    assert.equal(cost.taskCost.knownNativeTokens, 0);
    assert.equal(cost.taskCost.externalUnits, 0);
    evidence.taskCost = cost.taskCost;
    const beforeAcceptance = await publishFacts('workflow-v1', 'workflow-new-fact', [ciFact(2, 'success')]);
    assert.equal(beforeAcceptance.calls, 4);
    assert.equal(beforeAcceptance.groupFollowUpResult, undefined);
    assert.equal(beforeAcceptance.work[0].groupReview.followUp.state, 'armed');
    await refresh();
  }
  await refresh();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-proactive-ticket]')].some(el =>
    el.querySelector('[data-evidence-revision]')?.getAttribute('data-evidence-revision') === el.getAttribute('data-work-revision')));
  await click(ticket, 'proactive.approve');
  await ticket.getByText(t['proactive.state.accepted'], { exact: true }).waitFor();
  evidence.actions.push(first.checked[0], second.checked[0], (await awaitEvidence(value => value.checked[0]?.state === 'accepted')).checked[0]);
  if (groupArtifact) await verifyFollowUp(5);
  else assert.equal(host.requests(), 2);
  const notices = await awaitEvidence(value => value.notices?.length === 2);
  assert.deepEqual(notices.notices.map(row => row.kind), ['proactive', 'proactive']);
  assert.equal(new Set(notices.notices.map(row => row.operationId)).size, 2);
  assert.ok(notices.notices.some(row => row.operationId === firstNotice.notices[0].operationId));
  assert.ok(notices.notices.every(row => /^proactive-batch:[a-f0-9]{64}$/.test(row.operationId)));
  if (group && !groupArtifact) {
    const review = ticket.locator('[data-proactive-group-review]');
    await click(review, 'proactive.groupReview');
    await review.getByRole('button', { name: /^Fixture reviewers · fixture-ci \+ fixture-reviewer$/ }).click();
    await review.getByText(second.checked[0].title, { exact: false }).waitFor();
    assert.equal(host.requests(), 2);
    if (!groupFailure && !groupFollowUp) {
      await replaceReviewer();
      await click(review, 'proactive.groupConfirm');
      await review.getByText(t['proactive.groupFailed'], { exact: true }).waitFor();
      assert.equal(host.requests(), 2);
      await click(review, 'proactive.groupReview');
      await review.getByRole('button', { name: /^Updated reviewers · fixture-ci \+ replacement-reviewer$/ }).click();
      await review.getByText('replacement-reviewer', { exact: false }).waitFor();
    }
    if (groupFollowUp) {
    const target = review.getByRole('button', { name: t['proactive.groupFollowUpChoose'].replace('{bot}', 'fixture-reviewer'), exact: true });
      await target.click();
      await target.and(review.locator('[aria-pressed="true"]')).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(host.requests(), 2);
    }
    await click(review, 'proactive.groupConfirm');
    await review.getByRole('button', { name: t['proactive.groupOpen'], exact: true }).waitFor();
    const turnState = groupFailure ? 'partial' : 'completed';
    const childCount = groupFailure ? 1 : 2;
    const complete = await awaitEvidence(value => value.groupResult?.turn.state === turnState && value.groupResult.childSources.length === childCount);
    assert.equal(complete.groupResult.turn.proactive.ticketId, second.checked[0].ticketId);
    assert.equal(complete.groupResult.deliveries.length, 2);
    assert.equal(host.requests(), 4);
    evidence.groupReview = complete.groupResult;
    if (groupFollowUp) {
      const repeated = ciFact(1, 'failure');
      const ignored = await publishFacts('workflow-v1', 'workflow-repeat', [
        repeated, ciFact(2, 'success', { runId: '91' }),
      ]);
      assert.equal(ignored.calls, 4);
      assert.equal(ignored.groupFollowUpResult, undefined);
      assert.equal(ignored.work[0].groupReview.followUp.state, 'armed');
      if (groupFollowUpChanged) await replaceReviewer();
      if (groupFollowUpRevoked) {
        await click(panel, 'proactive.pause');
        await panel.getByRole('button', { name: t['proactive.resume'], exact: true }).waitFor();
        await click(review, 'proactive.groupFollowUpCancel');
        await review.getByText(t['proactive.groupFollowUp.denied'], { exact: true }).waitFor();
        await click(panel, 'proactive.resume');
      }
      if (groupFollowUpCold) {
        await click(panel, 'proactive.pause');
        await panel.getByRole('button', { name: t['proactive.resume'], exact: true }).waitFor();
      }
      const pending = await publishFacts('workflow-repeat', 'workflow-new-fact', [ciFact(2, 'success')]);
      if (groupFollowUpChanged || groupFollowUpRevoked) {
        const denied = await awaitEvidence(value => value.work[0]?.groupReview?.followUp?.state === 'denied');
        assert.equal(denied.calls, 4);
        assert.equal(denied.groupFollowUpResult, undefined);
        evidence.groupFollowUp = { state: 'denied', calls: denied.calls };
      } else if (groupFollowUpCold) {
        assert.equal(pending.calls, 4);
        assert.equal(pending.groupFollowUpResult, undefined);
        assert.equal(pending.status.snapshot.executionControl.paused, true);
        evidence.groupFollowUpPending = pending.work[0].groupReview.followUp;
      } else if (groupFollowUpLate) {
        await awaitEvidence(value => value.calls === 5 && value.groupFollowUpResult?.deliveries[0]?.state === 'running');
        await publishFacts('workflow-new-fact', 'workflow-newer-fact', [ciFact(3, 'failure')]);
        await writeFile(resolve(dir, 'release-follow-up'), 'ready');
        const stale = await awaitEvidence(value => value.groupFollowUpResult?.turn.state === 'recovery_needed');
        assert.equal(stale.calls, 5);
        assert.equal(stale.groupFollowUpResult.deliveries[0].state, 'unknown');
        assert.equal(stale.groupFollowUpResult.deliveries[0].outputMessageId, undefined);
        evidence.groupFollowUp = { ...stale.groupFollowUpResult, calls: stale.calls };
      } else {
        await verifyFollowUp(5);
      }
    }
    if (!groupFollowUp) {
      await click(review, 'proactive.groupOpen');
      await page.locator('[data-group-author="proactive"]').getByText(second.checked[0].title, { exact: false }).waitFor();
      await page.locator('[data-group-author="bot"]').nth(groupFailure ? 0 : 1).waitFor();
    }
  }
  const noticeStatus = noticeUnknown ? 'notifications.unknown' : 'notifications.accepted';
  if (notice) {
    const outbound = ticket.locator('[data-proactive-external-notice]');
    const transports = async () => (await readFile(resolve(dir, 'notice-transports.ndjson'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse);
    await click(outbound, 'proactive.noticePreview');
    await outbound.getByText('Fixture target', { exact: false }).waitFor();
    assert.deepEqual(await transports(), []);
    await writeFile(resolve(dir, 'notice-target.txt'), 'Changed target label');
    await click(outbound, 'proactive.noticeConfirm');
    await outbound.getByText(t['proactive.noticeFailed'], { exact: true }).waitFor();
    assert.deepEqual(await transports(), []);
    await click(outbound, 'proactive.noticePreview');
    await outbound.getByText('Changed target label', { exact: false }).waitFor();
    await click(outbound, 'proactive.noticeConfirm');
    await outbound.getByText(t[noticeStatus], { exact: true }).waitFor();
    evidence.externalNotice = await transports();
    assert.equal(evidence.externalNotice.length, 1);
    assert.equal(evidence.externalNotice[0].text, second.checked[0].title);
    await click(outbound, 'actions.close');
    await click(outbound, 'proactive.noticePreview');
    await outbound.getByText(t[noticeStatus], { exact: true }).waitFor();
    assert.equal(await outbound.getByRole('button', { name: t['proactive.noticeConfirm'] }).count(), 0);
  }
  await context.close();
  await host.stop();
  host = await start();
  const cold = await awaitEvidence(value => value.calls === 0 && value.checked[0]?.state === 'accepted');
  assert.equal(cold.checked[0].evidenceDigest, second.checked[0].evidenceDigest);
  evidence.cold = cold;
  if (group) {
    const groupCold = await awaitEvidence(value => value.calls === 0 && value.groupResult?.childSources.length === (groupFailure ? 1 : 2));
    assert.equal(groupCold.groupResult.turn.id, evidence.groupReview.turn.id);
    assert.equal(host.requests(), 0);
    const coldPage = await open(primary);
    await click(coldPage.panel.locator('[data-proactive-ticket]').first(), 'proactive.openDetails');
    const review = coldPage.panel.locator('[data-proactive-group-review]');
    if (groupFollowUpCold) {
      assert.equal(groupCold.work[0].groupReview.followUp.state, 'armed');
      await click(coldPage.panel, 'proactive.resume');
      await verifyFollowUp(1);
      await refresh(coldPage);
      await coldPage.page.waitForFunction(() => [...document.querySelectorAll('[data-proactive-ticket]')].some(el =>
        el.querySelector('[data-evidence-revision]')?.getAttribute('data-evidence-revision') === el.getAttribute('data-work-revision')));
    }
    if (groupFollowUpLate) {
      assert.equal(groupCold.groupFollowUpResult?.turn.id, evidence.groupFollowUp.turn.id);
      assert.equal(groupCold.groupFollowUpResult.deliveries[0].outputMessageId, undefined);
    }
    await review.getByRole('button', { name: t['proactive.groupOpen'], exact: true }).waitFor();
    if (evidence.groupFollowUp?.fact) {
      if (!groupFollowUpCold) {
        assert.equal(groupCold.work[0].groupReview.followUp.state, 'linked');
        assert.equal(groupCold.groupFollowUpResult?.turn.id, evidence.groupFollowUp.turn.id);
        evidence.groupFollowUpCold = groupCold.groupFollowUpResult.turn.id;
      }
      await click(review, 'proactive.groupOpen');
      await coldPage.page.locator('[data-group-author="proactive"]').getByText(evidence.groupFollowUp.fact.text, { exact: true }).waitFor();
    }
    assert.equal(host.requests(), groupFollowUpCold ? 1 : 0);
    await coldPage.context.close();
    if (groupFollowUpCold) {
      await host.stop();
      host = await start();
      const finalCold = await awaitEvidence(value => value.groupFollowUpResult?.turn.id === evidence.groupFollowUp.turn.id && value.calls === 0);
      assert.equal(finalCold.work[0].groupReview.followUp.state, 'linked');
      assert.equal(host.requests(), 0);
      evidence.groupFollowUpCold = finalCold.groupFollowUpResult.turn.id;
    }
  }
  if (notice) {
    const coldPage = await open(all[0]);
    await click(coldPage.panel.locator('[data-proactive-ticket]').first(), 'proactive.openDetails');
    const outbound = coldPage.panel.locator('[data-proactive-external-notice]');
    await click(outbound, 'proactive.noticePreview');
    await outbound.getByText(t[noticeStatus], { exact: true }).waitFor();
    const sent = (await readFile(resolve(dir, 'notice-transports.ndjson'), 'utf8')).trim().split('\n');
    assert.equal(sent.length, 1);
    await coldPage.context.close();
  }
  }
  await writeFile(resolve(dir, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS proactive browser and native workflow ${dir}`);
} catch (error) {
  await writeFile(resolve(dir, 'failure.json'), JSON.stringify({ ...evidence, error: redact(error.stack ?? error) }, null, 2));
  throw new Error(`Proactive workflow failed. See ${dir}`);
} finally {
  await browser?.close();
  await host?.stop();
}
