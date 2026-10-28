/** Navigate the native sidebar, including paged overflow in both supported locales. */
export async function openSidebarSession(page, sessionId) {
  const target = page.getByRole('treeitem').and(page.locator(`[data-row-key="session:${sessionId}"]:visible`));
  const more = page.getByRole('button', {
    name: /^(?:Show \d+ more sessions|显示更多\s*\d+\s*个会话|展开其余\s*\d+\s*个会话)$/,
  }).and(page.locator(':visible:enabled')).first();
  // Wait for native rows to arrive before deciding whether the target is folded.
  // Repeated expansion also handles groups with more than one overflow page.
  const deadline = Date.now() + 20000;
  while (!await target.isVisible()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Sidebar session still hidden after expanding overflow: ${sessionId}`);
    await target.or(more).first().waitFor({ state: 'visible', timeout: remaining });
    if (await target.isVisible()) break;
    await more.click({ timeout: Math.max(1, deadline - Date.now()) });
  }
  await target.click();
  await page.locator(`[data-row-key="session:${sessionId}"][aria-selected="true"]`).waitFor({ state: 'visible' });
}

/** A session selection may finish after its content first appears. Verify the global panel owns focus. */
export async function openBotsPanel(page, label, recordFailure = async () => {}) {
  const entry = page.getByRole('navigation').getByRole('button', { name: label, exact: true });
  const panel = page.locator('[data-bots-page]:visible');
  const attempts = [];
  const deadline = Date.now() + 20000;
  const timeout = () => Math.max(1, Math.min(4000, deadline - Date.now()));
  for (let attempt = 1; attempt <= 3 && Date.now() < deadline; attempt++) {
    try {
      await entry.waitFor({ state: 'visible', timeout: timeout() });
      await entry.click({ trial: true, timeout: timeout() });
      if (await entry.getAttribute('aria-current') !== 'page') await entry.click({ timeout: timeout() });
      await panel.waitFor({ state: 'visible', timeout: timeout() });
      // Consecutive animation frames allow native selection/render effects to settle, without a blind sleep.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (await entry.getAttribute('aria-current') === 'page' && await panel.isVisible()) return;
      throw new Error('Native panel selection was superseded by session navigation');
    } catch (error) {
      const failure = { attempt, error: String(error) }; attempts.push(failure);
      await recordFailure(failure);
    }
  }
  throw new Error(`Bots panel did not become active: ${JSON.stringify(attempts)}`);
}
