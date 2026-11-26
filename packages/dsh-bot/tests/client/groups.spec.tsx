// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { createGroupActions } from '../../src/client/groups-state.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import { GroupConversation } from '../../src/client/components/GroupsPanel.js';
import { GroupMessageCard, GroupTimeline } from '../../src/client/components/GroupTimeline.js';
import { selectGroupComposer, groupMessageDefinition } from '../../src/client/workspace-group.js';
import { GroupReplyFolds } from '../../src/client/group-reply-folds.js';
import { bots, view, summary, configure } from './group-fixture.js';
import { bot, mountClient, button, click, fill, field } from './helpers.js';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
async function composer(language: 'en' | 'zh' = 'en', workspace = true, catalog = bots) {
  const ctx = new Context(); const data = view(); data.group.mode = 'natural';
  const send = vi.fn<GroupMethods['send']>(async () => { throw new Error('uncertain'); });
  const cancel = vi.fn<GroupMethods['cancel']>();
  const remote = { view: async () => ({ ok: true, value: data }), list: async () => ({ ok: true, value: [summary()] }), send, cancel } as unknown as GroupMethods;
  ctx.provide('remote.dshBot.groups', remote);
  const actions = createGroupActions(ctx, {}), element = document.createElement('div'); document.body.append(element);
  let root = createRoot(element); const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) =>
    (language === 'en' ? en : zh).ui[key].replace(/\{(\w+)\}/g, (_match, k) => String(params?.[k] ?? k))) as PropsLocale<'dsh-bot'>['t'];
  const render = async () => { await act(async () => root.render(<GroupConversation workspace={workspace} summary={summary()} actions={actions} bots={catalog}
    expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={async () => {}} t={t} />));
    await vi.waitFor(() => expect(element.querySelector('textarea')).toBeTruthy()); };
  await render();
  return { element, actions, send, cancel, t, data,
    async remount() { await act(async () => root.unmount()); root = createRoot(element); await render(); },
    async refresh() { await act(async () => { for (const listener of [] as Array<() => void>) listener(); await actions.catalog.refresh(); }); },
    async close() { await act(async () => root.unmount()); await ctx.fiber.dispose(); element.remove(); },
  };
}
describe('workspace group composer and management', () => {
  it.each(['en', 'zh'] as const)('%s retains draft/focus and failed request id, with no second message timeline', async language => {
    const f = await composer(language);
    try {
      const draft = field(f.element, f.t('groups.message')) as HTMLTextAreaElement;
      expect(f.element.querySelector('[role="log"]')).toBeNull();
      await fill(draft, 'ordinary message'); draft.focus(); draft.setSelectionRange(2, 4);
      expect(document.activeElement).toBe(draft);
      await click(button(f.element, f.t('groups.send')));
      expect(f.element.textContent).toContain(f.t('groups.export.sendFailed')); expect(draft.value).toBe('ordinary message');
      const first = f.send.mock.calls[0]?.[1];
      await f.remount();
      expect((field(f.element, f.t('groups.message')) as HTMLTextAreaElement).value).toBe('ordinary message');
      await click(button(f.element, f.t('groups.send')));
      expect(f.send.mock.calls[1]?.[1].operationId).toBe(first?.operationId);
    } finally { await f.close(); }
  });
  it('sends an explicit plain-text question to a guest by its exact identity', async () => {
    const text = '问 Jarvis：请介绍你自己';
    const jarvis = bot({ id: 'outside', name: 'Jarvis' }), f = await composer('zh', true, [...bots, jarvis]);
    try {
      await fill(field(f.element, f.t('groups.message')), text);
      await click(button(f.element, f.t('groups.send')));
      expect(f.send.mock.calls[0]?.[1]).toMatchObject({ text, expectedGuest: { botId: 'outside', botCreatedAt: jarvis.createdAt },
        memberIds: [] });
      expect(f.send.mock.calls[0]?.[1]).not.toHaveProperty('expectedRelay');
    } finally { await f.close(); }
  });
  it.each(['你问下 Jarvis 最近有和这个相关的吗？', '@Beta 问下 Jarvis 最近有和这个相关的吗？'])('submits the named relay and only the human-supplied topic: %s', async text => {
    const jarvis = bot({ id: 'outside', name: 'Jarvis' });
    const f = await composer('zh', true, [bot({ id: 'alpha', name: 'Alpha' }), bot({ id: 'beta', name: 'Beta' }), jarvis]);
    try {
      const quoted = f.data.messages[0]!;
      if (!text.startsWith('@')) await act(async () => f.actions.reply('group-root-one', quoted));
      await fill(field(f.element, f.t('groups.message')), text);
      expect(f.element.textContent).toContain(f.t('groups.relay.hint', { sender: 'Beta', guest: 'Jarvis' }));
      await click(button(f.element, f.t('groups.send')));
      expect(f.send).not.toHaveBeenCalled();
      expect(f.element.textContent).toContain(f.t('groups.relay.topicRequired'));
      await fill(field(f.element, f.t('groups.relay.topicLabel')), 'HarmonyOS migration');
      await f.remount();
      expect(field(f.element, f.t('groups.relay.topicLabel')).value).toBe('HarmonyOS migration');
      await click(button(f.element, f.t('groups.send')));
      const request = f.send.mock.calls[0]?.[1];
      expect(request).toMatchObject({ text, expectedGuest: { botId: 'outside', botCreatedAt: jarvis.createdAt },
        expectedRelay: { botId: 'beta', botCreatedAt: 1 }, relayTopic: 'HarmonyOS migration', memberIds: ['member:beta'] });
      expect(request?.replyTo).toBe(text.startsWith('@') ? undefined : quoted.id);
      expect(JSON.stringify(request)).not.toContain(quoted.text);
    } finally { await f.close(); }
  });
  it.each([true, false])('only lists everyone and available group members in the @ menu (workspace=%s)', async workspace => {
    const f = await composer('zh', workspace, [...bots, bot({ id: 'outside', name: 'Jarvis' })]);
    try {
      const member = f.data.members[0]!;
      f.data.members.push({ ...member, id: 'disabled-member', bot: { botId: 'disabled', botCreatedAt: 2 }, enabled: false },
        { ...member, id: 'removed-member', bot: { botId: 'removed', botCreatedAt: 3 }, removedAt: 4 });
      f.data.unavailableMemberIds.push(f.data.members[1]!.id);
      await f.remount();
      const draft = field(f.element, f.t('groups.message'));
      for (const text of ['@', '请 @']) {
        await fill(draft, text);
        await vi.waitFor(() => expect(Array.from(f.element.querySelectorAll('[role=option] strong'), el => el.textContent))
          .toEqual(['everyone', 'Same name']));
      }
      await fill(draft, '@Jar');
      await vi.waitFor(() => expect(f.element.querySelector('[role=option]')).toBeNull());
      expect(draft.value).toBe('@Jar');
      await fill(draft, '@everyone check in');
      await click(button(f.element, f.t('groups.send')));
      expect(f.send.mock.calls[0]?.[1].memberIds).toEqual([member.id]);
    } finally { await f.close(); }
  });
  it('updates an open mention menu when members leave or are disabled without editing the draft', async () => {
    const f = await composer('en', true, [bot({ id: 'alpha', name: 'Alpha' }), bot({ id: 'beta', name: 'Beta' })]);
    try {
      const draft = field(f.element, f.t('groups.message'));
      const options = () => Array.from(f.element.querySelectorAll('[role=option] strong'), el => el.textContent);
      await fill(draft, '@');
      await vi.waitFor(() => expect(options()).toEqual(['everyone', 'Alpha', 'Beta']));
      f.data.members[0]!.enabled = false;
      f.data.members[1]!.removedAt = 4;
      f.data.group.membershipRevision++;
      await act(async () => f.actions.messageView({ groupId: f.data.group.id, groupCreatedAt: f.data.group.createdAt }).refresh());
      await vi.waitFor(() => expect(options()).toEqual(['everyone']));
      expect(draft.value).toBe('@');
      expect(f.send).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each(['@Jarvis 请介绍你自己', '请 @Jarvis 核实', '＠Jarvis 请介绍你自己', '让 Beta 问 @Jarvis：核实版本'])(
    'keeps an out-of-group @ in the draft without dispatching: %s', async text => {
      const f = await composer('zh', true, [bot({ id: 'alpha', name: 'Alpha' }), bot({ id: 'beta', name: 'Beta' }),
        bot({ id: 'outside', name: 'Jarvis' })]);
      try {
        const draft = field(f.element, f.t('groups.message'));
        await fill(draft, text);
        await click(button(f.element, f.t('groups.send')));
        expect(f.send).not.toHaveBeenCalled();
        expect(draft.value).toBe(text);
        expect(Array.from(f.element.querySelectorAll('[role=alert]'), el => el.textContent).join(' ')).toContain('@');
      } finally { await f.close(); }
    });
  it('retains old guest picks in the draft without routing them to a namesake group member', async () => {
    const jarvis = bot({ id: 'outside', name: 'Jarvis' });
    const f = await composer('zh', true, [bot({ id: 'alpha', name: 'Jarvis' }), jarvis]);
    try {
      const text = '@Jarvis 请核实版本';
      const mention = '@Jarvis';
      await act(async () => f.actions.patchDraft(f.data.group.rootSessionId, draft => ({ ...draft, text,
        mentionBindings: [{ start: 0, end: mention.length, text: mention, memberId: 'guest:' + JSON.stringify([jarvis.id, jarvis.createdAt]) }] })));
      await f.remount();
      await click(button(f.element, f.t('groups.send')));
      expect(f.send).not.toHaveBeenCalled();
      expect(field(f.element, f.t('groups.message')).value).toBe(text);
    } finally { await f.close(); }
  });
  it('resolves a typed member @ within the group even if a guest has the same display name', async () => {
    const f = await composer('zh', true, [bot({ id: 'alpha', name: 'Jarvis' }), bot({ id: 'guest-duplicate', name: 'Jarvis' })]);
    try {
      await fill(field(f.element, f.t('groups.message')), '@Jarvis how are you?');
      await click(button(f.element, f.t('groups.send')));
      const request = f.send.mock.calls[0]?.[1];
      expect(request?.memberIds).toEqual(['member:alpha']);
      expect(request).not.toHaveProperty('expectedGuest');
    } finally { await f.close(); }
  });
  it.each(['guest-ambiguous', 'guest-unavailable', 'guest-changed'] as const)('shows the host reason for a rejected guest question: %s', async code => {
    const f = await composer();
    try {
      f.send.mockRejectedValueOnce({ code: `dsh-bot/${code}` });
      await fill(field(f.element, f.t('groups.message')), 'Ask Jarvis what is the status?');
      await click(button(f.element, f.t('groups.send')));
      expect(f.element.textContent).toContain(f.t(code === 'guest-unavailable' ? 'groups.guest.unavailable' : code === 'guest-ambiguous' ? 'groups.guest.ambiguous' : 'groups.guest.changed'));
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });
  it.each(['group-data-blocked', 'conflict', 'member-limit'] as const)('shows a specific %s refusal and retains the draft', async code => {
    const f = await composer();
    try {
      f.send.mockRejectedValueOnce({ code: `dsh-bot/${code}` });
      await fill(field(f.element, f.t('groups.message')), 'keep this draft');
      await click(button(f.element, f.t('groups.send')));
      expect(f.element.textContent).toContain(f.t(code === 'group-data-blocked' ? 'groups.export.dataBlocked' : code === 'member-limit' ? 'groups.memberLimitFailed' : 'groups.conflict', { limit: 6 }));
      expect(field(f.element, f.t('groups.message')).value).toBe('keep this draft');
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });
  it('cleared reply does not resurrect after switch and staged receipts persist', async () => {
    const f = await composer();
    try {
      await act(async () => f.actions.reply('group-root-one', view().messages[0] as NonNullable<ReturnType<typeof view>['messages'][0]>));
      await click(button(f.element, f.t('groups.clearReply')));
      await act(async () => f.actions.patchDraft('group-root-one', value => ({ ...value, uploads: [{ id: 'a', name: 'file.txt', bytes: 3, state: 'uploaded', receiptId: 'real-receipt' }] })));
      await f.remount();
      expect(f.actions.draft('group-root-one').replyTo).toBeUndefined();
      expect(f.element.textContent).toContain('file.txt');
      await click(button(f.element, f.t('groups.send')));
      expect(f.send.mock.calls[0]?.[1].fileReceiptIds).toEqual(['real-receipt']);
    } finally { await f.close(); }
  });
  it('late acceptance clears only sent data even after unmount while preserving a newer draft', async () => {
    const f = await composer(); let settle!: (value: Awaited<ReturnType<GroupMethods['send']>>) => void;
    try {
      f.send.mockReturnValueOnce(new Promise(resolve => { settle = resolve; }));
      await fill(field(f.element, f.t('groups.message')), 'sent text'); await click(button(f.element, f.t('groups.send')));
      await f.remount(); expect(button(f.element, f.t('groups.send')).disabled).toBe(true);
      await fill(field(f.element, f.t('groups.message')), 'new text');
      await act(async () => settle({ ok: true, value: {} as never }));
      expect(field(f.element, f.t('groups.message')).value).toBe('new text');
      expect(f.actions.draft('group-root-one').operation).toBeUndefined();
      expect(button(f.element, f.t('groups.send')).disabled).toBe(false);
    } finally { await f.close(); }
  });
  it.each(['Enter', 'Shift', 'IME', '229'] as const)('keyboard gating %s', async mode => {
    const f = await composer();
    try {
      const draft = field(f.element, f.t('groups.message')); await fill(draft, 'keyboard');
      await act(async () => draft.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true,
        shiftKey: mode === 'Shift', isComposing: mode === 'IME', keyCode: mode === '229' ? 229 : 13 })));
      expect(f.send).toHaveBeenCalledTimes(mode === 'Enter' ? 1 : 0);
    } finally { await f.close(); }
  });
  it('exact roots select the replacement; ordinary conversations keep the native composer', async () => {
    const f = await composer();
    try {
      await f.actions.catalog.refresh();
      expect(selectGroupComposer({ sessionId: 'normal' as never }, f.actions)).toBeNull();
      expect(selectGroupComposer({ sessionId: 'group-root-one' as never }, f.actions)).toEqual({ sessionId: 'group-root-one' });
      expect(selectGroupComposer({ sessionId: 'group-root-fake' as never }, f.actions)).toBeNull();
    } finally { await f.close(); }
  });
  it('plugin group page manages and opens the workspace, without a parallel chat', async () => {
    const app = await mountClient(bots, 'en', configure);
    try {
      await click(button(app.container, en.ui['groups.title']));
      await click(button(app.container, en.ui['card.more'] + ' · Synthetic group'));
      await click(button(app.container, en.ui['chat.profile']));
      await vi.waitFor(() => expect(app.container.textContent).toContain('Synthetic group'));
      expect(app.container.querySelector('[role="log"]')).toBeNull();
      expect(app.container.querySelector('textarea')).toBeNull();
      expect(button(app.container, en.ui['groups.open'])).toBeTruthy();
    } finally { await app.dispose(); }
  });
});

describe('exclusive native group message projection', () => {
  it('claims only canonical appended Bot messages, preserving normal user and malformed-source fallback', () => {
    const event = { type: 'user/message', surfaceOp: 'append', data: { id: 'bot-message', source: { kind: 'dsh-bot-group',
      group: { groupId: 'g', groupCreatedAt: 1 }, memberId: 'a', turnId: 'turn', speaker: { bot: { botId: 'alpha', botCreatedAt: 1 }, name: 'Alpha' } } } };
    expect(groupMessageDefinition.match(event as never)?.exclusive).toBe(true);
    expect(groupMessageDefinition.match({ ...event, data: { ...event.data, source: { kind: 'user' } } } as never)).toBeNull();
    expect(groupMessageDefinition.match({ ...event, data: { ...event.data, source: { kind: 'dsh-bot-group' } } } as never)).toBeNull();
  });
  it.each(['completed', 'group-message', 'error', 'aborted', 'max-tokens', 'refusal'] as const)('native card preserves real partial state: %s', async reason => {
    const element = document.createElement('div'), root = createRoot(element);
    try {
      await act(async () => root.render(<GroupMessageCard message={{ ...(view().messages[0] ?? {}), id: 'message', seq: 1, at: 1, text: 'reply', turnId: 'turn', stopReason: reason }}
        labels={{ code: { copyLabel: 'copy', copiedLabel: 'copied' }, footnotes: 'footnotes' }} onReply={() => {}} onOpenAttachment={async () => {}}
        onOpenSession={async () => {}} t={(key => en.ui[key as keyof typeof en.ui]) as PropsLocale<'dsh-bot'>['t']} />));
      expect(element.textContent?.includes(en.ui['groups.partial'])).toBe(!['completed', 'group-message'].includes(reason));
      // The raw native stop value is never the only explanation.
      expect(element.querySelector('[data-group-stop]')?.textContent?.trim().endsWith(` · ${reason}`) ?? false).toBe(false);
    } finally { await act(async () => root.unmount()); }
  });
  it.each([
    [{ code: 'QUOTA', status: 402, message: 'Insufficient Balance (request_id: r-1)' }, en.ui['groups.failure.quota'], 'QUOTA · 402'],
    [{ code: 'ACCOUNT_QUOTA', message: 'quota' }, en.ui['groups.failure.quota'], 'ACCOUNT_QUOTA'],
    [{ code: 'AUTH', status: 401, message: 'bad key' }, en.ui['groups.failure.auth'], 'AUTH · 401'],
    [{ code: 'APPROVAL_REJECTED', message: 'the user rejected tool "bot_delegate"' }, en.ui['groups.failure.approvalRejected'], 'APPROVAL_REJECTED'],
    [{ code: 'UPSTREAM', status: 503, message: 'Service temporarily unavailable' }, 'Service temporarily unavailable', 'UPSTREAM · 503'],
    [undefined, en.ui['groups.stop.error'], ''],
  ] as const)('names the native failure cause on a partial reply: %o', async (failure, text, code) => {
    const element = document.createElement('div'), root = createRoot(element);
    try {
      await act(async () => root.render(<GroupMessageCard message={{ ...(view().messages[0] ?? {}), id: 'message', seq: 1, at: 1, text: 'reply', turnId: 'turn',
        stopReason: 'error', ...(failure ? { failure } : {}) }}
        labels={{ code: { copyLabel: 'copy', copiedLabel: 'copied' }, footnotes: 'footnotes' }} onReply={() => {}} onOpenAttachment={async () => {}}
        onOpenSession={async () => {}} t={(key => en.ui[key as keyof typeof en.ui]) as PropsLocale<'dsh-bot'>['t']} />));
      const status = element.querySelector('[data-group-stop="error"]');
      expect(status?.textContent).toBe(`${en.ui['groups.partial']} · ${text}${code}`);
    } finally { await act(async () => root.unmount()); }
  });
  it('keeps a claimed Bot message when its stored failure detail is malformed', () => {
    const source = { kind: 'dsh-bot-group', group: { groupId: 'g', groupCreatedAt: 1 }, memberId: 'a', turnId: 'turn',
      speaker: { bot: { botId: 'alpha', botCreatedAt: 1 }, name: 'Alpha' }, stopReason: 'error' };
    const event = (extra: object) => ({ type: 'user/message', surfaceOp: 'append', seq: 3, time: 1,
      data: { id: 'bot-message', content: [{ type: 'text', text: 'partial' }], source: { ...source, ...extra } } });
    const failure = { code: 'QUOTA', status: 402, message: 'Insufficient Balance' };
    const start = (value: ReturnType<typeof event>) => groupMessageDefinition.start({} as never, { event: value } as never, undefined as never).message;
    expect(start(event({ failure })).failure).toEqual(failure);
    expect(groupMessageDefinition.match(event({ failure: { status: 'bad' } }) as never)?.exclusive).toBe(true);
    expect(start(event({ failure: { status: 'bad' } }))).not.toHaveProperty('failure');
  });
});


describe('caret group mention UI', () => {
  it('selects same-name member by stable identity with Tab; remount keeps text and binding', async () => {
    const f = await composer();
    try {
      const input = field(f.element, f.t('groups.message')) as HTMLTextAreaElement;
      await fill(input, 'hello @');
      await vi.waitFor(() => expect(f.element.querySelectorAll('[role="option"]')).toHaveLength(3));
      await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
      await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
      expect(input.value).toBe('hello @Same name ');
      expect(f.send).not.toHaveBeenCalled();
      await f.remount();
      await click(button(f.element, f.t('groups.send')));
      expect(f.send.mock.calls[0]?.[1].memberIds).toEqual(['member:alpha']);
      expect(f.element.querySelector('select')).toBeNull();
      expect(f.element.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    } finally { await f.close(); }
  });
  it('composition closing Enter cannot select or send; next ordinary Enter can select', async () => {
    const f = await composer();
    try {
      const input = field(f.element, f.t('groups.message')) as HTMLTextAreaElement;
      await fill(input, '@');
      await vi.waitFor(() => expect(f.element.querySelectorAll('[role="option"]')).toHaveLength(3));
      await act(async () => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
      expect(input.value).toBe('@'); expect(f.send).not.toHaveBeenCalled();
      await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
      expect(input.value).toBe('@everyone '); expect(f.send).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});

it('public conversation projection keeps user authorship and explicit reply metadata', () => {
  for (const kind of ['user', 'dsh-bot-group-user', 'dsh-bot-group-followup']) {
    const event = { type: 'user/message', surfaceOp: 'append', time: 1, seq: 2, data: { id: 'user-reply', content: [{ type: 'text', text: 'Follow up' }], source: { kind, group: { groupId: 'g', groupCreatedAt: 1 }, turnId: 'turn', replyTo: 'original' } } };
    expect(groupMessageDefinition.match(event as never)?.exclusive).toBe(true);
    const result = groupMessageDefinition.start({} as never, { event } as never, {} as never);
    expect(result.message.authorKind).toBe('user'); expect(result.message.speaker).toBeUndefined(); expect(result.message.replyTo).toBe('original');
  }
});

it('folds group-only task inputs, owner follow-ups and unassigned Supergroup messages in their owning session', async () => {
  const { WorkspaceMessage } = await import('../../src/client/workspace-group.js');
  const data = view(), group = { groupId: data.group.id, groupCreatedAt: data.group.createdAt };
  const t = ((name: keyof typeof en.ui) => en.ui[name]) as PropsLocale<'dsh-bot'>['t'];
  const content = [{ type: 'text', text: 'Public question\n\nSecond paragraph.' }];
  const event = (id: string, source: object) => ({ type: 'user/message', surfaceOp: 'append', seq: 3, time: 1, data: { id, source, content } });
  const followup = { kind: 'dsh-bot-group-owner-followup', group, turnId: 'turn', cardId: 'card', predecessorTurnId: 'previous' };
  const task = { kind: 'dsh-bot-supergroup', group, turnId: 'turn', workId: 'work' };
  const ownerInput = { kind: 'user', group, supergroupWorkId: 'work', operationId: 'send' };
  const input = (id: string, source: object) => {
    const row = event(id, source);
    expect(groupMessageDefinition.match(row as never)?.exclusive).toBe(true);
    return groupMessageDefinition.start({} as never, { event: row } as never, {} as never);
  };
  // The worker receives a separate native prompt with the same kind and card.
  expect(groupMessageDefinition.match(event('private-worker-message', followup) as never)).toBeNull();
  expect(groupMessageDefinition.match(event('historical-user-input', { kind: 'user' }) as never)).toBeNull();
  data.turns = [{ id: 'turn', group, mode: 'natural', state: 'completed', operationId: 'op', requestDigest: 'digest',
    inputMessageId: 'question', inputSeq: 3, revision: 1, createdAt: 1, updatedAt: 1, schemaVersion: 1, membershipRevision: 1, contextThroughSeq: 0,
    orderedMemberIds: ['member:alpha'], ownerFollowUp: { cardId: 'card', cardRevision: 1, predecessorTurnId: 'previous', predecessorTurnRevision: 1,
      membershipRevision: 1, modelRevision: 0, memberId: 'member:alpha', bot: { botId: 'alpha', botCreatedAt: 1 }, botRevision: 1,
      modelSelection: { provider: 'local', model: 'fixture' } } }];
  const snapshot = { view: data };
  const actions = { messageView: () => ({ subscribe: () => () => {}, getSnapshot: () => snapshot }), replyFolds: new GroupReplyFolds() } as unknown as import('../../src/client/groups-state.js').GroupActions;
  const element = document.createElement('div'), root = createRoot(element);
  const render = (id: string, source: object, sessionId = data.group.rootSessionId) => act(async () => {
    root.render(<WorkspaceMessage sessionId={sessionId} node={{ data: input(id, source) } as never} actions={actions} onOpenSession={async () => {}} t={t} />);
  });
  const fold = async (kind: 'user' | 'proactive') => {
    const button = element.querySelector<HTMLButtonElement>('[data-group-author="' + kind + '"] [data-group-reply-toggle]');
    if (!button) throw Error('Missing public message fold control');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(element.querySelector('[data-group-reply-preview]')?.textContent).toBe('Public question');
    await click(button);
  };
  try {
    const publicFollowup = { ...followup, groupRootSessionId: data.group.rootSessionId };
    await render('question', publicFollowup);
    await fold('proactive');
    for (const [id, changes, session] of [
      ['private-worker-message', {}, data.group.rootSessionId],
      ['question', {}, 'worker-session'],
      ['question', { predecessorTurnId: 'another' }, data.group.rootSessionId],
    ] as const) {
      await render(id, { ...publicFollowup, ...changes }, session);
      expect(element.childElementCount).toBe(0);
    }
    data.group.supergroup = { workId: 'work', originSessionId: 'origin', originMessageId: 'original', owner: { botId: 'alpha', botCreatedAt: 1 },
      readers: [{ botId: 'alpha', botCreatedAt: 1 }], expiresAt: 1000 };
    await render('question', task);
    await fold('proactive');
    await render('question', { ...task, workId: 'other' });
    expect(element.childElementCount).toBe(0);
    await render('unassigned', ownerInput);
    await fold('user');
    await render('unassigned', ownerInput, 'private-session');
    expect(element.childElementCount).toBe(0);
  } finally { await act(async () => root.unmount()); }
});

it('projects a legacy wrapped upload only when its native receipt belongs to that input', () => {
  const attachment = { type: 'file', attachment: { attachmentId: 'known-file', name: 'from-history.txt', bytes: 5 } };
  const project = (rpcId: string) => groupMessageDefinition.start({} as never, { event: { type: 'user/message', time: 1, seq: 2,
    data: { id: 'original-input', content: [{ type: 'file', attachment }],
      source: { kind: 'user', group: { groupId: 'g', groupCreatedAt: 1 }, turnId: 'turn', rpcId } } } } as never, {} as never).message;
  expect(project('turn')).toMatchObject({ id: 'original-input', text: '', attachments: [attachment] });
  expect(project('other').attachments).toEqual([]);
});

it('sent quotes render real authors, invoke original jump, and show unavailable explicitly', async () => {
  const element = document.createElement('div'), root = createRoot(element), jump = vi.fn();
  const t = ((key: keyof typeof en.ui) => en.ui[key]) as PropsLocale<'dsh-bot'>['t'];
  const message = { id: 'reply', seq: 2, at: 1, text: 'Reply', turnId: 'turn', authorKind: 'user' as const, replyTo: 'original' };
  const quoted = { ...message, id: 'original', replyTo: undefined, text: 'User original' };
  try {
    const render = async (hasQuote: boolean) => { await act(async () => root.render(<GroupMessageCard message={message} quoted={hasQuote ? quoted : undefined} onJump={jump}
      labels={{ code: { copyLabel: 'copy', copiedLabel: 'copied' }, footnotes: 'footnotes' }} onReply={() => {}} onOpenAttachment={async () => {}} onOpenSession={async () => {}} t={t} />)); };
    await render(true); expect(element.querySelector('blockquote')?.textContent).toContain('You');
    await click(element.querySelector('blockquote button') as HTMLButtonElement); expect(jump).toHaveBeenCalledWith('original');
    await render(false); expect(element.textContent).toContain(en.ui['groups.quoteUnavailable']);
  } finally { await act(async () => root.unmount()); }
});

it.each(['en', 'zh'] as const)('%s task source and quoted fallback follow exact Supergroup metadata in both renderers', async language => {
  const { WorkspaceMessage } = await import('../../src/client/workspace-group.js');
  const element = document.createElement('div'), root = createRoot(element);
  const data = view(), key = { groupId: data.group.id, groupCreatedAt: data.group.createdAt };
  const input = { id: 'task-source', seq: 1, at: 1, text: 'Authorized task text', turnId: 'task-turn', authorKind: 'proactive' as const };
  const reply = { ...input, id: 'task-reply', seq: 2, replyTo: input.id, text: 'Task reference' };
  data.messages = [input, reply];
  const snapshot = { view: data };
  const actions = { messageView: () => ({ subscribe: () => () => {}, getSnapshot: () => snapshot }) } as unknown as import('../../src/client/groups-state.js').GroupActions;
  const labels = language === 'en' ? en : zh;
  const t = ((name: keyof typeof en.ui) => labels.ui[name]) as PropsLocale<'dsh-bot'>['t'];
  const setSupergroup = () => { data.group.supergroup = { workId: 'work', originSessionId: 'origin', originMessageId: 'origin-input',
    owner: { botId: 'alpha', botCreatedAt: 1 }, readers: [{ botId: 'alpha', botCreatedAt: 1 }], expiresAt: 1000 }; };
  try {
    for (const automatic of [false, true]) {
      if (automatic) setSupergroup(); else delete data.group.supergroup;
      const expected = t(automatic ? 'groups.collaborationSource' : 'proactive.groupSource');
      await act(async () => root.render(<GroupTimeline view={data} messages={data.messages} lookup={() => undefined}
        expanded={{}} onExpand={() => {}} busy={false} onCancel={() => {}} onReply={() => {}} onOpenSession={async () => {}} onOpenAttachment={async () => {}} t={t} />));
      expect(element.querySelector('blockquote strong')?.textContent).toBe(expected);
      expect([...element.querySelectorAll('[data-group-author="proactive"] strong')].every(node => node.textContent === expected)).toBe(true);
      await act(async () => root.render(<WorkspaceMessage node={{ data: { group: key, message: reply } } as never} actions={actions} onOpenSession={async () => {}} t={t} />));
      expect(element.querySelector('blockquote strong')?.textContent).toBe(expected);
      expect([...element.querySelectorAll('[data-group-author="proactive"] strong')].every(node => node.textContent === expected)).toBe(true);
    }
    // A stale or mismatched generation cannot classify another group's source.
    data.group.createdAt = 999;
    await act(async () => root.render(<WorkspaceMessage node={{ data: { group: key, message: reply } } as never} actions={actions} onOpenSession={async () => {}} t={t} />));
    expect(element.querySelector('blockquote strong')?.textContent).toBe(t('proactive.groupSource'));
    expect(element.textContent).not.toContain(t('groups.collaborationSource'));
    expect(data.messages.map(message => message.authorKind)).toEqual(['proactive', 'proactive']);
  } finally { await act(async () => root.unmount()); }
});

it('native quote lookup reports loading until async resolution, and unavailable only after a missing result', async () => {
  const { WorkspaceMessage } = await import('../../src/client/workspace-group.js');
  const element = document.createElement('div'), root = createRoot(element);
  const quoted = { id: 'quoted', seq: 1, at: 1, text: 'Original is available', turnId: 'turn', authorKind: 'user' as const };
  let settle!: (message: typeof quoted | undefined) => void;
  const lookup = vi.fn(() => new Promise<typeof quoted | undefined>(resolve => { settle = resolve; }));
  const snapshot = { view: undefined };
  const actions = { messageView: () => ({ subscribe: () => () => {}, getSnapshot: () => snapshot }), quotedMessage: lookup } as unknown as import('../../src/client/groups-state.js').GroupActions;
  const t = ((key: keyof typeof en.ui) => en.ui[key]) as PropsLocale<'dsh-bot'>['t'];
  const render = async (id: string) => { await act(async () => root.render(<WorkspaceMessage key={id} node={{ data: { group: { groupId: 'g', groupCreatedAt: 1 }, message: { ...quoted, id, replyTo: 'quoted' } } } as never} actions={actions} onOpenSession={async () => {}} t={t} />)); };
  try {
    await render('reply-a');
    expect(element.textContent).toContain(en.ui['groups.quoteLoading']); expect(element.textContent).not.toContain(en.ui['groups.quoteUnavailable']);
    await act(async () => settle(quoted));
    expect(element.querySelector('blockquote')?.textContent).toContain(quoted.text); expect(element.textContent).not.toContain(en.ui['groups.quoteUnavailable']);
    await render('reply-b');
    expect(element.textContent).toContain(en.ui['groups.quoteLoading']);
    await act(async () => settle(undefined));
    expect(element.textContent).toContain(en.ui['groups.quoteUnavailable']); expect(element.textContent).not.toContain(en.ui['groups.quoteLoading']);
  } finally { await act(async () => root.unmount()); }
});

async function armMemory(f: Awaited<ReturnType<typeof composer>>) {
  await click(f.element.querySelector('[data-group-command-launcher]') as HTMLElement);
  await vi.waitFor(() => expect(f.element.querySelector('[data-group-command="memory"]')).not.toBeNull());
  await click(f.element.querySelector('[data-group-command="memory"]') as HTMLElement);
}

it('pins the single suggested memory reference while a new group reply arrives', async () => {
  const f = await composer('zh');
  try {
    const quoted = f.data.messages[0]!, group = f.data.group, member = f.data.members[1]!;
    f.data.turns.push({ id: quoted.turnId, group: { groupId: group.id, groupCreatedAt: group.createdAt }, operationId: 'previous',
      requestDigest: 'digest', inputMessageId: 'question', createdAt: 1, updatedAt: 1, revision: 1, schemaVersion: 1,
      membershipRevision: group.membershipRevision, orderedMemberIds: [member.id], mode: 'natural', contextThroughSeq: 1, state: 'completed' });
    const delivery = { id: 'reply-delivery', turnId: quoted.turnId, memberId: member.id, ordinal: 0, bot: member.bot,
      botRevision: 1, presetId: 'bot-beta', contextOutputMessageIds: [], contextTruncated: false, state: 'completed' as const, outputMessageId: quoted.id };
    f.data.deliveries.push(delivery);
    await f.remount();
    await fill(field(f.element, f.t('groups.message')), '只记下来。');
    expect(f.element.querySelector('[data-group-memory-reference]')?.textContent).toContain(quoted.text);
    f.data.messages.push({ ...quoted, id: 'another', seq: 2, text: 'Different reply' });
    f.data.deliveries.push({ ...delivery, id: 'another-delivery', outputMessageId: 'another' });
    await f.remount();
    await click(button(f.element, f.t('groups.send')));
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ memoryStatusOnly: true, replyTo: quoted.id });
    await fill(field(f.element, f.t('groups.message')), 'new draft');
    await fill(field(f.element, f.t('groups.message')), '只记下来');
    await click(button(f.element, f.t('groups.send')));
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.element.textContent).toContain(f.t('groups.memoryStatus.needsText'));
  } finally { await f.close(); }
});

it('records an explicit memory instruction, asking for a reference only when the material is missing', async () => {
  const f = await composer('zh');
  try {
    const draft = field(f.element, f.t('groups.message')), send = button(f.element, f.t('groups.send'));
    await fill(draft, '只记下来');
    await click(send);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.element.textContent).toContain(f.t('groups.memoryStatus.needsText'));
    const quoted = f.data.messages[0]!;
    await act(async () => f.actions.reply(f.data.group.rootSessionId, quoted));
    await click(send);
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ memoryStatusOnly: true, replyTo: quoted.id, text: '只记下来' });
    await click(button(f.element, f.t('groups.clearReply')));
    await fill(draft, '只记下来：先核对旧版的行为');
    await click(send);
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ memoryStatusOnly: true, text: '只记下来：先核对旧版的行为' });
    await fill(draft, '你刚才说的“只记下来”是什么意思？');
    await click(send);
    expect(f.send.mock.calls.at(-1)?.[1]).not.toHaveProperty('memoryStatusOnly');
    const count = f.send.mock.calls.length;
    await act(async () => f.actions.patchDraft(f.data.group.rootSessionId, old => ({ ...old, followup: { deliveryId: 'active', turnId: 'active-turn' } })));
    await fill(draft, '只记下来：仅保存状态');
    expect(send.disabled).toBe(true);
    expect(f.element.textContent).toContain(f.t('groups.memoryStatus.incompatible'));
    expect(f.send).toHaveBeenCalledTimes(count);
  } finally { await f.close(); }
});

it.each(['en', 'zh'] as const)('opts into memory from +, retains failure/remount and clears the successful draft (%s)', async language => {
  const f = await composer(language);
  try {
    await fill(field(f.element, f.t('groups.message')), 'Remember my preferred review format');
    expect(f.element.querySelector('[data-group-memory-status]')).toBeNull();
    expect(f.element.querySelector('input[type="checkbox"]')).toBeNull();
    await armMemory(f);
    expect(f.element.querySelector('[data-group-memory-status]')?.textContent).toContain(f.t('groups.memoryStatus.toggle'));
    expect(document.activeElement).toBe(field(f.element, f.t('groups.message')));
    expect(field(f.element, f.t('groups.message')).value).toBe('Remember my preferred review format');
    await click(button(f.element, f.t('groups.send')));
    expect(f.send.mock.calls[0]?.[1].memoryStatusOnly).toBe(true);
    expect(f.element.querySelector('[data-group-memory-status]')).not.toBeNull();
    expect(f.actions.draft(f.data.group.rootSessionId).memoryStatusOnly).toBe(true);
    await f.remount();
    expect(f.element.querySelector('[data-group-memory-status]')).not.toBeNull();
    expect(field(f.element, f.t('groups.message')).value).toBe('Remember my preferred review format');
    f.send.mockResolvedValueOnce({ ok: true, value: { id: 'turn:status-only' } as never });
    await click(button(f.element, f.t('groups.send')));
    expect(f.send.mock.calls[1]?.[1].operationId).toBe(f.send.mock.calls[0]?.[1].operationId);
    expect(f.element.querySelector('[data-group-memory-status]')).toBeNull();
    expect(field(f.element, f.t('groups.message')).value).toBe('');
  } finally { await f.close(); }
});

it.each([true, false])('cancels memory mode without losing text or focus (workspace=%s)', async workspace => {
  const f = await composer('en', workspace);
  try {
    await fill(field(f.element, f.t('groups.message')), 'Keep this draft');
    await armMemory(f);
    await click(button(f.element, f.t('groups.memoryStatus.cancel')));
    expect(f.element.querySelector('[data-group-memory-status]')).toBeNull();
    expect(field(f.element, f.t('groups.message')).value).toBe('Keep this draft');
    expect(document.activeElement).toBe(field(f.element, f.t('groups.message')));
    await click(button(f.element, f.t('groups.send')));
    expect(f.send.mock.calls[0]?.[1]).not.toHaveProperty('memoryStatusOnly');
  } finally { await f.close(); }
});

it('does not treat an IME confirmation as a send or cancel the armed memory mode', async () => {
  const f = await composer('zh');
  try {
    await armMemory(f);
    const input = field(f.element, f.t('groups.message')) as HTMLTextAreaElement;
    await fill(input, '记住评审格式');
    await act(async () => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(f.send).not.toHaveBeenCalled();
    expect(input.value).toBe('记住评审格式');
    expect(f.element.querySelector('[data-group-memory-status]')).not.toBeNull();
  } finally { await f.close(); }
});

it.each(['memory', 'reply'] as const)('requires an explicit choice between a reply and memory-only mode: %s', async choice => {
  const f = await composer();
  try {
    await armMemory(f);
    await act(async () => f.actions.reply(f.data.group.rootSessionId, view().messages[0] as NonNullable<ReturnType<typeof view>['messages'][0]>));
    expect(f.element.querySelector('[data-group-memory-status]')).not.toBeNull();
    await fill(field(f.element, f.t('groups.message')), 'Keep my draft');
    const send = button(f.element, f.t('groups.send'));
    expect(send.disabled).toBe(true);
    expect(f.element.textContent).toContain(f.t('groups.memoryStatus.incompatible'));
    expect(f.send).not.toHaveBeenCalled();
    await click(choice === 'memory' ? button(f.element, f.t('groups.clearReply'))
      : f.element.querySelector('[data-group-memory-cancel]') as HTMLElement);
    f.send.mockResolvedValueOnce({ ok: true, value: { id: 'turn:choice' } as never });
    await click(send);
    const request = f.send.mock.calls[0]![1];
    expect(request.memoryStatusOnly).toBe(choice === 'memory' ? true : undefined);
    expect(request.replyTo).toBe(choice === 'reply' ? view().messages[0]?.id : undefined);
    expect(f.element.querySelector('[data-group-memory-status]')).toBeNull();
    expect(field(f.element, f.t('groups.message')).value).toBe('');
  } finally { await f.close(); }
});

it.each([true, false])('rechecks changed recipients before replacing a rejected request, confirmed=%s', async confirmed => {
  const f = await composer();
  try {
    await fill(field(f.element, f.t('groups.message')), 'Keep my draft');
    f.send.mockImplementationOnce(async () => {
      f.data.group = { ...f.data.group, membershipRevision: 2 };
      if (confirmed) throw { code: 'dsh-bot/conflict' };
      throw new Error('Transport lost');
    });
    const send = button(f.element, f.t('groups.send'));
    await click(send);
    const first = f.send.mock.calls[0]![1];
    expect(first.expectedMembershipRevision).toBe(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(field(f.element, f.t('groups.message')).value).toBe('Keep my draft');
    if (confirmed) expect(f.element.textContent).toContain('Group members changed');
    const key = { groupId: f.data.group.id, groupCreatedAt: f.data.group.createdAt };
    await act(async () => { await f.actions.messageView(key).refresh(); });
    await click(send);
    const second = f.send.mock.calls[1]![1];
    expect(second.expectedMembershipRevision).toBe(confirmed ? 2 : 1);
    expect(second.operationId === first.operationId).toBe(!confirmed);
  } finally { await f.close(); }
});

it('limits file selection across batches before uploading and blocks oversized retained drafts', async () => {
  const f = await composer();
  try {
    const id = f.data.group.rootSessionId;
    const upload = vi.spyOn(f.actions, 'upload').mockImplementation(async (_, file) => ({receiptId: file.name, name: file.name, bytes: file.size}));
    const input = f.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const choose = (count: number, prefix: string) => act(async () => {
      Object.defineProperty(input, 'files', {configurable: true, value: Array.from({length: count}, (_, i) => new File(['hello'], prefix+i))});
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await choose(15, 'first');
    await choose(2, 'next');
    expect(upload).toHaveBeenCalledTimes(16);
    expect(f.element.textContent).toContain(f.t('groups.attachmentLimit', {limit: 16}));
    expect(f.actions.draft(id).uploads).toHaveLength(16);
    const send = button(f.element, f.t('groups.send'));
    expect(send.disabled).toBe(false);
    await act(async () => { f.actions.patchDraft(id, draft => ({...draft, uploads: [...draft.uploads, {id:'old',name:'old',bytes:1,state:'uploaded',receiptId:'old'}]})); });
    expect(send.disabled).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

describe('group send error classification and pre-flight guards (#54)', () => {
  it('blocks ended supplement targets before sending, clears on close, and handles racing unavailable responses', async () => {
    const f = await composer('en', true, [bot({ id: 'alpha', name: 'Alpha' }), bot({ id: 'beta', name: 'Beta' })]);
    try {
      const id = f.data.group.rootSessionId;
      f.data.turns.push({
        id: 'turn:one', group: { groupId: f.data.group.id, groupCreatedAt: 1 }, operationId: 'op:one',
        requestDigest: 'hash', inputMessageId: 'msg:one', createdAt: 1, updatedAt: 1, revision: 1,
        schemaVersion: 1, membershipRevision: 1, orderedMemberIds: ['member:alpha'], mode: 'natural',
        contextThroughSeq: -1, state: 'idle',
      });
      f.data.deliveries.push({
        id: 'delivery:done', turnId: 'turn:one', memberId: 'member:alpha', ordinal: 0,
        bot: { botId: 'alpha', botCreatedAt: 1 }, botRevision: 1, presetId: 'bot-alpha',
        contextOutputMessageIds: [], contextTruncated: false, state: 'completed',
      });
      await f.remount();
      await act(async () => f.actions.patchDraft(id, old => ({ ...old, followup: { turnId: 'turn:one', deliveryId: 'delivery:done' } })));
      expect(f.element.textContent).toContain(f.t('groups.supplementEndedShort'));
      const draft = field(f.element, f.t('groups.message'));
      await fill(draft, 'Late supplement');
      await click(button(f.element, f.t('groups.send')));
      expect(f.send).not.toHaveBeenCalled();
      expect(f.element.textContent).toContain(f.t('groups.supplementEnded'));
      expect(f.element.textContent).not.toContain(f.t('groups.export.sendFailed'));

      await click(button(f.element, f.t('groups.close')));
      expect(f.element.textContent).not.toContain(f.t('groups.supplementEnded'));

      // Now simulate a racing delivery that was still running locally but finished on the Host.
      f.data.turns[0]!.state = 'running';
      f.data.deliveries[0]!.state = 'running';
      await f.remount();
      await act(async () => f.actions.patchDraft(id, old => ({ ...old, followup: { turnId: 'turn:one', deliveryId: 'delivery:done' } })));
      f.send.mockRejectedValueOnce({ code: 'dsh-bot/unavailable' });
      await click(button(f.element, f.t('groups.send')));
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.element.textContent).toContain(f.t('groups.supplementEnded'));
      expect(f.element.textContent).not.toContain(f.t('groups.export.sendFailed'));
      expect(f.actions.draft(id).operation).toBeUndefined();
    } finally { await f.close(); }
  });

  it('classifies mention-only Host rejection without @mention and blocks oversized drafts before RPC', async () => {
    const f = await composer('zh', true, [bot({ id: 'alpha', name: 'Alpha' }), bot({ id: 'beta', name: 'Beta' })]);
    try {
      f.data.group.mode = 'mention';
      await f.remount();
      const draft = field(f.element, f.t('groups.message'));
      await fill(draft, '未提及任何成员的消息');
      f.send.mockRejectedValueOnce({ code: 'dsh-bot/invalid' });
      await click(button(f.element, f.t('groups.send')));
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.element.textContent).toContain(f.t('groups.mentionRequired'));
      expect(f.element.textContent).not.toContain(f.t('groups.export.sendFailed'));
      expect(f.actions.draft(f.data.group.rootSessionId).operation).toBeUndefined();

      // Editing clears the definitive validation alert, and @mentioning sends normally.
      await fill(draft, '@Alpha 请看下');
      expect(f.element.textContent).not.toContain(f.t('groups.mentionRequired'));
      f.send.mockResolvedValueOnce({ ok: true, value: { id: 'turn:mention-ok' } as never });
      await click(button(f.element, f.t('groups.send')));
      expect(f.send).toHaveBeenCalledTimes(2);

      // Oversized text (> 64KB) is blocked before RPC.
      await fill(draft, 'a'.repeat(70000));
      await click(button(f.element, f.t('groups.send')));
      expect(f.send).toHaveBeenCalledTimes(2);
      expect(f.element.textContent).toContain(f.t('groups.messageTooLong'));
    } finally { await f.close(); }
  });

  it.each([
    ['dsh-bot/invalid', 'groups.sendInvalid'],
    ['gateway/input-invalid', 'groups.sendInvalid'],
    ['dsh-bot/unavailable', 'groups.sendUnavailable'],
    ['dsh-bot/approval-denied', 'groups.sendDenied'],
    ['dsh-bot/unsupported', 'groups.sendUnsupported'],
    ['dsh-bot/not-found', 'groups.sendNotFound'],
  ] as const)('classifies definitive pre-dispatch rejection %s without misreporting sendFailed', async (code, key) => {
    const f = await composer('en');
    try {
      const draft = field(f.element, f.t('groups.message'));
      await fill(draft, 'Definitive rejection test');
      f.send.mockRejectedValueOnce({ code });
      await click(button(f.element, f.t('groups.send')));
      expect(f.element.textContent).toContain(f.t(key));
      expect(f.element.textContent).not.toContain(f.t('groups.export.sendFailed'));
      expect(f.actions.draft(f.data.group.rootSessionId).operation).toBeUndefined();
      await fill(draft, 'Edited after definitive rejection');
      expect(f.element.textContent).not.toContain(f.t(key));
    } finally { await f.close(); }
  });

  it.each(['dsh-bot/recovery-needed', 'gateway/internal'] as const)('retains sendFailed, diagnostic code, and idempotency key for uncertain failure %s', async code => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = await composer('en');
    try {
      const draft = field(f.element, f.t('groups.message'));
      await fill(draft, 'Uncertain send test');
      f.send.mockRejectedValueOnce({ code });
      await click(button(f.element, f.t('groups.send')));
      expect(f.element.textContent).toContain(`${f.t('groups.export.sendFailed')} (${code})`);
      const firstId = f.actions.draft(f.data.group.rootSessionId).operation?.request.operationId;
      expect(firstId).toBeTruthy();
      expect(warn).toHaveBeenCalledWith('[dsh-bot] Group operation did not complete', { code });
      // Editing does not silently discard an uncertain acceptance warning.
      await fill(draft, 'Uncertain send test edited');
      expect(f.element.textContent).toContain(f.t('groups.export.sendFailed'));
    } finally {
      warn.mockRestore();
      await f.close();
    }
  });
});
