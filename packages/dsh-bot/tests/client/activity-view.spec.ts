import { describe, expect, it } from 'vitest';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { ACTIVITY_HIDDEN_PREVIEW, type ActivitySession } from '../../src/shared/activity.js';
import { botCreateSchema, botSchema } from '../../src/shared/schema.js';
import { botSessionRows, previewText, relativeTime, sortBotEntries } from '../../src/client/activity-view.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

const entry = (id: string, name: string, createdAt = 1) => ({ bot: botSchema.parse({ ...botCreateSchema.parse({ id, name }), createdAt, updatedAt: createdAt, schemaVersion: 1 }),
  status: { id, presetId: `custom/${id}`, preset: { state: 'ok' as const } } });
describe('activity display projection', () => {
  it('orders active Bots first and breaks inactive ties by localized name, creation time and id', () => {
    const entries = [entry('zebra-bot', 'Zebra'), entry('alpha-two', 'Alpha', 2), entry('alpha-one', 'Alpha'), entry('active-bot', 'Last')];
    expect(sortBotEntries(entries, [{ botId: 'active-bot', lastActivityAt: 5, unreadCount: 1 }], 'en').map(({ bot }) => bot.id))
      .toEqual(['active-bot', 'alpha-one', 'alpha-two', 'zebra-bot']);
    expect(entries[0]?.bot.id).toBe('zebra-bot');
  });
  it('localizes both old and new hidden markers, and relative times by active UI locale', () => {
    for (const dictionary of [en.ui, zh.ui]) {
      const t = ((key: keyof typeof en.ui) => dictionary[key]) as PropsLocale<'dsh-bot'>['t'];
      for (const marker of [ACTIVITY_HIDDEN_PREVIEW, '[已隐藏]']) expect(previewText(marker, t)).toBe(dictionary['activity.hidden']);
      expect(previewText('Hello', t)).toBe('Hello');
    }
    expect(relativeTime(60_000, 'en', 180_000)).toBe(new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' }).format(-2, 'minute'));
    expect(relativeTime(60_000, 'zh', 180_000)).toBe(new Intl.RelativeTimeFormat('zh', { numeric: 'auto', style: 'short' }).format(-2, 'minute'));
    expect(relativeTime(0, 'en')).toBe('');
  });
  it('uses authoritative Host membership and preset identity, enriched with sanitized activity and running state', () => {
    const summary = { id: 'current', displayTitle: 'Host title', updatedAt: 5, running: true, projectionValues: { agentPreset: 'custom/alpha-bot' } };
    const sessions = { ids: ['current', 'old', 'sub', 'archived', 'other'], byId: {
      current: summary, old: { ...summary, id: 'old', updatedAt: 2, running: false },
      cached: { ...summary, id: 'cached' }, sub: { ...summary, id: 'sub', origin: 'subagent' },
      archived: { ...summary, id: 'archived' }, other: { ...summary, id: 'other', projectionValues: { agentPreset: 'wrong' } },
    }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState;
    const activity: ActivitySession = { botId: 'alpha-bot', sessionId: 'current', title: ACTIVITY_HIDDEN_PREVIEW,
      lastMessage: { role: 'assistant', at: 10, preview: ACTIVITY_HIDDEN_PREVIEW }, updatedAt: 10, unread: true };
    expect(botSessionRows('alpha-bot', [entry('alpha-bot', 'Alpha')], sessions, [activity], ['archived' as never]))
      .toEqual([{ id: 'current', title: ACTIVITY_HIDDEN_PREVIEW, preview: ACTIVITY_HIDDEN_PREVIEW, updatedAt: 10, unread: true, running: true },
        { id: 'old', title: 'Host title', preview: '', updatedAt: 2, unread: false, running: false }]);
  });
});
