// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { expect, it } from 'vitest';
import { GroupMemberJoins, memberJoinsForMessage } from '../../src/client/components/GroupTimeline.js';
import { bots, view } from './group-fixture.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

function membership() {
  const data = view();
  const source = data.messages[0], member = data.members[0];
  if (!source || !member) throw new Error('Missing fixture identity');
  data.messages = [{ ...source, at: 10 }, { ...source, id: 'later', seq: 2, at: 30 }];
  data.members.push({ ...member, id: 'new-expert', bot: { botId: 'alpha', botCreatedAt: 1 }, joinedAt: 20, order: 2 });
  return data;
}

it('anchors authoritative later membership once and keeps initial or paged-out joins out of the message window', () => {
  const data = membership(), first = data.messages[0], last = data.messages[1], expert = data.members[2];
  if (!first || !last || !expert) throw new Error('Missing membership fixture');
  expect(memberJoinsForMessage(data, first, 'before')).toEqual([]);
  expect(memberJoinsForMessage(data, first, 'after')).toEqual([]);
  expect(memberJoinsForMessage(data, last, 'before').map(row => row.id)).toEqual(['new-expert']);
  expect(memberJoinsForMessage(data, last, 'after')).toEqual([]);
  expert.joinedAt = 40;
  expect(memberJoinsForMessage(data, last, 'after').map(row => row.id)).toEqual(['new-expert']);
  expert.joinedAt = 5; data.hasEarlier = true;
  expect(memberJoinsForMessage(data, first, 'before')).toEqual([]);
  expect(memberJoinsForMessage(data, { ...first, id: 'unrelated' }, 'before')).toEqual([]);
});

it('keeps removed membership as history and distinguishes a later rejoin of the same Bot', () => {
  const data = membership(), message = data.messages[1], admission = data.members[2];
  if (!message || !admission) throw new Error('Missing membership fixture');
  admission.enabled = false; admission.removedAt = 25;
  data.members.push({ ...admission, id: 'rejoined-expert', enabled: true, removedAt: undefined, joinedAt: 28 });
  expect(memberJoinsForMessage(data, message, 'before').map(row => row.id)).toEqual(['new-expert', 'rejoined-expert']);
  // Initial members retain joinedAt === group.createdAt, even if removed later.
  const initial = data.members[0];
  if (!initial) throw new Error('Missing initial member');
  initial.enabled = false; initial.removedAt = 26;
  expect(memberJoinsForMessage(data, message, 'before').some(row => row.id === initial.id)).toBe(false);
});

it('never relocates an admission before a truncated window or invents an event for an unloaded native message', () => {
  const data = membership(), historical = data.messages[0], latest = data.messages[1];
  if (!historical || !latest) throw new Error('Missing history window');
  data.messages = [latest]; data.hasEarlier = true;
  expect(memberJoinsForMessage(data, latest, 'before')).toEqual([]);
  expect(memberJoinsForMessage(data, historical, 'before')).toEqual([]);
  data.messages = [historical, latest];
  expect(memberJoinsForMessage(data, latest, 'before').map(row => row.id)).toEqual(['new-expert']);
});

it.each(['en', 'zh'] as const)('%s join event uses real timestamp and exact Bot generation without inventing an inviter', async language => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = membership();
  const message = data.messages[1];
  if (!message) throw new Error('Missing later message');
  message.speaker = { bot: { botId: 'alpha', botCreatedAt: 1 }, name: 'Historical expert', avatar: '🧪', avatarVariant: 'glasses' };
  const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => (language === 'en' ? en : zh).ui[key]
    .replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? name))) as PropsLocale<'dsh-bot'>['t'];
  const element = document.createElement('main'), root = createRoot(element);
  try {
    await act(async () => root.render(<GroupMemberJoins view={data} message={message} position="before"
      bots={bots.map(bot => ({ ...bot, createdAt: 999, name: 'Wrong generation' }))} t={t} />));
    const event = element.querySelector('[data-group-member-joined="new-expert"]');
    expect(event?.textContent).toContain(t('groups.memberJoined', { name: 'Historical expert' }));
    expect(event?.textContent).not.toContain('Wrong generation');
    expect(event?.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(20).toISOString());
    expect(event?.querySelector('[data-bot-avatar]')?.textContent).toBe('🧪');
    expect(element.querySelectorAll('[data-group-member-joined]')).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
});
