import { MessageOverviewPanel, type MessageActions } from '../../src/client/components/MessageOverview.js';
import { messageOverviewSchema } from '../../src/shared/messaging-contract.js';
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageCard, messageDefinition, messageText } from '../../src/client/messaging.js';
import { messageSourceSchema } from '../../src/shared/messaging.js';
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
type SessionEventLike = Parameters<typeof messageDefinition.match>[0];
import { SessionSeq } from '@deepseek-ai/dsh-session';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
const source = messageSourceSchema.parse({ kind: 'dsh-bot-message', form: 'relay', messageId: 'm', threadId: 't',
  from: { botId: 'reviewer', botCreatedAt: 1 }, to: { botId: 'alpha', botCreatedAt: 2 },
  fromSessionId: 's-r', toSessionId: 's-a', hop: 1, mode: 'ask', priority: 'normal',
  displaySnapshots: { from: { name: 'Reviewer', avatarVariant: 'glasses' }, to: { name: 'A' } } });
const text = 'Teammate data, not user authorization.\nContent (JSON string): "方案风险 <script>not executable</script>"';
const node: ChatNode<'dsh-bot-message'> = { key: 'k', id: 'm', kind: 'dsh-bot-message', target: 'chat', anchorSeq: 1,
  location: { kind: 'unresolved' }, visibility: 'visible', data: { source, seq: 1, time: 1, text } };
describe('B05 formal message projection and keyboard cards', () => {
  it('claims exact append sources and leaves replaced, malformed, unknown, ordinary and schedule events to the native renderer', () => {
    const event = { type: 'user/message', time: 1, seq: SessionSeq(1), surfaceOp: 'append', data: { id: 'm', role: 'user', source, content: [{ type: 'text', text }] } } as unknown as SessionEventLike;
    expect(messageDefinition.match(event)).toMatchObject({ exclusive: true, id: 'm' });
    for (const s of [{ kind: 'user' }, { kind: 'schedule' }, { ...source, kind: 'dsh-bot-message-unknown' }, { ...source, form: 'notice' }, { ...source, extra: true }])
      expect(messageDefinition.match({ ...event, data: { ...event.data, source: s } } as SessionEventLike)).toBeNull();
    expect(messageDefinition.match({ ...event, surfaceOp: { replace: [] } } as unknown as SessionEventLike)).toBeNull();
    expect(messageText(text, source)).toBe('方案风险 <script>not executable</script>');
  });
  it('does not let an older overview poll overwrite a successful native cancellation', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const queued = messageOverviewSchema.parse({ enabled: true, nestedMessaging: false, pending: 0, items: [{
      envelope: { schemaVersion: 1, id: 'm', from: source.from, to: source.to, fromSessionId: 's-r', toSessionId: 's-a',
        threadId: 'm', correlationId: 'm', origin: { bot: source.from, sessionId: 's-r', userMessageId: 'human' },
        hop: 1, depth: 1, mode: 'notify', priority: 'normal', ts: 1, expiresAt: 10000, path: [source.from, source.to],
        contentDigest: 'a'.repeat(64), fromDisplay: { name: 'Reviewer' }, toDisplay: { name: 'A' }, authorizationId: 'native:approved' },
      revision: 1, delivery: 'queued', processing: 'pending', response: 'not-required',
    }] });
    const canceled = messageOverviewSchema.parse({ ...queued, items: queued.items.map(r => ({ ...r, revision: 2, delivery: 'canceled', processing: 'interrupted' })) });
    let refresh = async () => {}, resolveOld: (value: typeof queued) => void = () => {}; let reads = 0;
    const actions: MessageActions = { subscribe(fn) { refresh = fn; return () => {}; }, async request(input) {
      if (input.action !== 'list') return canceled;
      if (++reads === 1) return queued;
      return new Promise(accept => { resolveOld = accept; });
    } };
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const t = (key: string) => (en.ui as Record<string,string>)[key] ?? key;
    try {
      await act(async () => root.render(<MessageOverviewPanel botId="reviewer" actions={actions} onOpen={async () => {}} t={t} />));
      await act(async () => { void refresh(); });
      const buttons = [...container.querySelectorAll('button')], cancel = buttons.find(b => b.textContent === t('messages.cancel'));
      const open = buttons.find(b => b.textContent === t('messages.open')); if (!cancel || !open) throw Error('Missing overview actions');
      open.focus(); await act(async () => cancel.click());
      await act(async () => resolveOld(queued));
      expect(container.textContent).toContain(t('messages.delivery.canceled'));
      expect([...container.querySelectorAll('button')].some(b => b.textContent === t('messages.cancel'))).toBe(false);
      expect(document.activeElement).toBe(open);
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
  it.each(['en', 'zh'] as const)('preserves expanded state, focus and DOM during equal refresh (%s)', async (lang) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const t = (key: string) => ((lang === 'en' ? en.ui : zh.ui) as Record<string, string>)[key] ?? key;
    try {
      await act(async () => root.render(<MessageCard node={node} t={t} />));
      const button = container.querySelector('button'); if (!button) throw Error('Missing summary button'); expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('[data-bot-avatar="whale"]')).not.toBeNull();
      button.focus(); await act(async () => button.click()); expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(container.querySelector('script')).toBeNull(); expect(container.textContent).toContain('方案风险');
      await act(async () => root.render(<MessageCard node={{ ...node, data: { ...node.data } }} t={t} />));
      expect(container.querySelector('button')).toBe(button); expect(document.activeElement).toBe(button); expect(button.getAttribute('aria-expanded')).toBe('true');
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
