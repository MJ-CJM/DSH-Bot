// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JSDOM } from 'jsdom';
import type { BotsPageInjected } from '../../src/client/pages/bots-page-types.js';
import { conversationKey, recentPreferences, setRecentPreference } from '../../src/client/pages/recent-conversations.js';
import { readDirectoryWindow, writeDirectoryWindow } from '../../src/client/pages/native-directory.js';
import { groupKey } from '../../src/shared/groups.js';
import { bots, configure, summary } from './group-fixture.js';
import { button, click, mountClient } from './helpers.js';
import { requireValue } from './test-required.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

let app: Awaited<ReturnType<typeof mountClient>>;
async function mount(lang: 'en' | 'zh' = 'en', archived = false) {
  app = await mountClient(bots, lang, remote => {
    configure(remote);
    const first = summary();
    first.group.archived = archived;
    requireValue(remote.data.groupView).group.archived = archived;
    const second = summary();
    second.group = { ...second.group, id: 'group:other', rootSessionId: 'group-root-other' };
    remote.data.groups = [first, second];
    remote.groups.deleteGroup.mockImplementation(async key => {
      remote.data.groups = remote.data.groups.filter(row => row.group.id !== key.groupId || row.group.createdAt !== key.groupCreatedAt);
      return { ok: true, value: true };
    });
  });
  return requireValue((requireValue(app.main.inject)() as unknown as BotsPageInjected).groups);
}
// Node 25 exposes a process localStorage object without Storage methods when no
// storage file is configured. Vitest preserves existing Node globals, so bind
// the actual browser Storage instances from this suite's JSDOM environment.
beforeEach(() => {
  const browser = (globalThis as typeof globalThis & { jsdom: JSDOM }).jsdom.window;
  vi.stubGlobal('localStorage', browser.localStorage);
  vi.stubGlobal('sessionStorage', browser.sessionStorage);
  localStorage.clear(); sessionStorage.clear(); recentPreferences.clear();
});
afterEach(async () => {
  try { await app.dispose(); }
  finally {
    localStorage.clear(); sessionStorage.clear(); recentPreferences.clear();
    vi.unstubAllGlobals();
  }
});

const target = summary().group;
const row = () => requireValue(app.container.querySelector<HTMLElement>('[data-directory-id="group:one"]'));
const dialog = () => requireValue(document.body.querySelector('dialog'));
async function openDelete(label: string) {
  await click(requireValue(row().querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')));
  await click(button(document.body, label));
}

it.each(['en', 'zh'] as const)('deletes only the approved archived group through its directory menu (%s)', async lang => {
  const copy = (lang === 'en' ? en : zh).ui;
  await mount(lang, true);
  await click(button(app.container, copy['groups.title']));
  await click(button(app.container, copy['groups.filter']));
  await click(button(app.container, copy['groups.filter.archived']));
  await openDelete(copy['groups.delete']);
  expect(dialog().textContent).toContain(target.name);
  expect(dialog().textContent).toContain(target.id);
  expect(dialog().textContent).toContain(copy['groups.deleteImpact']);
  await click(button(dialog(), copy['actions.cancel']));
  expect(app.remote.groups.deleteGroup).not.toHaveBeenCalled();
  const key = conversationKey('group', target.id, target.createdAt), other = conversationKey('group', 'group:other', target.createdAt);
  setRecentPreference(key, 'pinned'); setRecentPreference(other, 'pinned');
  writeDirectoryWindow(sessionStorage, location.pathname, 'selection', { selected: key });
  await openDelete(copy['groups.delete']);
  await click(button(dialog(), copy['groups.delete']));
  expect(app.remote.groups.deleteGroup).toHaveBeenCalledExactlyOnceWith(groupKey(target), target.revision);
  expect(app.container.querySelector('[data-directory-id="group:one"]')).toBeNull();
  expect(app.remote.data.groups.map(row => row.group.id)).toEqual(['group:other']);
  expect(recentPreferences.has(key)).toBe(false);
  expect(recentPreferences.get(other)?.pinned).toBe(true);
  expect(readDirectoryWindow(sessionStorage, location.pathname, 'selection').selected).toBeUndefined();
});

it('invalidates an open consent after a revision change or a replacement with the same ID', async () => {
  const actions = await mount();
  await click(button(app.container, en.ui['chat.recent']));
  await openDelete(en.ui['groups.delete']);
  for (const replacement of [{ ...target, revision: 2 }, { ...target, createdAt: target.createdAt + 1 }]) {
    app.remote.data.groups = [{ ...summary(), group: replacement }];
    await act(async () => actions.catalog.refresh());
    expect(button(dialog(), en.ui['groups.delete']).disabled).toBe(true);
    expect(dialog().textContent).toContain(en.ui['groups.deleteChanged']);
  }
  expect(app.remote.groups.deleteGroup).not.toHaveBeenCalled();
});

it('explains active groups, managed groups and a late Host refusal without retrying deletion', async () => {
  const actions = await mount();
  await click(button(app.container, en.ui['chat.recent']));
  await openDelete(en.ui['groups.delete']);
  const first = requireValue(app.remote.data.groups[0]);
  app.remote.data.groups = [{ ...first, running: true }];
  await act(async () => actions.catalog.refresh());
  expect(button(dialog(), en.ui['groups.delete']).disabled).toBe(true);
  expect(dialog().textContent).toContain(en.ui['groups.deleteBusy']);
  app.remote.data.groups = [first];
  await act(async () => actions.catalog.refresh());
  app.remote.groups.deleteGroup.mockRejectedValueOnce({ code: 'dsh-bot/busy' });
  await click(button(dialog(), en.ui['groups.delete']));
  expect(dialog().textContent).toContain(en.ui['groups.deleteBusy']);
  expect(button(dialog(), en.ui['groups.delete']).disabled).toBe(true);
  expect(app.remote.groups.deleteGroup).toHaveBeenCalledTimes(1);
  await click(button(dialog(), en.ui['actions.cancel']));
  const owner = { botId: 'alpha', botCreatedAt: 1 };
  const managed = { ...first.group, supergroup: { workId: 'work:1', originSessionId: 'main:alpha', originMessageId: 'message:1', owner, readers: [owner], expiresAt: 1000 } };
  app.remote.data.groups = [{ ...first, group: managed }];
  await act(async () => actions.catalog.refresh());
  await openDelete(en.ui['groups.delete']);
  expect(dialog().textContent).toContain(en.ui['groups.deleteManaged']);
  expect(button(dialog(), en.ui['groups.delete']).disabled).toBe(true);
});
