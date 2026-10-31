import { requireValue } from './test-required.js';
import { act } from 'react';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { button, click, type mountClient } from './helpers.js';
import type { BotsPageInjected } from '../../src/client/pages/BotsPage.js';
type App = Awaited<ReturnType<typeof mountClient>>;
export async function openProfile(app: App, language: 'en' | 'zh' = 'en', id = 'alpha-bot') {
  const row = app.container.querySelector(`[data-bot-id="${id}"]`)?.closest('li');
  if (!row) throw new Error(`Missing recent Bot ${id}`);
  await click(requireValue(row.querySelector('summary')));
  await click(button(row, (language === 'zh' ? zh.ui : en.ui)['chat.profile']));
}
export async function openHistory(app: App, language: 'en' | 'zh' = 'en') {
  await openProfile(app, language);
  const article = requireValue(app.container.querySelector('article'));
  await click(requireValue(article.querySelector('summary')));
  await click(button(article, (language === 'zh' ? zh.ui : en.ui)['bots.history']));
}
export async function refreshBots(app: App) {
  await act(async () => (requireValue(app.main.inject)() as unknown as BotsPageInjected).onRefresh());
}
export async function openSettings(app: App, language: 'en' | 'zh' = 'en') {
  const copy = language === 'zh' ? zh.ui : en.ui;
  const trigger = [...app.container.querySelectorAll('button')].find(node => node.textContent === copy['chat.settings']);
  if (trigger) await click(trigger);
}
export async function openMaintenance(app: App, language: 'en' | 'zh' = 'en') {
  await openSettings(app, language);
  const trigger = [...app.container.querySelectorAll('button')].find(node => node.textContent === (language === 'zh' ? zh.ui : en.ui)['manage.memoryTools']);
  if (trigger) await click(trigger);
}
