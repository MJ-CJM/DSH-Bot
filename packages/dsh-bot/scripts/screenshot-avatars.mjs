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
      await bots.locator(`[role="option"][data-bot-id="${bot.id}"]`).click();
      await bots.locator(`[data-bot-detail="${bot.id}"]`).getByRole('button', { name: zh.ui['card.edit'], exact: true }).click();
      const editor = page.getByRole('dialog', { name: zh.ui['editor.edit'], exact: true });
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
      const avatars = await measureAvatars(page);
      verifyAvatarContrast(avatars, samples.map(sample => sample.id));
      // Ensure both rows are entirely on screen and the Bot list remains beside
      // the editor. This verifies geometry without changing production layout.
      const dialogBox = await editor.boundingBox();
      for (const group of [shapes, palette]) {
        const box = await group.boundingBox();
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
        const rows = await group.getByRole('button').evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().top)));
        assert.equal(new Set(rows).size, 1, 'Each selector fits one row at the screenshot viewport');
      }
      for (const sample of samples) {
        const box = await bots.locator(`[role="option"][data-bot-id="${sample.id}"] [data-bot-avatar]`).boundingBox();
        assert.ok(box && dialogBox && box.x + box.width <= dialogBox.x && box.y + box.height <= height, 'Different Bot avatars stay visible beside the editor');
      }
      const bodyTheme = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim());
      const file = `v022-avatar-${theme}.png`;
      setStep(`v022-avatar-${theme}-capture`);
      await page.screenshot({ path: resolve(output, file), fullPage: true, animations: 'disabled' });
      shots.push({ file, language: 'zh', theme, width, height, surface: 'avatar-editor', bodyTheme, avatars });
      save('avatar-checks.json', shots);
    } finally { await context.close(); }
  }
  assert.equal(errors.length, 0, 'No Client page errors');
  assert.notEqual(shots[0].bodyTheme, shots[1].bodyTheme, 'Real theme changes');
  const destination = resolve(root, '.codex/screens');
  mkdirSync(destination, { recursive: true });
  for (const shot of shots) copyFileSync(resolve(output, shot.file), resolve(destination, shot.file));
}
