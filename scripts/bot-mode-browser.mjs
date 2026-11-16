import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

const root = process.cwd(), base = resolve(root, process.env.DSH_BOT_APPROVAL_DIR ?? '.dsh-dev/bot-mode-approval');
assert.ok(base.startsWith(`${root}/.dsh-dev/`));
const dir = resolve(root, '.dsh-dev/bot-mode-browser', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
process.env.TMPDIR = resolve(base, 'tmp');
await mkdir(process.env.TMPDIR, { recursive: true });
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const state = await json(resolve(base, 'service.json'));
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
const executablePath = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
  .flatMap(name => ['arm64', 'x64'].map(arch => resolve(cache, name, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'))).find(existsSync);
assert.ok(executablePath, 'Cached Chromium required; no global install');
const checks = [], errors = [], screenshots = [], responseChecks = [];
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); };
const waitFor = async (name, test, timeout = 45000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { try { if (await test()) return; } catch { /* atomic native JSON save may be in progress */ } await delay(100); }
  throw new Error(`Timed out: ${name}`);
};
const works = () => json(resolve(base, 'work-state.json'));
const previousWorkIds = new Set((await works()).map(row => row.work.id));
const fixture = await json(resolve(base, 'fixture.json'));
const provenance = await json(resolve(base, 'client-provenance.json'));
const expected = {};
for (const [id, resource] of Object.entries(provenance)) {
  const bytes = await readFile(resource.path); assert.equal(createHash('sha256').update(bytes).digest('hex'), resource.sha256);
  expected[id] = bytes.toString().trimEnd().replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*$/u, '').trimEnd();
}
let browser, page, phase = 'boot', workflowDone = false;
const step = name => { phase = name; console.log(JSON.stringify({ phase })); };
try {
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true,
    env: { ...process.env, TMPDIR: resolve(base, 'tmp'), XDG_STATE_HOME: resolve(base, 'state') } });
  for (const [language, theme, width] of [['zh', 'light', 1360], ['en', 'dark', 390], ['zh', 'dark', 1360], ['en', 'light', 390]]) {
    step(`${language}/${theme}/${width}:open`);
    const context = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', colorScheme: theme, viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(45000);
    page.on('pageerror', error => errors.push(redact(error.stack ?? error)));
    const bodies = [];
    page.on('response', response => { if (new URL(response.url()).pathname === '/plugins/' && /javascript/.test(response.headers()['content-type'] ?? '')) void response.text().then(text => bodies.push(text)).catch(() => {}); });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await installOverlayHandler(page, () => {});
    await page.goto(state.url, { waitUntil: 'domcontentloaded' }); await dismissFirstRunOverlays(page, () => {}, 'bot-mode-browser');
    step(`${language}/${theme}/${width}:sidebar`);
    const sidebar = page.locator('[data-bot-mode-sidebar]');
    const objects = sidebar.getByRole('navigation');
    if (width < 640) {
      if (await sidebar.getAttribute('data-collapsed') !== null) {
        const toggles = await page.getByRole('button', { name: /Show or hide Bots and groups|展开或收起 Bot 和群列表/ }).all();
        const visible = []; for (const toggle of toggles) if (await toggle.isVisible()) visible.push(toggle);
        assert.ok(visible.length, 'Collapsed shell exposes object-list toggle'); await visible[0].click();
      }
    }
    await sidebar.waitFor();
    await objects.getByRole('button', { name: /^通用助手/ }).first().waitFor();
    step(`${language}/${theme}/${width}:select-bot`);
    await objects.getByRole('button', { name: /^通用助手/ }).first().click();
    const chat = page.locator('[data-bot-mode-object="bot"]'); await chat.waitFor();
    await waitFor('selected exact assistant title', async () => await chat.locator('[data-bot-mode-title]').textContent() === '通用助手');
    if (width < 700) await objects.getByRole('button', { name: /^通用助手/ }).first().waitFor({ state: 'hidden' });
    const composer = chat.locator('[contenteditable="true"]:visible').first(); await composer.waitFor();
    step(`${language}/${theme}/${width}:provenance`);
    await waitFor('actual frozen Client resources', () => Object.values(expected).every(contents => bodies.some(body => body.includes(contents))), 15000);
    for (const [id, contents] of Object.entries(expected)) check(`${language}/${theme}/${width}: actual response matches ${id} frozen Client`, bodies.some(body => body.includes(contents)));
    responseChecks.push({ language, theme, width, packages: Object.keys(expected) });
    check(`${language}/${theme}/${width}: Bot shell and native composer visible`, await composer.isVisible());
    check(`${language}/${theme}/${width}: no New Session button`, await page.getByRole('button', { name: /^(新建会话|New Session)$/ }).count() === 0);
    const shot = async name => { await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true, animations: 'disabled' }); screenshots.push(`${name}.png`); };
    await shot(`${language}-${theme}-${width}-bot`);
    if (!workflowDone) {
      workflowDone = true;
      step('native-commands-and-drafts');
      const selected = fixture.sessions['local-assistant'];
      await page.keyboard.press('Meta+Alt+K');
      check('native search shortcut focuses Bot search', await sidebar.getByRole('textbox').evaluate(node => node === document.activeElement));
      await sidebar.getByRole('textbox').fill('不存在的对象-唯一'); check('search filters objects', await objects.getByRole('button', { name: /^通用助手/ }).count() === 0);
      await sidebar.getByRole('textbox').fill('');
      await composer.fill('未发送的独立草稿');
      await objects.getByRole('button', { name: /^研究员/ }).first().click();
      await page.waitForFunction(() => document.querySelector('[data-bot-mode-object="bot"] [data-bot-mode-title]')?.textContent === '研究员');
      check('other Bot has separate native draft', (await page.locator('[contenteditable="true"]:visible').first().textContent()) !== '未发送的独立草稿');
      await objects.getByRole('button', { name: /^通用助手/ }).first().click(); await waitFor('restored draft', async () => (await composer.textContent()).includes('未发送的独立草稿'));
      check('switching Bot preserves exact original draft'); await composer.fill('');
      await page.keyboard.press('Meta+Shift+F'); await page.keyboard.press('Meta+Alt+A');
      check('Fork and Archive do not leave or archive Bot conversation', await chat.isVisible());
      await page.keyboard.press('Meta+Alt+N');
      await page.getByRole('dialog').waitFor(); check('New shortcut opens existing Bot creation form');
      await page.getByRole('dialog').getByRole('button', { name: /^(取消|Cancel)$/ }).click();
      await objects.getByRole('button', { name: /^通用助手/ }).first().click(); await composer.waitFor();
      step('simple-request');
      await composer.fill('你好'); await composer.press('Enter');
      await page.getByText('你好，这是独立的 Bot 模式审批服务。', { exact: false }).last().waitFor();
      check('native per-message Branch action is absent', await chat.getByRole('button', { name: /在新对话中分支|Branch in new conversation/i }).count() === 0);
      check('simple greeting creates no work', (await works()).length === previousWorkIds.size);
      step('automatic-collaboration');
      await composer.fill(`方案验收 ${Date.now()}：请评估下面的项目方案，先做小范围验证，再分阶段上线。比较实施成本、风险和验收步骤。`); await composer.press('Enter');
      await waitFor('completed automatic work', async () => (await works()).some(row => !previousWorkIds.has(row.work.id) && ['completed', 'partial'].includes(row.work.state)), 90000);
      const work = (await works()).find(row => !previousWorkIds.has(row.work.id) && ['completed', 'partial'].includes(row.work.state));
      check('automatic group exists and original Bot remains selected', work.group && await chat.isVisible());
      check('expert joined the same work before delivery', work.group.members.filter(member => member.enabled && member.removedAt === undefined).length >= 3);
      await page.getByText('【本地演示】本次协作已完成。', { exact: false }).last().waitFor(); check('result returned to original Bot');
      await shot('zh-light-1360-original-delivery');
      const older = sidebar.locator('summary').filter({ hasText: '更早的群' });
      if (await older.isVisible().catch(() => false) && !await older.evaluate(node => node.parentElement.open)) await older.click();
      await objects.getByRole('button', { name: new RegExp(`^${work.group.group.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first().click();
      const groupChat = page.locator('[data-bot-mode-object="group"]'); await groupChat.waitFor();
      await groupChat.getByText('研究员', { exact: true }).first().waitFor(); check('group displays actual named Bot messages');
      check('collaboration quote labels are checked only for an actual marked Supergroup', Boolean(work.group.group.supergroup));
      const collaborationQuotes = work.group.messages.filter(message => message.replyTo && work.group.messages.some(source => source.id === message.replyTo && source.authorKind === 'proactive'));
      check('actual Supergroup contains references to its shared task input', collaborationQuotes.length > 0);
      for (const message of collaborationQuotes) {
        const quote = groupChat.locator(`[data-group-message="${message.id}"] blockquote`); await quote.waitFor();
        check('real Supergroup task quote uses collaboration source label', await quote.getByText('协作任务', { exact: true }).isVisible()
          && await quote.getByText('主动 CI 审阅', { exact: true }).count() === 0);
      }
      await groupChat.locator(`[data-group-message="${collaborationQuotes[0].id}"] blockquote`).scrollIntoViewIfNeeded();
      await shot('zh-light-1360-collaboration-source-label');
      for (const message of work.group.messages.filter(row => row.speaker)) {
        const rendered = groupChat.locator(`[data-group-message="${message.id}"]`);
        await rendered.waitFor();
        check(`real group author ${message.speaker.name} retains message and Bot avatar identity`, (await rendered.textContent()).includes(message.speaker.name) && await rendered.locator(`[data-bot-id="${message.speaker.bot.botId}"]`).count() > 0);
      }
      const expertRequests = work.group.messages.filter(message => message.authorKind === 'bot' && message.stopReason === 'expert-request' && message.causeId?.startsWith('expert-request:'));
      check('real group contains an authoritatively marked expert request', expertRequests.length > 0);
      for (const message of expertRequests) {
        const process = groupChat.locator(`[data-group-expert-request="${message.id}"]`); await process.waitFor();
        check('actual expert-request metadata is folded by default', await process.evaluate(node => node.tagName === 'DETAILS' && !node.open) && !await process.locator('code').isVisible());
        await shot('zh-light-1360-expert-request-folded');
        await process.locator('summary').click();
        check('expanding expert-request preserves complete actual parameters', await process.locator('code').isVisible() && await process.locator('code').textContent() === message.text);
        await shot('zh-light-1360-expert-request-expanded'); await process.locator('summary').click();
      }
      for (const message of work.group.messages.filter(row => row.speaker && !(row.authorKind === 'bot' && row.stopReason === 'expert-request' && row.causeId?.startsWith('expert-request:')))) {
        const rendered = groupChat.locator(`[data-group-message="${message.id}"]`);
        check(`ordinary real message by ${message.speaker.name} remains visible`, await rendered.locator('[data-group-expert-request]').count() === 0 && await rendered.getByText(message.text, { exact: true }).last().isVisible());
      }
      const groupComposer = groupChat.locator('textarea:visible').first(); await groupComposer.waitFor();
      step('group-human-input');
      await groupComposer.fill('请补充具体的成本核对步骤。'); await groupChat.getByRole('button', { name: '发送', exact: true }).click();
      await waitFor('group input and delivery receipt', async () => (await works()).some(row => row.work.id === work.work.id && row.work.groupInputs.some(input => input.state === 'completed' && input.delivery?.state === 'delivered')), 90000);
      const after = (await works()).find(row => row.work.id === work.work.id);
      check('group input continues same work and group', after.work.group.groupId === work.work.group.groupId && (await works()).length === previousWorkIds.size + 1);
      check('real group user input has a checked delivery receipt', after.work.groupInputs[0].messageId && after.work.groupInputs[0].delivery.answerMessageId);
      const ordinaryJson = JSON.stringify({ note: '普通人类 JSON 原样保留，不是专家请求' });
      await groupComposer.fill(ordinaryJson); await groupChat.getByRole('button', { name: '发送', exact: true }).click();
      await waitFor('ordinary JSON group input and delivery receipt', async () => {
        const current = (await works()).find(row => row.work.id === work.work.id);
        return current?.group.messages.some(message => message.authorKind === 'user' && message.text === ordinaryJson)
          && current.work.groupInputs.length >= 2 && current.work.groupInputs.at(-1).state === 'completed' && current.work.groupInputs.at(-1).delivery?.state === 'delivered';
      }, 90000);
      const ordinaryMessage = (await works()).find(row => row.work.id === work.work.id).group.messages.find(message => message.authorKind === 'user' && message.text === ordinaryJson);
      const ordinaryCard = groupChat.locator(`[data-chat-flow-kind="user"][data-chat-node-key$="${ordinaryMessage.id}"]`); await ordinaryCard.waitFor();
      await ordinaryCard.scrollIntoViewIfNeeded();
      check('ordinary human JSON is real group input and remains visible', await ordinaryCard.getByText(ordinaryJson, { exact: true }).isVisible() && await ordinaryCard.locator('[data-group-expert-request]').count() === 0);
      await shot('zh-light-1360-ordinary-human-json');
      await groupChat.locator('[data-bot-mode-details]').click();
      const details = page.locator('[data-bot-mode-details-panel]'); await details.waitFor();
      await details.getByRole('button', { name: '资料', exact: true }).click();
      await details.getByText('请补充具体的成本核对步骤。', { exact: true }).waitFor();
      check('materials contains the real group input and member results', await details.getByRole('button', { name: /成果|Result/ }).count() > 0);
      await shot('zh-light-1360-group-materials');
      await details.getByRole('button', { name: '成员', exact: true }).click();
      await details.getByText('技术专家', { exact: true }).first().waitFor(); check('member details includes invited expert');
      await objects.getByRole('button', { name: /^通用助手/ }).first().click(); await chat.waitFor();
      await page.getByText('【本地演示】已收到群内补充和协作结果', { exact: false }).last().waitFor(); check('group revision result reaches original Bot');
      await page.reload({ waitUntil: 'domcontentloaded' }); await sidebar.waitFor(); await chat.waitFor();
      check('reload restores exact Bot object', await chat.locator('[data-bot-mode-title]').textContent() === '通用助手');
      check('main session identity retained', (await json(resolve(base, 'fixture.json'))).sessions['local-assistant'] === selected);
      step('continue-from-original-bot');
      const beforeContinue = (await works()).find(row => row.work.id === work.work.id).work.inputMessageIds.length;
      await composer.fill('继续细化验收步骤。'); await composer.press('Enter');
      await waitFor('same work continued from original Bot', async () => {
        const rows = await works(), current = rows.find(row => row.work.id === work.work.id);
        return rows.length === previousWorkIds.size + 1 && current?.work.inputMessageIds.length === beforeContinue + 1 && ['completed', 'partial'].includes(current.work.state);
      }, 90000);
      check('original Bot continuation reuses the same work and group');
      step('stop-whole-work');
      const beforeStop = new Set((await works()).map(row => row.work.id));
      await composer.fill('停止验收：请分析另一个独立上线方案并安排协作。'); await composer.press('Enter');
      await waitFor('new work running', async () => (await works()).some(row => !beforeStop.has(row.work.id) && row.work.state === 'running'));
      const stopWork = (await works()).find(row => !beforeStop.has(row.work.id));
      await chat.locator(`[data-supergroup-work="${stopWork.work.id}"]`).getByRole('button', { name: '停止协作', exact: true }).click();
      await waitFor('whole work cancelled', async () => (await works()).some(row => row.work.id === stopWork.work.id && row.work.state === 'cancelled'));
      check('Stop cancels the whole automatic collaboration');
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(dir, 'result.json'), JSON.stringify({ status: 'PASS', checks, screenshots, responseChecks, errors, realModelRequests: 0 }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', dir, checks: checks.length, screenshots, realModelRequests: 0 }));
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(dir, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {}); await page.content().then(html => writeFile(resolve(dir, 'failure.html'), html)).catch(() => {}); }
  await writeFile(resolve(dir, 'result.json'), JSON.stringify({ status: 'FAIL', phase, error: redact(error.stack ?? error), checks, screenshots, responseChecks, errors }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', dir, phase, error: redact(error) })); process.exitCode = 1;
} finally { await browser?.close(); }
