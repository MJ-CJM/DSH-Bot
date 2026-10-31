// R06: real installed Client + Remote + Host. No DOM fixtures or model prompts.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import zh from '../locale/zh.json' with { type: 'json' };
import { dismissFirstRunOverlays, installOverlayHandler, measureAvatars, verifyAvatarContrast } from './screenshot-support.ts';

export async function captureAvatars({ browser, cookies, origin, remote, bot, researcher, output, root, shots, save, setPage, setStep, errors }) {
  const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.value; };
  const variants = ['classic', 'glasses', 'spout', 'baby', 'hat', 'sleeping'];
  const colors = ['--dsw-alias-state-business-primary', 'teal', 'purple', 'rose', 'orange', 'slate'];
  const samples = [];
  for (const [index, variant] of variants.entries()) {
    const fields = { name: zh.ui[`avatar.variant.${variant}`], avatarVariant: variant, avatarColor: colors[index] };
    const sample = index < 2
      ? unwrap(await remote.update(index === 0 ? bot.id : researcher.id, fields))
      : unwrap(await remote.create({ id: `avatar-${variant}`, ...fields }));
    samples.push(sample);
    assert.equal(unwrap(await remote.get(sample.id)).avatarVariant, variant, 'Variant round-trips through Remote/storage');
  }
  save('avatar-seed.json', { samples, modelRequests: 0 });
  for (const theme of ['light', 'dark']) {
    const width = 1920, height = 1080;
    setStep(`v022-avatar-${theme}-open`);
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', colorScheme: theme, reducedMotion: 'reduce' });
    let completed = false;
    try {
      await context.addCookies(cookies);
      await context.route('**/api/session/prompt', () => { throw new Error('Avatar screenshots must never prompt'); });
      const page = await context.newPage();
      setPage(page);
      page.setDefaultTimeout(30_000);
      page.on('pageerror', error => errors.push(error.message));
      await installOverlayHandler(page, () => {});
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunOverlays(page, () => {}, 'avatar-open');
      await page.getByRole('button', { name: 'Bots', exact: true }).click();
      const bots = page.locator('[data-bots-page]');
      for (const sample of samples) {
        await bots.locator(`[role="option"][data-bot-id="${sample.id}"] [data-avatar-variant="${sample.avatarVariant}"]`).waitFor();
      }
      // Row click/Enter opens the main conversation. Arrow selection is the
      // public management path: select details without starting navigation.
      const list = bots.getByRole('listbox', { name: zh.ui['bots.list'], exact: true });
      const ids = await list.getByRole('option').evaluateAll(options => options.map(option => option.dataset.botId));
      const targetIndex = ids.indexOf(bot.id);
      assert.ok(targetIndex >= 0, 'Editor Bot exists in the real list');
      await list.press('Home');
      for (let index = 0; index < targetIndex; index++) await list.press('ArrowDown');
      await bots.locator(`[role="option"][data-bot-id="${bot.id}"][aria-selected="true"]`).waitFor();
      const detail = bots.locator(`[data-bot-detail="${bot.id}"]`);
      await detail.waitFor({ state: 'visible' });
      const edit = detail.getByRole('button', { name: zh.ui['card.edit'], exact: true });
      setStep(`v022-avatar-${theme}-editor-ready`);
      // Trial retains Playwright's visible/enabled/stable/receives-events checks.
      // No forced click, timeout extension, or fallback to another Bot/button.
      await edit.click({ trial: true });
      assert.equal(await edit.isEnabled(), true, 'Selected Bot editor is enabled');
      await edit.click();
      const editor = page.getByRole('dialog', { name: zh.ui['editor.edit'], exact: true });
      await editor.waitFor({ state: 'visible' });
      const shapes = editor.getByRole('group', { name: zh.ui['avatar.variant'], exact: true });
      const palette = editor.getByRole('group', { name: zh.ui['avatar.color'], exact: true });
      assert.equal(await shapes.getByRole('button').count(), 6);
      assert.equal(await palette.getByRole('button').count(), 12);
      // Real native keyboard activation; jsdom cannot simulate button defaults.
      await shapes.getByRole('button', { name: zh.ui['avatar.variant.glasses'], exact: true }).focus();
      await page.keyboard.press('Space');
      await palette.getByRole('button', { name: zh.ui['avatar.purple'], exact: true }).focus();
      await page.keyboard.press('Enter');
      const preview = editor.getByRole('img', { name: zh.ui['avatar.current'], exact: true });
      assert.equal(await preview.getAttribute('data-avatar-variant'), 'glasses');
      assert.equal(await preview.getAttribute('data-avatar-color'), 'purple');
      await preview.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      const picker = editor.locator('[data-avatar-picker]');
      const avatars = await measureAvatars(page, '[data-avatar-picker] [data-bot-avatar]');
      assert.equal(avatars.length, 19, 'Preview + six shapes + twelve colors are measured');
      verifyAvatarContrast(avatars, [bot.id]);
      // The selector itself must fit; the modal intentionally covers the list.
      for (const group of [shapes, palette]) {
        const box = await group.boundingBox();
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
        const rows = await group.getByRole('button').evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().top)));
        assert.equal(new Set(rows).size, 1, 'Each selector fits one row at the screenshot viewport');
      }
      const bodyTheme = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim());
      const file = `v022-avatar-${theme}.png`;
      setStep(`v022-avatar-${theme}-selector-capture`);
      await picker.screenshot({ path: resolve(output, file), animations: 'disabled' });
      shots.push({ file, language: 'zh', theme, width, height, surface: 'avatar-selector', bodyTheme, avatars });
      save('avatar-checks.json', shots);

      setStep(`v022-avatar-${theme}-list-ready`);
      await editor.getByRole('button', { name: zh.ui['actions.close'], exact: true }).click();
      await editor.waitFor({ state: 'detached' });
      await list.scrollIntoViewIfNeeded();
      const listAvatars = await measureAvatars(page, '[data-bots-page] [role="listbox"] [data-bot-avatar]');
      verifyAvatarContrast(listAvatars, samples.map(sample => sample.id));
      const visible = [];
      for (const sample of samples) {
        const avatar = list.locator(`[role="option"][data-bot-id="${sample.id}"] [data-bot-avatar]`);
        await avatar.waitFor({ state: 'visible' });
        assert.equal(await avatar.getAttribute('data-avatar-variant'), sample.avatarVariant);
        assert.equal(await avatar.getAttribute('data-avatar-color'), sample.avatarColor);
        const evidence = await avatar.evaluate(element => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { inViewport: box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
            unobscured: hit !== null && element.contains(hit) };
        });
        assert.ok(evidence.inViewport && evidence.unobscured, `List avatar ${sample.id} is fully visible without a modal`);
        visible.push({ botId: sample.id, variant: sample.avatarVariant, color: sample.avatarColor, ...evidence });
      }
      assert.equal(new Set(visible.map(sample => sample.variant)).size, 6);
      assert.equal(new Set(visible.map(sample => sample.color)).size, 6);
      const listFile = `v022-avatar-list-${theme}.png`;
      setStep(`v022-avatar-${theme}-list-capture`);
      await list.screenshot({ path: resolve(output, listFile), animations: 'disabled' });
      shots.push({ file: listFile, language: 'zh', theme, width, height, surface: 'avatar-list', bodyTheme, avatars: listAvatars, visible });
      save('avatar-checks.json', shots);
      completed = true;
    } finally {
      // Outer runner captures failure evidence before closing the browser.
      if (completed) await context.close();
    }
  }
  assert.equal(errors.length, 0, 'No Client page errors');
  assert.equal(shots.length, 4, 'Both themes include the selector and unobscured list');
  assert.notEqual(shots.find(shot => shot.theme === 'light').bodyTheme, shots.find(shot => shot.theme === 'dark').bodyTheme, 'Real theme changes');
  const destination = resolve(root, '.codex/screens');
  mkdirSync(destination, { recursive: true });
  for (const shot of shots) copyFileSync(resolve(output, shot.file), resolve(destination, shot.file));
}
