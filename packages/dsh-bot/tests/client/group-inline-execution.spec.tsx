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

async function fixture(language: 'en' | 'zh' = 'en', denials?: string[], firstDelivery: Partial<GroupDelivery> = {}, denialCode = 'FS_SANDBOX_DENIED') {
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
  const remote = { view: vi.fn(async (_key: unknown, options: { beforeSeq?: number } = {}) => {
    const page = structuredClone(data);
    page.hasEarlier = options.beforeSeq === undefined;
    if (options.beforeSeq !== undefined) page.messages = [questions[0] as GroupMessage];
    return { ok: true, value: page };
  }), open: vi.fn(async () => ({ ok: true, value: { sessionId: data.group.rootSessionId, workspaceId: 'bots' } })),
    list: vi.fn(async () => ({ ok: true, value: [summary()] })), cancel: vi.fn(async () => ({ ok: true, value: true })),
    stopMember: vi.fn(async () => ({ ok: true, value: true })), continueTurn: vi.fn(async () => ({ ok: true, value: true })) };
  ctx.provide('remote.dshBot.groups', remote as unknown as GroupMethods);
  ctx.provide('uiWorkspace', { openSession: vi.fn() } as never);
  ctx.provide('sessions', { binding: () => ({ session: { loadThrough: vi.fn(async () => {}) } }) } as never);
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
      error: { name: 'HarnessError', code: denialCode }, subCalls: [] } } }] : [];
    const value = { nodes: { values: () => nodes } };
    return { subscribe: () => () => {}, getSnapshot: () => value };
  } }) } as never);
  const bridge = { ctx, open: vi.fn(), ...(statistics ? { statistics } : {}) } as unknown as ExecutionBridge;
  const element = document.createElement('div'); document.body.append(element); let root = createRoot(element);
  const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => (language === 'en' ? en : zh).ui[key]
    .replace(/\{(\w+)\}/g, (_match, k) => String(params?.[k] ?? k))) as PropsLocale<'dsh-bot'>['t'];
  const nativeReply: GroupMessage = { ...questions[1] as GroupMessage, id: 'bot-reply', seq: 9, text: 'Reply', authorKind: 'bot' };
  const render = async () => {
    const nodes = [...questions, { ...questions[1], id: 'followup', text: 'Supplement' }, nativeReply] as GroupMessage[];
    await act(async () => root.render(<>
      {nodes.map(message => <WorkspaceMessage key={message.id} node={{ data: { group: key, message } } as never}
        actions={actions} bots={catalog} executionBridge={bridge} onOpenSession={async () => {}} t={t} />)}
      <GroupConversation workspace summary={summary()} actions={actions} bots={bots} expandedTurns={{}} onExpandTurn={() => {}}
        onOpenSession={async () => {}} t={t} />
    </>));
    await vi.waitFor(() => expect(element.querySelectorAll('[data-group-turn]')).toHaveLength(2));
  };
  await render();
  return { element, data, key, actions, bridge, remote, t, retained, nativeReply,
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
      const question = f.question(id), disclosure = question.querySelector('[data-group-turn] > button[aria-expanded]') as HTMLButtonElement;
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
    await click(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]') as HTMLButtonElement);
    f.data.turns[1] = { ...f.data.turns[1] as GroupTurn, state: 'paused', revision: 2 };
    await f.refresh();
    expect(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    await f.remount();
    expect(f.question('first').querySelector('[data-group-turn] > button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    expect(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    await click(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]') as HTMLButtonElement);
    await f.refresh();
    expect(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    expect(f.bridge.open).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('keeps the original execution accessible through expiry and closure without offering stale review', async () => {
  const f = await fixture('zh', undefined, { reasonCode: 'export-approval-required', exportFlowId: crypto.randomUUID() });
  try {
    const question = f.question('first');
    const disclosure = question.querySelector('[data-group-turn] > button[aria-expanded]') as HTMLButtonElement;
    await click(disclosure);
    expect(question.textContent).toContain(f.t('groups.export.pending'));
    expect(button(question, f.t('groups.export.openQueue'))).toBeTruthy();

    f.data.group = { ...f.data.group, membershipRevision: 2 };
    await f.refresh();
    const member = question.querySelector('[data-group-execution-card="delivery-first"]');
    expect(question.textContent).not.toContain(f.t('groups.export.pending'));
    expect(member?.textContent).toContain(f.t('groups.export.expiredStatus'));
    expect(button(question, f.t('groups.export.openExpired'))).toBeTruthy();
    expect(question.textContent).not.toContain(f.t('groups.export.openQueue'));

    const before = f.data.deliveries[0];
    if (!before) throw new Error('Missing historical delivery in fixture');
    f.data.deliveries[0] = { ...before, staleExportClosedAt: 10 };
    await f.refresh();
    expect(question.textContent).toContain('Question first');
    expect(member?.textContent).toContain(f.t('groups.export.expiredClosed'));
    expect(question.textContent).not.toContain(f.t('groups.export.openExpired'));
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    await click(button(question, f.t('execution.viewDetails')));
    expect(f.bridge.open).toHaveBeenCalledExactlyOnceWith('child-first');
  } finally { await f.close(); }
});

it('keeps native details, supplement focus, member stop and task cancellation bound to the selected question', async () => {
  const f = await fixture();
  try {
    const draft = f.element.querySelector('textarea') as HTMLTextAreaElement;
    await fill(draft, 'Keep this draft');
    await click(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]') as HTMLButtonElement);
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
    expect(f.question('first').querySelector('[data-group-turn] > button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
  } finally { await f.close(); }
});

it('shows a failed continuation locally and retries using the refreshed task revision', async () => {
  const f = await fixture();
  try {
    f.data.turns[1] = { ...f.data.turns[1] as GroupTurn, state: 'paused', revision: 4 };
    await f.refresh();
    await click(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]') as HTMLButtonElement);
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
    expect(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    await click(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]') as HTMLButtonElement);
    await f.remount();
    expect(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
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
    expect(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    // Earlier questions are not observed while collapsed, bounding retained native histories.
    expect(f.question('first').querySelector('[data-group-permission-denied]')).toBeNull();
    expect(f.retained).not.toContain('child-first');
  } finally { await f.close(); }
});

it.each(['en', 'zh'] as const)('%s keeps approval rejection visible while folded without attributing it to a human or offering a permission switch', async language => {
  const f = await fixture(language, ['child-second'], {}, 'APPROVAL_REJECTED');
  try {
    const notice = () => f.question('second').querySelector('[data-group-permission-denied]');
    await vi.waitFor(() => expect(notice()?.textContent).toBe(f.t('groups.permissionDenied', { names: bots[1]?.name })));
    expect(notice()?.querySelector('button')).toBeNull();
    expect(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    expect(f.remote.cancel).not.toHaveBeenCalled();
    expect(f.remote.continueTurn).not.toHaveBeenCalled();
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

it('loads and focuses the requested historical question in the native chat without changing views', async () => {
  const f = await fixture();
  try {
    const question = f.question('first');
    const scroll = vi.fn();
    question.scrollIntoView = scroll;
    await act(async () => { await f.actions.openRun(f.key, 'first'); });
    await act(async () => { await vi.waitFor(() => expect(f.actions.runRequests.getSnapshot()).toBeUndefined()); });
    expect(f.remote.open).toHaveBeenCalledWith(f.key);
    expect(f.remote.view).toHaveBeenCalledWith(f.key, { beforeSeq: 2 });
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(document.activeElement).toBe(question);
    expect(question.querySelector('[data-group-turn="first"]')).not.toBeNull();
    expect(f.remote.cancel).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('lets a repeated run request replace its older lookup without restarting on catalog refresh', async () => {
  const f = await fixture();
  const pending: Array<(message: GroupMessage) => void> = [];
  const lookup = vi.spyOn(f.actions, 'quotedMessage').mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
  const loadThrough = vi.spyOn(f.actions, 'loadThrough');
  const scroll = vi.fn();
  f.question('first').scrollIntoView = scroll;
  const message: GroupMessage = { id: 'question-first', seq: 1, at: 1, text: 'Question first', turnId: 'first', authorKind: 'user' };
  try {
    await act(async () => { await f.actions.openRun(f.key, 'first'); });
    expect(lookup).toHaveBeenCalledTimes(1);
    const initial = f.actions.runRequests.getSnapshot()?.requestId;
    await f.refresh();
    expect(lookup).toHaveBeenCalledTimes(1);

    await act(async () => { await f.actions.openRun(f.key, 'first'); });
    expect(lookup).toHaveBeenCalledTimes(2);
    const latest = f.actions.runRequests.getSnapshot()?.requestId;
    expect(latest).not.toBe(initial);
    expect(lookup.mock.calls[0]?.[2]?.aborted).toBe(true);

    await act(async () => { pending[0]?.(message); });
    expect(loadThrough).not.toHaveBeenCalled();
    expect(f.actions.runRequests.getSnapshot()?.requestId).toBe(latest);
    await act(async () => { pending[1]?.(message); });
    await act(async () => { await vi.waitFor(() => expect(f.actions.runRequests.getSnapshot()).toBeUndefined()); });
    expect(loadThrough).toHaveBeenCalledExactlyOnceWith(f.key, message.seq);
    expect(scroll).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

it('shows verified status-only memory counts and a selectable provider request ID per failed member', async () => {
  const f = await fixture('en', undefined, { memoryWriteStatus: 'saved', failure: { code: 'QUOTA', status: 402, message: 'Balance exhausted', requestId: 'req-synthetic-402' } });
  try {
    f.data.turns = f.data.turns.map(turn => turn.id === 'first' ? { ...turn, memoryStatusOnly: true } : turn);
    await f.refresh();
    expect(f.question('first').textContent).toContain(f.t('groups.memoryStatus.summary', { saved: 1, failed: 0, unverified: 0 }));
    expect(f.question('first').querySelector('code')?.textContent).toBe('req-synthetic-402');
    expect(f.question('first').textContent).toContain(f.t('groups.failureRequestId'));
    await click(f.question('first').querySelector('[data-group-turn] > button[aria-expanded]') as HTMLButtonElement);
    expect(f.question('first').querySelector('[data-group-member-process]')).toBeNull();
  } finally { await f.close(); }
});

it.each(['en', 'zh'] as const)('%s distinguishes a queued guest question, native receipt, withheld reply and confirmed author', async language => {
  const f = await fixture(language);
  try {
    const turn = f.data.turns[1], row = f.data.deliveries[1];
    if (!turn || !row) throw Error('Missing guest turn fixture');
    turn.guestQuestion = { name: 'Jarvis', bot: { botId: 'outside', botCreatedAt: 2 } };
    turn.orderedMemberIds = [];
    row.state = 'starting';
    const status = () => f.question('second').querySelector('[data-group-guest-status]')?.textContent;
    const label = (key: keyof typeof en.ui) => f.t(key, { name: 'Jarvis' });
    // A different generation with a completion record cannot stand in for Jarvis.
    row.bot = { botId: 'outside', botCreatedAt: 1 }; row.state = 'completed'; row.outputMessageId = 'other';
    await f.refresh(); expect(status()).toContain(label('groups.guest.queued'));
    row.bot = turn.guestQuestion.bot; row.state = 'running'; delete row.outputMessageId;
    await f.refresh(); expect(status()).toContain(label('groups.guest.queued'));
    row.acceptedAt = 2; await f.refresh(); expect(status()).toContain(label('groups.guest.delivered'));
    await click(f.question('second').querySelector('[data-group-turn] > button[aria-expanded]') as HTMLButtonElement);
    expect(f.question('second').textContent).not.toContain(f.t('execution.viewDetails'));
    row.state = 'failed'; await f.refresh(); expect(status()).toContain(label('groups.guest.noReply'));
    delete row.acceptedAt; await f.refresh(); expect(status()).toContain(label('groups.guest.notSent'));
    row.state = 'unknown'; row.reasonCode = 'export-approval-required'; row.exportFlowId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await f.refresh(); expect(status()).toContain(label('groups.guest.review'));
    delete row.reasonCode; delete row.exportFlowId; await f.refresh(); expect(status()).toContain(label('groups.guest.unconfirmed'));
    row.acceptedAt = 3; await f.refresh(); expect(status()).toContain(label('groups.guest.replyUnconfirmed'));
    delete row.acceptedAt; row.state = 'completed'; turn.state = 'idle'; await f.refresh(); expect(status()).toContain(label('groups.guest.unconfirmed'));
    f.nativeReply.guestReply = true;
    f.nativeReply.speaker = { name: 'Jarvis', bot: turn.guestQuestion.bot };
    row.outputMessageId = 'different-answer'; row.outputSeq = 9;
    await f.refresh(); await f.remount();
    expect(f.element.querySelector('[data-group-guest-author]')).toBeNull();
    row.outputMessageId = f.nativeReply.id; await f.refresh(); await f.remount();
    expect(f.element.querySelector('[data-group-guest-author="outside"]')?.parentElement?.textContent).toContain('Jarvis');
    expect(status()).toContain(label('groups.guest.replied'));
    expect(status()).not.toContain(f.t('groups.turnSummary', { count: 0, state: f.t('groups.idle') }));
  } finally { await f.close(); }
});

it('reports the outside answer as a handoff and only the exact member publication as a group reply', async () => {
  const f = await fixture('zh');
  try {
    const turn = f.data.turns[1]!, member = f.data.deliveries[1]!;
    const via = { bot: member.bot, memberId: member.memberId, name: 'Beta', presetId: member.presetId, botRevision: 1 };
    const guest = { name: 'Jarvis', bot: { botId: 'outside', botCreatedAt: 2 }, via };
    turn.guestQuestion = guest;
    const source: GroupDelivery = { ...member, bot: guest.bot, memberId: 'guest:b', id: turn.id + ':0', state: 'running', acceptedAt: 5 };
    member.ordinal = 1; member.id = turn.id + ':1'; member.state = 'pending';
    f.data.deliveries.push(source);
    const status = () => f.question('second').querySelector('[data-group-guest-status]')?.textContent;
    await f.refresh(); expect(status()).toContain('Beta 的问题已送达 Jarvis');
    source.state = 'completed'; source.answeredAt = 6;
    await f.refresh(); expect(status()).toContain('Jarvis 已准备好答复');
    member.acceptedAt = 7;
    await f.refresh(); expect(status()).toContain('Jarvis 已答复 Beta，等待 Beta 回群');
    member.outputMessageId = f.nativeReply.id; member.outputSeq = f.nativeReply.seq; member.state = 'completed';
    f.nativeReply.guestReply = true; f.nativeReply.speaker = { name: 'Jarvis', bot: guest.bot };
    await f.refresh(); await f.remount();
    expect(f.element.querySelector('[data-workspace-group-message="bot-reply"]')).toBeNull();
    delete f.nativeReply.guestReply; f.nativeReply.relayReply = true; f.nativeReply.speaker = { bot: via.bot, name: via.name };
    await f.remount();
    expect(f.element.querySelector('[data-group-relay-author="beta"]')).toBeTruthy();
    expect(status()).toContain('Beta 已根据 Jarvis 的答复回群');
  } finally { await f.close(); }
});
