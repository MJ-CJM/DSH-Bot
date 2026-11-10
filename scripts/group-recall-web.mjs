import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel, openSidebarSession } from './deepening/sidebar-session.mjs';
import { auditArtifact, command } from './p34-artifact.mjs';
import { scratch } from './proactive/worker.mjs';

assert.equal(process.argv.length, 3, 'Usage: node scripts/group-recall-web.mjs <frozen repo-local candidate.tgz>');
const root = process.cwd(), artifact = resolve(process.argv[2]), local = relative(root, artifact);
assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'Choose a candidate in the repository');
process.env.DSH_BOT_DSH_BIN ??= resolve('.dsh-dev/native-api-rc2/node_modules/.bin/dsh');
const dir = await scratch('group-recall-web');
const screenshots = resolve('output/playwright', basename(dir));
await mkdir(screenshots, { recursive: true });
const artifactAudit = await auditArtifact(root, artifact, dir);
const require = createRequire(resolve('packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
const evidence = [], browserWorkflow = [];
let host, browser, hostVersion;
console.log(dir);

const json = async name => JSON.parse(await readFile(join(dir, name), 'utf8'));
const until = async (read, description) => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(80);
  }
  throw new Error(`Timed out: ${description}`);
};
const tokens = page => page.evaluate(() => ({ locale: document.documentElement.lang,
  dark: matchMedia('(prefers-color-scheme: dark)').matches,
  background: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim() }));
const writeEvidence = () => writeFile(join(dir, 'recall-web-evidence.json'), JSON.stringify({
  artifact: artifactAudit.artifact, artifactSha256: artifactAudit.sha256, hostVersion, screenshots, evidence, browserWorkflow,
}, null, 2));

try {
  host = await webHost(dir, 'group-recall-web', artifact, resolve('packages/dsh-bot/tests/group-recall-web-profile.mjs'), [
    '- id: dsh-bot', '  config:', '    proactiveEnabled: false',
    '- id: agent-default-model', '  config:', '    provider: recall-fixture', '    model: fixture',
  ], { artifactAudit, mockModel: false });
  const version = await command(resolve('scripts/dsh'), ['--version'], { env: host.env });
  assert.equal(version.code, 0);
  hostVersion = version.output.trim();
  assert.ok(['0.2.1-rc.2', '0.2.2-rc.1'].includes(hostVersion), `Unexpected Host ${hostVersion}`);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = host.env.TMPDIR;
  try {
    browser = await chromium.launch({ executablePath: process.env.DSH_BOT_CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true, chromiumSandbox: true, env: host.env });
  } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  const initial = await json('recall-web-initial.json');
  const { alpha, group, rootSessionId, mainSessionId, expected, latest, oldMember } = initial.fixture;
  const original = expected.items[0];
  const question = original.sources.find(source => source.role === 'question');
  const answer = original.sources.find(source => source.role === 'answer');
  assert.ok(question && answer && latest);
  assert.equal(initial.realModelRequests, 0);
  assert.equal(initial.baseline.modelStreams, initial.syntheticRequests);
  assert.deepEqual(initial.baseline.memories, []);
  const wide = { width: 1360, height: 950 };
  const label = (t, key, values) => t[key].replace(/\{(\w+)\}/g, (_match, name) => values[name]);
  const native = id => `[data-conversation-content][data-conversation-session="${id}"]:visible`;
  const probe = async (id, stage) => {
    const error = await json('recall-web-error.json').catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
    assert.equal(error, undefined, `Host probe failed: ${JSON.stringify(error)}`);
    const key = `${id}-${stage}`;
    await writeFile(join(dir, 'recall-web-probe.json'), JSON.stringify({ id: key }));
    const value = await until(() => json(`recall-web-probe-${key}.json`), key);
    assert.deepEqual(value, initial.baseline, `Unexpected session, memory or model activity at ${stage}`);
    browserWorkflow.push({ id, stage, native: value });
  };

  for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) for (const width of [1360, 390]) {
    const id = `${language}-${theme}-${width}`;
    console.log(`GROUP_RECALL_WEB ${id}`);
    const t = JSON.parse(await readFile(join(artifactAudit.packedRoot, 'locale', `${language}.json`), 'utf8')).ui;
    const context = await browser.newContext({ viewport: wide, colorScheme: theme,
      locale: language === 'en' ? 'en-US' : 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(16000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const shot = async name => page.screenshot({ path: join(screenshots, `${id}-${name}.png`), animations: 'disabled' });
    const openMemory = async () => {
      await page.setViewportSize(wide);
      await openBotsPanel(page, t['bots.title']);
      const bots = page.locator('[data-bots-page]:visible');
      const detail = bots.locator(`[data-bot-detail="${alpha.botId}"]:visible`);
      if (!await detail.isVisible()) await bots.getByRole('button', { name: `${t['chat.profile']} · ${alpha.botId}`, exact: true }).click();
      await detail.getByRole('tab', { name: t['detail.memory'], exact: true }).click();
      const section = detail.getByRole('region', { name: t['groupRecall.title'], exact: true });
      await section.waitFor();
      return section;
    };
    const draftInMain = async expectedIdentity => {
      await page.locator(native(mainSessionId)).waitFor();
      const composer = page.locator('[contenteditable="true"]:visible').first();
      await composer.waitFor();
      await until(async () => (await composer.innerText()).includes(JSON.stringify(expectedIdentity)), 'native draft identity');
      const text = await composer.innerText();
      assert.match(text, /bot_group_recall/);
      assert.ok(!text.includes(question.text) && !text.includes(answer.text), 'Draft copied source transcript');
      return composer;
    };
    try {
      await installOverlayHandler(page, () => {});
      await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'group-recall-web');
      let section = await openMemory();
      await section.getByRole('button', { name: t['groupRecall.more'], exact: true }).waitFor();
      assert.equal(await section.getByRole('listitem').count(), 3);
      assert.ok((await section.innerText()).includes(original.groupName));
      await page.setViewportSize({ width, height: width === 390 ? 844 : wide.height });
      const search = section.getByRole('searchbox', { name: t['groupRecall.search'], exact: true });
      await search.scrollIntoViewIfNeeded();
      await shot('memory');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const overflow = await section.locator('input:visible, button:visible, summary:visible').evaluateAll(elements =>
        elements.some(element => { const box = element.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1; }));
      assert.equal(overflow, false);
      const themeTokens = await tokens(page);
      assert.equal(themeTokens.locale.startsWith(language), true);
      assert.equal(themeTokens.dark, theme === 'dark');
      assert.ok(themeTokens.background);
      const showMore = section.getByRole('button', { name: t['groupRecall.more'], exact: true });
      await showMore.click();
      await until(async () => (await section.getByRole('listitem').count()) === 4, 'four recalled deliveries');
      await search.fill('验收通过');
      await section.getByRole('button', { name: t['memory.searchAction'], exact: true }).click();
      const recalled = section.getByRole('listitem').filter({ hasText: question.text });
      await recalled.waitFor();
      assert.equal(await section.getByRole('listitem').count(), 1);
      await recalled.getByText(t['groupRecall.excerpts'], { exact: true }).click();
      await recalled.getByText(answer.text, { exact: true }).waitFor();
      await recalled.scrollIntoViewIfNeeded();
      await shot('source-excerpt');
      if (id === 'en-light-1360' || id === 'zh-dark-390') {
        await probe(id, 'read-only');
        await recalled.getByRole('button', { name: t['groupRecall.open'], exact: true }).click();
        await page.locator(native(rootSessionId)).waitFor();
        await page.waitForFunction(({ expectedGroup, messageId }) => {
          const focused = document.activeElement;
          return focused?.getAttribute('data-workspace-group') === expectedGroup
            && focused.getAttribute('data-workspace-group-message') === messageId;
        }, { expectedGroup: `${group.groupId}:${group.groupCreatedAt}`, messageId: question.messageId });
        await page.waitForFunction(id => {
          const focused = document.activeElement;
          if (focused?.getAttribute('data-workspace-group-message') !== id) return false;
          const rect = (focused.querySelector('[data-group-author]') ?? focused).getBoundingClientRect();
          return rect.top >= 80 && rect.bottom <= innerHeight - 120;
        }, question.messageId);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await shot('original-group');
        await probe(id, 'original-group');

        section = await openMemory();
        await section.getByRole('searchbox', { name: t['groupRecall.search'], exact: true }).fill('验收通过');
        await section.getByRole('button', { name: t['memory.searchAction'], exact: true }).click();
        await section.getByRole('listitem').filter({ hasText: question.text })
          .getByRole('button', { name: t['groupRecall.remember'], exact: true }).click();
        const remember = await draftInMain({ group, turnId: original.turnId, deliveryId: original.deliveryId,
          sessionId: answer.sessionId, messageId: answer.messageId, seq: answer.seq });
        await shot('remember-draft');
        await probe(id, 'remember-draft');
        await remember.press('ControlOrMeta+A'); await remember.press('Backspace');

        await openSidebarSession(page, rootSessionId);
        await page.getByRole('tab', { name: t['groups.manage'], exact: true }).click();
        await page.getByRole('tab', { name: t['groups.view.members'], exact: true }).click();
        await page.locator(`[data-group-member="${oldMember}"]`).getByRole('button',
          { name: label(t, 'execution.memberActions', { name: alpha.botId }), exact: true }).click();
        await page.getByRole('menuitem', { name: t['groups.askInChat'], exact: true }).click();
        const ask = await draftInMain({ group, turnId: latest.turnId, deliveryId: latest.deliveryId,
          sessionId: rootSessionId, messageId: latest.messageId, seq: latest.seq });
        await shot('direct-ask-draft');
        await probe(id, 'direct-ask-draft');
        await ask.press('ControlOrMeta+A'); await ask.press('Backspace');
      }
      assert.deepEqual(errors, []);
      evidence.push({ id, language, theme, width, themeTokens, initialRows: 3, expandedRows: 4, searchRows: 1, errors });
      await writeEvidence();
    } catch (error) {
      await Promise.allSettled([shot('failure'), page.locator('body').ariaSnapshot({ timeout: 3000 })
        .then(tree => writeFile(join(dir, `${id}-failure-tree.yml`), tree))]);
      throw error;
    } finally { await context.close(); }
  }
  assert.equal(evidence.length, 8);
  assert.equal(browserWorkflow.length, 8);
  assert.notEqual(evidence.find(item => item.theme === 'light').themeTokens.background,
    evidence.find(item => item.theme === 'dark').themeTokens.background);
  assert.equal(host.requests(), 0);
  await assert.rejects(readFile(join(dir, 'network-denials.jsonl')), { code: 'ENOENT' });
  await probe('final', 'no-send');
  await writeEvidence();
  console.log(`PASS ${artifactAudit.sha256}: 8 browser layouts, exact source and native drafts; unchanged native input, memory and model counts`);
} finally {
  try { await browser?.close(); } finally { await host?.stop(); }
}
