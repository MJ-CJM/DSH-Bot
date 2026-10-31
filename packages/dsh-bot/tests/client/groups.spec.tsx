// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { createGroupActions } from '../../src/client/groups-state.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import { GroupConversation } from '../../src/client/components/GroupsPanel.js';
import { GroupMessageCard } from '../../src/client/components/GroupTimeline.js';
import { selectGroupComposer, groupMessageDefinition } from '../../src/client/workspace-group.js';
import { bots, view, summary, configure } from './group-fixture.js';
import { mountClient, button, click, fill, field } from './helpers.js';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
async function composer(language: 'en' | 'zh' = 'en') {
  const ctx = new Context(); const data = view(); data.group.mode = 'natural';
  const send = vi.fn<GroupMethods['send']>(async () => { throw new Error('uncertain'); });
  const cancel = vi.fn<GroupMethods['cancel']>();
  const remote = { view: async () => ({ ok: true, value: data }), list: async () => ({ ok: true, value: [summary()] }), send, cancel } as unknown as GroupMethods;
  ctx.provide('remote.dshBot.groups', remote);
  const actions = createGroupActions(ctx, {}), element = document.createElement('div'); document.body.append(element);
  let root = createRoot(element); const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) =>
    (language === 'en' ? en : zh).ui[key].replace(/\{(\w+)\}/g, (_match, k) => String(params?.[k] ?? k))) as PropsLocale<'dsh-bot'>['t'];
  const render = async () => { await act(async () => root.render(<GroupConversation workspace summary={summary()} actions={actions} bots={bots}
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
      expect(f.element.textContent).toContain(f.t('groups.conflict')); expect(draft.value).toBe('ordinary message');
      const first = f.send.mock.calls[0]?.[1];
      await f.remount();
      expect((field(f.element, f.t('groups.message')) as HTMLTextAreaElement).value).toBe('ordinary message');
      await click(button(f.element, f.t('groups.send')));
      expect(f.send.mock.calls[1]?.[1].operationId).toBe(first?.operationId);
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
    } finally { await act(async () => root.unmount()); }
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
      expect(f.element.querySelector('input[type="checkbox"]')).toBeNull();
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
