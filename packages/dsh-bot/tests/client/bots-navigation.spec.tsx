// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { bot, button, click, field, fill, mountClient, submit } from './helpers.js';
import { bots, configure, summary } from './group-fixture.js';
import { requireValue } from './test-required.js';
import { openEditor, openProfile } from './bot-ui-helpers.js';
import { conversationKey, recentPreferences } from '../../src/client/pages/recent-conversations.js';
import type { BotsPageInjected } from '../../src/client/pages/bots-page-types.js';
import { connectorSchema } from '../../src/shared/integrations.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

const mounted: Awaited<ReturnType<typeof mountClient>>[] = [];
async function mount(...args: Parameters<typeof mountClient>) { const app = await mountClient(...args); mounted.push(app); return app; }
const actions = (app: Awaited<ReturnType<typeof mountClient>>) => requireValue(app.main.inject)() as unknown as BotsPageInjected;
const settingsButton = (app: Awaited<ReturnType<typeof mountClient>>) => requireValue(app.container.querySelector<HTMLButtonElement>('[data-settings-navigation]'));
afterEach(async () => { for (const app of mounted.splice(0)) await app.dispose(); recentPreferences.clear(); vi.restoreAllMocks(); });

it.each(['en', 'zh'] as const)('%s shows every Bot independently of recent hiding and groups', async language => {
  const copy = (language === 'en' ? en : zh).ui;
  const unseen = bot({ id: 'no-sessions', name: 'No sessions' });
  const app = await mount([...bots, unseen], language, configure);
  recentPreferences.set(conversationKey('bot', unseen.id, unseen.createdAt), { hidden: true });
  await act(async () => actions(app).onRefresh());
  expect(app.container.querySelectorAll('[data-bots-list="bots"] button[data-bot-id]')).toHaveLength(3);
  expect(app.container.querySelector('[data-bots-list]')?.textContent).not.toContain('Synthetic group');
  await click(button(app.container, copy['chat.recent']));
  expect(app.container.querySelector(`[data-bot-id="${unseen.id}"]`)).toBeNull();
  expect(app.container.querySelector('[data-bots-list]')?.textContent).toContain('Synthetic group');
  await click(button(app.container, copy['navigation.myBots']));
  expect(app.container.querySelector(`[data-bot-id="${unseen.id}"]`)).toBeTruthy();
  expect(app.remote.methods.openConversation).not.toHaveBeenCalled();
  expect(app.openSession).not.toHaveBeenCalled();
});

it('returns to the same group, allows member details, and consumes navigation exactly once', async () => {
  const app = await mount(bots, 'en', configure), group = summary().group, page = actions(app);
  await act(async () => page.groups?.select(group.id, group.createdAt));
  await vi.waitFor(() => expect(app.container.querySelector('article')?.getAttribute('aria-label')).toBe(group.name));
  const article = requireValue(app.container.querySelector('article'));
  expect(article.querySelectorAll('[data-group-member]')).toHaveLength(2);
  await click(button(article.querySelector('[data-group-member="member:alpha"]') as HTMLElement, en.ui['execution.memberActions'].replace('{name}', 'Same name')));
  await click(button(article, en.ui['chat.profile']));
  expect(app.container.querySelector('[data-bot-detail]')?.getAttribute('data-bot-detail')).toBe('alpha');
  await click(button(app.container, 'Back to Groups'));
  expect(app.container.querySelector('article')).toBe(article);
  await click(settingsButton(app));
  expect(settingsButton(app).textContent).toBe('Back to Synthetic group');
  await act(async () => { await page.groups?.selection.refresh(); await page.groups?.catalog.refresh(); });
  expect(app.container.querySelector('h1')?.textContent).toBe(en.ui['chat.settings']);
  await click(settingsButton(app));
  expect(app.container.querySelector('article')).toBe(article);
  expect(document.activeElement).toBe(settingsButton(app));
  await click(button(app.container, en.ui['navigation.myBots']));
  await app.unmountPage(); await app.remountPage();
  expect(app.container.querySelector('[data-bots-list]')?.getAttribute('data-bots-list')).toBe('bots');
  expect(page.groups?.selection.getSnapshot().selectedId).toBeUndefined();
  expect(app.openSession).not.toHaveBeenCalled();
});

it.each(['bots', 'recent'] as const)('restores %s search and scroll through settings and native panel remounts', async section => {
  const app = await mount([bot({ id: 'alpha', name: 'Alpha' }), bot({ id: 'beta', name: 'Beta' })]);
  if (section === 'recent') await click(button(app.container, en.ui['chat.recent']));
  await fill(field(app.container, en.ui[section === 'bots' ? 'navigation.searchBots' : 'chat.search']), 'Beta');
  const scroll = requireValue(app.container.querySelector<HTMLDivElement>('[data-bots-page] > div'));
  await act(async () => { scroll.scrollTop = 120; scroll.dispatchEvent(new Event('scroll')); });
  await click(settingsButton(app)); await click(settingsButton(app));
  expect(field(app.container, en.ui[section === 'bots' ? 'navigation.searchBots' : 'chat.search']).value).toBe('Beta');
  expect(scroll.scrollTop).toBe(120);
  await app.unmountPage(); await app.remountPage();
  expect(field(app.container, en.ui[section === 'bots' ? 'navigation.searchBots' : 'chat.search']).value).toBe('Beta');
  expect(actions(app).pageNavigation?.section).toBe(section);
});

it('does not substitute a recreated group into an open detail', async () => {
  const app = await mount(bots, 'en', configure), page = actions(app), group = summary().group;
  await act(async () => page.groups?.select(group.id, group.createdAt));
  await vi.waitFor(() => expect(app.container.querySelector('article')).toBeTruthy());
  await click(settingsButton(app));
  app.remote.data.groups = [{ ...summary(), group: { ...group, createdAt: group.createdAt + 1 } }];
  await act(async () => page.groups?.catalog.refresh());
  await click(settingsButton(app));
  expect(app.container.querySelector('article')).toBeNull();
  expect(app.container.textContent).toContain(en.ui['navigation.targetMissing']);
  expect(page.pageNavigation?.group).toBeUndefined();
});

it('protects unsaved connector settings when returning or changing the selected Bot', async () => {
  const app = await mount(bots);
  await click(settingsButton(app));
  await click(button(app.container, en.ui['connectors.newConnector']));
  await fill(field(app.container, en.ui['integrations.label']), 'Unsaved connector');
  await click(settingsButton(app));
  expect(app.container.querySelector('dialog')?.textContent).toContain(en.ui['navigation.unsaved']);
  await click(button(requireValue(app.container.querySelector('dialog')), en.ui['navigation.keepEditing']));
  expect(field(app.container, en.ui['integrations.label']).value).toBe('Unsaved connector');
  const owner = field(app.container, en.ui['integrations.bot']) as HTMLSelectElement;
  await act(async () => { owner.value = 'beta'; owner.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(app.container.querySelector('dialog')).toBeTruthy();
  await click(button(requireValue(app.container.querySelector('dialog')), en.ui['navigation.keepEditing']));
  expect(owner.value).toBe('alpha');
  await click(settingsButton(app));
  await click(button(requireValue(app.container.querySelector('dialog')), en.ui['navigation.discardLeave']));
  expect(app.container.querySelector('h1')?.textContent).toBe(en.ui['bots.title']);
  await click(settingsButton(app));
  expect(app.container.querySelector('form')).toBeNull();
  expect(app.remote.connectors.saveDefinition).not.toHaveBeenCalled();
});

it('saved HTTP connector credentials do not cause a false unsaved warning', async () => {
  const app = await mount(bots);
  await click(settingsButton(app));
  await click(button(app.container, en.ui['connectors.newConnector']));
  await fill(field(app.container, en.ui['integrations.id']), 'saved-connector');
  await fill(field(app.container, en.ui['integrations.label']), 'Saved connector');
  await fill(field(app.container, en.ui['connectors.url']), 'https://example.test/mcp');
  await fill(field(app.container, en.ui['connectors.credentialRef']), 'REFERENCE_ONLY');
  app.remote.connectors.saveDefinition.mockImplementation(async (input, expected) => ({ ok: true,
    value: connectorSchema.parse({ ...input, revision: expected + 1, createdAt: 1, updatedAt: 1, schemaVersion: 1 }) }));
  await submit(app.container);
  expect(app.remote.connectors.saveDefinition).toHaveBeenCalledOnce();
  await click(settingsButton(app));
  expect(app.container.querySelector('dialog')).toBeNull();
  expect(app.container.querySelector('h1')?.textContent).toBe(en.ui['bots.title']);
});


it('retains search, scroll and exact profile-button focus when returning from inline details', async () => {
  const app = await mount([bot()]);
  await fill(field(app.container, en.ui['navigation.searchBots']), 'Alpha');
  const scroll = requireValue(app.container.querySelector<HTMLDivElement>('[data-bots-page] > div'));
  const trigger = button(app.container, en.ui['chat.profile']);
  await act(async () => { scroll.scrollTop = 120; trigger.focus(); });
  await openProfile(app);
  expect(app.container.querySelector('dialog')).toBeNull();
  await click(button(app.container, 'Back to My Bots'));
  expect(field(app.container, en.ui['navigation.searchBots']).value).toBe('Alpha');
  expect(scroll.scrollTop).toBe(120);
  expect(document.activeElement).toBe(trigger);
});

it('retains an inline profile draft across tabs and guards leaving it', async () => {
  const app = await mount([bot()]);
  await openEditor(app);
  await fill(field(app.container, en.ui['editor.description']), 'Unsaved profile');
  await click(button(app.container, en.ui['detail.overview']));
  await click(button(app.container, en.ui['detail.settings']));
  expect(field(app.container, en.ui['editor.description']).value).toBe('Unsaved profile');
  await click(button(app.container, 'Back to My Bots'));
  await click(button(requireValue(app.container.querySelector('dialog')), en.ui['navigation.keepEditing']));
  expect(field(app.container, en.ui['editor.description']).value).toBe('Unsaved profile');
  await click(button(app.container, 'Back to My Bots'));
  await click(button(requireValue(app.container.querySelector('dialog')), en.ui['navigation.discardLeave']));
  expect(app.container.querySelector('[data-bot-detail]')).toBeNull();
  expect(app.remote.methods.update).not.toHaveBeenCalled();
});

it('never substitutes a recreated Bot into an open detail or draft', async () => {
  const original = bot();
  const app = await mount([original]);
  await openEditor(app);
  await fill(field(app.container, en.ui['editor.description']), 'Old identity draft');
  app.remote.data.records = [{ ...original, createdAt: original.createdAt + 1 }];
  await act(async () => actions(app).onRefresh());
  expect(app.container.querySelector('[data-bot-detail]')).toBeNull();
  await openProfile(app);
  expect(app.container.querySelector('[data-bot-detail]')?.getAttribute('data-bot-identity')).toBe(`${original.id}:${original.createdAt + 1}`);
  expect(app.remote.methods.update).not.toHaveBeenCalled();
});
