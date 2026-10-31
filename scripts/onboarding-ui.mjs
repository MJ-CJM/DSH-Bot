import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { openSidebarSession, openBotsPanel } from './deepening/sidebar-session.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const artifactPath = process.env.DSH_BOT_ARTIFACT ? resolve(root, process.env.DSH_BOT_ARTIFACT) : undefined;
const dir = resolve(root, '.dsh-dev/onboarding-ui', `${Date.now()}-${process.pid}`); await mkdir(dir, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json')), { chromium } = require('playwright-core');
const allMatrix = ['en', 'zh'].flatMap(language => ['light', 'dark'].flatMap(theme => [1360, 390].map(width => ({ language, theme, width }))));
const ids = process.env.FILTER?.split(',').filter(Boolean);
if (ids) assert.ok(ids.every(id => allMatrix.some(item => `${item.language}-${item.theme}-${item.width}` === id)));
const matrix = ids ? allMatrix.filter(item => ids.includes(`${item.language}-${item.theme}-${item.width}`)) : allMatrix;
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
let host, browser, phase = 'host'; const results = [], pageErrors = [];
const calls = async () => (await readFile(resolve(dir, 'ui-model-calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
const until = async check => {
  const deadline = Date.now() + 20000;
  for (;;) {
    const error = await readFile(resolve(dir, 'onboarding-ui-error.json'), 'utf8').catch(() => ''); assert.equal(error, '', error);
    const result = await check(); if (result) return result;
    assert.ok(Date.now() < deadline, 'Onboarding UI condition timed out'); await delay(40);
  }
};
let artifact;
try {
  artifact = { version: JSON.parse(await readFile(resolve(root, 'packages/dsh-bot/package.json'), 'utf8')).version,
    clientSha256: createHash('sha256').update(await readFile(resolve(root, 'packages/dsh-bot/lib/client.js'))).digest('hex') };
  host = await webHost(dir, 'onboarding-ui', artifactPath, resolve(root, 'packages/dsh-bot/tests/onboarding-ui-profile.mjs'));
  if (artifactPath) {
    const manifest = JSON.parse(await readFile(resolve(dir, 'artifact-manifest.json'), 'utf8'));
    artifact = { ...artifact, tarball: manifest.artifact, sha256: manifest.sha256, installedBytesVerified: true };
  }
  const fixture = await until(() => readFile(resolve(dir, 'onboarding-ui-fixture.json'), 'utf8').then(JSON.parse).catch(() => undefined));
  assert.equal((await calls()).filter(call => call.onboarding).length, 0, 'Legacy fixtures must not trigger onboarding');
  const cache = resolve(homedir(), 'Library/Caches/ms-playwright'), releases = await readdir(cache).catch(() => []);
  const executablePath = process.env.DSH_BOT_CHROMIUM ?? releases.filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync)
    ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = host.env.TMPDIR;
  try { browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: host.env, timeout: 30000 }); }
  finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
  phase = 'matrix';
  for (const item of matrix) {
    const { language, theme, width } = item, id = `${language}-${theme}-${width}`;
    const t = JSON.parse(await readFile(resolve(root, `packages/dsh-bot/locale/${language}.json`), 'utf8')).ui;
    const context = await browser.newContext({ colorScheme: theme, locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => pageErrors.push(redact(error)));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const checks = [], screenshots = [], receipts = []; let probeSerial = 0;
    const check = (name, value = true) => { assert.ok(value, `${id}: ${name}`); checks.push(name); };
    const shot = async state => {
      check(`${state}: no viewport overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const colors = await page.evaluate(() => {
        const element = document.createElement('div'); element.style.backgroundColor = 'var(--dsw-alias-bg-base)'; element.style.color = 'var(--dsw-alias-label-primary)';
        document.body.append(element); const style = getComputedStyle(element); const result = { background: style.backgroundColor, color: style.color }; element.remove(); return result;
      });
      const rgb = colors.background.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      check(`${state}: theme tokens reflect ${theme}`, rgb?.length === 3 && (theme === 'dark' ? rgb.reduce((a,b) => a+b,0) < 384 : rgb.reduce((a,b) => a+b,0) > 384));
      const file = `${id}-${state}.png`; await page.screenshot({ path: resolve(dir, file), fullPage: true }); screenshots.push({ file, state, colors });
    };
    const openNative = async sessionId => {
      await page.setViewportSize({ width: 1360, height: 1000 }); await openSidebarSession(page, sessionId);
      await page.locator(`[data-conversation-content][data-conversation-session="${sessionId}"]:visible`).waitFor();
      await page.setViewportSize({ width, height: 1000 });
    };
    const probe = async (sessionId, stage) => {
      const key = `${id}-${++probeSerial}`;
      await writeFile(resolve(dir, 'onboarding-probe-request.json'), JSON.stringify({ id: key, sessionId }));
      const result = await until(() => readFile(resolve(dir, `onboarding-probe-${key}.json`), 'utf8').then(JSON.parse).catch(() => undefined));
      receipts.push({ stage, ...result }); return result;
    };
    try {
      await installOverlayHandler(page, () => {}); await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'onboarding-ui');
      await openBotsPanel(page, t['bots.title']);
      let bots = page.locator('[data-bots-page]:visible'); await bots.locator('button[data-bot-id="v063-empty-whale"]').waitFor();
      await bots.locator('button[data-bot-id="v063-empty-whale"]').click();
      const blank = fixture.sessions['v063-empty-whale'];
      await page.locator(`[data-conversation-content][data-conversation-session="${blank}"]:visible`).waitFor();
      await page.locator('[data-bot-composer-identity] [data-bot-avatar]').waitFor();
      check('empty Bot has its own avatar above the native composer');
      const empty = await probe(blank, 'empty-main'); check('empty native conversation has no model requests', empty.requests === 0 && empty.inputs.length === 0);
      await page.setViewportSize({ width, height: 1000 }); await shot('empty-bot-avatar');
      await openNative(fixture.sessions['v063-active-whale']);
      await page.locator(`[data-row-key="session:${fixture.sessions['v063-active-whale']}"] [data-bot-avatar]`).waitFor({ state: 'attached' });
      await page.getByRole('button', { name: t['badge.open'].replace('{name}', 'Active Whale'), exact: true }).locator('[data-bot-avatar]').waitFor();
      check('ordinary Bot conversation has its own sidebar and header avatar');
      await shot('active-bot-avatar');
      const activeSession = fixture.sessions['v063-active-whale'];
      const roleBefore = await probe(activeSession, 'role-before');
      const expectedRole = roleBefore.bot.persona.prefix; assert.ok(expectedRole);
      const openActiveRole = async () => {
        await page.setViewportSize({ width: 1360, height: 1000 });
        await page.getByRole('button', { name: t['badge.open'].replace('{name}', 'Active Whale'), exact: true }).click();
        const detail = page.locator('[data-bot-detail="v063-active-whale"]:visible'); await detail.waitFor();
        const role = detail.locator('[data-bot-persona="v063-active-whale"]');
        const expand = role.getByText(t['persona.expand'], { exact: true });
        if (await expand.isVisible()) await expand.click();
        await role.getByText(expectedRole, { exact: true }).waitFor();
        return role;
      };
      let role = await openActiveRole();
      check('Bot details show the complete committed lasting-role prefix', await role.locator('p').textContent() === expectedRole);
      await page.setViewportSize({ width, height: 1000 });
      check('all Bot detail actions fit inside the dialog', await role.locator('xpath=ancestor::dialog[1]').evaluate(dialog => {
        const bounds = dialog.getBoundingClientRect();
        return Array.from(dialog.querySelectorAll('button, summary')).filter(element => element.checkVisibility()).every(element => {
          const box = element.getBoundingClientRect(); return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
        });
      }));
      await shot('current-role');
      await role.getByRole('button', { name: t['persona.edit'], exact: true }).click();
      await page.locator(`[data-conversation-content][data-conversation-session="${activeSession}"]:visible`).waitFor();
      let roleComposer = page.locator('[contenteditable="true"]:visible').first(); await roleComposer.waitFor();
      const draftText = async () => (await roleComposer.innerText()).replace(/\u00a0/g, ' ').trim();
      await until(async () => (await draftText()) === t['persona.prompt'].trim());
      const roleDraft = await probe(activeSession, 'role-draft');
      check('Change role in chat initializes the native draft without sending or saving',
        roleDraft.requests === roleBefore.requests && roleDraft.inputs.length === roleBefore.inputs.length && roleDraft.bot.persona.prefix === expectedRole);
      await shot('role-draft');
      const retainedDraft = `ONBOARDING_UI_KEEP_DRAFT ${id}`;
      await roleComposer.fill(retainedDraft);
      role = await openActiveRole();
      await page.setViewportSize({ width, height: 1000 });
      await role.getByRole('button', { name: t['persona.edit'], exact: true }).click();
      await page.locator(`[data-conversation-content][data-conversation-session="${activeSession}"]:visible`).waitFor();
      roleComposer = page.locator('[contenteditable="true"]:visible').first(); await roleComposer.waitFor();
      await until(async () => (await draftText()) === retainedDraft);
      const preservedDraft = await probe(activeSession, 'role-draft-preserved');
      check('Change role in chat preserves an existing native draft and does not send',
        preservedDraft.requests === roleBefore.requests && preservedDraft.inputs.length === roleBefore.inputs.length && preservedDraft.bot.persona.prefix === expectedRole);
      await shot('role-draft-preserved');
      await roleComposer.click(); await roleComposer.press('ControlOrMeta+A'); await roleComposer.press('Backspace');
      await until(async () => (await draftText()) === '');
      check('role draft is cleared through the native editor before subsequent cases');
      await openNative(fixture.sessions['v063-empty-emoji']);
      check('custom emoji Bot sidebar retains its chosen avatar', (await page.locator(`[data-row-key="session:${fixture.sessions['v063-empty-emoji']}"] [data-bot-avatar]`).textContent())?.includes('🦉'));
      await shot('emoji-avatar');
      await openNative(fixture.group.rootSessionId);
      await page.locator(`[data-row-key="session:${fixture.group.rootSessionId}"] [data-group-avatar="whales"]`).waitFor({ state: 'attached' });
      const groupHeader = page.getByRole('button', { name: `${t['groups.manage']} · ${fixture.group.name}`, exact: true });
      await groupHeader.locator('[data-group-avatar="whales"]').waitFor();
      await page.getByRole('textbox', { name: t['groups.message'], exact: true }).waitFor();
      await page.locator('[data-conversation-content]:visible').getByText(language === 'zh' ? '加载历史记录中...' : 'Loading history...', { exact: true }).waitFor({ state: 'hidden' });
      check('group sidebar and header both use composite whales');
      await shot('group-whales');
      await page.setViewportSize({ width: 1360, height: 1000 }); await openBotsPanel(page, t['bots.title']); bots = page.locator('[data-bots-page]:visible');
      const recent = bots.getByRole('button', { name: t['chat.recent'], exact: true }); if (await recent.isVisible()) await recent.click();
      const newMenu = bots.locator(`summary[aria-label="${t['chat.new']}"]`);
      if (!await newMenu.evaluate(element => element.parentElement.open)) await newMenu.press('Enter');
      await bots.getByRole('button', { name: t['bots.create'], exact: true }).click();
      const create = bots.locator('dialog:visible'); check('creation still needs only one visible input', await create.locator('input:visible').count() === 1);
      const name = `${language === 'zh' ? '论文助手' : 'Research assistant'} ${id}`;
      await create.getByRole('textbox', { name: t['editor.name'], exact: true }).fill(name);
      await page.setViewportSize({ width, height: 1000 }); await shot('create');
      const [response] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/dshBot/createForChat')),
        create.getByRole('button', { name: t['chat.createAndChat'], exact: true }).click()]);
      const creation = await response.json(); check('dedicated native createForChat succeeds', creation.result?.ok === true);
      await create.waitFor({ state: 'hidden' });
      const chat = page.locator('[data-conversation-content][data-conversation-session]:visible'); await chat.waitFor();
      const sessionId = await chat.getAttribute('data-conversation-session'); assert.ok(sessionId);
      const greeting = language === 'zh' ? '我是论文助手，可以协助整理文献和研究进展。你希望我先关注哪个方向？'
        : 'I can help organize papers and research updates. What would you like me to focus on first?';
      await chat.getByText(greeting, { exact: true }).waitFor();
      const initial = await until(async () => {
        const receipt = await probe(sessionId, 'greeted');
        return receipt.status?.state === 'completed' ? receipt : undefined;
      });
      const notice = chat.locator('[data-bot-onboarding-notice]');
      await notice.waitFor({ state: 'attached' });
      const noticeTurn = await notice.locator('xpath=ancestor::*[@data-chat-turn][1]').getAttribute('data-chat-turn');
      assert.ok(noticeTurn);
      const processToggle = chat.locator(`button[data-turn-process="${noticeTurn}"]`);
      // The native disclosure appears only after the Client has rendered turn/end.
      // Host completion alone can precede that render. Establish an explicit open
      // choice, rather than relying on the temporary live-process default.
      await processToggle.waitFor();
      if (await processToggle.getAttribute('aria-expanded') === 'true') {
        await processToggle.click();
        await until(async () => await processToggle.getAttribute('aria-expanded') === 'false');
      }
      await processToggle.click();
      await until(async () => await processToggle.getAttribute('aria-expanded') === 'true');
      const step = notice.locator('xpath=ancestor::*[@data-step-process][1]');
      if (await step.count()) {
        const innerToggle = step.locator(':scope > div > button[data-process-activity]');
        if (await innerToggle.count() && await innerToggle.getAttribute('aria-expanded') === 'false') await innerToggle.click();
      }
      await notice.waitFor();
      check('completed introduction source is visible through native process disclosure');
      await page.locator('[contenteditable="true"]:visible').first().waitFor(); check('native composer stays usable');
      check('greeting is an assistant event after one distinct onboarding source', initial.inputs.filter(input => input.source.kind === 'dsh-bot-onboarding').length === 1 && initial.replies.length === 1);
      check('greeting inserts no user source and saves no guessed persona', initial.inputs.every(input => input.source.kind !== 'user') && initial.bot.persona.prefix === '');
      check('greeting calls selected native model exactly once in this synthetic fixture', initial.requests === 1 && (await calls()).filter(call => call.sessionId === sessionId).length === 1);
      await shot('greeting');
      await openNative(fixture.group.rootSessionId); await openNative(sessionId);
      await page.reload({ waitUntil: 'domcontentloaded' }); await dismissFirstRunOverlays(page, () => {}, 'onboarding-reload');
      await openNative(sessionId);
      await chat.getByText(greeting, { exact: true }).waitFor();
      const reopened = await probe(sessionId, 'reopened');
      check('switch and browser reload preserve a single greeting request', reopened.requests === 1 && reopened.inputs.filter(input => input.source.kind === 'dsh-bot-onboarding').length === 1);
      const composer = page.locator('[contenteditable="true"]:visible').first();
      await composer.fill('ONBOARDING_UI_FIRST_TASK'); await composer.press('Enter');
      await chat.getByText('ONBOARDING_UI_TASK_RECEIVED', { exact: true }).waitFor();
      const after = await probe(sessionId, 'user-task');
      check('first real user input continues the same native conversation', after.inputs.filter(input => input.source.kind === 'user').length === 1 && after.requests === 2 && after.replies.length === 2);
      check('one-time task has not changed the lasting persona', after.bot.persona.prefix === '');
      await shot('first-task');
      results.push({ ...item, status: 'PASS', checks, screenshots, receipts });
      await writeFile(resolve(dir, 'progress.json'), JSON.stringify(results, null, 2));
    } catch (error) {
      await page.screenshot({ path: resolve(dir, `${id}-failure.png`), fullPage: true }).catch(() => {});
      await writeFile(resolve(dir, `${id}-failure-aria.txt`), redact(await page.locator('body').ariaSnapshot()));
      results.push({ ...item, status: 'FAIL', checks, screenshots, receipts, error: redact(error) }); throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'PASS', coverage: ids ? 'filtered-debug' : 'full',
    results, pageErrors, modelCalls: await calls(), loopbackRequests: host.requests(), realModelRequests: 0, artifact,
    chromiumSandbox: true, scope: 'Synthetic model in real isolated Host and browser; content quality is not a real-model evaluation.' }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', dir, cases: results.length, screenshots: results.flatMap(item => item.screenshots).length }));
} catch (error) {
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'FAIL', phase, results, pageErrors, error: redact(error), stack: redact(error.stack), artifact, realModelRequests: 0 }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', dir, phase, error: redact(error) })); process.exitCode = 1;
} finally { await browser?.close(); await host?.stop(); }
