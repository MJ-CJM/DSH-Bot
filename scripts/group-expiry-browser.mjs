import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel } from './deepening/sidebar-session.mjs';
import { sha256 } from './p34-artifact.mjs';
import { scratch } from './proactive/worker.mjs';

const [arg, shaArg] = process.argv.slice(2);
const expected = shaArg?.match(/^--expected-sha=([a-f0-9]{64})$/)?.[1];
assert.ok(arg && expected, 'Usage: node scripts/group-expiry-browser.mjs <frozen tgz> --expected-sha=<sha256>');
const artifact = resolve(arg);
assert.equal(sha256(await readFile(artifact)), expected, 'The frozen package changed');
process.env.DSH_BOT_DSH_BIN ??= '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const runtime = execFileSync(resolve('scripts/dsh'), ['--version'], {
  encoding: 'utf8', env: { PATH: process.env.PATH, DSH_HOME: resolve('.dsh-dev'), DSH_BOT_DSH_BIN: process.env.DSH_BOT_DSH_BIN },
}).trim();
assert.equal(runtime, '0.2.2-rc.5');

const dir = await scratch('group-expiry-rc5');
console.log(dir);
const fixturePath = resolve(dir, 'fixture-entry.mjs');
await writeFile(fixturePath, `export {inject,apply} from ${JSON.stringify(resolve('packages/dsh-bot/tests/group-expiry-profile.mjs'))};\n`);
const read = name => readFile(resolve(dir, name + '.json'), 'utf8').then(JSON.parse);
const save = (name, value) => writeFile(resolve(dir, name + '.json'), JSON.stringify(value, null, 2));
const usedChecks = [];
const check = (name, condition = true) => {
  assert.ok(condition, name);
  usedChecks.push(name);
  console.log('GROUP_EXPIRY_CHECK ' + name);
};
const live = async predicate => {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const error = await read('observer-error').catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    assert.ok(!error, error?.error);
    const report = await read('proof-live');
    if (predicate(report)) return report;
    await delay(25);
  }
  throw Error('Group expiry Host proof timed out');
};
const unchanged = report => report.privateMemoryUnchanged && report.historicalMessagesUnchanged
  && report.historicalTurnUnchanged && report.historicalDeliveriesUnchanged
  && report.historicalReviewFlowsUnchanged && report.historicalChildrenUnchanged;
const expand = async queue => {
  const toggle = queue.locator('button[aria-controls]').first();
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
};

let host, browser, page;
const screenshots = [];
const errors = [];
const shot = async (screen, name) => {
  const file = name + '.png';
  await screen.screenshot({ path: resolve(dir, file), fullPage: true });
  await writeFile(resolve(dir, name + '.txt'), await screen.locator('body').ariaSnapshot());
  screenshots.push(file);
};
try {
  host = await webHost(dir, 'group-expiry', artifact, fixturePath);
  const fixture = await read('fixture');
  const artifactAudit = await read('artifact-manifest');
  assert.equal(artifactAudit.sha256, expected);
  const source = (await readFile(fixture.productPath, 'utf8')).trimEnd()
    .replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*$/u, '').trimEnd();
  const require = createRequire(resolve('packages/dsh-bot/package.json'));
  const { chromium } = require('playwright-core');
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
  const executablePath = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell')))
    .find(existsSync);
  assert.ok(executablePath, 'Cached Chromium headless shell is required');
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env });
  let exactClientServed = false;
  const open = async (locale, colorScheme, viewport) => {
    const labels = JSON.parse(await readFile(resolve(dirname(dirname(fixture.productPath)), `locale/${locale}.json`))).ui;
    const context = await browser.newContext({ locale: locale === 'en' ? 'en-US' : 'zh-CN', colorScheme, viewport, reducedMotion: 'reduce' });
    const screen = await context.newPage();
    screen.setDefaultTimeout(15000);
    screen.on('pageerror', error => errors.push(String(error)));
    screen.on('response', response => {
      if (new URL(response.url()).pathname !== '/plugins/' || !/javascript/.test(response.headers()['content-type'] ?? '')) return;
      void response.text().then(body => { exactClientServed ||= body.includes(source); }).catch(() => {});
    });
    await screen.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await installOverlayHandler(screen, () => {});
    await screen.goto(host.url, { waitUntil: 'domcontentloaded' });
    await dismissFirstRunOverlays(screen, () => {}, 'group-expiry');
    await openBotsPanel(screen, labels['bots.title']);
    const navigation = screen.getByRole('navigation', { name: labels['navigation.sections'], exact: true });
    await navigation.getByRole('button', { name: labels['groups.title'], exact: true }).click();
    const directoryRow = screen.locator(`[data-directory-kind="group"][data-directory-id="${fixture.key.groupId}"]`);
    await directoryRow.locator('[data-directory-open]').waitFor();
    const directoryText = await directoryRow.innerText();
    const pendingLocator = await screen.locator(`[data-directory-pending-group="${fixture.key.groupId}"]`).count();
    await directoryRow.locator('[data-directory-open]').click();
    const composer = screen.locator(`[data-workspace-group-composer="${fixture.sessionId}"]:visible`);
    await composer.waitFor();
    const queue = screen.locator(`[data-group-export-queue="${fixture.key.groupId}"]`);
    await queue.waitFor();
    return { context, screen, labels, composer, queue, directoryText, pendingLocator };
  };
  const wide = { width: 1360, height: 1000 };
  const ui = await open('en', 'light', wide);
  page = ui.screen;
  const expired = queue => queue.locator('[data-group-expired-exports]');
  const close = queue => queue.locator('[data-close-stale-exports]');
  const pendingRows = queue => queue.locator('[data-group-export-review]');
  const oldHistory = screen => screen.locator(`[data-group-turn="${fixture.oldTurn}"]`);
  const first = await live(report => report.staleOpen === 3);
  check('stale-only state is excluded from the pending count', first.pending === 0 && first.freshHeld.length === 0);
  check('Host denies stale preview, pre-edit approval token, and an outdated bulk close revision',
    fixture.staleReviewRejected && fixture.staleTokenRejected && fixture.staleCloseRevisionRejected);
  check('three settled Bots took exactly one private tool call and one mock reply apiece', first.calls === 6 && host.requests() === 6);
  await expired(ui.queue).waitFor();
  check('composer explains why all three old reply reviews expired', await expired(ui.queue).getAttribute('data-expired-count') === '3'
    && /member|audience/i.test(await expired(ui.queue).innerText()));
  check('stale old replies have no review controls and no private body in the composer', await pendingRows(ui.queue).count() === 0
    && !(await ui.queue.innerText()).includes('PRIVATE_EXPIRY_OLD:'));
  await oldHistory(page).getByText(ui.labels['groups.export.expiredStatus']).first().waitFor();
  check('original round still explains its expired reply review status');
  await oldHistory(page).getByRole('button', { name: ui.labels['groups.export.openExpired'], exact: true }).click();
  check('the historical locator focuses the composer expiry queue', await ui.queue.evaluate(node => document.activeElement === node));
  check('group directory does not show an old reply pending count', ui.pendingLocator === 0
    && !ui.directoryText.includes(ui.labels['groups.export.queueCount'].replace('{count}', '3')));
  await shot(page, '01-expired-only-en-light');

  const localized = await open('zh', 'dark', wide);
  try {
    await localized.screen.setViewportSize({ width: 390, height: 844 });
    await expired(localized.queue).waitFor();
    assert.match(await expired(localized.queue).innerText(), /成员/);
    await close(localized.queue).scrollIntoViewIfNeeded();
    const box = await close(localized.queue).boundingBox();
    check('Chinese narrow dark view exposes the expiry reason and bulk action within the viewport',
      box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
    await shot(localized.screen, '02-expired-only-zh-dark-narrow');
  } finally {
    await localized.context.close();
  }

  await ui.composer.getByRole('textbox', { name: ui.labels['groups.message'], exact: true }).fill('STALE_FIXTURE_CURRENT');
  await ui.composer.getByRole('button', { name: ui.labels['groups.send'], exact: true }).click();
  const mixed = await live(report => report.freshHeld.length === 4);
  check('current four-person replies are pending while old entries remain separate', mixed.pending === 4 && mixed.staleOpen === 3
    && mixed.publishedOld === 0 && mixed.publishedFresh === 0);
  await ui.queue.getByRole('button', { name: ui.labels['groups.export.queueCount'].replace('{count}', '4'), exact: true }).waitFor();
  check('composer pending badge shows exactly four current replies', await expired(ui.queue).getAttribute('data-expired-count') === '3');
  await expand(ui.queue);
  const clearReceipts = ui.queue.getByRole('button', { name: ui.labels['groups.export.clearReceipts'], exact: true });
  check('clear-processed-receipts stays hidden until there are processed receipts', await clearReceipts.count() === 0);
  const chosen = mixed.freshHeld[0];
  const row = ui.queue.locator(`[data-group-export-review="${chosen.id}"]`);
  await row.getByRole('button', { name: ui.labels['groups.export.review'], exact: true }).click();
  const body = row.locator('pre');
  await body.waitFor();
  check('current preview remains usable and includes the exact new audience',
    (await body.innerText()).includes(`PRIVATE_EXPIRY_FRESH:${chosen.botId}`)
    && (await Promise.all(fixture.bots.map(bot => row.getByText(bot.botId).count()))).every(count => count >= 1));
  const selection = row.getByRole('checkbox');
  await selection.check();
  await shot(page, '03-mixed-old-expired-and-live-review');
  await close(ui.queue).click();
  const closedReceipt = ui.queue.locator('[data-stale-exports-result][data-closed-count="3"]');
  await closedReceipt.waitFor();
  await expired(ui.queue).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-stale-exports-result'));
  check('bulk action moves keyboard focus to the closure receipt');
  const closed = await live(report => report.staleClosed === 3);
  check('single bulk action reports closing three expired reviews', closed.staleOpen === 0);
  await oldHistory(page).getByText(ui.labels['groups.export.expiredClosed']).first().waitFor();
  check('original round shows closed review status after the queue action');
  check('bulk close preserves current selection, count, and unsent status',
    await selection.isChecked() && closed.pending === 4 && closed.publishedFresh === 0);
  check('old delivery rows, turn, group history, child-session history, and private memory ACLs stay unchanged',
    unchanged(closed) && closed.publishedOld === 0 && closed.noAutomaticApproval);
  check('bulk close does not rerun or replay a model', closed.calls === 14 && host.requests() === 14);
  await shot(page, '04-bulk-closed-receipt');
  await ui.queue.locator('[data-send-selection="1"]').click();
  await row.locator('[data-export-receipt]').waitFor();
  const approved = await live(report => report.publishedFresh === 1);
  check('current selected reply sends exactly once after old replies close', approved.pending === 3
    && approved.publishedOld === 0 && approved.freshHeld.length === 3 && unchanged(approved));
  await clearReceipts.click();
  await row.waitFor({ state: 'hidden' });
  check('clear-processed-receipts removes the message receipt while keeping all current pending work',
    await clearReceipts.count() === 0 && await pendingRows(ui.queue).count() === 3 && (await live(() => true)).publishedFresh === 1);
  check('actual browser executes the installed frozen Client source', exactClientServed);
  check('browser hit no page errors', errors.length === 0);

  await ui.context.close();
  page = undefined;
  await host.stop();
  host = undefined;
  host = await webHost(dir, 'group-expiry', artifact, fixturePath, [], { preserveProfile: true, artifactAudit });
  const cold = await read('cold-result');
  check('cold restart retains closure, history, private permissions and fresh pending replies', cold.status === 'PASS'
    && cold.idempotent && cold.staleClosed === 3 && cold.pending === 3 && unchanged(cold));
  check('cold restart makes zero model requests and publishes no expired replies', host.requests() === 0
    && cold.calls === 0 && cold.publishedOld === 0);
  const reopened = await open('en', 'light', wide);
  try {
    await expand(reopened.queue);
    await pendingRows(reopened.queue).first().waitFor();
    check('reopened composer shows only three actionable pending replies', await pendingRows(reopened.queue).count() === 3
      && await expired(reopened.queue).count() === 0);
    await shot(reopened.screen, '05-cold-only-current-pending');
  } finally {
    await reopened.context.close();
  }
  check('isolated native fixture attempted no outside network requests', !existsSync(resolve(dir, 'network-denials.jsonl')));
  await save('verified', {
    status: 'PASS', artifactSha256: expected, runtime, checks: usedChecks, screenshots,
    nativeFixtureModelCalls: approved.calls, coldFixtureModelCalls: cold.calls, realModelRequests: 0, errors, closed, cold,
  });
  console.log('GROUP_EXPIRY_PRECHECK_PASS');
} catch (error) {
  if (page) await shot(page, 'failure').catch(() => {});
  await save('runner-error', { status: 'FAIL', checks: usedChecks, screenshots, errors, error: String(error.stack ?? error) });
  throw error;
} finally {
  await browser?.close();
  await host?.stop();
}
