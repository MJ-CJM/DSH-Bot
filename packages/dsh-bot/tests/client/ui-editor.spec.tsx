import { requireValue } from './test-required.js';
import { openProfile, refreshBots } from './bot-ui-helpers.js';
// @vitest-environment jsdom
import { act } from 'react';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { bot, button, click, field, fill, loadBuiltClient, mountClient, submit } from './helpers.js';

const t = en.ui;
const mounted: Awaited<ReturnType<typeof mountClient>>[] = [];
async function mount(...args: Parameters<typeof mountClient>) {
  const app = await mountClient(...args);
  mounted.push(app);
  return app;
}
afterEach(async () => {
  for (const app of mounted.splice(0).reverse()) await app.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});


describe('Bots editor, explicit launch and lifecycle', () => {
  it('renders Bot details and opens the server-selected preset, without constructing a Client prefix', async () => {
    const app = await mount([bot({ id: 'alpha-bot', name: 'Alpha Bot', avatar: '🦊', description: 'A careful helper' })]);
    await openProfile(app);
    expect(app.sidebarLabel()).toBe(t['bots.title']);
    expect(app.main.options.key).toBe('dsh-bot');
    expect(app.core.entries('sidebar.panellist')[0]?.options.id).toBe('dsh-bot');
    expect(app.container.textContent).toContain('Alpha Bot');
    expect(app.container.querySelector('article')?.textContent).toContain('A careful helper');
    expect(app.container.querySelector('article')?.textContent).toContain('🦊');
    await click(button(app.container, 'Alpha Bot'));
    expect(app.remote.methods.openConversation).toHaveBeenCalledExactlyOnceWith('alpha-bot');
    expect(app.createSession).not.toHaveBeenCalled();
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('test-created-session');
    expect(app.openWorkspace).not.toHaveBeenCalled();
  });

  it.each(['en', 'zh'] as const)('shows the localized empty page in %s', async (language) => {
    const app = await mount([], language);
    const dictionary = language === 'en' ? en.ui : zh.ui;
    expect(app.sidebarLabel()).toBe(dictionary['bots.title']);
    expect(app.container.textContent).toContain(dictionary['bots.empty']);
    expect(app.container.querySelectorAll('article')).toHaveLength(0);
    expect(button(app.container, dictionary['bots.create']).disabled).toBe(false);
  });

  it.each(['broken', 'missing'] as const)('disables %s presets and explains the Host reason', async (state) => {
    const app = await mount([bot()], 'en', (remote) => {
      remote.data.statuses = [{ id: 'alpha-bot', presetId: 'private-server-preset', preset: { state, reason: 'Host activation failed' } }];
    });
    await openProfile(app);
    const start = button(app.container, t['bots.newSession']);
    expect(start.disabled).toBe(true);
    expect(app.container.textContent).toContain('Host activation failed');
    await click(start);
    expect(app.openWorkspace).not.toHaveBeenCalled();
  });

  it('disables a Bot without a matching status instead of guessing its preset id', async () => {
    const app = await mount([bot()], 'en', (remote) => { remote.data.statuses = []; });
    await openProfile(app);
    expect(button(app.container, t['bots.newSession']).disabled).toBe(true);
    expect(app.container.textContent).toContain(t['card.statusUnknown']);
    expect(app.openWorkspace).not.toHaveBeenCalled();
  });

  it('validates the create form before Remote and saves editable fields, then refetches the list', async () => {
    const app = await mount();
    await click(button(app.container, t['bots.create']));
    await submit(app.container);
    expect(app.remote.methods.create).not.toHaveBeenCalled();
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(t['validation.name']);
    await fill(field(app.container, t['editor.name']), 'New Bot');
    await fill(field(app.container, t['editor.description']), 'New description');
    await fill(field(app.container, t['editor.persona']), 'Be precise.\nAsk when needed.');
    await fill(field(app.container, t['editor.template']), 'minimal');
    await fill(field(app.container, t['editor.hiddenTools']), 'read, write\nread');
    await fill(field(app.container, t['editor.injectLimit']), '-1');
    await submit(app.container);
    expect(app.remote.methods.create).not.toHaveBeenCalled();
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(t['validation.memory']);
    await fill(field(app.container, t['editor.injectLimit']), '7');
    await click(button(app.container, t['editor.avatar']));
    await click(button(app.container, '🧠'));
    await submit(app.container);
    expect(app.remote.methods.createForChat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: expect.any(String), language: 'en', bot: expect.objectContaining({
      id: expect.stringMatching(/^bot-/u), name: 'New Bot', avatar: '🧠', description: 'New description',
      persona: { prefix: 'Be precise.\nAsk when needed.' }, template: 'minimal',
      tools: { deny: ['read', 'write'] }, memory: { enabled: true, injectLimit: 7 },
    }) }));
    expect(app.remote.methods.list.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(app.container.querySelector('dialog,[role="dialog"]')).toBeNull();
    expect(app.container.textContent).toContain('New Bot');
    expect(app.remote.methods.openConversation).toHaveBeenCalledWith(requireValue(app.remote.data.records.at(-1)).id);
  });

  it('keeps the id immutable and sends null when an avatar is cleared, retaining advanced persona options', async () => {
    const original = bot({
      id: 'alpha-bot', name: 'Alpha Bot', avatar: '🦊',
      persona: { prefix: 'Original', suffix: 'Keep this suffix', complete: false },
      model: { provider: 'provider', model: 'model' },
    });
    const app = await mount([original]);
    await click(button(app.container, t['card.edit']));
    expect(app.container.querySelector('label')?.textContent).not.toBe(t['editor.id']);
    await click(button(app.container, t['editor.avatar']));
    await click(button(app.container, t['avatar.clear']));
    await fill(field(app.container, t['editor.persona']), 'Updated');
    await submit(app.container);
    expect(app.remote.methods.update).toHaveBeenCalledExactlyOnceWith('alpha-bot', expect.objectContaining({
      avatar: null, persona: { prefix: 'Updated', suffix: 'Keep this suffix', complete: false },
    }));
    const patch = app.remote.methods.update.mock.calls[0]?.[1];
    expect(patch).not.toHaveProperty('id');
    expect(patch).not.toHaveProperty('model');
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    expect(app.remote.data.records[0]).not.toHaveProperty('avatar');
    expect(app.remote.data.records[0]?.model).toEqual(original.model);
  });

  it('shows Remote failures as alerts, preserves the edit form, and can recover by retrying', async () => {
    const app = await mount([bot()]);
    await click(button(app.container, t['card.edit']));
    await fill(field(app.container, t['editor.name']), 'Changed locally');
    app.remote.methods.update.mockResolvedValueOnce({
      ok: false, error: new RemoteError('bot/conflict', 'Host rejected this change', {}),
    });
    await submit(app.container);
    expect(app.container.querySelector('dialog,[role="dialog"]')).not.toBeNull();
    expect(app.container.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
    expect((field(app.container, t['editor.name']) as HTMLInputElement).value).toBe('Changed locally');
    expect(app.remote.methods.list).toHaveBeenCalledTimes(1);
    await submit(app.container);
    expect(app.remote.methods.update).toHaveBeenCalledTimes(2);
    expect(app.container.querySelector('dialog,[role="dialog"]')).toBeNull();
    expect(app.container.textContent).toContain('Changed locally');
  });

  it('shows an initial read failure and a manual refresh recovers the list', async () => {
    const app = await mount([bot()], 'en', (remote) => {
      remote.methods.list.mockRejectedValueOnce(new Error('Transport is offline'));
    });
    expect(app.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(app.container.querySelectorAll('article')).toHaveLength(0);
    await refreshBots(app);
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    expect(app.container.textContent).toContain('Alpha Bot');
  });

  it('awaits an asynchronous Host refusal and displays the reason on the page', async () => {
    const app = await mount([bot()]);
    app.remote.methods.openConversation.mockRejectedValueOnce(new Error('Host refused the selected preset'));
    await click(button(app.container, 'Alpha Bot'));
    expect(app.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain('Host refused the selected preset');
    expect(button(app.container, 'Alpha Bot').disabled).toBe(false);
    await click(button(app.container, 'Alpha Bot'));
    expect(app.remote.methods.openConversation).toHaveBeenCalledTimes(2);
    expect(app.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('starts immediately with no workspace and no workspace chooser', async () => {
    const app = await mount([bot()]);
    await app.setWorkspaces({ items: [] });
    await click(button(app.container, 'Alpha Bot'));
    expect(app.remote.methods.ensureHome).not.toHaveBeenCalled();
    expect(app.remote.methods.openConversation).toHaveBeenCalledExactlyOnceWith('alpha-bot');
    expect(app.createSession).not.toHaveBeenCalled();
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('test-created-session');
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.container.querySelector('dialog')).toBeNull();
  });

  it('validates a duplicate id and calls the dedicated Remote operation before refreshing', async () => {
    const app = await mount([bot()]);
    await openProfile(app);
    await click(requireValue(app.container.querySelector('article summary')));
    await click(button(app.container, t['card.duplicate']));
    const dialog = app.container.querySelector('dialog');
    expect(dialog?.textContent).toContain('Alpha Bot');
    expect(dialog?.textContent).not.toContain('{name}');
    await fill(field(app.container, t['duplicate.id']), 'INVALID');
    await submit(app.container);
    expect(app.remote.methods.duplicate).not.toHaveBeenCalled();
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(t['validation.id']);
    await fill(field(app.container, t['duplicate.id']), 'copied-bot');
    await submit(app.container);
    expect(app.remote.methods.duplicate).toHaveBeenCalledExactlyOnceWith('alpha-bot', 'copied-bot');
    expect(app.remote.methods.create).not.toHaveBeenCalled();
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    expect(app.container.querySelectorAll('li > button[data-bot-id]')).toHaveLength(2);
    expect(app.container.querySelectorAll('[data-bot-detail]')).toHaveLength(1);
  });

  it('requires deletion confirmation with memory and history consequences; cancellation does not delete', async () => {
    const app = await mount([bot()]);
    const openDelete = async () => {
      if (!app.container.querySelector('article')) await openProfile(app);
    await click(requireValue(app.container.querySelector('article summary')));
      await click(button(app.container, t['actions.delete']));
      const dialog = app.container.querySelector('dialog');
      if (!dialog) throw new Error('Delete dialog was not mounted');
      return dialog;
    };
    let dialog = await openDelete();
    expect((field(dialog, t['delete.memories']) as HTMLInputElement).checked).toBe(true);
    expect(dialog.textContent).toContain(t['delete.description'].replace('{name}', 'Alpha Bot'));
    expect(dialog.textContent).toContain(t['delete.history']);
    expect(app.remote.methods.delete).not.toHaveBeenCalled();
    await click(button(dialog, t['actions.cancel']));
    expect(app.remote.methods.delete).not.toHaveBeenCalled();
    dialog = await openDelete();
    await click(button(dialog, t['actions.delete']));
    expect(app.remote.methods.delete).toHaveBeenCalledOnce();
    const call = app.remote.methods.delete.mock.calls[0];
    expect(call).toHaveLength(2);
    expect(call?.[0]).toBe('alpha-bot');
    expect(call?.[1]).toEqual({ deleteMemories: true, deleteHome: false, expectedCreatedAt: 1, expectedUpdatedAt: 1 });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    expect(app.container.querySelectorAll('article')).toHaveLength(0);
    expect(app.container.textContent).toContain(t['delete.success']);
  });

  it('lets the user preserve memories, sends false, and resets the choice when reopening confirmation', async () => {
    const app = await mount([bot()]);
    const openDelete = async () => {
      if (!app.container.querySelector('article')) await openProfile(app);
    await click(requireValue(app.container.querySelector('article summary')));
      await click(button(app.container, t['actions.delete']));
      return app.container.querySelector('dialog') as HTMLDialogElement;
    };
    let dialog = await openDelete();
    await click(field(dialog, t['delete.memories']));
    expect(dialog.textContent).toContain(t['delete.keepMemories']);
    expect(dialog.textContent).not.toContain(t['delete.memoriesWarning']);
    await click(button(dialog, t['actions.cancel']));
    dialog = await openDelete();
    expect((field(dialog, t['delete.memories']) as HTMLInputElement).checked).toBe(true);
    await click(field(dialog, t['delete.memories']));
    await click(button(dialog, t['actions.delete']));
    expect(app.remote.methods.delete).toHaveBeenCalledExactlyOnceWith('alpha-bot', { deleteMemories: false, deleteHome: false, expectedCreatedAt: 1, expectedUpdatedAt: 1 });
    expect(app.container.textContent).toContain(t['delete.keptSuccess']);
    expect(app.container.textContent).not.toContain(t['delete.success']);
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
  });

  it('owns the built CSS through React across redraw, page exit, plugin unload and repeated hot reload', async () => {
    const styleCount = () => document.querySelectorAll('style[data-dsh-bot-styles]').length;
    const plugin = loadBuiltClient();
    // Factory evaluation itself creates no style elements.
    expect(styleCount()).toBe(0);
    const app = await mount([bot()], 'en', undefined, {}, plugin);
    expect(styleCount()).toBe(1);
    const style = app.container.querySelector('style[data-dsh-bot-styles]');
    expect(style?.textContent).toContain('.bots_page');
    expect(app.container.querySelector('section')?.className).toContain('bots_page');
    await refreshBots(app);
    expect(styleCount()).toBe(1);
    expect(style?.isConnected).toBe(true);
    await app.unmountPage();
    expect(styleCount()).toBe(0);
    await app.remountPage();
    expect(styleCount()).toBe(1);
    for (let i = 0; i < 3; i++) {
      const previous = app.container.querySelector('style[data-dsh-bot-styles]');
      await app.reloadPlugin(loadBuiltClient());
      expect(previous?.isConnected).toBe(false);
      expect(styleCount()).toBe(1);
    }
    // Do not manually unmount React first: disappearance of the public slot must remove its view and style.
    await app.unloadPlugin();
    expect(styleCount()).toBe(0);
    expect(app.container.textContent).toBe('');
    await app.reloadPlugin(loadBuiltClient());
    expect(styleCount()).toBe(1);
    await app.dispose();
    expect(styleCount()).toBe(0);
  });

  it('releases public registrations and dictionaries when the Cordis plugin unloads', async () => {
    const app = await mount([bot()]);
    await app.unloadPlugin();
    expect(app.container.textContent).toBe('');
    expect(app.core.entries('main')).toHaveLength(0);
    expect(app.core.entries('sidebar.panellist')).toHaveLength(0);
    expect(app.dictionaries.size).toBe(0);
    expect(app.remoteMounted()).toBe(false);
    expect(app.ctx.get('remote.dshBot')).toBeUndefined();
    const reads = app.remote.methods.list.mock.calls.length;
    await act(async () => { app.ctx.emit('connection/reset'); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(reads);
  });
});
