import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
import { auditArtifact } from './p34-artifact.mjs';
import { scratch } from './proactive/worker.mjs';

assert.ok(process.argv[2], 'Pass the frozen product candidate tgz');
const artifact = resolve(process.argv[2]);
const dir = await scratch('v066-follow-up-client');
const screenshots = resolve('output/playwright', dir.split('/').at(-1));
await mkdir(screenshots, { recursive: true });
console.log(dir);
const require = createRequire(resolve('packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
const fixture = resolve('packages/dsh-bot/tests/v066-follow-up-client-profile.mjs');
const artifactAudit = await auditArtifact(process.cwd(), artifact, dir);
const flags = ['- id: dsh-bot', '  config:', '    proactiveEnabled: false', '    proactiveExecutionEnabled: false',
  `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`];
const untilReceipt = async name => {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const failed = await readFile(join(dir, 'client-error.json'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (failed) throw new Error(`Native fixture failed: ${failed}`);
    try { return JSON.parse(await readFile(join(dir, name), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(100);
  }
  throw new Error(`Missing native receipt ${name}`);
};
const label = (t, key, values = {}) => t[key].replace(/\{(\w+)\}/g, (_, name) => values[name]);
let host, browser;
const evidence = [];
const phase = value => console.log(`FOLLOW_UP_CLIENT ${value}`);
try {
  host = await webHost(dir, 'v066-follow-up-client', artifact, fixture, flags, { artifactAudit });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath: process.env.DSH_BOT_CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, chromiumSandbox: true, env: host.env }); }
  finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  const initial = await untilReceipt('client-initial.json');
  const session = async (language, theme) => {
    const t = JSON.parse(await readFile(resolve(`packages/dsh-bot/locale/${language}.json`), 'utf8')).ui;
    const context = await browser.newContext({ viewport: { width: 1360, height: 950 }, colorScheme: theme,
      locale: language === 'en' ? 'en-US' : 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(18000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await installOverlayHandler(page, () => {});
    await page.goto(host.url, { waitUntil: 'domcontentloaded' });
    await dismissFirstRunOverlays(page, () => {}, 'v066-follow-up-client');
    const bots = page.locator('[data-bots-page]:visible');
    const openPersonal = async () => {
      await openBotsPanel(page, t['bots.title']);
      const profile = bots.getByRole('button', { name: `${t['chat.profile']} · Fixture alpha`, exact: true });
      const fallback = bots.locator('button[data-bot-id="alpha"]');
      await profile.or(fallback).first().waitFor();
      if (await profile.isVisible()) await profile.click(); else await fallback.click();
      const detail = page.locator('[data-bot-detail="alpha"]');
      await detail.getByRole('tab', { name: t['detail.work'], exact: true }).click();
      const followUp = detail.locator('[data-follow-up="detail"]:visible');
      await followUp.waitFor();
      return followUp;
    };
    const openGroup = async () => {
      const detail = page.locator('[data-bot-detail="alpha"]:visible');
      if (await detail.isVisible()) await detail.getByRole('button',
        { name: label(t, 'navigation.returnTo', { name: t['navigation.myBots'] }), exact: true }).click();
      await openBotsPanel(page, t['bots.title']);
      await bots.getByRole('button', { name: t['groups.title'], exact: true }).click();
      await bots.locator(`[data-group-directory-row="${initial.group.group.groupId}"]`).click();
      const group = bots.locator(`[data-group-overview="${initial.group.group.groupId}"]`);
      await group.getByRole('tab', { name: t['groups.view.activity'], exact: true }).click();
      const followUp = group.locator('[data-follow-up="detail"]:visible');
      await followUp.waitFor();
      return followUp;
    };
    return { context, page, t, openPersonal, openGroup, errors };
  };
  const checkBounds = async (page, owner) => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const clipped = await owner.locator('button:visible, select:visible, textarea:visible').evaluateAll(elements =>
      elements.filter(element => { const box = element.getBoundingClientRect(); return box.right > innerWidth + 1 || box.left < -1; })
        .map(element => element.outerHTML.slice(0, 100)));
    assert.deepEqual(clipped, []);
  };

  phase('first personal and group enable through original UI');
  const first = await session('en', 'light');
  try {
    let personal = await first.openPersonal();
    const enable = first.t['followUp.enable'], enabled = first.t['followUp.enabled'];
    await personal.getByText(first.t['followUp.off'], { exact: true }).waitFor();
    await first.page.screenshot({ path: join(screenshots, 'personal-before-enable.png') });
    await personal.getByRole('button', { name: enable, exact: true }).click();
    assert.deepEqual(await untilReceipt('client-personal-enabled.json'), { personal: true, group: false, other: false, requests: 0, modelProviders: 0 });
    if (!await personal.isVisible()) personal = await first.openPersonal();
    await personal.getByText(enabled, { exact: true }).waitFor();
    const group = await first.openGroup();
    await group.getByText(first.t['followUp.off'], { exact: true }).waitFor();
    await first.page.screenshot({ path: join(screenshots, 'group-before-enable.png') });
    await group.getByRole('button', { name: enable, exact: true }).click();
    await group.getByText(enabled, { exact: true }).waitFor();
    assert.deepEqual(await untilReceipt('client-group-enabled.json'), { personal: true, group: true, other: false, requests: 0, modelProviders: 0 });
    assert.deepEqual(first.errors, []);
  } finally { await first.context.close(); }
  const seeded = await untilReceipt('client-cards.json');
  assert.equal(seeded.requests, 3);

  for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) for (const width of [1360, 390]) {
    phase(`${language} ${theme} ${width}`);
    const { context, page, t, openPersonal, openGroup, errors } = await session(language, theme);
    try {
      const personal = await openPersonal();
      await personal.getByText(t['followUp.enabled'], { exact: true }).waitFor();
      assert.equal(await personal.getByText(initial.watchTitle, { exact: true }).count(), 0);
      await page.setViewportSize({ width, height: 950 });
      await personal.scrollIntoViewIfNeeded();
      await checkBounds(page, personal);
      await page.screenshot({ path: join(screenshots, `personal-${language}-${theme}-${width}.png`) });
      await page.setViewportSize({ width: 1360, height: 950 });
      const group = await openGroup();
      const proposal = group.locator(`[data-follow-up-card="${seeded.proposal.id}"]`);
      await proposal.getByRole('button', { name: t['followUp.confirmWatch'], exact: true }).waitFor();
      assert.equal(await proposal.getByRole('button', { name: t['followUp.complete'], exact: true }).count(), 0);
      const failure = group.locator(`[data-follow-up-card="${seeded.failure.id}"]`);
      await page.setViewportSize({ width, height: 950 });
      await proposal.scrollIntoViewIfNeeded();
      await checkBounds(page, group);
      await page.screenshot({ path: join(screenshots, `group-proposal-${language}-${theme}-${width}.png`) });
      await failure.getByRole('button', { name: t['followUp.groupContinue'], exact: true }).click();
      const member = failure.getByRole('combobox', { name: t['followUp.groupMember'], exact: true });
      assert.equal(await member.evaluate(element => document.activeElement === element), true);
      assert.equal(await member.locator('option').count(), 5);
      await member.selectOption(initial.selected);
      await failure.getByText(`${initial.selectedRoute.provider} / ${initial.selectedRoute.model}`, { exact: false }).waitFor();
      const input = failure.getByRole('textbox', { name: t['followUp.groupText'], exact: true });
      await page.keyboard.press('Tab');
      assert.equal(await input.evaluate(element => document.activeElement === element), true);
      await input.fill(initial.continuationInput);
      assert.equal(await input.inputValue(), initial.continuationInput);
      const start = failure.getByRole('button', { name: t['followUp.groupAccept'], exact: true });
      assert.equal(await start.isEnabled(), true);
      await input.scrollIntoViewIfNeeded();
      await checkBounds(page, group);
      await page.screenshot({ path: join(screenshots, `group-continue-${language}-${theme}-${width}.png`) });
      const nativeTheme = await page.evaluate(() => ({
        locale: document.documentElement.lang, dark: matchMedia('(prefers-color-scheme: dark)').matches,
        background: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
      }));
      assert.equal(nativeTheme.locale.startsWith(language), true);
      assert.equal(nativeTheme.dark, theme === 'dark');
      assert.ok(nativeTheme.background);
      assert.deepEqual(errors, []);
      if (language === 'zh' && theme === 'dark' && width === 390) {
        await proposal.getByRole('button', { name: t['followUp.confirmWatch'], exact: true }).click();
        const confirmed = await untilReceipt('client-confirmed.json');
        assert.equal(confirmed.requests, 3);
        await proposal.getByRole('button', { name: t['followUp.complete'], exact: true }).waitFor();
        await start.click();
        const accepted = await untilReceipt('client-accepted.json');
        assert.equal(accepted.selected, initial.selected);
        assert.equal(accepted.requests, 4);
        assert.equal(accepted.realModelRequests, 0);
        await page.screenshot({ path: join(screenshots, 'group-confirmed-and-continued.png') });
      }
      evidence.push({ language, theme, width, nativeTheme, controls: ['personal', 'proposal', 'single member'], errors });
      await writeFile(join(dir, 'browser-evidence.json'), JSON.stringify({ artifactSha256: artifactAudit.sha256, screenshots, evidence }, null, 2));
    } catch (error) {
      await Promise.allSettled([
        page.screenshot({ path: join(screenshots, `failure-${language}-${theme}-${width}.png`), timeout: 3000 }),
        page.locator('body').ariaSnapshot({ timeout: 3000 }).then(tree => writeFile(join(dir, 'failure-tree.yml'), tree)),
      ]);
      throw error;
    } finally { await context.close(); }
  }
  assert.equal(evidence.length, 8);
  const background = theme => new Set(evidence.filter(item => item.theme === theme).map(item => item.nativeTheme.background));
  assert.equal(background('light').size, 1);
  assert.equal(background('dark').size, 1);
  assert.notDeepEqual(background('light'), background('dark'));
  phase('30 persisted synthetic group changes to real Web summary');
  const burst = await session('en', 'light');
  try {
    await burst.openGroup();
    const group = burst.page.locator(`[data-bots-page]:visible [data-group-overview="${initial.group.group.groupId}"]`);
    await group.getByRole('tab', { name: burst.t['groups.view.members'], exact: true }).click();
    const summary = group.locator('[data-follow-up="summary"]:visible');
    await summary.waitFor();
    const failures = summary.locator('[data-follow-up-card]').filter({ hasText: burst.t['followUp.condition.failed'] });
    assert.equal(await failures.count(), 0);
    await writeFile(join(dir, 'client-start-burst'), 'start');
    await failures.nth(2).waitFor({ timeout: 10000 });
    const visibleAt = Date.now();
    const receipt = await untilReceipt('client-burst.json');
    assert.equal(receipt.facts, 30);
    assert.equal(receipt.uniqueProjected, 30);
    assert.equal(receipt.adapterRequests, 0);
    const elapsedMs = visibleAt - receipt.firstDurableAt;
    assert.ok(elapsedMs >= 0 && elapsedMs <= 10000, `Web summary appeared after ${elapsedMs}ms`);
    assert.deepEqual(burst.errors, []);
    await burst.page.screenshot({ path: join(screenshots, 'group-30-changes-summary.png') });
    await writeFile(join(dir, 'browser-performance.json'), JSON.stringify({ ...receipt, visibleAt, elapsedMs }, null, 2));
    console.log(`PASS 30 persisted synthetic changes to real Web summary in ${elapsedMs} ms`);
  } finally { await burst.context.close(); }
  assert.equal(host.requests(), 0);
  console.log(`PASS native Client matrix, explicit scope enable, group confirmation and selected continuation: ${screenshots}`);
} finally { await browser?.close(); await host?.stop(); }
