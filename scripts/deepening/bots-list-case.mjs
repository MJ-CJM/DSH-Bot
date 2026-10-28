import assert from 'node:assert/strict';
import { openBotsPanel } from './sidebar-session.mjs';

/** Exercise shipped Client selection and native navigation; no mocked navigation handlers. */
export async function botsListCase({ page, bots, fixture, id, width, t, shot }) {
  const target = id === 'en-light-1360' ? 'zh-dark-390' : 'en-light-1360';
  const detail = bots.locator(`[data-bot-detail="${target}"]:visible`);
  const option = () => bots.getByRole('option').and(page.locator(`[data-bot-id="${target}"]`));
  const selectedSession = session => page.locator(`[data-row-key="session:${session}"][aria-selected="true"]`);
  const calls = [];
  const isOpen = request => new URL(request.url()).pathname.endsWith('/dshBot/openConversation');
  const record = request => { if (isOpen(request)) calls.push(request); };
  page.on('request', record);
  try {
    await page.setViewportSize({ width, height: 1000 });
    await option().click();
    await detail.waitFor();
    assert.ok(await bots.isVisible(), 'Single click must retain Bots page');
    assert.equal(calls.length, 0, 'Single click must not request a conversation');
    if (width === 1360) assert.equal(await selectedSession(fixture.sessions[id]).count(), 1, 'Single click must not navigate');
    await shot('bots-list');
    for (const action of ['button', 'Enter', 'Space', 'double']) {
      const before = calls.length;
      const response = page.waitForResponse(response => isOpen(response.request()));
      void response.catch(() => {}); // Context cleanup can reject it if the click itself fails.
      if (action === 'button') await detail.getByRole('button', { name: t['bots.newSession'], exact: true }).click();
      else {
        const back = bots.getByRole('button', { name: t['bots.back'], exact: true });
        if (await back.isVisible()) await back.click();
        if (action === 'double') await option().dblclick();
        else {
          // Arrow selection must leave the narrow list visible and keep activation explicit.
          const list = bots.getByRole('listbox');
          await list.focus();
          const options = await bots.getByRole('option').all();
          const index = (await Promise.all(options.map(row => row.getAttribute('data-bot-id')))).indexOf(target);
          assert.ok(index >= 0);
          await list.press('Home');
          for (let i = 0; i < index; i++) await list.press('ArrowDown');
          await list.press(action);
        }
      }
      assert.ok((await response).ok(), `${action} RPC must succeed`);
      assert.equal(calls.length, before + 1, `${action} must activate exactly once`);
      await page.locator(`[data-conversation-content][data-conversation-session="${fixture.sessions[target]}"]:visible`).waitFor();
      await page.setViewportSize({ width: 1360, height: 1000 });
      await selectedSession(fixture.sessions[target]).waitFor({ state: 'visible' });
      await openBotsPanel(page, t['bots.title']);
      await page.setViewportSize({ width, height: 1000 });
    }
  } finally { page.off('request', record); }
}
