// @vitest-environment jsdom
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots';
import { type ComponentType, act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import type { ActivitySnapshot } from '../../src/client/activity-state.js';
import type { CatalogSnapshot } from '../../src/client/state.js';
import type { ActivitySession } from '../../src/shared/activity.js';
import { SessionBotHover, SessionBotLeading, type SessionBotRowInjected, type SessionBotRowProps } from '../../src/client/components/SessionBotLeading.js';
import { bot, click, loadBuiltClient, mountClient, workspace } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const sessionId = 'session-row-alpha' as SessionBotRowProps['sessionId'];
const activityRow = (id: string = sessionId): ActivitySession => ({
  sessionId: id, botId: 'alpha-bot', updatedAt: 100, unread: true,
  lastMessage: { role: 'assistant', preview: 'Completed Bot reply', at: 100 },
});
const translate = (language: 'en' | 'zh'): SessionBotRowProps['t'] => (key, params) => {
  const dictionary: Record<string, string> = language === 'en' ? en.ui : zh.ui;
  const value = dictionary[key];
  if (value === undefined) throw new Error(`Missing ${language} locale ${key}`);
  return value.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? `{${name}}`));
};

async function snapshotRow(options: { catalog?: Partial<CatalogSnapshot>; activity?: Partial<ActivitySnapshot>; id?: string } = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const catalog: CatalogSnapshot = { entries: [{ bot: bot() }], loading: false, loaded: true, pollIntervalMs: 5000, ...options.catalog };
  const activity: ActivitySnapshot = { sessions: [activityRow()], bots: [], loading: false, loaded: true, pollIntervalMs: 5000, ...options.activity };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<SessionBotLeading sessionId={(options.id ?? sessionId) as SessionBotRowProps['sessionId']}
    useCatalog={(selector) => selector(catalog)} useActivity={(selector) => selector(activity)} t={translate('en')} />));
  return container;
}

type TestClient = Awaited<ReturnType<typeof mountClient>>;
type RowSeat = 'sidebar.session.row.leading' | 'sidebar.session.row.hover';

/** Public SlotCore registrations and catalogs are real. This local renderer
 * double binds their public hooks, preserving list siblings for CSS checks.
 * It does not import or claim to test the native Workspace row layout. */
async function mountRows(app: TestClient, ids: string[], language: 'en' | 'zh' = 'en', hover = false) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  function Entry({ entry, id }: { entry: StoredEntry; id: string }) {
    const Component = entry.component as ComponentType<SessionBotRowProps>;
    const injected = entry.inject?.() as SessionBotRowInjected | undefined;
    const useCatalog: SessionBotRowProps['useCatalog'] = (selector) => {
      if (!injected) throw new Error('Missing Bot catalog injection');
      return selector(useSyncExternalStore(injected.hooks.catalog.subscribe, injected.hooks.catalog.getSnapshot));
    };
    const useActivity: SessionBotRowProps['useActivity'] = (selector) => {
      if (!injected) throw new Error('Missing Bot activity injection');
      return selector(useSyncExternalStore(injected.hooks.activity.subscribe, injected.hooks.activity.getSnapshot));
    };
    return <Component useCatalog={useCatalog} useActivity={useActivity}
      sessionId={id as SessionBotRowProps['sessionId']} t={translate(language)} />;
  }
  const renderSeat = (seat: RowSeat, id: string) => <span data-slot={seat} style={{ display: 'contents' }}>
    {[...app.core.entriesOfSlot(seat)].sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
      .map((entry) => <Entry key={entry.options.id} entry={entry} id={id} />)}
  </span>;
  const render = () => {
    if (mounted) root.render(ids.map((id) => <div key={id} data-test-row={id}>
      {renderSeat('sidebar.session.row.leading', id)}
      {hover && renderSeat('sidebar.session.row.hover', id)}
    </div>));
  };
  const stopLeading = app.core.subscribe('sidebar.session.row.leading', render);
  const stopHover = app.core.subscribe('sidebar.session.row.hover', render);
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    stopLeading(); stopHover();
    await act(async () => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  await act(async () => render());
  return { container, unmount };
}

async function setup(language: 'en' | 'zh' = 'en', built = false, count = 1) {
  const ids = Array.from({ length: count }, (_, index) => index ? `${sessionId}-${index}` : sessionId);
  const app = await mountClient([bot()], language, (remote) => {
    remote.data.activities = ids.map((id) => activityRow(id));
  }, {}, built ? loadBuiltClient() : undefined);
  cleanups.push(app.dispose);
  await app.unmountPage();
  return { app, ids };
}

describe('Bot identity in public native session row seats', () => {
  it('renders a 16px colored whale and keeps the row decoration non-interactive', async () => {
    const container = await snapshotRow();
    const leading = container.querySelector<HTMLElement>('[data-bot-session-leading]');
    const avatar = leading?.querySelector<HTMLElement>('[data-bot-avatar="whale"]');
    expect(avatar?.style.width).toBe('16px');
    expect(avatar?.style.height).toBe('16px');
    expect(avatar?.dataset.botId).toBe('alpha-bot');
    expect(avatar?.getAttribute('aria-label')).toBe('Bot: Alpha Bot');
    expect(avatar?.getAttribute('data-avatar-color')).toMatch(/^--dsw-alias-/);
    expect(container.querySelector('button, a, [tabindex]')).toBeNull();
    const activateRow = vi.fn();
    if (!leading) throw new Error('Missing Bot leading decoration');
    document.body.addEventListener('click', activateRow);
    await click(leading);
    document.body.removeEventListener('click', activateRow);
    expect(activateRow).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-Bot session', { id: 'ordinary-session' }],
    ['a session without activity', { activity: { sessions: [] } }],
    ['an activity for a deleted Bot', { catalog: { entries: [] } }],
    ['an unresolved Bot catalog', { catalog: { loaded: false } }],
    ['an unresolved activity catalog', { activity: { loaded: false } }],
  ] as const)('returns no element or placeholder for %s', async (_name, options) => {
    const container = await snapshotRow(options);
    expect(container.childNodes).toHaveLength(0);
    expect(container.textContent).toBe('');
  });

  it('keeps the last successful identity during refreshes, including a failed refresh', async () => {
    const container = await snapshotRow({
      catalog: { loading: true, error: { message: 'offline' } },
      activity: { loading: true, error: { message: 'offline' } },
    });
    expect(container.querySelector('[data-bot-session-leading]')).not.toBeNull();
    expect(container.textContent).not.toContain('offline');
  });

  it.each(['en', 'zh'] as const)('uses the registered shared catalog for localized leading and hover identity in %s', async (language) => {
    const { app, ids } = await setup(language);
    const { container } = await mountRows(app, ids, language, true);
    const expected = (language === 'en' ? en.ui : zh.ui)['row.bot'].replace('{name}', 'Alpha Bot');
    expect(container.querySelector('[data-bot-avatar]')?.getAttribute('aria-label')).toBe(expected);
    expect(container.querySelector('[data-bot-session-hover]')?.textContent).toBe(expected);
    const hover = container.querySelector<HTMLElement>('[data-bot-session-hover]');
    expect(hover?.style.color).toBe('var(--dsw-alias-label-primary)');
    expect(hover?.style.background).toBe('var(--dsw-alias-bg-base)');
    expect(app.sessionListeners.size).toBe(0);
    expect(app.openSession).not.toHaveBeenCalled();
    expect(app.remote.methods.activity.markRead).not.toHaveBeenCalled();
  });

  it('keeps the whale on completed Bot sessions in Bots without changing other workspace or ungrouped rows', async () => {
    const { app, ids } = await setup();
    const other = 'session-other-workspace';
    const ungrouped = 'session-ungrouped';
    const bots = { ...workspace('bots-workspace', 'Bots'), path: '/test/dsh-bot/bots', sessionIds: [sessionId] };
    const existing = workspace('existing-workspace', 'Existing project');
    const before = [bots, existing];
    await app.setWorkspaces({ items: before });
    const { container } = await mountRows(app, [...ids, other, ungrouped]);
    expect(container.querySelector(`[data-test-row="${sessionId}"] [data-bot-avatar="whale"]`)).not.toBeNull();
    expect(container.querySelector(`[data-test-row="${other}"] [data-bot-session-leading]`)).toBeNull();
    expect(container.querySelector(`[data-test-row="${ungrouped}"] [data-bot-session-leading]`)).toBeNull();
    expect(app.ctx.workspaces.list.getSnapshot().items).toEqual(before);
    expect(app.createWorkspace).not.toHaveBeenCalled();
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.createSession).not.toHaveBeenCalled();
    expect(app.sessionListeners.size).toBe(0);
  });

  it('removes both decorations after catalog deletion even while the activity mapping remains', async () => {
    const { app, ids } = await setup();
    const { container } = await mountRows(app, ids, 'en', true);
    expect(container.querySelector('[data-bot-session-leading]')).not.toBeNull();
    app.remote.data.records = [];
    await act(async () => app.ctx.emit('connection/reset'));
    expect(app.remote.data.activities).toHaveLength(1);
    expect(container.querySelector('[data-bot-session-leading], [data-bot-session-hover], style')).toBeNull();
    expect(container.querySelector('[data-slot="sidebar.session.row.leading"]')?.childNodes).toHaveLength(0);
  });

  it('removes both decorations when activity no longer maps the session to the existing Bot', async () => {
    const { app, ids } = await setup();
    const { container } = await mountRows(app, ids, 'en', true);
    app.remote.data.activities = [];
    await act(async () => app.ctx.emit('connection/reset'));
    expect(app.remote.data.records).toHaveLength(1);
    expect(container.querySelector('[data-bot-session-leading], [data-bot-session-hover], style')).toBeNull();
  });

  it('registers Bot at order 0 before a distinct schedule entry at order 10 without replacing it', async () => {
    const { app, ids } = await setup();
    const releaseSchedule = app.core.register({ name: 'sidebar.session.row.leading', id: 'schedule-mark', order: 10 },
      (() => <span data-test-schedule="">Clock</span>) as never);
    cleanups.push(async () => { releaseSchedule(); });
    const leading = app.core.entries('sidebar.session.row.leading');
    expect(leading.map((entry) => [entry.options.id, entry.options.order])).toEqual([
      ['dsh-bot-avatar', 0], ['schedule-mark', 10],
    ]);
    expect(leading[0]?.component).toBe(SessionBotLeading);
    expect(app.core.entries('sidebar.session.row.hover')[0]?.component).toBe(SessionBotHover);
    const { container } = await mountRows(app, ids);
    const decoration = container.querySelector('[data-bot-session-leading]');
    expect(decoration?.nextElementSibling?.hasAttribute('data-test-schedule')).toBe(true);
    await app.unloadPlugin();
    expect(app.core.entries('sidebar.session.row.leading').map((entry) => entry.options.id)).toEqual(['schedule-mark']);
    expect(app.core.entries('sidebar.session.row.hover')).toHaveLength(0);
    expect(container.querySelector('[data-bot-session-leading]')).toBeNull();
    expect(container.querySelector('[data-test-schedule]')).not.toBeNull();
  });

  it('shares one polling timer across many leading and hover instances and releases it with the last row', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { app, ids } = await setup('en', false, 12);
    expect(vi.getTimerCount()).toBe(0);
    const rows = await mountRows(app, ids, 'en', true);
    expect(rows.container.querySelectorAll('[data-bot-session-leading]')).toHaveLength(12);
    expect(vi.getTimerCount()).toBe(1);
    const calls = [app.remote.methods.list.mock.calls.length, app.remote.methods.activity.list.mock.calls.length];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes((calls[0] ?? 0) + 1);
    expect(app.remote.methods.activity.list).toHaveBeenCalledTimes((calls[1] ?? 0) + 1);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(0);
    visibility.mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(1);
    await rows.unmount();
    expect(vi.getTimerCount()).toBe(0);
    const stopped = [app.remote.methods.list.mock.calls.length, app.remote.methods.activity.list.mock.calls.length];
    await act(async () => {
      app.ctx.emit('connection/reset');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(stopped[0] ?? 0);
    expect(app.remote.methods.activity.list).toHaveBeenCalledTimes(stopped[1] ?? 0);
    await mountRows(app, ids);
    expect(vi.getTimerCount()).toBe(1);
    await app.unloadPlugin();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ships CSS that yields only its own element to a later occupant and recovers after that occupant unmounts', async () => {
    const { app, ids } = await setup('en', true);
    const releaseSchedule = app.core.register({ name: 'sidebar.session.row.leading', id: 'schedule-mark', order: 10 },
      (() => <span data-test-schedule="">Clock</span>) as never);
    cleanups.push(async () => { releaseSchedule(); });
    const { container } = await mountRows(app, ids);
    const css = container.querySelector('[data-dsh-bot-row-styles]')?.textContent ?? '';
    const selector = css.match(/([^{}]+:has\(~ :not\(style\)\))\s*\{\s*display:\s*none;/)?.[1]?.trim();
    if (!selector) throw new Error('Built artifact omitted the own-element coexistence selector');
    const decoration = container.querySelector<HTMLElement>('[data-bot-session-leading]');
    expect(decoration?.matches(selector)).toBe(true);
    expect(container.querySelector('[data-test-schedule]')?.matches(selector)).toBe(false);
    expect(css).not.toContain('data-session-schedule-mark');
    await act(async () => releaseSchedule());
    expect(decoration?.matches(selector)).toBe(false);
    expect(container.querySelector('[data-bot-session-leading] [data-bot-avatar]')).not.toBeNull();
    // Selector matching is a jsdom contract check, not native browser geometry.
  });
});
