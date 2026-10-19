// @vitest-environment jsdom
import { act } from 'react';
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { bot, button, click, field, fill, mountClient, submit, workspace } from './helpers.js';

const apps: Awaited<ReturnType<typeof mountClient>>[] = [];
type App = Awaited<ReturnType<typeof mountClient>>;
type Surface = 'page' | 'footer' | 'right';
const surfaces = ['page', 'footer', 'right'] as const;
const home = '/test/dsh-bot/bots/alpha-bot/home';
async function mount(language: 'en' | 'zh' = 'en', records = [bot()]) {
  const app = await mountClient(records, language, undefined, {}, undefined, true);
  apps.push(app);
  return app;
}
async function surface(app: App, name: Surface, dictionary = en.ui) {
  if (name === 'page') return { container: app.container, start: () => click(button(app.container, dictionary['bots.newSession'])) };
  await app.unmountPage();
  if (name === 'footer') {
    const container = await app.mountSidebar();
    await click(button(container, dictionary['sidebar.sessions']));
    return { container, start: () => click(button(container, dictionary['sidebar.newSession'].replace('{name}', 'Alpha Bot'))) };
  }
  const container = await app.mountRightTab();
  return { container, start: () => click(container.querySelector<HTMLElement>('[role="option"]') as HTMLElement) };
}
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.dispose();
  vi.restoreAllMocks();
});

describe('workspace-free Bot chat', () => {
  it.each(surfaces)('creates from %s with cwd and the Host preset even when no workspace exists', async (name) => {
    const app = await mount();
    await app.setWorkspaces({ items: [], phase: 'pending', state: 'loading' });
    const view = await surface(app, name);
    await view.start();
    expect(app.remote.methods.ensureHome).toHaveBeenCalledExactlyOnceWith('alpha-bot');
    expect(app.createSession).toHaveBeenCalledExactlyOnceWith({ cwd: home, agentPreset: 'host-selected/alpha-bot' });
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('test-created-session');
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(view.container.querySelector('select')).toBeNull();
  });

  it('uses the latest custom cwd without preparing the private home or choosing from multiple workspaces', async () => {
    const app = await mount();
    await app.setWorkspaces({ items: [workspace(), workspace('second')] });
    app.remote.data.records = [bot({ id: 'alpha-bot', name: 'Alpha Bot', defaultCwd: '/test/custom-work' })];
    await click(button(app.container, en.ui['bots.newSession']));
    expect(app.remote.methods.get).toHaveBeenCalledExactlyOnceWith('alpha-bot');
    expect(app.remote.methods.ensureHome).not.toHaveBeenCalled();
    expect(app.createSession).toHaveBeenCalledExactlyOnceWith({ cwd: '/test/custom-work', agentPreset: 'host-selected/alpha-bot' });
    expect(app.container.querySelector('dialog')).toBeNull();
    expect(app.openWorkspace).not.toHaveBeenCalled();
  });

  it.each(surfaces.flatMap((name) => ['home', 'create'].map((stage) => ({ name, stage }))))('keeps $name open and reports $stage refusal without navigation', async ({ name, stage }) => {
    const app = await mount();
    const view = await surface(app, name);
    if (stage === 'home') app.remote.methods.ensureHome.mockResolvedValueOnce({ ok: false, error: new RemoteError('bot/invalid', 'Home unavailable', {}) });
    else app.createSession.mockRejectedValueOnce(new Error('Creation denied'));
    await view.start();
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    if (name === 'page') expect(view.container.querySelector('[data-bot-detail] [data-chat-error]')).not.toBeNull();
    if (stage === 'home') expect(app.createSession).not.toHaveBeenCalled();
    expect(app.openSession).not.toHaveBeenCalled();
    expect(app.openWorkspace).not.toHaveBeenCalled();
    await view.start();
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('test-created-session');
  });

  it.each(surfaces.flatMap((name) => ['home', 'create'].map((stage) => ({ name, stage }))))('ignores late $stage completion after $name unload', async ({ name, stage }) => {
    const app = await mount();
    const view = await surface(app, name);
    let finish!: () => void;
    if (stage === 'home') app.remote.methods.ensureHome.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true, value: { path: home } });
    }));
    else app.createSession.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve('late-session' as SessionId); }));
    await view.start();
    if (name === 'page') await app.unmountPage();
    else if (name === 'right') await app.unmountRightTab();
    else await app.unloadPlugin();
    await act(async () => finish());
    if (stage === 'home') expect(app.createSession).not.toHaveBeenCalled();
    expect(app.openSession).not.toHaveBeenCalled();
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.openRightTab).not.toHaveBeenCalled();
  });

  it('keeps the right tab workspace action available through its secondary menu', async () => {
    const app = await mount();
    await app.setWorkspaces({ items: [workspace(), workspace('workspace-two', 'Second')] });
    const view = await surface(app, 'right');
    await click(button(view.container, en.ui['card.more']));
    await click(button(view.container, en.ui['chat.inWorkspace']));
    await fill(field(view.container, en.ui['chat.workspace']), 'workspace-two');
    await submit(view.container);
    expect(app.openWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-two', expect.any(Function), { agentPreset: 'host-selected/alpha-bot' });
    expect(app.createSession).not.toHaveBeenCalled();
    expect(app.remote.methods.ensureHome).not.toHaveBeenCalled();
  });

  it.each(['en', 'zh'] as const)('never shows home basename as the conversation title in %s', async (language) => {
    const app = await mount(language);
    const dictionary = language === 'en' ? en.ui : zh.ui;
    const row: SessionSummary = { id: 'home-chat' as SessionId, displayTitle: 'home', cwd: home,
      running: false, blank: false, updatedAt: 1, retainedBy: {}, projectionValues: { agentPreset: 'host-selected/alpha-bot' } };
    await app.setSessions({ ids: [row.id], byId: { [row.id]: row } });
    expect(app.container.querySelector('[data-session-id]')?.textContent).toContain(dictionary['sidebar.untitled']);
    app.remote.data.activities = [{ botId: 'alpha-bot', sessionId: row.id, updatedAt: 2, unread: false, firstUserPreview: 'First human question',
      lastMessage: { role: 'assistant', preview: 'An answer', at: 2 } }];
    await click(button(app.container, dictionary['bots.refresh']));
    expect(app.container.querySelector('[data-session-id]')?.textContent).toContain('First human question');
    expect(app.container.querySelector('[data-session-id]')?.textContent).not.toContain('home');
    const footer = await surface(app, 'footer', dictionary);
    expect(footer.container.querySelector('[data-session-id]')?.getAttribute('aria-label')).toBe('First human question');
  });
});

describe('default working directory editor and explicit home removal', () => {
  it.each(['en', 'zh'] as const)('shows private home, accepts a public directory picker and resets with JSON-preserved null in %s', async (language) => {
    const app = await mount(language, [bot({ id: 'alpha-bot', name: 'Alpha Bot', defaultCwd: '/test/existing' })]);
    const dictionary = language === 'en' ? en.ui : zh.ui;
    await click(button(app.container, dictionary['card.edit']));
    const area = app.container.querySelector('[data-bot-default-cwd]');
    expect(area?.querySelector('[data-effective-cwd]')?.textContent).toContain('/test/existing');
    expect(area?.textContent).toContain(dictionary['editor.cwdPermissions']);
    app.pickDirectory.mockResolvedValueOnce('/test/chosen');
    await click(button(app.container, dictionary['editor.cwdChoose']));
    expect(app.pickDirectory).toHaveBeenCalledExactlyOnceWith();
    expect(field(app.container, dictionary['editor.defaultCwd']).value).toBe('/test/chosen');
    await submit(app.container);
    expect(app.remote.methods.update).toHaveBeenLastCalledWith('alpha-bot', expect.objectContaining({ defaultCwd: '/test/chosen' }));
    await click(button(app.container, dictionary['card.edit']));
    await click(button(app.container, dictionary['editor.cwdReset']));
    expect(area?.isConnected).toBe(false);
    expect(app.container.querySelector('[data-effective-cwd]')?.textContent).toContain(home);
    await submit(app.container);
    const patch = app.remote.methods.update.mock.calls.at(-1)?.[1];
    expect(JSON.parse(JSON.stringify(patch))).toHaveProperty('defaultCwd', null);
    expect(app.remote.data.records[0]).not.toHaveProperty('defaultCwd');
  });

  it('keeps form values on picker cancellation/failure and rejects relative cwd before Remote save', async () => {
    const app = await mount();
    await click(button(app.container, en.ui['card.edit']));
    await fill(field(app.container, en.ui['editor.defaultCwd']), '/test/typed');
    await click(button(app.container, en.ui['editor.cwdChoose']));
    expect(field(app.container, en.ui['editor.defaultCwd']).value).toBe('/test/typed');
    app.pickDirectory.mockRejectedValueOnce(new Error('picker failed'));
    await click(button(app.container, en.ui['editor.cwdChoose']));
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(en.ui['editor.cwdPickError']);
    await fill(field(app.container, en.ui['editor.defaultCwd']), 'relative/path');
    await submit(app.container);
    expect(app.remote.methods.update).not.toHaveBeenCalled();
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(en.ui['validation.defaultCwd']);
  });

  it('retries editor home failure without navigation and allocates no home for an unsaved Bot', async () => {
    const app = await mount();
    app.remote.methods.ensureHome.mockRejectedValueOnce(new Error('no home'));
    await click(button(app.container, en.ui['card.edit']));
    expect(app.container.querySelector('[data-bot-default-cwd] [role="alert"]')?.textContent).toContain(en.ui['editor.cwdHomeError']);
    await click(button(app.container, en.ui['actions.retry']));
    expect(app.container.querySelector('[data-effective-cwd]')?.textContent).toContain(home);
    await click(button(app.container, en.ui['actions.cancel']));
    app.remote.methods.ensureHome.mockClear();
    await click(button(app.container, en.ui['bots.create']));
    expect(app.container.querySelector('[data-effective-cwd]')?.textContent).toContain(en.ui['editor.cwdAfterSave']);
    expect(app.remote.methods.ensureHome).not.toHaveBeenCalled();
    expect(app.openSession).not.toHaveBeenCalled();
  });

  it('refreshes committed Bot deletion and explains incomplete private-home cleanup', async () => {
    const app = await mount();
    app.remote.methods.delete.mockImplementationOnce(async () => {
      app.remote.data.records = [];
      return { ok: false, error: new RemoteError('bot/home-cleanup-failed', 'sensitive filesystem diagnostic', {}) };
    });
    await click(button(app.container, en.ui['card.more']));
    await click(button(app.container, en.ui['actions.delete']));
    const dialog = app.container.querySelector('dialog') as HTMLDialogElement;
    await click(field(dialog, en.ui['delete.home']));
    await click(button(dialog, en.ui['actions.delete']));
    expect(app.container.querySelector('[data-bot-detail]')).toBeNull();
    expect(app.container.querySelector('dialog')).toBeNull();
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(en.ui['delete.homeCleanupFailed']);
    expect(app.container.textContent).not.toContain('sensitive filesystem diagnostic');
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
  });

  it('defaults to keeping private home, resets the checkbox after cancel, and passes only explicit deleteHome consent', async () => {
    const app = await mount();
    const open = async () => {
      await click(button(app.container, en.ui['card.more']));
      await click(button(app.container, en.ui['actions.delete']));
      return app.container.querySelector('dialog') as HTMLDialogElement;
    };
    let dialog = await open();
    expect((field(dialog, en.ui['delete.home']) as HTMLInputElement).checked).toBe(false);
    await click(field(dialog, en.ui['delete.home']));
    expect(dialog.textContent).toContain(en.ui['delete.homeWarning']);
    await click(button(dialog, en.ui['actions.cancel']));
    expect(app.remote.methods.delete).not.toHaveBeenCalled();
    dialog = await open();
    expect((field(dialog, en.ui['delete.home']) as HTMLInputElement).checked).toBe(false);
    await click(field(dialog, en.ui['delete.home']));
    await click(button(dialog, en.ui['actions.delete']));
    expect(app.remote.methods.delete).toHaveBeenCalledExactlyOnceWith('alpha-bot', { deleteMemories: true, deleteHome: true });
  });
});
