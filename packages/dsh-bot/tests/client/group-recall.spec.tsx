// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import type { GroupRecallItem, GroupRecallPage } from '../../src/shared/group-recall.js';
import type { BotsPageInjected } from '../../src/client/pages/BotsPage.js';
import { groupKey } from '../../src/shared/groups.js';
import { openProfile } from './bot-ui-helpers.js';
import { view } from './group-fixture.js';
import { bot, button, click, field, fill, mountClient } from './helpers.js';
import { requireValue } from './test-required.js';

const owner = bot();
const ownerKey = { botId: owner.id, botCreatedAt: owner.createdAt };
const group = view().group;
const recalled: GroupRecallItem = {
  group: groupKey(group), groupName: group.name, memberId: 'member:alpha', turnId: 'turn:one',
  deliveryId: 'delivery:one', childSessionId: 'child:one', state: 'completed', at: 10,
  sources: [
    { role: 'question', sessionId: group.rootSessionId, messageId: 'question:one', seq: 2, text: 'How should we validate this release?' },
    { role: 'answer', sessionId: group.rootSessionId, messageId: 'answer:one', seq: 4, text: 'Compare the frozen package hash.' },
  ],
};
const exact = { group: recalled.group, turnId: recalled.turnId, limit: 20 };
const reply = (value: GroupRecallPage) => ({ ok: true as const, value });
const page = (items: GroupRecallItem[] = [recalled], extra: Partial<GroupRecallPage> = {}) => reply({ items, incomplete: false, ...extra });

async function openMemory(app: Awaited<ReturnType<typeof mountClient>>, language: 'en' | 'zh' = 'en') {
  const copy = language === 'en' ? en.ui : zh.ui;
  await openProfile(app, language);
  await click(button(app.container, copy['detail.memory']));
  return requireValue(app.container.querySelector(`section[aria-label="${copy['groupRecall.title']}"]`));
}

describe('group recall in the existing Bot memory page', () => {
  it.each(['en', 'zh'] as const)('loads a small Bot-scoped page, searches and paginates in %s', async language => {
    const copy = language === 'en' ? en.ui : zh.ui;
    const later = { ...recalled, turnId: 'turn:two', deliveryId: 'delivery:two', groupName: 'Second page' };
    const app = await mountClient([owner], language, remote => {
      remote.groups.recallForBot.mockImplementation(async (_bot, input) => {
        if (input.cursor === 'next') return page([later], { incomplete: true });
        if (input.query === 'missing') return page([]);
        if (input.query === 'unavailable') return page([], { unavailable: true, incomplete: true });
        return page([recalled], { nextCursor: 'next' });
      });
    });
    try {
      expect(app.remote.groups.recallForBot).not.toHaveBeenCalled();
      const section = await openMemory(app, language);
      expect(app.remote.groups.recallForBot).toHaveBeenCalledExactlyOnceWith(ownerKey, { limit: 3 });
      expect(section.textContent).toContain(copy['groupRecall.description']);
      expect(section.textContent).toContain(recalled.groupName);
      expect(requireValue(section.querySelector('details')).open).toBe(false);
      expect(button(app.container, copy['memory.add'])).toBeTruthy();
      await click(button(section, copy['groupRecall.more']));
      expect(app.remote.groups.recallForBot).toHaveBeenLastCalledWith(ownerKey, { limit: 3, cursor: 'next' });
      expect(section.textContent).toContain(later.groupName);
      expect(section.textContent).toContain(copy['groupRecall.incomplete']);
      await fill(field(section, copy['groupRecall.search']), '  missing  ');
      await click(button(section, copy['memory.searchAction']));
      expect(app.remote.groups.recallForBot).toHaveBeenLastCalledWith(ownerKey, { limit: 3, query: 'missing' });
      expect(section.textContent).toContain(copy['groupRecall.noMatches']);
      expect(section.textContent).not.toContain(later.groupName);
      await fill(field(section, copy['groupRecall.search']), 'unavailable');
      await click(button(section, copy['memory.searchAction']));
      expect(section.textContent).toContain(copy['groupRecall.unavailable']);
      expect(section.textContent).not.toContain(copy['groupRecall.noMatches']);
      expect(app.remote.methods.memory.save).not.toHaveBeenCalled();
    } finally { await app.dispose(); }
  });

  it('uses the original group turn and prepares a source-specific native draft without sending or saving', async () => {
    const app = await mountClient([owner], 'en', remote => {
      remote.data.groupView = view();
      remote.groups.recallForBot.mockResolvedValue(page());
    });
    const init = vi.fn<() => 'applied' | 'blocked'>(() => 'applied');
    const send = vi.fn();
    app.ctx.provide('conversation', { input: { requestDraftInitialization: init }, send } as never);
    const binding = { ctx: app.ctx };
    const using = vi.fn(async (_id: unknown, _options: unknown, operation: (reference: unknown) => Promise<void>) => operation({ ready: Promise.resolve(binding) }));
    Object.assign(app.ctx.sessions, { using });
    try {
      const section = await openMemory(app);
      app.remote.groups.recallForBot.mockResolvedValueOnce(page([{ ...recalled, deliveryId: 'delivery:newer' }], { nextCursor: 'exact-next' }));
      await click(button(section, en.ui['groupRecall.open']));
      expect(app.remote.groups.recallForBot).toHaveBeenLastCalledWith(ownerKey, { ...exact, cursor: 'exact-next' });
      expect(app.remote.groups.open).toHaveBeenCalledExactlyOnceWith(recalled.group);
      expect(app.openSession).toHaveBeenLastCalledWith(group.rootSessionId);
      const injected = app.main.inject?.() as unknown as BotsPageInjected;
      expect(injected.groups?.runRequests.getSnapshot()).toMatchObject({ turnId: recalled.turnId, source: { messageId: 'question:one', seq: 2 } });
      await click(button(section, en.ui['groupRecall.remember']));
      expect(app.remote.groups.recallForBot).toHaveBeenLastCalledWith(ownerKey, exact);
      expect(init).toHaveBeenCalledExactlyOnceWith(binding, { prompt: expect.stringContaining(JSON.stringify({
        group: recalled.group, turnId: recalled.turnId, deliveryId: recalled.deliveryId,
        sessionId: group.rootSessionId, messageId: 'answer:one', seq: 4,
      })) });
      expect(app.openSession).toHaveBeenLastCalledWith('test-created-session');
      init.mockReturnValueOnce('blocked');
      app.openSession.mockClear();
      await click(button(section, en.ui['groupRecall.remember']));
      expect(section.textContent).toContain(en.ui['groupRecall.rememberFailed']);
      expect(app.openSession).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(app.remote.methods.memory.save).not.toHaveBeenCalled();
      expect(app.remote.groups.send).not.toHaveBeenCalled();
    } finally { await app.dispose(); }
  });

  it('rejects stale sources and cancels navigation when the retained memory tab is hidden', async () => {
    const app = await mountClient([owner], 'en', remote => {
      remote.data.groupView = view();
      remote.groups.recallForBot.mockResolvedValue(page());
    });
    try {
      const section = await openMemory(app);
      app.remote.groups.recallForBot.mockResolvedValueOnce(page([], { unavailable: true }));
      await click(button(section, en.ui['groupRecall.open']));
      expect(section.textContent).toContain(en.ui['groupRecall.openFailed']);
      expect(app.remote.groups.open).not.toHaveBeenCalled();
      let resolve: ((value: ReturnType<typeof page>) => void) | undefined;
      app.remote.groups.recallForBot.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
      await click(button(section, en.ui['groupRecall.open']));
      await click(button(app.container, en.ui['detail.overview']));
      await act(async () => requireValue(resolve)(page()));
      expect(app.remote.groups.open).not.toHaveBeenCalled();
      expect(app.openSession).not.toHaveBeenCalled();
    } finally { await app.dispose(); }
  });

  it('explains that group recall is off without reading group records or changing personal memory', async () => {
    const app = await mountClient([{ ...owner, memory: { ...owner.memory, enabled: false } }]);
    try {
      const section = await openMemory(app);
      expect(section.textContent).toContain(en.ui['groupRecall.disabled']);
      expect(app.remote.groups.recallForBot).not.toHaveBeenCalled();
      expect(button(app.container, en.ui['memory.add'])).toBeTruthy();
    } finally { await app.dispose(); }
  });
});
