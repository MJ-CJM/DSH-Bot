// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bot, button, click, mountClient } from './helpers.js';
import { openProfile } from './bot-ui-helpers.js';
const apps: Awaited<ReturnType<typeof mountClient>>[] = [];
afterEach(async () => { for (const app of apps.splice(0).reverse()) await app.dispose(); vi.unstubAllGlobals(); });
describe('recent conversation list and separate profile', () => {
  for (const language of ['en', 'zh'] as const) for (const width of [1360, 390]) {
    it(`${language}/${width}: single click opens native main; Profile opens management separately`, async () => {
      vi.stubGlobal('innerWidth', width);
      const app = await mountClient([bot(), bot({ id: 'beta-bot', name: 'Beta' })], language); apps.push(app);
      const row = button(app.container, 'Beta'); row.focus(); expect(document.activeElement).toBe(row);
      await click(row);
      expect(app.remote.methods.openConversation).toHaveBeenCalledExactlyOnceWith('beta-bot');
      expect(app.openSession).toHaveBeenCalledOnce();
      expect(app.container.querySelector('[data-bot-detail]')).toBeNull();
      await openProfile(app, language, 'beta-bot');
      expect(app.container.querySelector('[data-bot-detail="beta-bot"]')).not.toBeNull();
      expect(app.remote.methods.openConversation).toHaveBeenCalledOnce();
    });
  }
});

it('retains the externally requested Bot when initial activity resolves with a different recent-first Bot', async () => {
  const { act } = await import('react');
  const recent = bot({ id: 'recent-research', name: 'Research assistant' });
  const active = bot({ id: 'active-whale', name: 'Active Whale' });
  let releaseActivity: (() => void) | undefined;
  const initialActivity = new Promise<void>(resolve => { releaseActivity = resolve; });
  const app = await mountClient([recent, active], 'en', remote => {
    const list = remote.methods.activity.list.getMockImplementation();
    if (!list) throw new Error('Missing activity double');
    remote.methods.activity.list.mockImplementationOnce(async (...args) => { await initialActivity; return list(...args); });
    remote.data.activities = [
      { sessionId: 'recent-session', botId: recent.id, botCreatedAt: recent.createdAt, updatedAt: 500,
        unread: false, lastMessage: { role: 'assistant', preview: 'Newest reply', at: 500 } },
      { sessionId: 'active-session', botId: active.id, botCreatedAt: active.createdAt, updatedAt: 100,
        unread: false, lastMessage: { role: 'assistant', preview: 'Earlier reply', at: 100 } },
    ];
  });
  apps.push(app);
  const badge = app.core.entries('conversation.session.header.utilities').find(entry => entry.options.id === 'dsh-bot');
  const actions = badge?.inject?.() as unknown as { onOpenBot(id: string): void };
  await app.unmountPage();
  await act(async () => actions.onOpenBot(active.id));
  // The same source is consumed synchronously as the newly mounted page
  // starts independent activity/catalog reads, as in native panel navigation.
  await app.remountPage();
  await act(async () => { releaseActivity?.(); await initialActivity; });
  expect(app.container.querySelector('[data-bot-detail]')?.getAttribute('data-bot-detail')).toBe(active.id);
  expect(app.container.querySelector('li [data-bot-id]')?.getAttribute('data-bot-id')).toBe(recent.id);
  await act(async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    app.ctx.emit('connection/reset');
  });
  expect(app.container.querySelector('[data-bot-detail]')?.getAttribute('data-bot-detail')).toBe(active.id);
});

it('renders an explicit incoming detail target before consuming it instead of briefly showing the default Bot', async () => {
  const { act, useCallback, useLayoutEffect, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useBotsPage } = await import('../../src/client/pages/use-bots-page.js');
  const { default: en } = await import('../../locale/en.json');
  type Request = { botId: string; requestId: number } | undefined;
  const first = bot({ id: 'recent-first', name: 'A new Research assistant' });
  const target = bot({ id: 'active-whale', name: 'Active Whale' });
  const catalog = { entries: [{ bot: first }, { bot: target }], loaded: true, loading: false, pollIntervalMs: 5000 };
  const activity = { bots: [], sessions: [], loaded: true, loading: false, pollIntervalMs: 5000 };
  const useValue = <Value,>(value: Value) => <Selected,>(selector: (value: Value) => Selected) => selector(value);
  const observed: Array<{ requested: string; displayed?: string }> = [];
  const countMemories = async () => 0;
  const translate = (key: keyof typeof en.ui) => en.ui[key];
  let requestDetail: ((value: Request) => void) | undefined;
  function Harness() {
    const [request, setRequest] = useState<Request>(); requestDetail = setRequest;
    const page = {
      useCatalog: useValue(catalog), useActivity: useValue(activity),
      useSessionCatalog: useValue({ ids: [], byId: {}, phase: 'ready' }),
      useWorkspaceCatalog: useValue({ items: [], archivedSessionIds: [] }),
      useBotDetail: useValue(request), onDetailConsumed: useCallback(() => setRequest(undefined), []),
      onCountMemories: countMemories, t: translate,
    } as unknown as Parameters<typeof useBotsPage>[0];
    const model = useBotsPage(page);
    // Layout observes the committed render before the passive consumption
    // effect. This makes an incorrect default-Bot frame deterministic.
    useLayoutEffect(() => {
      if (model.requestedDetail) observed.push({ requested: model.requestedDetail.botId, displayed: model.selected?.bot.id });
    });
    return <div data-selected={model.selected?.bot.id} />;
  }
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    expect(container.firstElementChild?.getAttribute('data-selected')).toBe(first.id);
    await act(async () => requestDetail?.({ botId: target.id, requestId: 1 }));
    expect(observed).toEqual([{ requested: target.id, displayed: target.id }]);
    expect(container.firstElementChild?.getAttribute('data-selected')).toBe(target.id);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
