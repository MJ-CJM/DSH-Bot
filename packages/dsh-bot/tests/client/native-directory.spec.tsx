// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ActivitySession } from '../../src/shared/activity.js';
import type { GroupActions } from '../../src/client/groups-state.js';
import { nativeDirectoryRows, filterNativeDirectory, migrateLegacyDirectory, readDirectoryWindow } from '../../src/client/pages/native-directory.js';
import { conversationKey, recentPreferences, restoreRecentPreferences, setRecentPreference } from '../../src/client/pages/recent-conversations.js';
import { RecentConversations } from '../../src/client/pages/RecentConversations.js';
import { DirectoryPending } from '../../src/client/pages/DirectoryPending.js';
import { GroupDirectory } from '../../src/client/components/GroupDirectory.js';
import type { BotsPageProps } from '../../src/client/pages/bots-page-types.js';
import type { BotsPageModel } from '../../src/client/pages/use-bots-page.js';
import { bot, button, click, field, fill } from './helpers.js';
import { requireValue } from './test-required.js';
import { summary } from './group-fixture.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => en.ui[key].replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? name))) as PropsLocale<'dsh-bot'>['t'];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); recentPreferences.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });
const storage = () => { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };
const activity = (patch: Partial<ActivitySession> = {}): ActivitySession => ({ botId: 'alpha', botCreatedAt: 2, sessionId: 'main-alpha', updatedAt: 20,
  lastMessage: { role: 'assistant', preview: 'Current reply', at: 20 }, unread: true, ...patch });

describe('native directory identity and display preferences', () => {
  it('never borrows previews, unread, or recent order from another birthday or non-primary chat', () => {
    const record = { ...bot({ id: 'alpha', name: 'Alpha' }), createdAt: 2 };
    const entries = [{ bot: record, status: { mainSessionId: 'main-alpha' } as never }];
    for (const wrong of [activity({ botCreatedAt: 1 }), activity({ sessionId: 'fork-alpha' }), activity({ botCreatedAt: undefined })]) {
      expect(nativeDirectoryRows(entries, [], [wrong])[0]).toMatchObject({ unread: 0, at: 2, preview: undefined });
    }
    expect(nativeDirectoryRows(entries, [], [activity()])[0]).toMatchObject({ unread: 1, at: 20, preview: 'Current reply' });
  });
  it('searches normalized names, IDs and descriptions without searching private message previews', () => {
    const record = { ...bot({ id: 'alpha', name: 'Ａlpha', description: 'Release planning' }), createdAt: 2 };
    const group = summary(); group.group.name = 'Release group';
    const rows = nativeDirectoryRows([{ bot: record, status: { mainSessionId: 'main-alpha' } as never }], [group], [activity({ lastMessage: { role: 'assistant', preview: 'PRIVATE_CANARY', at: 20 } })]);
    expect(filterNativeDirectory(rows, 'alpha release').map(row => row.kind)).toEqual(['bot', 'group']);
    expect(filterNativeDirectory(rows, 'planning').map(row => row.id)).toEqual(['alpha']);
    expect(filterNativeDirectory(rows, 'PRIVATE_CANARY')).toEqual([]);
  });
  it('migrates only exact existing legacy identities once, without taking over native selection', () => {
    const memory = storage(), live = [{ kind: 'bot' as const, id: 'alpha', createdAt: 2 }, { kind: 'group' as const, id: 'group:one', createdAt: 1 }];
    memory.setItem('dsh-bot.bot-mode.v1', JSON.stringify({ pinned: [JSON.stringify(['bot', 'alpha', 1]), JSON.stringify(['bot', 'alpha', 2]), JSON.stringify(['group', 'group:one', 1]), 'invalid'],
      selected: { kind: 'bot', id: 'alpha', createdAt: 2 }, read: { secret: 999 } }));
    expect(migrateLegacyDirectory(memory, '/profile', live)).toBe('bot:alpha:2');
    expect([...recentPreferences.keys()]).toEqual(['bot:alpha:2', 'group:group:one:1']);
    expect(readDirectoryWindow(memory, '/profile', 'selection')).toEqual({ selected: 'bot:alpha:2' });
    setRecentPreference('bot:alpha:2', 'pinned');
    expect(migrateLegacyDirectory(memory, '/profile', live)).toBeUndefined();
    expect(recentPreferences.get('bot:alpha:2')?.pinned).toBe(false);
    expect(JSON.stringify([...recentPreferences])).not.toContain('secret');
  });
  it('retains colon-containing group identities and recent timestamps across preference restore', () => {
    const memory = storage(), stop = restoreRecentPreferences(memory, '/profile');
    cleanups.push(stop);
    const key = conversationKey('group', 'group:one', 1); setRecentPreference(key, 'pinned');
    stop(); cleanups.push(restoreRecentPreferences(memory, '/profile'));
    expect(recentPreferences.get(key)?.pinned).toBe(true);
    const rows = nativeDirectoryRows([{ bot: bot({ id: 'new', name: 'Newest' }) }], [summary()], []);
    expect(filterNativeDirectory(rows, '')[0]?.key).toBe(key);
  });
  it('tolerates disabled and malformed browser storage', () => {
    const broken = { getItem: () => '{broken', setItem: () => { throw new Error('disabled'); } };
    expect(() => migrateLegacyDirectory(broken, '/', [])).not.toThrow();
    expect(readDirectoryWindow(broken, '/', 'groups')).toEqual({});
  });
});

async function directory(language: 'en' | 'zh' = 'en', mode: 'bots' | 'recent' = 'bots') {
  const record = bot({ id: 'planner-alpha', name: 'Planner', description: 'Release review' });
  const entries = [{ bot: record }];
  const start = vi.fn(async () => {}), exact = vi.fn(async (_bot: unknown, _signal: AbortSignal) => {}), showBot = vi.fn(), errors: unknown[] = [];
  const labels = (language === 'zh' ? zh : en).ui;
  const translate = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => labels[key].replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? name))) as typeof t;
  const model = { entries, activity: { bots: [], sessions: [] }, snapshot: { loaded: true }, pageState: { lists: { [mode]: { query: '', hidden: false } } },
    showBot, navigate: async (action: (signal: AbortSignal) => Promise<void>) => { try { await action(new AbortController().signal); } catch (error) { errors.push(error); } } } as unknown as BotsPageModel;
  const page = { t: translate, onStart: start, onStartExact: exact } as unknown as BotsPageProps;
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  cleanups.push(async () => { await act(async () => root.unmount()); element.remove(); });
  const render = async () => act(async () => root.render(<RecentConversations mode={mode} model={model} page={page} />));
  await render();
  return { element, record, model, exact, start, showBot, errors, translate, render };
}

describe.each(['bots', 'recent'] as const)('%s directory actions', mode => {
  it.each(['en', 'zh'] as const)('uses one menu for pin, unpin and profile without opening the session (%s)', async language => {
    const f = await directory(language, mode);
    await fill(field(f.element, f.translate(mode === 'bots' ? 'navigation.searchBots' : 'chat.search')), 'planner-alpha release');
    const row = requireValue(f.element.querySelector('[data-directory-id="planner-alpha"]'));
    expect(row.getAttribute('data-directory-created-at')).toBe(String(f.record.createdAt));
    const open = button(row, 'Planner'), more = button(row, `${f.translate('card.more')} Planner`);
    expect([...row.querySelectorAll('button')]).toEqual([open, more]);
    await click(more);
    expect([...row.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual([
      f.translate('chat.pin'), ...(mode === 'recent' ? [f.translate('chat.hide')] : []),
      f.translate('chat.profile'), f.translate('actions.delete'),
    ]);
    await click(button(row, f.translate('chat.pin')));
    expect(row.querySelector('[data-directory-pinned]')?.textContent).toBe(f.translate('chat.pinned'));
    expect([...row.querySelectorAll('button')]).toEqual([open, more]);
    await click(more); await click(button(row, f.translate('chat.unpin')));
    expect(row.querySelector('[data-directory-pinned]')).toBeNull();
    await click(more); await click(button(row, f.translate('chat.profile')));
    expect(f.showBot).toHaveBeenCalledExactlyOnceWith(f.record);
    expect(f.exact).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
    await click(open);
    expect(f.exact).toHaveBeenCalledExactlyOnceWith({ id: f.record.id, createdAt: f.record.createdAt }, expect.any(AbortSignal));
    expect(f.start).not.toHaveBeenCalled();
    expect(recentPreferences.get(conversationKey('bot', f.record.id, f.record.createdAt))?.openedAt).toBeGreaterThan(0);
  });
});

it('retains a failed directory row for retry and does not record a successful visit', async () => {
  const f = await directory(); f.exact.mockRejectedValueOnce(new Error('not open'));
  await click(f.element.querySelector('[data-directory-open]') as HTMLElement);
  expect(f.errors).toHaveLength(1); expect(recentPreferences.get(conversationKey('bot', f.record.id, f.record.createdAt))?.openedAt).toBeUndefined();
  await click(f.element.querySelector('[data-directory-open]') as HTMLElement);
  expect(f.exact).toHaveBeenCalledTimes(2);
});

it('does not open a replacement incarnation from a stale directory row', async () => {
  const f = await directory();
  f.model.entries = [{ bot: { ...f.record, createdAt: f.record.createdAt + 1 } }];
  await click(f.element.querySelector('[data-directory-open]') as HTMLElement);
  expect(f.exact).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.errors).toHaveLength(1);
});

it('legacy selection locates the directory row without opening or replacing the native conversation', async () => {
  sessionStorage.setItem('dsh-bot.bot-mode.v1', JSON.stringify({ selected: { kind: 'bot', id: 'planner-alpha', createdAt: 1 }, pinned: [JSON.stringify(['bot', 'planner-alpha', 1])] }));
  const f = await directory();
  expect(f.element.querySelector('[data-directory-selected]')?.getAttribute('data-directory-id')).toBe(f.record.id);
  expect(f.element.querySelector('[data-directory-pinned]')?.textContent).toBe(f.translate('chat.pinned'));
  expect(f.exact).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
});

it('shows count-only group waiting links and opens the exact group without preview or approval calls', async () => {
  const group = { ...summary(), exportPendingCount: 3 }, open = vi.fn(async () => {}), review = vi.fn();
  const snapshot = { groups: [group] };
  const groups = { catalog: { subscribe: () => () => {}, getSnapshot: () => snapshot }, open, remote: () => ({ reviewExport: review }) } as unknown as GroupActions;
  const element = document.createElement('div'), root = createRoot(element);
  cleanups.push(async () => { await act(async () => root.unmount()); });
  await act(async () => root.render(<DirectoryPending groups={groups} t={t} />));
  expect(element.textContent).toContain('3'); expect(review).not.toHaveBeenCalled();
  await click(element.querySelector('[data-directory-pending-group]') as HTMLElement);
  expect(open).toHaveBeenCalledExactlyOnceWith({ groupId: group.group.id, groupCreatedAt: group.group.createdAt }, expect.any(AbortSignal)); expect(review).not.toHaveBeenCalled();
});

it('shows a count-source failure instead of treating unavailable data as no waiting work', async () => {
  const refresh = vi.fn(async () => {}), snapshot = { groups: [], error: new Error('private transport details') };
  const groups = { catalog: { subscribe: () => () => {}, getSnapshot: () => snapshot, refresh } } as unknown as GroupActions;
  const element = document.createElement('div'), root = createRoot(element);
  cleanups.push(async () => { await act(async () => root.unmount()); });
  await act(async () => root.render(<DirectoryPending groups={groups} t={t} />));
  expect(element.querySelector('[role="alert"]')?.textContent).toContain(en.ui['groups.disconnected']);
  expect(element.textContent).not.toContain('private transport details');
  await click(button(element, en.ui['bots.refresh'])); expect(refresh).toHaveBeenCalledOnce();
});

it('searches group ID and member names, retains filters on remount, and separates opening from management', async () => {
  const group = summary(), open = vi.fn(async () => {}), select = vi.fn();
  const element = document.createElement('div'), root = createRoot(element);
  cleanups.push(async () => { await act(async () => root.unmount()); });
  const render = async (key: string) => act(async () => root.render(<GroupDirectory key={key} rows={[group]} bots={[bot({ id: 'alpha', name: 'Researcher' })]} onOpen={open} onSelect={select} onCreate={() => {}} onRefresh={() => {}} t={t} />));
  await render('one'); await fill(field(element, en.ui['groups.search']), 'group:one researcher');
  expect(element.querySelector('[data-group-directory-row]')).not.toBeNull();
  await render('two'); expect(field(element, en.ui['groups.search']).value).toBe('group:one researcher');
  await click(element.querySelector('[data-directory-open]') as HTMLElement);
  expect(open).toHaveBeenCalledExactlyOnceWith(group.group, expect.any(AbortSignal)); expect(select).not.toHaveBeenCalled();
  await click(button(element, `${en.ui['card.more']} · ${group.group.name}`));
  await click(button(element, en.ui['chat.profile'])); expect(select).toHaveBeenCalledExactlyOnceWith(group.group);
});

it('pins and unpins the chosen group from its labelled menu without navigating', async () => {
  const first = summary(), second = { ...first, group: { ...first.group, id: 'group:two', name: 'Zeta group' } };
  const open = vi.fn(async () => {}), select = vi.fn(), element = document.createElement('div'), root = createRoot(element);
  cleanups.push(async () => { await act(async () => root.unmount()); });
  await act(async () => root.render(<GroupDirectory rows={[first, second]} bots={[]} onOpen={open} onSelect={select} onCreate={() => {}} onRefresh={() => {}} t={t} />));
  const order = () => [...element.querySelectorAll('[data-group-directory-row]')].map(row => row.getAttribute('data-group-directory-row'));
  const menu = () => button(element, `${en.ui['card.more']} · ${second.group.name}`);
  expect(order()).toEqual([first.group.id, second.group.id]);
  await click(menu()); await click(button(element, en.ui['chat.pin']));
  expect(order()).toEqual([second.group.id, first.group.id]);
  expect(element.querySelector('[data-group-directory-row]')?.textContent).toContain(en.ui['chat.pinned']);
  await click(menu()); await click(button(element, en.ui['chat.unpin']));
  expect(order()).toEqual([first.group.id, second.group.id]);
  expect(element.textContent).not.toContain(en.ui['chat.pinned']);
  expect(open).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
});

it('deduplicates group opening and cancels pending navigation when management takes over', async () => {
  const group = summary(), select = vi.fn(); let finish!: () => void;
  const open = vi.fn(async (_group: unknown, _signal?: AbortSignal) => new Promise<void>(resolve => { finish = resolve; }));
  const element = document.createElement('div'), root = createRoot(element);
  cleanups.push(async () => { await act(async () => root.unmount()); });
  await act(async () => root.render(<GroupDirectory rows={[group]} bots={[]} onOpen={open} onSelect={select} onCreate={() => {}} onRefresh={() => {}} t={t} />));
  const target = element.querySelector('[data-directory-open]') as HTMLButtonElement;
  await act(async () => { target.click(); target.click(); });
  expect(open).toHaveBeenCalledOnce();
  await click(button(element, `${en.ui['card.more']} · ${group.group.name}`));
  await click(button(element, en.ui['chat.profile']));
  expect(open.mock.calls[0]?.[1]?.aborted).toBe(true);
  await act(async () => finish());
  expect(recentPreferences.get(conversationKey('group', group.group.id, group.group.createdAt))?.openedAt).toBeUndefined();
});
