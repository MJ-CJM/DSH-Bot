// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { BotsPageInjected } from '../../src/client/pages/bots-page-types.js';
import { BotComposerIdentity } from '../../src/client/components/BotComposerIdentity.js';
import { FirstChatHint, type FirstChatActions } from '../../src/client/components/FirstChatHint.js';
import type { SessionBotBadgeProps } from '../../src/client/components/SessionBotBadge.js';
import { SessionBotLeading } from '../../src/client/components/SessionBotLeading.js';
import { GroupAvatar } from '../../src/client/components/GroupAvatar.js';
import { onboardingNoticeDefinition } from '../../src/client/onboarding-notice.js';
import type { OnboardingStatus } from '../../src/shared/onboarding.js';
import { bot, button, click, field, fill, submit, mountClient } from './helpers.js';
import { openProfile } from './bot-ui-helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); vi.useRealTimers(); });
async function surface() {
  const container = document.createElement('div'); document.body.append(container);
  const root: Root = createRoot(container);
  disposers.push(async () => { await act(async () => root.unmount()); container.remove(); });
  return { container, root };
}
const operationId = '00000000-0000-4000-8000-000000000001';
const sessionId = 'first-chat' as SessionBotBadgeProps['sessionId'];
const record = bot({ id: 'new-bot', name: 'Migration helper', avatar: '🐙' });
const catalog = { loaded: true, loading: false, pollIntervalMs: 5000, entries: [{ bot: record,
  status: { id: record.id, mainSessionId: sessionId, presetId: 'preset', preset: { state: 'ok' as const } } }] };
const emptyActivity = { loaded: true, loading: false, pollIntervalMs: 5000, sessions: [], bots: [] };
function props(language: 'en' | 'zh' = 'en'): SessionBotBadgeProps {
  return { sessionId, useCatalog: (selector: Parameters<SessionBotBadgeProps['useCatalog']>[0]) => selector(catalog), useActivity: (selector: Parameters<SessionBotBadgeProps['useActivity']>[0]) => selector(emptyActivity),
    t: (key: keyof typeof en.ui) => (language === 'en' ? en.ui : zh.ui)[key], onMarkRead: vi.fn(), onOpenBot: vi.fn() } as unknown as SessionBotBadgeProps;
}
it('uses the manual-create command and starts only after successful native navigation; model failure preserves navigation', async () => {
  const app = await mountClient(); disposers.push(app.dispose);
  const page = app.main.inject?.() as unknown as BotsPageInjected;
  await act(async () => { await page.onCreateForChat?.({ id: 'new-bot', name: 'Migration helper' }, operationId, 'zh'); });
  expect(app.remote.methods.create).not.toHaveBeenCalled();
  expect(app.remote.methods.createForChat).toHaveBeenCalledExactlyOnceWith({ operationId, language: 'zh', bot: { id: 'new-bot', name: 'Migration helper' } });
  app.openSession.mockImplementationOnce(() => { throw new Error('navigation failed'); });
  await expect(page.onStartCreated?.('new-bot', operationId)).rejects.toThrow('navigation failed');
  expect(app.remote.methods.startOnboarding).not.toHaveBeenCalled();
  app.remote.methods.startOnboarding.mockRejectedValueOnce(new Error('no model'));
  // Native navigation may synchronously unmount the creation page and abort
  // its waiter. A successful open still binds this one creation operation.
  const navigation = new AbortController();
  app.openSession.mockImplementationOnce(() => navigation.abort());
  await act(async () => { await page.onStartCreated?.('new-bot', operationId, navigation.signal); });
  expect(app.openSession).toHaveBeenCalledTimes(2);
  expect(app.remote.methods.createForChat).toHaveBeenCalledTimes(1);
  expect(app.remote.methods.startOnboarding).toHaveBeenCalledExactlyOnceWith({ botId: 'new-bot', operationId, sessionId: 'test-created-session' });
  await act(async () => { await page.onStart('new-bot'); });
  expect(app.remote.methods.startOnboarding).toHaveBeenCalledTimes(1);
});
it.each(['en', 'zh'] as const)('keeps a readable failure fallback and only offers the Host-approved retry in %s', async language => {
  const { root, container } = await surface();
  let state: OnboardingStatus = { botId: record.id, operationId, sessionId, state: 'failed', retryable: true };
  const read = vi.fn(async () => state); const retry = vi.fn(async () => { state = { ...state, state: 'submitted', retryable: false }; return state; });
  await act(async () => root.render(<FirstChatHint {...props(language)} onOnboardingStatus={read} onRetryOnboarding={retry} />));
  expect(container.textContent).toContain((language === 'en' ? en.ui : zh.ui)['onboarding.failed']);
  expect(container.querySelector('textarea, input')).toBeNull();
  await act(async () => container.querySelector('button')?.click());
  expect(retry).toHaveBeenCalledExactlyOnceWith({ botId: record.id, operationId, sessionId });
  expect(container.querySelector('button')).toBeNull();
});
it('never exposes a blind retry for uncertain delivery and releases pending status polling on unmount', async () => {
  vi.useFakeTimers();
  const { root, container } = await surface();
  let state: OnboardingStatus = { botId: record.id, operationId, sessionId, state: 'pending', retryable: false };
  const read = vi.fn(async () => state);
  await act(async () => root.render(<FirstChatHint {...props()} onOnboardingStatus={read} onRetryOnboarding={vi.fn()} />));
  expect(vi.getTimerCount()).toBe(1);
  state = { ...state, state: 'uncertain', retryable: true };
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(container.querySelector('button')).toBeNull();
  expect(container.textContent).toBe(en.ui['onboarding.uncertain']);
  await act(async () => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
});
it('identifies an empty native main Session from Host status and shows each custom Bot avatar', async () => {
  const { root, container } = await surface();
  await act(async () => root.render(<SessionBotLeading {...props()} />));
  expect(container.querySelector('[data-bot-avatar="emoji"]')?.textContent).toBe('🐙');
  expect(container.querySelector('[data-bot-session-leading]')?.getAttribute('data-session-id')).toBe(sessionId);
});
it('uses two distinct whale silhouettes at the native 16px size', async () => {
  const { root, container } = await surface();
  await act(async () => root.render(<GroupAvatar size={16} label="Group chat" />));
  expect(container.querySelector('[data-group-avatar="whales"]')?.getAttribute('width')).toBe('16');
  expect(container.querySelectorAll('svg path')).toHaveLength(2);
  expect(container.querySelectorAll('svg path')[0]?.getAttribute('transform')).not.toBe(container.querySelectorAll('svg path')[1]?.getAttribute('transform'));
});
it('claims only the strict onboarding source with its exact input id, never human or other plugin messages', () => {
  const source = { kind: 'dsh-bot-onboarding', botId: record.id, botCreatedAt: record.createdAt, operationId, sessionId,
    inputId: 'input-one', context: { form: 'notice', summary: 'New Bot introduction' } };
  const event = { surfaceOp: 'append', type: 'user/message', data: { id: 'input-one', source }, seq: 1, time: 1 } as never;
  expect(onboardingNoticeDefinition.match(event)).toMatchObject({ id: 'input-one', exclusive: true });
  expect(onboardingNoticeDefinition.match({ ...event as object, data: { id: 'other-input', source } } as never)).toBeNull();
  expect(onboardingNoticeDefinition.match({ ...event as object, data: { id: 'input-one', source: { kind: 'user' } } } as never)).toBeNull();
  expect(onboardingNoticeDefinition.match({ ...event as object, data: { id: 'input-one', source: { ...source, unexpected: true } } } as never)).toBeNull();
});

it('reuses a stable operation after a lost committed-create response and never claims a same-name Bot', async () => {
  const app = await mountClient(); disposers.push(app.dispose);
  const create = app.remote.methods.createForChat.getMockImplementation();
  if (!create) throw new Error('Missing create double');
  app.remote.methods.createForChat.mockImplementationOnce(async input => { await create(input); throw new Error('response lost'); });
  await click(button(app.container, en.ui['bots.create']));
  await fill(field(app.container, en.ui['editor.name']), 'Name alone');
  await submit(app.container);
  expect(app.remote.data.records).toHaveLength(1);
  expect(app.openSession).not.toHaveBeenCalled();
  await submit(app.container);
  expect(app.remote.methods.createForChat).toHaveBeenCalledTimes(2);
  expect(app.remote.methods.createForChat.mock.calls[0]).toEqual(app.remote.methods.createForChat.mock.calls[1]);
  expect(app.remote.data.records).toHaveLength(1);
  expect(app.openSession).toHaveBeenCalledOnce();
});
it('does not attribute unversioned or old-generation historical activity to a recreated Bot', async () => {
  const { root, container } = await surface();
  const current = { ...record, createdAt: 200, updatedAt: 200 };
  const snapshot = { ...catalog, entries: [{ bot: current }] };
  const activity = { ...emptyActivity, sessions: [{ sessionId, botId: current.id, botCreatedAt: 1, updatedAt: 300,
    unread: false, lastMessage: { role: 'assistant' as const, preview: 'late old-generation reply', at: 300 } }] };
  const render = async (birthday?: number) => { await act(async () => root.render(<SessionBotLeading {...props()}
    useCatalog={selector => selector(snapshot)} useActivity={selector => selector({ ...activity,
      sessions: activity.sessions.map(row => ({ ...row, botCreatedAt: birthday })) })} />)); };
  await render(1); expect(container.querySelector('[data-bot-avatar]')).toBeNull();
  await render(); expect(container.querySelector('[data-bot-avatar]')).toBeNull();
  await render(200); expect(container.querySelector('[data-bot-avatar]')).not.toBeNull();
});
it.each(['en', 'zh'] as const)('shows the committed persona and initializes a native draft without sending in %s', async language => {
  const role = '  Exact lasting role\nwith line breaks  ';
  const entry = bot({ id: 'alpha-bot', name: 'Role helper', persona: { prefix: role, suffix: 'private suffix', complete: false } });
  const app = await mountClient([entry], language); disposers.push(app.dispose);
  const init = vi.fn(() => 'applied' as const);
  const send = vi.fn();
  app.ctx.provide('conversation', { input: { requestDraftInitialization: init }, send } as never);
  const ready = { ctx: app.ctx };
  const using = vi.fn(async (_id: unknown, _options: unknown, operation: (reference: unknown) => Promise<void>) => operation({ ready: Promise.resolve(ready) }));
  Object.assign(app.ctx.sessions, { using });
  await openProfile(app, language);
  expect(app.container.querySelector('[data-bot-persona]')?.textContent).toContain(role);
  expect(app.container.querySelector('[data-bot-persona]')?.textContent).not.toContain('private suffix');
  const page = app.main.inject?.() as unknown as BotsPageInjected;
  await act(async () => page.onEditPersona?.(entry));
  expect(init).toHaveBeenCalledExactlyOnceWith(ready, { prompt: (language === 'en' ? en.ui : zh.ui)['persona.prompt'] });
  expect(app.openSession).toHaveBeenCalledExactlyOnceWith('test-created-session');
  expect(send).not.toHaveBeenCalled();
  expect(app.remote.methods.update).not.toHaveBeenCalled();
});

it('shows a failed start transport only with Host-proven safe recovery and never retries automatically', async () => {
  const app = await mountClient(); disposers.push(app.dispose);
  const page = app.main.inject?.() as unknown as BotsPageInjected;
  await act(async () => page.onCreateForChat?.({ id: record.id, name: record.name }, operationId, 'en'));
  app.remote.methods.startOnboarding.mockRejectedValueOnce(new Error('connection lost before Host admission'));
  await act(async () => page.onStartCreated?.(record.id, operationId));
  const targetId = 'test-created-session' as SessionBotBadgeProps['sessionId'];
  app.remote.data.onboarding.set(record.id, { botId: record.id, operationId, sessionId: targetId,
    state: 'pending', retryable: true, reason: 'not-dispatched' });
  const actions = app.core.entries('conversation.input.dock').find(row => row.options.id === 'dsh-bot-empty-identity')?.inject?.() as unknown as FirstChatActions;
  const dock = { ...props(), sessionId: targetId, useCatalog: ((selector: Parameters<SessionBotBadgeProps['useCatalog']>[0]) => selector({ ...catalog,
    entries: [{ ...catalog.entries[0], bot: record, status: { ...catalog.entries[0]?.status, id: record.id, mainSessionId: targetId, presetId: 'preset', preset: { state: 'ok' as const } } }] })) as SessionBotBadgeProps['useCatalog'] };
  const { root, container } = await surface();
  await act(async () => root.render(<FirstChatHint {...dock} {...actions} />));
  expect(container.textContent).toContain(en.ui['onboarding.deliveryFailed']);
  expect(container.querySelector('button')).not.toBeNull();
  expect(app.remote.methods.startOnboarding).toHaveBeenCalledTimes(1);
  expect(app.remote.methods.retryOnboarding).not.toHaveBeenCalled();
  await act(async () => container.querySelector('button')?.click());
  expect(app.remote.methods.retryOnboarding).toHaveBeenCalledExactlyOnceWith({ botId: record.id, operationId, sessionId: targetId });
  expect(container.querySelector('button')).toBeNull();
  expect(app.remote.methods.createForChat).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<FirstChatHint {...dock} {...actions} onOnboardingStatus={async () => ({ botId: record.id,
    operationId, sessionId: targetId, state: 'uncertain', retryable: false })} />));
  expect(container.querySelector('button')).toBeNull();
  expect(app.remote.methods.retryOnboarding).toHaveBeenCalledTimes(1);
});
it('places empty Bot identity in the public native input dock and releases it when the Session is no longer blank', async () => {
  const app = await mountClient([record]); disposers.push(app.dispose);
  expect(app.core.entries('conversation.input.dock').find(row => row.options.id === 'dsh-bot-empty-identity')?.component).toBe(BotComposerIdentity);
  const { root, container } = await surface();
  const render = async (blank: boolean) => { await act(async () => root.render(<BotComposerIdentity {...props()}
    useSessions={selector => selector({ byId: { [sessionId]: { blank } } } as never)} />)); };
  await render(true);
  expect(container.querySelector('[data-bot-composer-identity]')?.textContent).toContain(record.name);
  expect(container.querySelector('[data-bot-avatar="emoji"]')).not.toBeNull();
  expect(container.querySelector('[data-bot-first-chat]')).not.toBeNull();
  await render(false);
  expect(container.querySelector('[data-bot-composer-identity]')).toBeNull();
});
