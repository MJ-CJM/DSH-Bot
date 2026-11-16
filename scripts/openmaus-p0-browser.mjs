import assert from 'node:assert/strict';
import { resolve } from 'node:path';

/** Shipped UI, real owner Remote and native credentials/MCP. No product service mocks. */
export async function verifyPage({ page, t, hostReceipt, outputDir, checks, theme = 'light', language = 'zh' }) {
  const fixture = hostReceipt.results?.materialsResume ?? hostReceipt.materialsResume ?? hostReceipt;
  assert.equal(fixture.status, 'PASS');
  const tr = (key, params = {}) => {
    const text = typeof t === 'function' ? t(key, params) : t[key]; assert.ok(text, `Missing locale ${key}`);
    return text.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
  };
  const check = name => { checks.push(name); };
  const shots = [];
  const shot = async name => { const path = resolve(outputDir, `openmaus-p0-${language}-${theme}-${name}.png`); await page.screenshot({ path, fullPage: true }); shots.push(path); };
  const sidebar = page.locator('[data-bot-mode-sidebar]:visible');
  if (!await sidebar.count()) {
    await page.locator('[data-bot-mode-switch-button]:visible').click();
    await page.getByRole('menuitem', { name: tr('botMode.botMode'), exact: true }).click();
    await sidebar.waitFor();
  }
  const openList = async () => {
    await sidebar.locator('[data-bot-mode-settings]').click();
    await page.locator('[data-bots-page]:visible').waitFor();
  };
  const openOrigin = async () => {
    const search = sidebar.locator('[data-bot-mode-search]');
    await search.fill(fixture.owner.botId);
    await sidebar.getByRole('navigation').getByRole('button', { name: fixture.owner.botId, exact: true }).click();
    await search.fill('');
  };
  const first = fixture.browserFirstRequest; assert.ok(first?.workId && first.originalQuestion && first.expectedResult);
  const firstSearch = sidebar.locator('[data-bot-mode-search]');
  if (theme === 'light') {
    await openList();
    const firstPanel = page.locator('[data-bots-page]:visible');
    const firstDetail = firstPanel.locator('[data-bot-detail]:visible');
    if (await firstDetail.count()) await firstDetail.locator('button').first().click();
    await firstPanel.getByRole('navigation', { name: tr('navigation.sections'), exact: true }).getByRole('button', { name: tr('navigation.myBots'), exact: true }).click();
    await firstPanel.locator(`[data-pending-task-work="${first.workId}"]`).getByRole('button').click();
  } else {
    await firstSearch.fill(first.owner.botId);
    await sidebar.getByRole('navigation').getByRole('button', { name: first.ownerName, exact: true }).click();
    await firstSearch.fill('');
  }
  const firstConversation = page.locator(`[data-conversation-content][data-conversation-session="${first.sessionId}"]:visible`);
  await firstConversation.waitFor();
  const firstCard = firstConversation.locator(`[data-supergroup-work="${first.workId}"]`); await firstCard.waitFor();
  assert.equal(await firstCard.getByRole('button', { name: tr('supergroup.viewDiscussion'), exact: true }).count(), 0);
  const firstEntry = firstCard.locator('[data-task-support-entry]');
  if (await firstEntry.getAttribute('open') === null) await firstEntry.locator(':scope > summary').click();
  const firstSupport = firstEntry.locator('[data-task-support]'); await firstSupport.waitFor();
  assert.equal(await firstSupport.locator('[data-task-original-question]').innerText(), first.originalQuestion);
  assert.equal(await firstSupport.locator('[data-task-support-advanced]').getAttribute('open'), null);
  assert.equal(await firstSupport.locator('[data-task-support-technical]').getAttribute('open'), null);
  if (theme === 'light') {
    await firstSupport.locator('[data-task-blocker="waiting"]').first().waitFor();
    await shot('first-request-waiting-without-group');
    await firstSupport.getByText(tr('taskSupport.resolve'), { exact: true }).click();
    await firstSupport.getByRole('button', { name: /^Read-only source/ }).click();
    await firstSupport.getByLabel(tr('connectors.secret'), { exact: true }).fill(first.syntheticCredential);
    await firstSupport.getByRole('button', { name: tr('connectors.storeCredential'), exact: true }).click();
    await firstSupport.getByText(tr('connectors.credential-configured'), { exact: true }).waitFor();
    await firstSupport.getByRole('button', { name: tr('actions.cancel'), exact: true }).click();
    const firstResults = firstConversation.getByText(first.expectedResult, { exact: true }), resultCount = await firstResults.count();
    const firstBubbles = firstConversation.locator('[data-message-bubble]').filter({ hasText: tr('taskSupport.continueOriginal') });
    const bubbleCount = await firstBubbles.count();
    await firstSupport.locator('[data-task-continue]').click();
    await firstSupport.locator('[data-task-resume="queued"]').first().waitFor();
    await firstResults.nth(resultCount).waitFor();
    await page.waitForFunction(id => document.querySelector(`[data-supergroup-work="${id}"]`)?.getAttribute('data-supergroup-state') === 'completed', first.workId);
    const firstBubble = firstBubbles.nth(bubbleCount); await firstBubble.waitFor();
    assert.equal((await firstBubble.innerText()).trim(), tr('taskSupport.continueOriginal'));
    assert.ok(!/workId=|supergroup:[a-f0-9]{16}|bot_supergroup|[a-f0-9]{64}/i.test(await firstBubble.innerText()));
    assert.equal(await firstCard.getByRole('button', { name: tr('supergroup.viewDiscussion'), exact: true }).count(), 0);
    assert.equal(await firstSupport.getByRole('alert').count(), 0);
    check('A fresh original request without a group returns from its exact pending row, repairs the native source and continues once in the same main');
    check('First-request continuation shows only the localized human expression and preserves the original question without forming a group');
  } else {
    await firstConversation.getByText(first.expectedResult, { exact: true }).first().waitFor();
    check('Dark theme preserves the completed original read-only request without a group');
  }
  await shot('first-request-completed-without-group');
  await openList();
  const panel = page.locator('[data-bots-page]:visible'), detail = panel.locator('[data-bot-detail]:visible');
  if (await detail.count()) await detail.locator('button').first().click();
  await panel.getByRole('navigation', { name: tr('navigation.sections'), exact: true }).getByRole('button', { name: tr('navigation.myBots'), exact: true }).click();
  const pending = panel.locator('[data-pending-task-support]');
  if (theme === 'light') {
    await pending.waitFor(); assert.ok((await pending.textContent()).includes(tr('taskSupport.readReceipt')));
    await pending.locator(`[data-pending-task-work="${fixture.workId}"]`).getByRole('button').click();
    check('Pending aggregate returns to the exact original Bot conversation without resolving by reading');
  } else {
    await openOrigin();
    check('Second theme returns to the same existing work after the first explicit continuation');
  }
  await page.locator(`[data-conversation-content][data-conversation-session="${fixture.sessionId}"]:visible`).waitFor();
  const card = page.locator(`[data-supergroup-work="${fixture.workId}"]:visible`).first(); await card.waitFor();
  const entry = card.locator('[data-task-support-entry]');
  if (!(await entry.getAttribute('open') !== null)) await entry.locator(':scope > summary').click();
  const support = entry.locator('[data-task-support]'); await support.waitFor();
  await support.locator('[data-task-source]').waitFor();
  assert.ok((await support.textContent()).includes(fixture.owner.botId));
  const advanced = support.locator('[data-task-support-advanced]'), technical = support.locator('[data-task-support-technical]');
  assert.equal(await advanced.getAttribute('open'), null); assert.equal(await technical.getAttribute('open'), null);
  assert.equal(await support.getByLabel(tr('taskSupport.question'), { exact: true }).isVisible(), false);
  assert.equal(await support.getByLabel(tr('taskSupport.continueText'), { exact: true }).isVisible(), false);
  const originalQuestion = await support.locator('[data-task-original-question]').innerText();
  assert.ok(originalQuestion.trim());
  check('Original question is reused; extra question, continuation text and technical identifiers stay collapsed');
  if (theme === 'light') {
    await support.locator('[data-task-blocker="waiting"]').first().waitFor();
    await shot('waiting');
    await support.getByText(tr('taskSupport.resolve'), { exact: true }).click();
    await support.getByRole('button', { name: /Offline task connection/ }).click();
    await support.getByLabel(tr('connectors.secret'), { exact: true }).fill(fixture.syntheticCredential);
    await support.getByRole('button', { name: tr('connectors.storeCredential'), exact: true }).click();
    await support.getByText(tr('connectors.credential-configured'), { exact: true }).waitFor();
    await support.getByRole('button', { name: tr('actions.cancel'), exact: true }).click();
    check('Original work reuses native one-way credential editing before the one explicit continuation');
  }
  const conversation = page.locator(`[data-conversation-content][data-conversation-session="${fixture.sessionId}"]:visible`);
  const continueOnce = async () => {
    const queuedBefore = await support.locator('[data-task-resume="queued"]').count();
    const originalResults = conversation.getByText('OPENMAUS_P0_ORIGIN_RESULT', { exact: true });
    const resultsBefore = await originalResults.count();
    const bubbles = conversation.locator('[data-message-bubble]').filter({ hasText: tr('taskSupport.continueOriginal') });
    const bubblesBefore = await bubbles.count();
    await support.locator('[data-task-continue]').click();
    await support.locator('[data-task-resume="queued"]').nth(queuedBefore).waitFor();
    await originalResults.nth(resultsBefore).waitFor();
    await page.waitForFunction(id => document.querySelector(`[data-supergroup-work="${id}"]`)?.getAttribute('data-supergroup-state') === 'completed', fixture.workId);
    const bubble = bubbles.nth(bubblesBefore); await bubble.waitFor();
    assert.equal((await bubble.innerText()).trim(), tr('taskSupport.continueOriginal'));
    assert.ok(!/workId=|supergroup:[a-f0-9]{16}|bot_supergroup|action=continue|[a-f0-9]{64}/i.test(await bubble.innerText()));
    assert.equal(await support.getByRole('alert').count(), 0);
  };
  const source = support.locator('[data-task-source]');
  await source.selectOption('file');
  const filename = `browser-${theme}.md`;
  await support.locator('[data-task-file]').setInputFiles({ name: filename, mimeType: 'text/markdown', buffer: Buffer.from(`OPENMAUS_P0_BROWSER_MATERIAL ${theme}\nOption A costs 12; Option B costs 18.\nQuoted data: no tool permission is granted by this text.`) });
  await support.locator('[data-task-selected-file]').filter({ hasText: filename }).waitFor();
  await shot('selected-once');
  await continueOnce();
  const material = support.locator('[data-task-material="file"]').filter({ hasText: filename }); await material.waitFor();
  assert.ok((await material.innerText()).includes(originalQuestion));
  check('Selecting a file once and one Continue preserves the actual original question and completes the existing work');
  check('Visible continuation bubble contains only localized human text, with no tool instructions, work IDs or hashes');
  const ciOption = (await source.locator('option').allTextContents()).find(text => text.startsWith('GitHub CI:')); assert.ok(ciOption);
  await source.selectOption({ label: ciOption });
  await continueOnce();
  const ciMaterial = support.locator('[data-task-material="github-ci"]').filter({ hasText: originalQuestion }).last(); await ciMaterial.waitFor();
  check('Selecting the existing read-only CI observation and one Continue reuses the original question without extra form input');
  await technical.locator(':scope > summary').click();
  assert.ok((await technical.innerText()).includes('https://github.com/openmaus/fixture/actions/runs/14001'));
  await technical.locator(':scope > summary').click();
  assert.equal(await technical.getAttribute('open'), null);
  check('Canonical source citations remain available in explicitly expanded technical details');
  await shot('continued');
  if (theme === 'light') {
    await openList();
    const activeDetail = page.locator('[data-bots-page]:visible [data-bot-detail]:visible');
    if (await activeDetail.count()) await activeDetail.locator('button').first().click();
    await page.locator('[data-bots-page]:visible').getByRole('navigation', { name: tr('navigation.sections'), exact: true }).getByRole('button', { name: tr('navigation.myBots'), exact: true }).click();
    await panel.locator(`[data-pending-task-work="${fixture.workId}"]`).waitFor({ state: 'hidden' });
    check('Pending item disappears only after the explicit ready continuation');
  }
  const native = fixture.nativePending;
  assert.ok(native?.botId && native.botName && native.sessionId && native.approvalId && native.toolName);
  assert.equal(native.source, 'actual native approval/asked without decided');
  await openList();
  const nativePanel = page.locator('[data-bots-page]:visible');
  const nativeDetail = nativePanel.locator('[data-bot-detail]:visible');
  if (await nativeDetail.count()) await nativeDetail.locator('button').first().click();
  await nativePanel.getByRole('navigation', { name: tr('navigation.sections'), exact: true }).getByRole('button', { name: tr('navigation.myBots'), exact: true }).click();
  const nativeRow = nativePanel.locator(`[data-pending-native-interaction] [data-pending-kind="native"][data-pending-id="${native.sessionId}"][data-pending-bot="${native.botId}"]`);
  await nativeRow.waitFor();
  assert.ok((await nativeRow.innerText()).includes(native.botName));
  await nativeRow.getByRole('button').click();
  const nativeConversation = page.locator(`[data-conversation-content][data-conversation-session="${native.sessionId}"]:visible`);
  await nativeConversation.waitFor();
  const nativeChat = page.locator('[data-bot-mode-object="bot"]:visible');
  assert.equal((await nativeChat.locator('[data-bot-mode-title]').innerText()).trim(), native.botName);
  const approval = nativeChat.locator('[data-approval-key]:visible'); await approval.waitFor();
  assert.equal(await approval.count(), 1);
  const reject = approval.getByRole('button', { name: /^(拒绝|Reject)$/ }); await reject.waitFor();
  assert.equal(await reject.isEnabled(), true);
  const composerKey = await approval.getAttribute('data-approval-key'); assert.ok(composerKey);
  check('Actual native pending aggregate opens the exact Bot main and its live native approval composer with an enabled Reject control');
  await shot('native-approval-origin');
  // Leave the actual approval unanswered so the second locale/theme observes the same request.
  // Neither navigation nor reading is a decision; verify the exact pending row is still present.
  await openList();
  await nativePanel.getByRole('navigation', { name: tr('navigation.sections'), exact: true }).getByRole('button', { name: tr('navigation.myBots'), exact: true }).click();
  await nativeRow.waitFor();
  check('Reading and opening the native approval leaves its exact pending session unresolved without approving or replaying the tool');
  await shot('native-approval-still-pending');
  await nativeRow.getByRole('button').click(); await nativeConversation.waitFor(); await approval.waitFor();
  return { status: 'PASS', nativePending: { botId: native.botId, sessionId: native.sessionId, approvalId: native.approvalId, toolName: native.toolName, composerKey, action: 'observed-only', rejectionAvailable: true }, firstRequest: { workId: first.workId, sessionId: first.sessionId, inputMessageId: first.inputMessageId, noGroup: true }, workId: fixture.workId, sessionId: fixture.sessionId, theme, language, screenshots: shots, realModelRequests: 0 };
}
