import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { openBotsPanel, selectBotDirectoryAction } from './deepening/sidebar-session.mjs';

/** Actual installed Client + owner Remote, used by the final shared Browser runner. */
export async function verifyPage({ page, t, hostReceipt, outputDir, checks }) {
  const fixture = hostReceipt.results?.followupMemory ?? hostReceipt.followupMemory ?? hostReceipt;
  assert.equal(fixture.status, 'PASS');
  const tr = (key, params = {}) => {
    const value = typeof t === 'function' ? t(key, params) : t[key];
    assert.ok(value, `Missing translation ${key}`);
    return value.replace(/\{(\w+)\}/g, (_, field) => String(params[field] ?? ''));
  };
  const check = name => { checks.push(name); };
  const sidebar = page.locator('[data-bot-mode-sidebar]:visible');
  if (await sidebar.count()) {
    const search = sidebar.locator('[data-bot-mode-search]');
    await search.fill(fixture.botName);
    await sidebar.getByRole('navigation').getByRole('button', { name: fixture.botName, exact: true }).click();
    await page.locator('[data-bot-mode-details]').click();
    await page.locator('[data-bot-mode-details-panel]').getByRole('button', { name: tr('botMode.memory'), exact: true }).click();
    await search.fill('');
  } else {
    await openBotsPanel(page, tr('bots.title'));
    const bots = page.locator('[data-bots-page]:visible');
    const retainedDetail = bots.locator('[data-bot-detail]:visible');
    if (await retainedDetail.count()) await retainedDetail.locator(':scope > button').first().click();
    await bots.getByRole('navigation', { name: tr('navigation.sections'), exact: true })
      .getByRole('button', { name: tr('navigation.myBots'), exact: true }).click();
    const search = bots.getByLabel(tr('navigation.searchBots'), { exact: true });
    await search.fill(fixture.botName);
    if (fixture.pending) {
      for (const [kind, id] of [['input', fixture.pending.inputCardId], ['review', fixture.pending.reviewCardId], ['unknown', fixture.pending.unknownAssignmentId]]) {
        const row = bots.locator(`[data-pending-follow-up] [data-pending-kind="${kind}"][data-pending-id="${id}"]`);
        await row.waitFor();
        assert.equal(await row.count(), 1);
        assert.ok((await row.textContent()).includes(fixture.botName));
      }
      const input = bots.locator(`[data-pending-follow-up] [data-pending-id="${fixture.pending.inputCardId}"]`);
      await input.getByRole('button').click();
      await page.locator(`[data-bot-detail="${fixture.botId}"]:visible`).waitFor();
      await page.locator(`[data-bot-detail="${fixture.botId}"]:visible`).locator(':scope > button').first().click();
      await bots.getByRole('navigation', { name: tr('navigation.sections'), exact: true })
        .getByRole('button', { name: tr('navigation.myBots'), exact: true }).click();
      await input.waitFor();
      check('Cross-Bot pending reads existing input, review and unknown receipts; opening a row does not resolve it');
    }
    await selectBotDirectoryAction(bots, fixture.botId, tr('chat.profile'));
    await page.locator(`[data-bot-detail="${fixture.botId}"]`).getByRole('tab', { name: tr('detail.memory'), exact: true }).click();
  }
  const detail = page.locator(`[data-bot-detail="${fixture.botId}"]:visible`);
  await detail.waitFor();
  const changes = detail.locator('[data-memory-changes]');
  await changes.locator('summary').click();
  const original = changes.locator(`[data-memory-change="${fixture.browserRestoreVersionId}"]`);
  await original.waitFor();
  assert.ok(!(await changes.textContent()).includes('OPENMAUS_OLD_BODY_FORBIDDEN'));
  const beforeCount = await changes.locator('[data-memory-change]').count();
  assert.ok(beforeCount >= 4);
  await changes.getByLabel(tr('memory.changes.before'), { exact: true }).first().waitFor();
  await changes.getByLabel(tr('memory.changes.after'), { exact: true }).first().waitFor();
  assert.ok(await changes.locator('time[datetime]').count() >= 4);
  await original.getByRole('button', { name: tr('memory.changes.restore'), exact: true }).click();
  await page.waitForFunction(({ id, count }) => document.querySelector(`[data-bot-detail="${id}"] [data-memory-changes]`)
    ?.querySelectorAll('[data-memory-change]').length > count, { id: fixture.botId, count: beforeCount });
  const latest = changes.locator('[data-memory-change]').first();
  assert.ok((await latest.getByLabel(tr('memory.changes.after'), { exact: true }).textContent()).includes('OPENMAUS_MEMORY_ORIGINAL'));
  assert.ok((await latest.textContent()).includes(tr('memory.changes.revision', { revision: beforeCount + 1 })));
  assert.equal(await changes.getByRole('alert').count(), 0);
  check('Memory recent changes shows source, time and before/after; explicit UI restore creates a new revision');
  await page.screenshot({ path: resolve(outputDir, `openmaus-memory-${checks.length}.png`), fullPage: true });

  await detail.getByRole('tab', { name: tr('detail.work'), exact: true }).click();
  const panel = detail.locator('[data-follow-up="detail"]');
  await panel.locator(`[data-follow-up-card="${fixture.browserConditionCardId}"]`).getByRole('button', { name: tr('simple.watchTask'), exact: true }).click();
  const form = panel.locator('form');
  assert.ok(await form.getByLabel(tr('followUp.watchTitle'), { exact: true }).inputValue());
  assert.equal(await form.getByRole('combobox').inputValue(), fixture.browserConditionCardId);
  assert.ok(await form.getByLabel(tr('followUp.when.expires'), { exact: true }).inputValue());
  check('Follow this task pre-fills title, exact original condition and editable deadline');
  const title = `Browser conditional watch ${Date.now()}`;
  await form.getByLabel(tr('followUp.watchTitle'), { exact: true }).fill(title);
  await form.getByLabel(tr('followUp.watchCompletion'), { exact: true }).fill('Review the existing original task result.');
  await form.getByRole('combobox').selectOption(fixture.browserConditionCardId);
  const date = new Date(Date.now() + 86400000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await form.getByLabel(tr('followUp.when.expires'), { exact: true }).fill(local);
  await form.getByRole('button', { name: tr('followUp.save'), exact: true }).click();
  const watch = panel.locator('[data-follow-up-card]').filter({ has: page.getByText(title, { exact: true }) });
  await watch.waitFor();
  assert.ok((await watch.textContent()).includes(tr('followUp.when.subtask-completed')));
  assert.ok((await watch.textContent()).includes(fixture.browserConditionCardId));
  await watch.getByRole('button', { name: tr('followUp.stop'), exact: true }).click();
  await watch.waitFor({ state: 'hidden' });
  await panel.getByRole('button', { name: tr('followUp.history'), exact: true }).click();
  await watch.waitFor();
  assert.ok((await watch.textContent()).includes(tr('followUp.history.stopped')));
  check('Original-task condition is selected in existing watch UI, bound with deadline, then explicitly stopped');
  const settled = panel.locator(`[data-follow-up-card="${fixture.settledCardId}"]`);
  await settled.getByRole('button', { name: tr('followUp.open'), exact: true }).click();
  await page.locator(`[data-conversation-content][data-conversation-session="${fixture.sessionId}"]:visible`).waitFor();
  check('Completed-condition review card returns to the exact originating Bot conversation');
  await page.screenshot({ path: resolve(outputDir, `openmaus-condition-${checks.length}.png`), fullPage: true });
  return { status: 'PASS', botId: fixture.botId, memoryRevisionsBefore: beforeCount, conditionStopped: true, realModelRequests: 0 };
}
