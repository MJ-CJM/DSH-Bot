// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import { GroupMessageCard, GroupTimeline } from '../../src/client/components/GroupTimeline.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import { groupReplyPreview, isLongGroupReply } from '../../src/client/group-reply-preview.js';
import type { GroupDelivery, GroupMessage, GroupTurn } from '../../src/shared/groups.js';
import { view } from './group-fixture.js';
const message: GroupMessage = {
  id: 'reply-1', turnId: 'turn-1', at: 1, seq: 1, authorKind: 'bot', replyTo: 'question',
  speaker: { bot: { botId: 'migration', botCreatedAt: 1 }, name: 'Migration' },
  text: ['> Are we ready?', '【Migration | Receipt】', 'Preliminary information.', '**Conclusion: Ready once the test data arrives.**',
    '## Details', 'Only shown inside the full reply.'].join('\n'),
};

it('selects an original conclusion and skips quoted questions, titles and code', () => {
  expect(groupReplyPreview(message.text)).toBe('Ready once the test data arrives.');
  expect(groupReplyPreview('# 状态\n> 用户提问\n**【迁移回执】**\n```js\nConclusion: example only\n```\n## 结论\n环境已准备好。')).toBe('环境已准备好。');
  expect(groupReplyPreview('### Report\n> quoted\n- **First** fact.\n- Second fact.')).toBe('First fact.');
  expect(groupReplyPreview('~~~\nSummary: inside code\n~~~')).toBe('');
  expect(groupReplyPreview('Ready?\nPrepared the test plan.', 'Ready?')).toBe('Prepared the test plan.');
});

it('keeps short text, pure attachments, errors and expert requests inline and supports legacy speakers', () => {
  expect(isLongGroupReply(message)).toBe(true);
  expect(isLongGroupReply({ ...message, text: 'OK' })).toBe(false);
  expect(isLongGroupReply({ ...message, text: '', hasNonText: true })).toBe(false);
  expect(isLongGroupReply({ ...message, stopReason: 'error' })).toBe(false);
  expect(isLongGroupReply({ ...message, stopReason: 'expert-request' })).toBe(false);
  expect(isLongGroupReply({ ...message, authorKind: 'user' })).toBe(false);
  expect(isLongGroupReply({ ...message, authorKind: undefined })).toBe(true);
});

it('opens the original reply and quote; collapsing from the footer returns focus to the same header', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const el = document.createElement('main');
  document.body.append(el);
  const root = createRoot(el);
  const reply = vi.fn(), jump = vi.fn();
  const t = ((key: keyof typeof en.ui, args?: { name?: string }) => en.ui[key].replace('{name}', args?.name ?? '')) as PropsLocale<'dsh-bot'>['t'];
  function Card() {
    const [expanded, setExpanded] = useState(false);
    return <GroupMessageCard message={message} quoted={{ ...message, id: 'question', text: 'Original question' }}
      fold={{ expanded, toggle: () => setExpanded(v => !v) }} onReply={reply} onJump={jump} t={t}
      labels={{ code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }}
      onOpenSession={async () => {}} onOpenAttachment={async () => {}} />;
  }
  try {
    await act(async () => root.render(<Card />));
    const header = el.querySelector<HTMLButtonElement>('[data-group-reply-toggle]');
    if (!header) throw new Error('Missing reply disclosure');
    const scroll = vi.fn();
    header.scrollIntoView = scroll;
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(el.textContent).toContain('Ready once the test data arrives.');
    expect(el.textContent).not.toContain('Original question');
    expect(el.textContent).not.toContain('Only shown inside');
    await act(async () => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(el.textContent).toContain('Only shown inside');
    await act(async () => el.querySelector<HTMLButtonElement>('blockquote button')?.click());
    expect(jump).toHaveBeenCalledWith('question');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-group-reply-collapse]')?.click());
    expect(document.activeElement).toBe(header);
    expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    await act(async () => Array.from(el.querySelectorAll('button')).find(b => b.textContent === en.ui['groups.reply'])?.click());
    expect(reply).toHaveBeenCalledWith(message);
  } finally {
    await act(async () => root.unmount());
    el.remove();
  }
});

it('operates the Bots timeline bulk action on its own multi-member round and leaves a later @ reply visible', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = view(), actions = createGroupActions(new Context(), {});
  const group = { groupId: data.group.id, groupCreatedAt: data.group.createdAt };
  const first: GroupTurn = { id: 'first', group, operationId: 'op:1', requestDigest: 'digest', inputMessageId: 'ask-1',
    createdAt: 1, updatedAt: 1, revision: 1, schemaVersion: 1, membershipRevision: 1,
    orderedMemberIds: data.members.map(m => m.id), mode: 'natural', contextThroughSeq: 1, state: 'completed' };
  const question: GroupMessage = { id: first.inputMessageId, at: 1, seq: 1, turnId: first.id, authorKind: 'user', text: 'Any updates?' };
  data.turns = [first];
  data.messages = [question, { ...message, id: 'long-a', turnId: first.id, seq: 2 },
    { ...message, id: 'long-b', turnId: first.id, seq: 3, speaker: { bot: { botId: 'tester', botCreatedAt: 1 }, name: 'Tester' } },
    { ...message, id: 'short', turnId: first.id, seq: 4, text: 'Short answer' }];
  const el = document.createElement('main'), root = createRoot(el);
  const t = ((key: keyof typeof en.ui) => en.ui[key]) as PropsLocale<'dsh-bot'>['t'];
  const render = () => act(async () => root.render(<GroupTimeline view={data} messages={data.messages} actions={actions} lookup={() => undefined}
    expanded={{}} onExpand={() => {}} busy={false} onCancel={() => {}} onReply={() => {}} onOpenSession={async () => {}}
    onOpenAttachment={async () => {}} t={t} />));
  const expanded = () => el.querySelectorAll('[data-group-reply-toggle][aria-expanded=true]').length;
  try {
    await render();
    const bulk = el.querySelector<HTMLButtonElement>('[data-group-reply-tools=first] button');
    if (!bulk) throw new Error('Missing bulk action on the original question');
    expect(el.querySelectorAll('[data-group-reply-toggle]')).toHaveLength(4);
    expect(expanded()).toBe(2);
    expect(el.querySelector('[data-group-message=short]')?.textContent).toContain('Short answer');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-group-reply-toggle=long-a]')?.click());
    expect(expanded()).toBe(3);
    await act(async () => bulk.click());
    expect(expanded()).toBe(4);
    const next = { ...first, id: 'second', inputMessageId: 'ask-2', orderedMemberIds: first.orderedMemberIds.slice(0, 1) };
    data.turns = [first, next];
    data.messages = [...data.messages, { ...question, id: next.inputMessageId, turnId: next.id, seq: 5, text: '@Migration Any detail?' },
      { ...message, id: 'targeted', turnId: next.id, seq: 6, replyTo: next.inputMessageId }];
    await render();
    expect(expanded()).toBe(6);
    expect(el.querySelector('[data-group-reply-tools=second]')).toBeNull();
    await act(async () => bulk.click());
    expect(expanded()).toBe(3);
    expect(el.querySelector('[data-group-reply-toggle=short]')?.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('[data-group-message=targeted]')?.textContent).toContain('Only shown inside the full reply.');
    expect(el.querySelector('[data-group-message=short]')?.textContent).toContain('Short answer');
  } finally { await act(async () => root.unmount()); }
});

it('shows actionable approval and failed counts in the collapsed execution summary', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = view(), rootElement = document.createElement('main'), root = createRoot(rootElement);
  const turn: GroupTurn = { id: 'inspect', group: { groupId: data.group.id, groupCreatedAt: data.group.createdAt },
    operationId: 'op', requestDigest: 'digest', inputMessageId: 'question', createdAt: 1, updatedAt: 1,
    revision: 1, schemaVersion: 1, membershipRevision: data.group.membershipRevision,
    orderedMemberIds: data.members.map(member => member.id), mode: 'natural', contextThroughSeq: 1, state: 'partial' };
  data.turns = [turn];
  const failure: GroupDelivery = { id: 'failed', turnId: turn.id, memberId: 'member:alpha', ordinal: 0,
    bot: { botId: 'alpha', botCreatedAt: 1 }, botRevision: 1, presetId: 'alpha', state: 'failed',
    contextOutputMessageIds: [], contextTruncated: false, reasonCode: 'native-failure' };
  data.deliveries = [failure, { ...failure, id: 'held', memberId: 'member:beta', ordinal: 1,
    bot: { botId: 'beta', botCreatedAt: 1 }, reasonCode: 'export-approval-required', exportFlowId: crypto.randomUUID() }];
  const t = ((key: keyof typeof en.ui, args?: { count?: number }) => en.ui[key].replace('{count}', String(args?.count))) as PropsLocale<'dsh-bot'>['t'];
  const render = () => act(async () => root.render(<GroupTimeline view={data} messages={[]} lookup={() => undefined}
    expanded={{}} onExpand={() => {}} busy={false} onCancel={() => {}} onReply={() => {}} onOpenSession={async () => {}}
    onOpenAttachment={async () => {}} t={t} />));
  try {
    await render();
    const summary = rootElement.querySelector('[data-group-turn=inspect] > button');
    if (!summary) throw new Error('Missing collapsed execution summary');
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(summary.textContent).toContain('1 awaiting review');
    expect(summary.textContent).toContain('1 failed');
    expect(summary.textContent).not.toContain('2 failed');
    data.group = { ...data.group, membershipRevision: turn.membershipRevision + 1 };
    await render();
    expect(summary.textContent).not.toContain('awaiting review');
    expect(summary.textContent).toContain('1 failed');
  } finally { await act(async () => root.unmount()); }
});
