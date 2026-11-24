import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { auditArtifact } from './p34-artifact.mjs';
import { webHost } from './deepening/b4-web-host.mjs';
import { openBotsPanel, openSidebarSession } from './deepening/sidebar-session.mjs';
import { scratch } from './proactive/worker.mjs';
import { dismissFirstRunOverlays, installOverlayHandler } from '../packages/dsh-bot/scripts/screenshot-support.ts';

const [candidate] = process.argv.slice(2);
assert.ok(candidate, 'Supply the frozen plugin archive');
const artifact = resolve(candidate);
const dir = await scratch('group-guest');
console.log(dir);
const audit = await auditArtifact(process.cwd(), artifact, dir);
const profile = resolve('packages/dsh-bot/tests/group-guest-profile.mjs');
const patch = ['- id: agent-default-model', '  config:', '    provider: guest-offline', '    model: fixture'];
const start = preserveProfile => webHost(dir, 'native-bots-workspace', artifact, profile, patch,
  { artifactAudit: audit, mockModel: false, preserveProfile });
const { chromium } = createRequire(resolve('packages/dsh-bot/package.json'))('playwright-core');
const cache = join(homedir(), 'Library/Caches/ms-playwright');
const executablePath = (await readdir(cache)).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .flatMap(n => ['arm64', 'x64'].map(arch => join(cache, n, 'chrome-headless-shell-mac-' + arch, 'chrome-headless-shell'))).find(existsSync);
let host;
let browser;
let page;
const checks = [];
async function waitForEvidence(file) {
  const end = Date.now() + 30000;
  while (!existsSync(join(dir, file)) && Date.now() < end) {
    if (existsSync(join(dir, 'fixture-error.txt'))) throw Error(await readFile(join(dir, 'fixture-error.txt'), 'utf8'));
    await delay(100);
  }
  assert.ok(existsSync(join(dir, file)), 'Missing fixture result: ' + file);
}
try {
  host = await start(false);
  const { root, jarvisMain } = JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8'));
  browser = await chromium.launch({ executablePath, env: host.env, chromiumSandbox: true });
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(String(err)));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await installOverlayHandler(page, () => {});
  await page.goto(host.url, { waitUntil: 'domcontentloaded' });
  await dismissFirstRunOverlays(page, () => {}, 'native-bots-workspace');
  await openSidebarSession(page, root);
  const composer = page.locator('[data-workspace-group-composer="' + root + '"]:visible');
  const conversation = page.locator('[data-conversation-content][data-conversation-session="' + root + '"]:visible');
  const input = composer.locator('textarea');
  const mentionMenu = composer.getByRole('listbox');
  const memberOption = mentionMenu.getByRole('option').filter({ has: page.getByText('deep', { exact: true }) });
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await input.fill('@');
    await memberOption.waitFor();
    const labels = await mentionMenu.getByRole('option').locator('strong').allTextContents();
    assert.deepEqual(labels.sort(), ['everyone', 'deep', '研究员'].sort());
    await page.screenshot({ path: join(dir, 'member-mentions-' + theme + '.png') });
    await input.fill('');
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await input.fill('请帮忙 @');
  await memberOption.waitFor();
  assert.deepEqual((await mentionMenu.getByRole('option').locator('strong').allTextContents()).sort(), ['everyone', 'deep', '研究员'].sort());
  await input.fill('@Jar');
  await mentionMenu.waitFor({ state: 'hidden' });
  for (const prefix of ['@', '＠']) {
    const outsiderDraft = prefix + 'Jarvis 请检查本群的测试说明';
    await input.fill(outsiderDraft);
    await input.press('Enter');
    await composer.getByRole('alert').filter({ hasText: /成员/ }).first().waitFor();
    assert.equal(await input.inputValue(), outsiderDraft);
  }
  await writeFile(join(dir, 'blocked-mention'), 'Check the original group before submitting the next input.');
  await waitForEvidence('blocked-mention.json');
  checks.push('only everyone and current members appear in the @ menu in light and dark themes',
    'typed outsider mention is rejected, retaining the draft with no extra turn or model call');
  await input.fill('@de');
  await memberOption.click();
  assert.equal(await input.inputValue(), '@deep ');
  await input.press('End');
  await page.keyboard.insertText('请单独回应成员提及测试。');
  await input.press('Enter');
  await waitForEvidence('member-mention.json');
  checks.push('selecting an in-group @ routes exactly one delivery to that member');
  await input.fill('你问下 Jarvis 最近有和这个相关的吗？');
  await input.press('Enter');
  await composer.getByRole('alert').filter({ hasText: '请补充' }).waitFor();
  await composer.locator('[data-group-relay-topic]').fill('公开主题：工程验收');
  await input.press('Enter');
  const status = conversation.locator('[data-group-guest-status]:visible').first();
  await status.getByText(/已送达 Jarvis，等待回复/, { exact: false }).or(status.filter({ hasText: /已送达 Jarvis，等待回复/ })).first().waitFor();
  assert.equal(await conversation.getByText('这份答复来自受邀的 Jarvis。', { exact: true }).count(), 0);
  checks.push('native UI accepted the addressed question and displayed delivery before reply');
  await page.screenshot({ path: join(dir, 'delivered.png') });
  await writeFile(join(dir, 'release-answer'), 'local synthetic adapter can answer');
  await status.filter({ hasText: /Jarvis 已回复到本群/ }).waitFor();
  const reply = conversation.locator('[data-group-author=bot]').filter({ hasText: '这份答复来自受邀的 Jarvis。' });
  await reply.getByText('Jarvis', { exact: true }).first().waitFor();
  await reply.locator('[data-group-guest-author="fixture-jarvis"]').getByText('群外回复', { exact: true }).or(reply.locator('[data-group-guest-author="fixture-jarvis"]').filter({ hasText: '群外回复' })).first().waitFor();
  assert.equal(await reply.count(), 1);
  checks.push('one group reply attributed to the real external Bot');
  await waitForEvidence('native-evidence.json');
  checks.push('exact question only, reserved target identity, restricted group tools, duplicate send idempotent, unchanged roster');
  await waitForEvidence('privacy.json');
  checks.push('own memory readable only to the guest, private answer requires one-time authorization, denial publishes no text');
  const member = conversation.locator('[data-group-author="bot"]').filter({ has: page.getByText('deep', { exact: true }) }).first();
  await member.hover();
  await member.getByRole('button', { name: '回复', exact: true }).click();
  const mediatedQuestion = '你问下 Jarvis 最近有和这个相关的吗？';
  await input.fill(mediatedQuestion);
  await composer.locator('[data-group-relay-route]').filter({ hasText: 'deep 将向 Jarvis 提问' }).waitFor();
  await input.press('Enter');
  await composer.getByRole('alert').filter({ hasText: '请补充' }).waitFor();
  assert.equal(await input.inputValue(), mediatedQuestion);
  const topicInput = composer.locator('[data-group-relay-topic]');
  assert.equal(await topicInput.inputValue(), '');
  await composer.getByRole('button', { name: '填入引用摘句' }).click();
  assert.equal(await topicInput.inputValue(), '已看到本群的测试说明。');
  await topicInput.fill('迁移验收的合成测试主题');
  await input.press('Enter');
  const relay = conversation.locator('[data-group-guest-status]');
  await relay.filter({ hasText: 'deep 的问题已送达 Jarvis，等待答复' }).waitFor();
  const openJarvis = async () => {
    await openBotsPanel(page, 'Bots');
    await page.locator('[data-bots-list="bots"]:visible [data-directory-id="fixture-jarvis"] [data-directory-open]').click();
  };
  const bSession = page.locator('[data-conversation-content][data-conversation-session="' + jarvisMain + '"]:visible');
  const marker = direction => bSession.locator('[data-bot-message][data-group-relay-receipt][data-message-direction="' + direction + '"]');
  await openJarvis();
  await marker('received').filter({ hasText: 'deep' }).waitFor();
  assert.equal(await marker('sent').count(), 0);
  await writeFile(join(dir, 'release-relay'), 'answer may return to deep');
  await marker('sent').filter({ hasText: 'deep' }).waitFor();
  await openSidebarSession(page, root);
  await relay.filter({ hasText: 'Jarvis 已答复 deep，等待 deep 回群' }).waitFor();
  await writeFile(join(dir, 'release-member'), 'deep may publish');
  await relay.filter({ hasText: 'deep 已根据 Jarvis 的答复回群' }).waitFor();
  const report = conversation.locator('[data-group-author="bot"]').filter({ has: page.locator('[data-group-relay-author="member-deep"]') });
  await report.getByText('我向 Jarvis 核对过，迁移验收可以进行。', { exact: true }).waitFor();
  assert.equal(await report.count(), 1);
  assert.ok(!(await conversation.innerText()).includes('B_REPLY_FOR_A_ONLY'));
  const turn = conversation.locator('[data-group-turn]').filter({ has: page.locator('[data-group-guest-status]').filter({ hasText: 'deep 已根据 Jarvis 的答复回群' }) });
  const showRelay = turn.locator(':scope > button[aria-expanded]');
  await showRelay.click();
  const details = turn.locator('[data-group-relay-details]');
  await details.locator('[data-relay-part="question"][data-relay-state="readable"]').filter({ hasText: '迁移验收的合成测试主题' }).waitFor();
  await details.locator('[data-relay-part="answer"][data-relay-state="readable"]').filter({ hasText: 'B_REPLY_FOR_A_ONLY' }).waitFor();
  await details.locator('[data-relay-part="report"][data-relay-state="readable"]').filter({ hasText: '我向 Jarvis 核对过' }).waitFor();
  await showRelay.click();
  assert.equal(await details.count(), 0);
  const groupStats = page.locator('[data-statistics-status]').filter({ hasText: 'deep 已根据 Jarvis 的答复回群' }).locator('..');
  await groupStats.waitFor();
  assert.doesNotMatch(await groupStats.innerText(), /等待执行|0\/2 位成员可读取/);
  await page.screenshot({ path: join(dir, 'relay-report.png') });
  await waitForEvidence('relay-evidence.json');
  await openJarvis();
  await marker('sent').waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openSidebarSession(page, jarvisMain);
  await marker('received').waitFor();
  await marker('sent').waitFor();
  for (const direction of ['received', 'sent']) assert.equal(await marker(direction).count(), 1);
  assert.ok(!(await bSession.innerText()).includes('UNRELATED_OLDER_GROUP_NOTE'));
  for (const [direction, part, original] of [
    ['received', 'question', '迁移验收的合成测试主题'], ['sent', 'answer', 'B_REPLY_FOR_A_ONLY'],
  ]) {
    const receipt = marker(direction);
    const toggle = receipt.locator('button[aria-expanded]');
    await toggle.click();
    await receipt.locator('[data-relay-part="' + part + '"][data-relay-state="readable"]').filter({ hasText: original }).waitFor();
    assert.equal(await receipt.locator('[data-relay-part]').count(), 1);
    await toggle.click();
  }
  checks.push('group disclosure resolves all three authorized parts and each Bot receipt resolves only its own original');
  await page.screenshot({ path: join(dir, 'jarvis-receipts.png') });
  await openSidebarSession(page, root);
  checks.push('quoted member resolves the request, missing topic preserves draft, only supplied context reaches guest',
    'Jarvis main chat shows exactly one incoming question then one outgoing reply, including after reload',
    'group shows delivery, handoff and only the member’s independently generated report');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 960, height: 720 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await status.filter({ hasText: /Jarvis 已回复到本群/ }).waitFor();
  await reply.getByText('Jarvis', { exact: true }).first().waitFor();
  await page.screenshot({ path: join(dir, 'answered.png') });
  await writeFile(join(dir, 'start-private-relay'), 'exercise separate private handoffs');
  await waitForEvidence('private-relay.json');
  checks.push('private guest answer authorized only to member; separate group authorization denied, nothing published');
  assert.deepEqual(pageErrors, []);
  checks.push('reply and sender survive frontend reload');
  assert.equal(host.requests(), 0);
  await browser.close();
  browser = undefined;
  await host.stop();
  host = undefined;
  host = await start(true);
  const restart = JSON.parse(await readFile(join(dir, 'restart.json'), 'utf8'));
  assert.equal(restart.replayedCalls, 0);
  checks.push('cold Host restart preserves native receipt without another model call');
  console.log('PASS', checks);
  await writeFile(join(dir, 'result.json'), JSON.stringify({ status: 'PASS', sha256: audit.sha256, checks }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(dir, 'failure.png') }).catch(() => {});
    await writeFile(join(dir, 'snapshot.txt'), await page.locator('body').ariaSnapshot()).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await host?.stop();
}
