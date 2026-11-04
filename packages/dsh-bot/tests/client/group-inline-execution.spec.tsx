// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupDelivery, GroupTurn, GroupMessage, GroupView } from '../../src/shared/groups.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import type { BotCatalog } from '../../src/client/state.js';
import type { ExecutionBridge } from '../../src/client/group-execution.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import { WorkspaceMessage } from '../../src/client/workspace-group.js';
import { GroupConversation } from '../../src/client/components/GroupsPanel.js';
import { bots, view, summary } from './group-fixture.js';
import { button, click, fill } from './helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

async function fixture(language: 'en' | 'zh' = 'en', denials?: string[], firstDelivery: Partial<GroupDelivery> = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context(), data = view();
  const key = { groupId: data.group.id, groupCreatedAt: data.group.createdAt };
  const turns: GroupTurn[] = ['first', 'second'].map((id, index) => ({ id, group: key, operationId: id, requestDigest: id,
    inputMessageId: `question-${id}`, createdAt: 1, updatedAt: 1, revision: 1, schemaVersion: 1, membershipRevision: 1,
    orderedMemberIds: [`member:${bots[index]?.id}`], mode: 'natural', contextThroughSeq: index, protocol: 2,
    state: index ? 'running' : 'partial', automaticExecutions: 0, continuationAllowance: 32 }));
  const questions: GroupMessage[] = turns.map((turn, index) => ({ id: turn.inputMessageId, seq: index + 1, at: 1,
    text: `Question ${turn.id}`, turnId: turn.id, authorKind: 'user' }));
  data.turns = turns;
  data.deliveries = turns.map((turn, index) => ({ id: `delivery-${turn.id}`, turnId: turn.id, memberId: turn.orderedMemberIds[0] ?? '',
    ordinal: 0, bot: { botId: bots[index]?.id ?? '', botCreatedAt: bots[index]?.createdAt ?? 1 }, botRevision: 1, presetId: 'fixture',
    contextOutputMessageIds: [], contextTruncated: false, state: index ? 'running' : 'failed', childSessionId: `child-${turn.id}`,
    ...(index ? {} : { reasonCode: 'fixture-failure', ...firstDelivery }) }));
  // Old question isn't in the latest page; its native history node still owns the task.
  data.messages = [questions[1] as GroupMessage];
  const remote = { view: vi.fn(async () => ({ ok: true, value: structuredClone(data) })),
    list: vi.fn(async () => ({ ok: true, value: [summary()] })), cancel: vi.fn(async () => ({ ok: true, value: true })),
    stopMember: vi.fn(async () => ({ ok: true, value: true })), continueTurn: vi.fn(async () => ({ ok: true, value: true })) };
  ctx.provide('remote.dshBot.groups', remote as unknown as GroupMethods);
  const actions = createGroupActions(ctx, {});
  const botSnapshot = { entries: bots.map(bot => ({ bot })) };
  const catalog = { subscribe: () => () => {}, getSnapshot: () => botSnapshot } as unknown as BotCatalog;
  // Optional native-projection doubles: statistics yields a binding; the Chat target carries tool results.
  const retained: string[] = [];
  const statistics = denials && { source: (_parentId: string, childId: string) => ({
    subscribe: () => { retained.push(childId); return () => {}; },
    getSnapshot: () => ({ state: 'ready', binding: { childId } }) }) };
  if (denials) ctx.provide('uiConversation', { binding: (binding: { childId: string }) => ({ target: () => {
    const nodes = denials.includes(binding.childId) ? [{ kind: 'tool-call', data: { root: { kind: 'tool-result', isError: true,
      error: { name: 'FsError', code: 'FS_SANDBOX_DENIED' }, subCalls: [] } } }] : [];
    const value = { nodes: { values: () => nodes } };
    return { subscribe: () => () => {}, getSnapshot: () => value };
  } }) } as never);
  const bridge = { ctx, open: vi.fn(), ...(statistics ? { statistics } : {}) } as unknown as ExecutionBridge;
  const element = document.createElement('div'); document.body.append(element); let root = createRoot(element);
  const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => (language === 'en' ? en : zh).ui[key]
    .replace(/\{(\w+)\}/g, (_match, k) => String(params?.[k] ?? k))) as PropsLocale<'dsh-bot'>['t'];
  const render = async () => {
    const nodes = [...questions, { ...questions[1], id: 'followup', text: 'Supplement' },
      { ...questions[1], id: 'bot-reply', text: 'Reply', authorKind: 'bot' }] as GroupMessage[];
    await act(async () => root.render(<>
      {nodes.map(message => <WorkspaceMessage key={message.id} node={{ data: { group: key, message } } as never}
        actions={actions} bots={catalog} executionBridge={bridge} onOpenSession={async () => {}} t={t} />)}
      <GroupConversation workspace summary={summary()} actions={actions} bots={bots} expandedTurns={{}} onExpandTurn={() => {}}
        onOpenSession={async () => {}} t={t} />
    </>));
    await vi.waitFor(() => expect(element.querySelectorAll('[data-group-turn]')).toHaveLength(2));
  };
  await render();
  return { element, data, key, actions, bridge, remote, t, retained,
    question(id: string) { return element.querySelector(`[data-workspace-group-message="question-${id}"]`) as HTMLElement; },
    async refresh() { await act(async () => actions.messageView(key).refresh()); },
    async remount() { await act(async () => root.unmount()); root = createRoot(element); await render(); },
    async close() { await act(async () => root.unmount()); await ctx.fiber.dispose(); element.remove(); },
  };
}

it.each(['en', 'zh'] as const)('%s anchors each task only below its question, including old history and no-output failure', async language => {
  const f = await fixture(language);
  try {
    for (const id of ['first', 'second']) {
      const question = f.question(id), disclosure = question.querySelector('button[aria-expanded]') as HTMLButtonElement;
      expect(question.querySelector(`[data-group-turn="${id}"]`)).toBeTruthy();
      expect(disclosure.getAttribute('aria-expanded')).toBe('false');
      expect(question.querySelector(`[data-group-execution-card="delivery-${id}"]`)).toBeTruthy();
      expect((question.querySelector('[data-group-message]')?.compareDocumentPosition(disclosure) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(f.element.querySelector('[data-workspace-group-message="followup"] [data-group-turn]')).toBeNull();
    expect(f.element.querySelector('[data-workspace-group-message="bot-reply"] [data-group-turn]')).toBeNull();
    expect(f.element.querySelector('[data-workspace-group-composer] [data-group-turn], [data-workspace-group-composer] [data-group-working]')).toBeNull();
    expect(f.question('first').textContent).toContain(f.t('groups.failed'));
    expect(f.question('second').textContent).not.toContain(f.t('execution.failed'));
    expect(f.question('first').querySelector('[data-group-message]')?.getAttribute('data-group-author')).toBe('user');
    expect(f.element.querySelector('[data-group-message="bot-reply"]')?.getAttribute('data-group-author')).toBe('bot');
  } finally { await f.close(); }
});

it('preserves independent disclosure choices through live updates and native message remounts', async () => {
  const f = await fixture();
  try {
    await click(f.question('second').querySelector('button[aria-expanded]') as HTMLButtonElement);
    f.data.turns[1] = { ...f.data.turns[1] as GroupTurn, state: 'paused', revision: 2 };
    await f.refresh();
    expect(f.question('second').querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    await f.remount();
    expect(f.question('first').querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    expect(f.question('second').querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    await click(f.question('second').querySelector('button[aria-expanded]') as HTMLButtonElement);
    await f.refresh();
    expect(f.question('second').querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    expect(f.bridge.open).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('keeps native details, supplement focus, member stop and task cancellation bound to the selected question', async () => {
  const f = await fixture();
  try {
    const draft = f.element.querySelector('textarea') as HTMLTextAreaElement;
    await fill(draft, 'Keep this draft');
    await click(f.question('second').querySelector('button[aria-expanded]') as HTMLButtonElement);
    await click(button(f.question('second'), f.t('execution.viewDetails')));
    expect(f.bridge.open).toHaveBeenCalledWith('child-second');
    await click(f.question('second').querySelector('button[aria-haspopup=menu]') as HTMLButtonElement);
    await click(button(f.question('second'), f.t('groups.supplement')));
    expect(f.actions.draft('group-root-one')).toMatchObject({ text: 'Keep this draft', followup: { turnId: 'second', deliveryId: 'delivery-second' } });
    expect(document.activeElement).toBe(draft);
    await click(f.question('second').querySelector('button[aria-haspopup=menu]') as HTMLButtonElement);
    await click(button(f.question('second'), f.t('execution.stopMember')));
    expect(f.remote.stopMember).toHaveBeenCalledWith(f.key, 'second', 'member:beta', 1);
    await click(button(f.question('second'), f.t('execution.stopTurn')));
    expect(f.remote.cancel).toHaveBeenCalledWith(f.key, 'second', 1);
    expect(f.question('first').querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
  } finally { await f.close(); }
});

it('shows a failed continuation locally and retries using the refreshed task revision', async () => {
  const f = await fixture();
  try {
    f.data.turns[1] = { ...f.data.turns[1] as GroupTurn, state: 'paused', revision: 4 };
    await f.refresh();
    await click(f.question('second').querySelector('button[aria-expanded]') as HTMLButtonElement);
    f.remote.continueTurn.mockRejectedValueOnce(new Error('conflict'));
    await click(button(f.question('second'), f.t('execution.continue')));
    expect(f.question('second').querySelector('[role="alert"]')?.textContent).toBe(f.t('groups.conflict'));
    expect(f.element.querySelector('[data-workspace-group-composer] [role="alert"]')).toBeNull();
    f.data.turns[1] = { ...f.data.turns[1] as GroupTurn, revision: 5 };
    await f.refresh(); await click(button(f.question('second'), f.t('execution.continue')));
    expect(f.remote.continueTurn).toHaveBeenLastCalledWith(f.key, 'second', 5);
    expect(f.question('second').querySelector('[role="alert"]')).toBeNull();
  } finally { await f.close(); }
});

it('keeps work folded unless the user chooses otherwise, and shows a continuing child once', async () => {
  const f = await fixture();
  try {
    f.data.deliveries.push({ ...f.data.deliveries[1] as GroupView['deliveries'][number], id: 'continued-second', ordinal: 1 });
    await f.refresh();
    expect(f.question('second').querySelectorAll('[data-group-execution-card]')).toHaveLength(1);
    expect(f.question('second').querySelector('[data-group-execution-card]')?.getAttribute('data-group-execution-card')).toBe('continued-second');
    f.data.turns[1] = { ...f.data.turns[1] as GroupTurn, state: 'idle', revision: 2 };
    await f.refresh();
    expect(f.question('second').querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    await click(f.question('second').querySelector('button[aria-expanded]') as HTMLButtonElement);
    await f.remount();
    expect(f.question('second').querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
  } finally { await f.close(); }
});

it.each([['en', ['child-first', 'child-second']], ['zh', ['child-first', 'child-second']], ['en', []]] as const)(
  '%s flags access-mode denials only on the latest question while collapsed (%j)', async (language, denials) => {
  const f = await fixture(language, [...denials]);
  try {
    const notice = () => f.question('second').querySelector('[data-group-permission-denied]');
    if (denials.length) await vi.waitFor(() => expect(notice()?.textContent).toContain(bots[1]?.name));
    else await vi.waitFor(() => expect(f.retained).toContain('child-second'));
    if (!denials.length) expect(notice()).toBeNull();
    expect(notice()?.getAttribute('role') ?? 'status').toBe('status');
    expect(f.question('second').querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    // Earlier questions are not observed while collapsed, bounding retained native histories.
    expect(f.question('first').querySelector('[data-group-permission-denied]')).toBeNull();
    expect(f.retained).not.toContain('child-first');
  } finally { await f.close(); }
});

it.each([['en', undefined], ['zh', undefined], ['en', 'reply-first']] as const)('%s names a failed member cause while folded unless its reply carries it (output %s)', async (language, outputMessageId) => {
  const failure = { code: 'QUOTA', status: 402, message: 'Insufficient Balance (request_id: r-1)' };
  const f = await fixture(language, undefined, { failure, stopReason: 'error', ...(outputMessageId ? { outputMessageId } : {}) });
  try {
    const question = f.question('first'), notice = question.querySelector('[data-group-member-failure]');
    if (outputMessageId) expect(notice).toBeNull();
    else {
      expect(notice?.textContent).toContain(f.t('groups.failure.quota'));
      expect(notice?.textContent).toContain('QUOTA · 402');
      expect(notice?.closest('[hidden]')).toBeNull();
    }
    expect(question.querySelector('[data-group-execution-card="delivery-first"]')?.textContent).toContain(f.t('groups.failure.quota'));
    expect(f.question('second').querySelector('[data-group-member-failure]')).toBeNull();
  } finally { await f.close(); }
});
