import { requireValue } from './test-required.js';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotEditor, type BotEditorProps } from '../../src/client/components/BotEditor.js';
import { botCreateSchema, botSchema } from '../../src/shared/schema.js';
import { matchesCreation, conversationKey } from '../../src/client/pages/recent-conversations.js';
import en from '../../locale/en.json';
import additions from '../../../../docs/implementation/v060-bots-locales.json';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;
const t = ((key: string) => ({ ...en.ui, ...additions.en })[key as keyof typeof en.ui] ?? key) as BotEditorProps['t'];
async function render(props: Partial<BotEditorProps> = {}) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const onSave = vi.fn(async (_input: Parameters<BotEditorProps['onSave']>[0]) => {});
  await act(async () => requireValue(root).render(<BotEditor onSave={onSave} onCancel={() => {}} t={t} {...props} />));
  return onSave;
}
async function fillName(value: string) {
  const input = requireValue(container.querySelector('input'));
  await act(async () => {
    requireValue(requireValue(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')).set).call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() { await act(async () => { requireValue(container.querySelector('form')).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });
it('creates from only a name with an automatic stable identity and no directory allocation on open/cancel', async () => {
  const home = vi.fn(), workspace = vi.fn();
  const onSave = await render({ onEnsureHome: home, onEnsureBotsWorkspace: workspace });
  expect(home).not.toHaveBeenCalled(); expect(workspace).not.toHaveBeenCalled();
  expect(container.querySelector('input[required]')).not.toBeNull();
  expect(container.querySelector('[data-avatar-picker]')).toBeNull();
  await fillName('Researcher'); await submit();
  expect(onSave).toHaveBeenCalledOnce();
  expect(onSave.mock.calls[0]?.[0]).toMatchObject({ name: 'Researcher', id: expect.stringMatching(/^bot-[a-f0-9]{20}$/), avatarVariant: 'auto' });
});
it('retains the same generated identity and name after an unknown create failure', async () => {
  const save = vi.fn(async (_input: unknown) => { throw new Error('response lost'); });
  await render({ onSave: save }); await fillName('Researcher'); await submit(); await submit();
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[0]?.[0]).toEqual(save.mock.calls[1]?.[0]);
});
it('only patches the renamed field and preserves untouched legacy flags, whitespace and duplicate arrays', async () => {
  const bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'legacy', name: 'Legacy', persona: { prefix: '  exact  ', suffix: '', complete: false },
    skills: { extraDirs: ['/tmp/one', '/tmp/one'] }, tools: { deny: ['read', 'read'] }, model: { provider: 'provider', model: 'model', reasoningEffort: 'high' },
    memory: { enabled: false, injectLimit: 0 } }), createdAt: 1, updatedAt: 1, schemaVersion: 1 });
  const save = await render({ bot }); await fillName('Renamed'); await submit();
  expect(save).toHaveBeenCalledExactlyOnceWith({ name: 'Renamed' });
});
it('does not claim an unrelated record after a lost create response', () => {
  const input = { id: 'stable', name: 'Researcher' };
  const bot = botSchema.parse({ ...botCreateSchema.parse(input), createdAt: 1, updatedAt: 1, schemaVersion: 1 });
  expect(matchesCreation(input, bot)).toBe(true);
  expect(matchesCreation(input, { ...bot, persona: { prefix: 'different' } })).toBe(false);
  expect(matchesCreation(input, { ...bot, name: 'Different' })).toBe(false);
  expect(conversationKey('bot', 'stable', 1)).not.toBe(conversationKey('bot', 'stable', 2));
});

it('retries opening after a committed create and never creates a second Bot', async () => {
  const { useBotsPage } = await import('../../src/client/pages/use-bots-page.js');
  type Page = Parameters<typeof useBotsPage>[0];
  let model: ReturnType<typeof useBotsPage> | undefined;
  const create = vi.fn(async () => {});
  const start = vi.fn().mockRejectedValueOnce(new Error('navigation failed')).mockResolvedValue(undefined);
  const page = {
    useCatalog: (select: (v: unknown) => unknown) => select({ entries: [], loaded: true, loading: false }),
    useActivity: (select: (v: unknown) => unknown) => select({ bots: [], sessions: [], loaded: true }),
    useSessionCatalog: (select: (v: unknown) => unknown) => select({ byId: {}, phase: 'ready' }),
    useWorkspaceCatalog: (select: (v: unknown) => unknown) => select({ items: [], archivedSessionIds: [] }),
    useBotDetail: () => undefined, onCountMemories: async () => 0, onCreate: create, onStart: start,
    onRefresh: async () => {}, onDetailConsumed: () => {}, t,
  } as unknown as Page;
  function Harness() { model = useBotsPage(page); return null; }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => requireValue(root).render(<Harness />));
  await act(async () => { requireValue(model).open({ kind: 'create' }); });
  await act(async () => { await expect(requireValue(model).save({ id: 'fixed', name: 'Researcher' })).rejects.toThrow('navigation failed'); });
  expect(requireValue(model).createdId).toBe('fixed');
  await act(async () => { await requireValue(model).save({ id: 'fixed', name: 'Researcher' }); });
  expect(create).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledTimes(2);
  expect(requireValue(model).dialog).toBeUndefined();
});

it('combines native Bot/group opens, search, pin, hide and recover without stopping work', async () => {
  const { RecentConversations } = await import('../../src/client/pages/RecentConversations.js');
  const { recentPreferences } = await import('../../src/client/pages/recent-conversations.js');
  const record = botSchema.parse({ ...botCreateSchema.parse({ id: 'research', name: 'Researcher' }), createdAt: 1, updatedAt: 1, schemaVersion: 1 });
  const groupSnapshot = { groups: [{ group: { id: 'team', name: 'Team', createdAt: 2, updatedAt: 3 } }] };
  const start = vi.fn(async () => {}), open = vi.fn(async () => {});
  const page = { t, onStart: start, groups: { catalog: { subscribe: () => () => {}, getSnapshot: () => groupSnapshot }, open } };
  const model = { entries: [{ bot: record }], activity: { bots: [] }, navigate: (action: (signal: AbortSignal) => Promise<void>) => action(new AbortController().signal) };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => requireValue(root).render(<RecentConversations page={page as never} model={model as never} />));
  const clickText = async (value: string) => {
    const button = requireValue([...container.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === value || node.textContent?.trim().replace(/^▣/u, '') === value));
    expect(button, value).toBeDefined(); await act(async () => button.click());
  };
  await clickText('Researcher'); await clickText('Team');
  expect(start).toHaveBeenCalledWith('research', expect.any(AbortSignal));
  expect(open).toHaveBeenCalledWith({ groupId: 'team', groupCreatedAt: 2 }, expect.any(AbortSignal));
  const pin = container.querySelector('li button:nth-of-type(1)'); expect(pin).toBeTruthy();
  const researchRow = requireValue([...container.querySelectorAll('li')].find(node => node.textContent?.includes('Researcher')));
  await act(async () => requireValue([...researchRow.querySelectorAll('button')].find(node => node.textContent === additions.en['chat.pin'])).click());
  expect(container.querySelector('li')?.textContent).toContain('Researcher');
  await act(async () => requireValue([...researchRow.querySelectorAll('button')].find(node => node.textContent === additions.en['chat.hide'])).click());
  expect(container.querySelector('ul')?.textContent).not.toContain('Researcher');
  await clickText(additions.en['chat.hidden']); await clickText(additions.en['chat.restore']); await clickText(additions.en['chat.recent']);
  expect(container.querySelector('ul')?.textContent).toContain('Researcher');
  const input = requireValue(container.querySelector('input'));
  await act(async () => { requireValue(requireValue(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')).set).call(input, 'team'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.querySelectorAll('li')).toHaveLength(1); expect(container.querySelector('li')?.textContent).toContain('Team');
  expect(start).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(1);
  recentPreferences.clear();
});

it('restores only display preferences across plugin lifetimes and tolerates disabled/corrupt storage', async () => {
  const { restoreRecentPreferences, setRecentPreference, recentPreferences } = await import('../../src/client/pages/recent-conversations.js');
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  const dispose = restoreRecentPreferences(storage, '/profile-a');
  setRecentPreference('bot:research:1', 'pinned'); setRecentPreference('group:team:2', 'hidden'); dispose();
  expect(recentPreferences.size).toBe(0);
  const nextDispose = restoreRecentPreferences(storage, '/profile-a');
  expect(recentPreferences.get('bot:research:1')?.pinned).toBe(true);
  expect(recentPreferences.get('group:team:2')?.hidden).toBe(true); nextDispose();
  restoreRecentPreferences(storage, '/profile-b'); expect(recentPreferences.size).toBe(0);
  restoreRecentPreferences({ getItem: () => '{bad', setItem: () => { throw new Error('disabled'); } }, '/profile-c');
  setRecentPreference('bot:research:1', 'hidden'); expect(recentPreferences.get('bot:research:1')?.hidden).toBe(true);
  recentPreferences.clear();
});
