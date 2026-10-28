// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { bot, button, click, doubleClick, mountClient } from './helpers.js';
const apps: Awaited<ReturnType<typeof mountClient>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.dispose();
  vi.unstubAllGlobals();
});
describe('Bots list selection and explicit activation', () => {
  for (const language of ['en', 'zh'] as const) for (const width of [1360, 390]) {
    it(`${language}/${width}: single click shows detail; explicit actions open the selected Bot`, async () => {
      vi.stubGlobal('innerWidth', width);
      const t = language === 'en' ? en.ui : zh.ui;
      const app = await mountClient([bot(), bot({ id: 'beta-bot', name: 'Beta' })], language);
      apps.push(app);
      const query = (selector: string) => {
        const node = app.container.querySelector<HTMLElement>(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        return node;
      };
      const list = () => query('[role="listbox"]');
      const beta = () => query('[data-bot-id="beta-bot"]');
      const back = async () => {
        if (width === 390) {
          await click(button(app.container, t['bots.back']));
          expect(document.activeElement).toBe(list());
        }
      };
      await click(beta());
      await vi.waitFor(() => expect(query('[data-bot-detail="beta-bot"]')).toBeDefined());
      expect(app.remote.methods.openConversation).not.toHaveBeenCalled();
      expect(app.openSession).not.toHaveBeenCalled();
      if (width === 390) expect(document.activeElement).toBe(button(app.container, t['bots.back']));
      else expect(document.activeElement).toBe(list());
      await click(button(app.container, t['bots.newSession']));
      expect(app.remote.methods.openConversation).toHaveBeenLastCalledWith('beta-bot');
      await back();
      for (const key of ['Enter', ' ']) {
        await act(async () => { list().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
        expect(app.remote.methods.openConversation).toHaveBeenLastCalledWith('beta-bot');
        await back();
      }
      await doubleClick(beta());
      expect(app.remote.methods.openConversation).toHaveBeenCalledTimes(4);
      expect(app.openSession).toHaveBeenCalledTimes(4);
    });
  }
});
