import { describe, expect, it } from 'vitest';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { ACTIVITY_HIDDEN_PREVIEW, type ActivitySession } from '../../src/shared/activity.js';
import { botCreateSchema, botSchema } from '../../src/shared/schema.js';
import { botSessionRows, previewText, relativeTime, sessionTitle, sortBotEntries } from '../../src/client/activity-view.js';
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
      current: summary, old: { ...summary, title: 'Host title', id: 'old', updatedAt: 2, running: false },
      cached: { ...summary, id: 'cached' }, sub: { ...summary, id: 'sub', origin: 'subagent' },
      archived: { ...summary, id: 'archived' }, other: { ...summary, id: 'other', projectionValues: { agentPreset: 'wrong' } },
    }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState;
    const activity: ActivitySession = { botId: 'alpha-bot', sessionId: 'current', title: ACTIVITY_HIDDEN_PREVIEW,
      lastMessage: { role: 'assistant', at: 10, preview: ACTIVITY_HIDDEN_PREVIEW }, updatedAt: 10, unread: true };
    expect(botSessionRows('alpha-bot', [entry('alpha-bot', 'Alpha')], sessions, [activity], ['archived' as never]))
      .toEqual([{ id: 'current', title: ACTIVITY_HIDDEN_PREVIEW, preview: ACTIVITY_HIDDEN_PREVIEW, updatedAt: 10, unread: true, running: true },
        { id: 'old', title: 'Host title', preview: '', updatedAt: 2, unread: false, running: false }]);
  });

  it('keeps a blank session out of history after its preset refreshes, then shows it after the first message', () => {
    const id = 'new-session';
    const summary = { id, displayTitle: 'Bots', cwd: '/shared/bots', updatedAt: 5, running: false, blank: true };
    const snapshot = (row: typeof summary & { projectionValues?: { agentPreset: string } }) => ({
      ids: [id], byId: { [id]: row }, phase: 'ready', projectionsBySession: {},
    }) as unknown as SessionListState;
    const entries = [entry('alpha-bot', 'Alpha')];
    expect(botSessionRows('alpha-bot', entries, snapshot(summary), [])).toEqual([]);
    const resolved = { ...summary, projectionValues: { agentPreset: 'custom/alpha-bot' } };
    expect(botSessionRows('alpha-bot', entries, snapshot(resolved), [])).toEqual([]);
    // Native message state is authoritative; a delayed/evicted plugin activity
    // summary must not hide an otherwise valid conversation after its first send.
    expect(botSessionRows('alpha-bot', entries, snapshot({ ...resolved, blank: false }), []).map((row) => row.id))
      .toEqual([id]);
  });

  it('uses the live durable title, activity title, first human preview, then an empty locale fallback; never displayTitle/cwd', () => {
    const activity: ActivitySession = { botId: 'alpha-bot', sessionId: 'test', title: 'Earlier title', firstUserPreview: 'First question',
      lastMessage: { role: 'assistant', at: 10, preview: 'Latest answer' }, updatedAt: 10, unread: false };
    expect(sessionTitle({ title: '  Renamed live  ' }, activity)).toBe('Renamed live');
    expect(sessionTitle({ title: '  ' }, activity)).toBe('Earlier title');
    expect(sessionTitle({}, { ...activity, title: '' })).toBe('First question');
    expect(sessionTitle({}, { ...activity, title: '', firstUserPreview: '' })).toBe('');
    const session = { id: 'test', displayTitle: 'pod_0814', cwd: '/projects/pod_0814', updatedAt: 5,
      running: false, projectionValues: { agentPreset: 'custom/alpha-bot' } };
    const sessions = { ids: ['test'], byId: { test: session }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState;
    expect(botSessionRows('alpha-bot', [entry('alpha-bot', 'Alpha')], sessions, [])[0]?.title).toBe('');
  });

  it('only adds a workspace label for a known workspace different from the current main-view context', () => {
    const summary = { displayTitle: 'pod_0814', updatedAt: 5, running: false, projectionValues: { agentPreset: 'custom/alpha-bot' } };
    const sessions = { ids: ['same', 'other'], byId: {
      same: { ...summary, id: 'same', cwd: '/current', retainedBy: { mainView: 1 } },
      other: { ...summary, id: 'other', cwd: '/other', retainedBy: {} },
    }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState;
    const workspaces = [{ path: '/current', title: 'Current' }, { path: '/other', title: 'Other workspace' }];
    const rows = botSessionRows('alpha-bot', [entry('alpha-bot', 'Alpha')], sessions, [], [], workspaces);
    expect(rows.find((row) => row.id === 'same')?.workspaceTitle).toBeUndefined();
    expect(rows.find((row) => row.id === 'other')?.workspaceTitle).toBe('Other workspace');
    expect(botSessionRows('alpha-bot', [entry('alpha-bot', 'Alpha')], sessions, [], [], []).every((row) => !row.workspaceTitle)).toBe(true);
  });

  it('screens live public titles before truncation and uses the same hidden marker as Host summaries', () => {
    const secret = `sk-${'a'.repeat(24)}`;
    for (const title of [secret, `${'safe '.repeat(50)}${secret}`, `**sk-**${'a'.repeat(24)}`]) {
      expect(sessionTitle({ title })).toBe(ACTIVITY_HIDDEN_PREVIEW);
    }
    expect(sessionTitle({ title: '# **Visible** title' })).toBe('Visible title');
    expect([...sessionTitle({ title: '好'.repeat(121) })]).toHaveLength(120);
  });
});
