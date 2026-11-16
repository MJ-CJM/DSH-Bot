// Attach to an orchestrator-started Electron. This script never starts/stops an
// app, installs a plugin, changes Host configuration, or calls a real model.
// DSH_BOT_DESKTOP_SMOKE_CONFIG points to a repository JSON file; see --help.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const repoPath = value => {
  const path = resolve(root, value);
  assert.ok(path.startsWith(`${root}/`), 'All smoke configuration/evidence must stay in the repository');
  return path;
};
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const redact = value => String(value).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
if (process.argv.includes('--help')) {
  console.log(JSON.stringify({
    usage: 'DSH_BOT_DESKTOP_SMOKE_CONFIG=.dsh-dev/.../smoke-config.json node scripts/bot-mode-desktop022-smoke.mjs',
    config: {
      mode: 'isolated | daily', cdpEndpoint: 'http://127.0.0.1:PORT', pid: 'actual Electron main PID', executable: 'actual Electron executable path',
      url: 'optional native Host origin used to choose the existing renderer', botId: 'existing Bot id', botName: 'existing Bot display name', sessionId: 'existing exact Bot main session',
      artifact: { path: 'approved .tgz within repo', sha256: 'expected frozen hash' },
      provenance: 'repository client-provenance.json path OR {packageId:{path,sha256}}; requires product, three adapters, original renderer',
      fixtureDir: 'required in isolated mode; contains synthetic fixture/calls/work-state/native-approval JSON',
      out: 'optional repository .dsh-dev output directory',
      keybindings: { new: 'Meta+N', search: 'Meta+K', fork: 'Meta+Alt+F', archive: 'Meta+Shift+A' },
      archiveState: { path: 'optional readable workspace JSON', sessionIdsKey: 'optional dot path to archivedSessionIds array' },
    },
    limits: 'CDP keys exercise the actual Electron renderer and preload. OS menu/deep-link/IME/multi-window behavior needs separate evidence. Daily never fills/sends input or saves settings.',
  }, null, 2));
  process.exit(0);
}
assert.ok(process.env.DSH_BOT_DESKTOP_SMOKE_CONFIG, 'Set DSH_BOT_DESKTOP_SMOKE_CONFIG; use --help for schema');
const config = await json(repoPath(process.env.DSH_BOT_DESKTOP_SMOKE_CONFIG));
assert.ok(['isolated', 'daily'].includes(config.mode));
assert.ok(config.botId && config.botName && config.sessionId, 'An existing exact Bot/session identity is required');
const endpoint = new URL(config.cdpEndpoint);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'CDP must be loopback');
assert.equal(sha(await readFile(repoPath(config.artifact.path))), config.artifact.sha256, 'Frozen approved artifact');
const out = repoPath(config.out ?? `.dsh-dev/bot-mode-desktop022/smoke-${config.mode}-${Date.now()}-${process.pid}`);
assert.ok(out.startsWith(`${root}/.dsh-dev/`));
await mkdir(out, { recursive: true });
const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
const { chromium } = require('playwright-core');
const provenance = typeof config.provenance === 'string' ? await json(repoPath(config.provenance)) : config.provenance;
const required = ['dsh-bot', '@deepseek-ai/dsh-client-shortcuts', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-renderer'];
const expected = {};
for (const id of required) {
  assert.ok(provenance?.[id], `Missing required Client provenance: ${id}`);
  // Paths are read-only and can refer to an installed application/profile.
  const bytes = await readFile(provenance[id].path);
  assert.equal(sha(bytes), provenance[id].sha256, `Installed bytes: ${id}`);
  expected[id] = bytes.toString().trimEnd().replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*$/u, '').trimEnd();
}
let fixture, fixtureDir;
if (config.mode === 'isolated') {
  fixtureDir = repoPath(config.fixtureDir);
  assert.ok(fixtureDir.startsWith(`${root}/.dsh-dev/`));
  fixture = await json(resolve(fixtureDir, 'fixture.json'));
  assert.equal(fixture.synthetic, true); assert.equal(fixture.realModelRequests, 0);
  assert.equal(fixture.supergroupEnabled, true); assert.equal(fixture.sessions[config.botId], config.sessionId);
}
const checks = [], errors = [], screenshots = [], responseProofs = [];
const check = (name, condition = true, detail) => {
  assert.ok(condition, `${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  checks.push({ name, status: 'PASS', ...(detail === undefined ? {} : { detail }) });
  console.log(JSON.stringify({ check: name, status: 'PASS' }));
};
const waitFor = async (name, test, timeout = 45000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await test()) return; } catch {} await delay(100); }
  throw new Error(`Timed out: ${name}`);
};
let browser, page, phase = 'attach';
const shot = async name => { const file = `${name}.png`; await page.screenshot({ path: resolve(out, file), fullPage: true, animations: 'disabled', timeout: 10000 }); screenshots.push(file); };
const archiveSnapshot = async () => {
  if (!config.archiveState) return undefined;
  const data = await json(config.archiveState.path);
  const rows = (config.archiveState.sessionIdsKey ?? 'archivedSessionIds').split('.').reduce((value, key) => value?.[key], data);
  assert.ok(Array.isArray(rows), 'Archive snapshot must select a real archived-session ID array');
  return rows;
};
try {
  const processCommand = execFileSync('/bin/ps', ['-p', String(config.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  check('target PID belongs to supplied actual Electron application', processCommand.startsWith(config.executable), { pid: config.pid, executable: config.executable });
  browser = await chromium.connectOverCDP(config.cdpEndpoint);
  const pages = browser.contexts().flatMap(context => context.pages());
  for (const candidate of pages) {
    if (config.url && new URL(candidate.url()).origin !== new URL(config.url).origin) continue;
    if (await candidate.evaluate(() => Boolean(window.dshDesktop?.keyboard)).catch(() => false)) { page = candidate; break; }
  }
  assert.ok(page, 'Existing renderer with the actual desktop keyboard preload is required; no headless fallback');
  page.setDefaultTimeout(30000);
  check('attached existing actual Electron renderer and native keyboard preload', true, { origin: new URL(page.url()).origin });
  page.on('pageerror', error => errors.push(redact(error.stack ?? error)));
  const bodies = [], pending = new Set();
  page.on('response', response => {
    if (new URL(response.url()).pathname !== '/plugins/' || !/javascript/.test(response.headers()['content-type'] ?? '')) return;
    const promise = response.text().then(body => bodies.push({ body, path: new URL(response.url()).pathname, responseSha256: sha(body) })).catch(() => {}).finally(() => pending.delete(promise));
    pending.add(promise);
  });
  phase = 'native-http-provenance';
  await page.reload({ waitUntil: 'domcontentloaded' });
  const sidebar = page.locator('[data-bot-mode-sidebar]'); await sidebar.waitFor();
  await waitFor('actual native HTTP Client factories', () => required.every(id => bodies.some(row => row.body.includes(expected[id]))), 45000);
  await Promise.all([...pending]);
  for (const id of required) {
    const response = bodies.find(row => row.body.includes(expected[id]));
    check(`actual native Host HTTP contains exact ${id} factory`, Boolean(response));
    responseProofs.push({ id, factorySha256: provenance[id].sha256, responseSha256: response.responseSha256, path: response.path });
  }
  phase = 'bot-navigation';
  if (await sidebar.getAttribute('data-collapsed') !== null) {
    const controls = await page.getByRole('button', { name: /Show or hide Bots and groups|展开或收起 Bot 和群列表/ }).all();
    const visible = []; for (const control of controls) if (await control.isVisible()) visible.push(control);
    assert.ok(visible.length); await visible[0].click();
  }
  const objects = sidebar.getByRole('navigation');
  const select = async () => {
    await objects.getByRole('button', { name: config.botName, exact: true }).first().click();
    await waitFor('exact selected Bot title', async () => await page.locator('[data-bot-mode-object="bot"] [data-bot-mode-title]').textContent() === config.botName);
  };
  await select();
  const chat = page.locator('[data-bot-mode-object="bot"]');
  const composer = chat.locator('[contenteditable="true"]:visible').first(); await composer.waitFor();
  const draftBefore = await composer.textContent();
  const keybindingPreferenceBefore = await page.evaluate(() => localStorage.getItem('dsh.keybindings.v1'));
  const selectedSession = () => chat.locator('[data-conversation-content]').getAttribute('data-conversation-session');
  check('Bot navigation selects the exact existing native session', await selectedSession() === config.sessionId);
  await select(); check('reselecting the same Bot retains its main session', await selectedSession() === config.sessionId);
  check('one Bot settings entry', await sidebar.locator('[data-bot-mode-settings]').count() === 1);
  check('no actionable Session New/Archive surface', await page.getByRole('button', { name: /^(新建会话|New Session|归档会话|Archive Session)$/i }).count() === 0);
  await shot('01-native-bot');
  phase = 'native-controls';
  for (const [name, pattern] of [['model', /^(选择模型，当前|Select model, current)/], ['permission', /^(访问模式，当前|Access mode, current)/]]) {
    const button = chat.getByRole('button', { name: pattern }); await button.waitFor();
    check(`native ${name} control enabled`, await button.isEnabled());
    await button.click(); await page.getByRole('menu').last().waitFor();
    check(`native ${name} menu opens without a selection change`); await shot(`02-${name}-menu`); await page.keyboard.press('Escape');
  }
  await chat.locator('[data-bot-mode-details]').click();
  const details = page.locator('[data-bot-mode-details-panel]'); await details.waitFor();
  check('details profile identifies selected Bot', await details.locator('[data-bot-mode-profile]').getByText(config.botName, { exact: true }).isVisible()
    && await details.locator(`[data-bot-mode-profile] [data-bot-id="${config.botId}"]`).count() === 1);
  await details.locator('[data-bot-mode-tab="materials"]').click(); check('Bot materials tab opens', await details.locator('[data-bot-mode-tab="materials"]').getAttribute('aria-pressed') === 'true');
  await shot('03-native-details-materials');
  await details.getByRole('button', { name: /^(关闭详情|Close details)$/ }).click();
  phase = 'native-shortcuts';
  const keys = { new: 'Meta+N', search: 'Meta+K', fork: 'Meta+Alt+F', archive: 'Meta+Shift+A', ...config.keybindings };
  const beforeArchive = await archiveSnapshot();
  await composer.click(); await page.keyboard.press(keys.search);
  await waitFor('native Search focuses Bot search', () => sidebar.getByRole('textbox').evaluate(node => node === document.activeElement));
  check('native Search routes to Bot object search');
  await composer.click();
  for (const key of ['fork', 'archive']) {
    await page.keyboard.press(keys[key]); await delay(250);
    check(`native ${key} preserves selected Bot and exact session`, await chat.isVisible() && await selectedSession() === config.sessionId);
  }
  if (beforeArchive) { assert.deepEqual(await archiveSnapshot(), beforeArchive); check('Fork/Archive leave durable archived-session list unchanged'); }
  await page.keyboard.press(keys.new);
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  check('native New opens Bot creation dialog', /Bot/.test(await dialog.textContent()));
  await shot('04-native-new-bot');
  await dialog.getByRole('button', { name: /^(取消|Cancel)$/ }).click(); await select();
  check('cancelling New returns to exact existing Bot session', await selectedSession() === config.sessionId);
  check('native controls and shortcuts preserve original composer draft', await composer.textContent() === draftBefore);
  check('native shortcuts leave stored keybinding preferences unchanged', await page.evaluate(() => localStorage.getItem('dsh.keybindings.v1')) === keybindingPreferenceBefore);
  check('native per-message Branch action absent', await chat.getByRole('button', { name: /在新对话中分支|Branch in new conversation/i }).count() === 0);
  if (config.mode === 'isolated') {
    phase = 'synthetic-greeting';
    const works = () => json(resolve(fixtureDir, 'work-state.json'));
    const previousWorks = new Set((await works()).map(row => row.work.id));
    await composer.fill('你好'); await composer.press('Enter');
    await chat.getByText('你好，这是独立的 Bot 模式审批服务。', { exact: false }).last().waitFor();
    check('actual native composer sends and displays local synthetic greeting');
    check('simple request creates no collaboration work', (await works()).length === previousWorks.size);
    phase = 'synthetic-native-approval';
    const previousApproval = await json(resolve(fixtureDir, 'native-approval.json')).catch(() => undefined);
    const previousId = previousApproval?.events.findLast(event => event.type === 'approval/asked')?.data.id;
    await composer.fill('布局审批验收'); await composer.press('Enter');
    const approval = chat.locator('[data-approval-key]'); await approval.waitFor();
    const reject = approval.getByRole('button', { name: /^(拒绝|Reject)$/ }); await reject.waitFor();
    check('actual native approval takeover exposes enabled Reject', await reject.isEnabled()); await shot('05-native-approval');
    await reject.click(); await approval.waitFor({ state: 'hidden' }); await composer.waitFor();
    await waitFor('durable current approval rejection', async () => {
      const receipt = await json(resolve(fixtureDir, 'native-approval.json'));
      const asked = receipt.events.findLast(event => event.type === 'approval/asked');
      return receipt.sessionId === config.sessionId && receipt.outcome === 'rejected' && asked?.data.id !== previousId
        && receipt.events.some(event => event.type === 'approval/decided' && event.data.id === asked.data.id && event.data.outcome === 'rejected');
    });
    check('native approval asked/decided belong to exact Bot session');
    await chat.getByText('【本地演示】原生审批已结束：rejected。', { exact: false }).last().waitFor();
    phase = 'synthetic-auto-collaboration';
    await composer.fill(`桌面兼容验收 ${Date.now()}：请评估项目方案，比较实施成本、风险和验收步骤，先做小范围验证，再分阶段上线。`); await composer.press('Enter');
    await waitFor('completed automatic work and invited expert', async () => (await works()).some(row => !previousWorks.has(row.work.id)
      && ['completed', 'partial'].includes(row.work.state) && row.group?.members.filter(member => member.enabled && member.removedAt === undefined).length >= 3), 90000);
    const work = (await works()).find(row => !previousWorks.has(row.work.id) && ['completed', 'partial'].includes(row.work.state));
    check('actual native request creates automatic group with expert joining', work.group.members.filter(member => member.enabled && member.removedAt === undefined).length >= 3);
    await chat.getByText('【本地演示】本次协作已完成。', { exact: false }).last().waitFor();
    check('collaboration delivered in original Bot native transcript', await selectedSession() === config.sessionId); await shot('06-native-original-bot-delivery');
    const older = sidebar.locator('[data-bot-mode-earlier]');
    if (await older.isVisible().catch(() => false) && !await older.evaluate(node => node.open)) await older.locator('summary').click();
    await objects.getByRole('button', { name: work.group.group.name, exact: true }).first().click();
    const groupChat = page.locator('[data-bot-mode-object="group"]'); await groupChat.waitFor();
    const expertRequests = work.group.messages.filter(message => message.authorKind === 'bot' && message.stopReason === 'expert-request' && message.causeId?.startsWith('expert-request:'));
    check('real group includes authoritative expert request', expertRequests.length > 0);
    for (const message of expertRequests) {
      const process = groupChat.locator(`[data-group-expert-request="${message.id}"]`); await process.waitFor();
      check('actual expert process folded by default', await process.evaluate(node => node.tagName === 'DETAILS' && !node.open));
    }
    phase = 'synthetic-group-input';
    const groupInput = groupChat.locator('textarea:visible').first(); await groupInput.waitFor();
    const supplement = '请补充具体的成本核对步骤。';
    await groupInput.fill(supplement); await groupChat.getByRole('button', { name: /^(发送|Send)$/ }).click();
    await waitFor('same-work real group input with delivered receipt', async () => (await works()).some(row => row.work.id === work.work.id
      && row.group?.messages.some(message => message.authorKind === 'user' && message.text === supplement)
      && row.work.groupInputs.some(input => input.state === 'completed' && input.delivery?.state === 'delivered' && input.delivery.answerMessageId)), 90000);
    check('actual native group input retains human source and original-Bot delivery receipt');
    const after = (await works()).find(row => row.work.id === work.work.id);
    check('group input continues exact same group and work', after.work.group.groupId === work.work.group.groupId && (await works()).length === previousWorks.size + 1);
    await groupChat.locator('[data-bot-mode-details]').click(); await details.waitFor();
    await details.locator('[data-bot-mode-tab="members"]').click(); await details.getByText('技术专家', { exact: true }).first().waitFor();
    check('native group details exposes invited expert'); await shot('07-native-group-expert');
    await details.locator('[data-bot-mode-tab="materials"]').click(); await details.getByText(supplement, { exact: true }).waitFor();
    check('native group materials contains actual human supplement'); await shot('08-native-group-materials');
    await select(); await chat.getByText('【本地演示】已收到群内补充和协作结果', { exact: false }).last().waitFor();
    check('group revision reaches original Bot native transcript');
    const calls = await json(resolve(fixtureDir, 'calls.json'));
    check('synthetic fixture exercised actual model adapter locally', calls.length > 0 && calls.every(call => !call.external));
  }
  phase = 'final';
  await shot('09-native-final');
  check('no renderer page errors', errors.length === 0, errors);
  await writeFile(resolve(out, 'result.json'), JSON.stringify({ status: 'PASS', mode: config.mode, transport: 'Actual Electron existing renderer via CDP; no replacement Browser',
    artifactSha256: config.artifact.sha256, botId: config.botId, sessionId: config.sessionId, checks, errors, screenshots, responseProofs,
    noSends: config.mode === 'daily', hostConfigurationChanged: false,
    realModelRequests: config.mode === 'isolated' ? 0 : 'NOT_MEASURED: smoke sends no requests',
    separateGates: [{ name: 'OS menu, deep links, IME and multi-window matrix', status: 'FAIL', reason: 'NOT_RUN: CDP renderer smoke only' },
      ...(!config.archiveState ? [{ name: 'Durable archive-state invariance', status: 'FAIL', reason: 'NOT_RUN: no archiveState JSON supplied; UI binding alone checked' }] : [])],
  }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', mode: config.mode, checks: checks.length, out }));
} catch (error) {
  await page?.screenshot({ path: resolve(out, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
  await writeFile(resolve(out, 'result.json'), JSON.stringify({ status: 'FAIL', mode: config.mode, phase, error: redact(error.stack ?? error), checks, errors, screenshots, responseProofs }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', phase, error: redact(error), out })); process.exitCode = 1;
} finally {
  // Playwright closes only this CDP connection for an externally owned browser.
  await browser?.close();
}
