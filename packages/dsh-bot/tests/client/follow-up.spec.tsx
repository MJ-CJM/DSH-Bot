// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis';
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import { fireEvent, getByLabelText, getByRole, queryByRole } from '@testing-library/dom';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { FollowUpPanel } from '../../src/client/proactive/FollowUpPanel.js';
import { createFollowUpSource, type FollowUpStatus } from '../../src/client/proactive/follow-up-state.js';
import { subjectKey, type FollowUpCard, type Subject } from '../../src/shared/proactive/follow-up.js';
import type { FollowUpPolicyRequest } from '../../src/shared/proactive/setup.js';
import type { FollowUpGroupAcceptRequest, FollowUpGroupChoiceRequest } from '../../src/shared/proactive/group-follow-up.js';

const t = ((key: string, params?: Record<string, string>) =>
  params?.value ? `${key} ${params.value}` : key) as ComponentProps<typeof FollowUpPanel>['t'];
const bot: Subject = { kind: 'bot', bot: { botId: 'alpha', botCreatedAt: 4 } };
const group: Subject = { kind: 'group', group: { groupId: 'group:one', groupCreatedAt: 8 } };
const epoch = '5298d8de-e141-43ca-8b38-5e18608200d4';
const ok = <T,>(value: T) => ({ ok: true as const, value });
const receipt = (commandId: string) => ok({ kind: 'receipt', receipt: { commandId, status: 'committed' } });
const card = (subject: Subject, id: string, origin: FollowUpCard['origin'], condition: FollowUpCard['condition']): FollowUpCard => ({
  subject, id: id.toLowerCase().replaceAll(' ', '-'), decisionId: `decision-${id.toLowerCase().replaceAll(' ', '-')}`, origin, condition, revision: 2,
  observedAt: '2026-11-09T00:00:00.000Z', title: id, state: 'open',
});
function ready(subject: Subject, localEnabled: boolean, rows: FollowUpCard[] = [], legacyCiActive = false): FollowUpStatus {
  return { state: 'ready', configEpoch: epoch, scopeOnly: !legacyCiActive,
    summary: { policy: { subject, revision: 3, pauseEpoch: 2, localEnabled,
      legacyCi: localEnabled || legacyCiActive ? 'inherit' : 'denied', observationStart: localEnabled ? 1 : null }, legacyCiActive, rows } };
}
function surface(methods: Record<string, unknown>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context();
  ctx.provide('remote.dshBot.proactive', methods as unknown as TypertRemoteNamespaceMap['dshBot.proactive']);
  const source = createFollowUpSource(ctx, {});
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  return { node, source,
    render: (subject: Subject, options: Partial<ComponentProps<typeof FollowUpPanel>> = {}) =>
      act(async () => root.render(<FollowUpPanel source={source} subject={subject} mode="detail" t={t} {...options} />)),
    click: (label: string) => act(async () => fireEvent.click(getByRole(node, 'button', { name: label }))),
    async close() { await act(async () => root.unmount()); await ctx.fiber.dispose(); node.remove(); },
  };
}

test('first enable is scoped and a lost response is checked with the original operation', async () => {
  let status: FollowUpStatus = { state: 'disabled', configEpoch: epoch };
  const followUpPolicy = vi.fn(async (input: FollowUpPolicyRequest) => {
    if (followUpPolicy.mock.calls.length === 1) return ok({ kind: 'unknown', commandId: input.commandId });
    status = ready(input.subject, input.action === 'enable-local');
    return receipt(input.commandId);
  });
  const app = surface({
    followUpSummary: async (subject: Subject) => ok(subjectKey(subject) === subjectKey(bot) ? status : ready(subject, false)),
    followUpPage: async () => ok({ rows: [] }), followUpPolicy,
  });
  try {
    await app.render(bot);
    await app.click('followUp.enable');
    expect(followUpPolicy).toHaveBeenCalledExactlyOnceWith({
      commandId: expect.any(String), subject: bot, action: 'enable-local', expectedRevision: null, expectedConfigEpoch: epoch,
    });
    expect(app.node.textContent).toContain('followUp.unknown');
    await app.render(group);
    expect(app.node.textContent).not.toContain('followUp.unknown');
    expect(app.node.textContent).toContain('followUp.paused');
    await app.render(bot);
    await app.click('followUp.recheck');
    expect(followUpPolicy.mock.calls[1]).toEqual(followUpPolicy.mock.calls[0]);
    expect(app.node.textContent).toContain('followUp.enabled');
    expect(queryByRole(app.node, 'button', { name: 'followUp.enable' })).toBeNull();
    await app.click('followUp.pause');
    expect(followUpPolicy).toHaveBeenLastCalledWith({
      commandId: expect.any(String), subject: bot, action: 'pause', expectedRevision: 3, expectedConfigEpoch: epoch,
    });
  } finally { await app.close(); }
});

test('manual watch and paged card actions stay in the current group and open the original run', async () => {
  const watch = card(group, 'Release checklist', { kind: 'watch', watchId: 'watch:one' },
    { kind: 'tracking', completion: 'Reviewer signs off' });
  const failure = card(group, 'Migration issue', { kind: 'group-turn', turnId: 'turn:one' },
    { kind: 'failed', reason: 'Verification failed' });
  const followUpPage = vi.fn(async ({ cursor }: { cursor?: string }) =>
    ok(cursor ? { rows: [watch, failure] } : { rows: [watch], next: 'next:one' }));
  const followUpWatchCreate = vi.fn(async (input: { commandId: string }) => receipt(input.commandId));
  const followUpAction = vi.fn(async (input: { commandId: string }) => receipt(input.commandId));
  const open = vi.fn();
  const app = surface({
    followUpSummary: async () => ok(ready(group, true, [watch])),
    followUpPage, followUpWatchCreate, followUpAction,
  });
  try {
    await app.render(group, { navigation: { canOpen: origin => origin.kind === 'group-turn', open } });
    expect(app.node.textContent).toContain('Reviewer signs off');
    await app.click('followUp.add');
    const save = getByRole(app.node, 'button', { name: 'followUp.save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await act(async () => {
      fireEvent.change(getByLabelText(app.node, 'followUp.watchTitle'), { target: { value: ' Review notes ' } });
      fireEvent.change(getByLabelText(app.node, 'followUp.watchCompletion'), { target: { value: ' Signed ' } });
    });
    await app.click('followUp.save');
    expect(followUpWatchCreate).toHaveBeenCalledExactlyOnceWith({
      commandId: expect.any(String), id: expect.any(String), subject: group, expectedRevision: 3,
      watch: { title: 'Review notes', completion: 'Signed', source: { kind: 'manual' } },
    });
    await app.click('followUp.more');
    expect(followUpPage).toHaveBeenLastCalledWith({ subject: group, cursor: 'next:one' });
    expect(app.node.querySelectorAll('[data-follow-up-card]')).toHaveLength(2);
    await app.click('followUp.open');
    expect(open).toHaveBeenCalledExactlyOnceWith({ kind: 'group-turn', turnId: 'turn:one' }, expect.any(AbortSignal));
    await app.click('followUp.complete');
    expect(followUpAction).toHaveBeenCalledExactlyOnceWith({
      commandId: expect.any(String), subject: group, cardId: watch.id, expectedRevision: 2, expectedPolicyRevision: 3, action: 'complete',
    });
  } finally { await app.close(); }
});

test('a failed group turn starts only the selected member and a recovered request keeps its original input', async () => {
  const failure = card(group, 'Group failure', { kind: 'group-turn', turnId: 'turn:one' }, { kind: 'failed' });
  const watch = card(group, 'Independent watch', { kind: 'watch', watchId: 'watch:one' }, { kind: 'tracking' });
  const members = ['alpha', 'beta', 'gamma', 'delta'].map(botId => ({
    id: `member-${botId}`, label: botId, bot: { botId, botCreatedAt: 10 },
  }));
  let prior: FollowUpGroupAcceptRequest | undefined;
  let releaseOffer!: () => void;
  let releaseAccept!: () => void;
  const oldOffer = new Promise<void>(resolve => { releaseOffer = resolve; });
  const lostResponse = new Promise<void>(resolve => { releaseAccept = resolve; });
  const followUpGroupChoice = vi.fn(async (input: FollowUpGroupChoiceRequest) => {
    const member = members.find(row => row.id === input.memberId);
    if (!member) throw new Error('Missing selected member');
    if (input.memberId === 'member-alpha') await oldOffer;
    return ok({ choice: prior?.choice ?? { predecessorTurnId: 'turn:one', predecessorTurnRevision: 3,
      membershipRevision: 1, modelRevision: 2, memberId: member.id, bot: member.bot, botRevision: 10,
      modelSelection: { provider: 'native', model: 'current-group-route' } }, ...(prior ? { existing: prior } : {}) });
  });
  const followUpGroupAccept = vi.fn(async (input: FollowUpGroupAcceptRequest) => {
    if (!prior) {
      prior = input;
      await lostResponse;
      return ok({ kind: 'unknown', commandId: input.commandId });
    }
    return ok({ kind: 'started', turnId: 'turn:continued', commandId: input.commandId });
  });
  const app = surface({
    followUpSummary: async (subject: Subject) => ok(ready(subject, true)),
    followUpPage: async ({ subject }: { subject: Subject }) => ok({ rows: subject.kind === 'group' ? [failure, watch] : [] }),
    followUpGroupChoice, followUpGroupAccept,
  });
  const transport = app.source.groupContinuation;
  const onAccepted = vi.fn();
  if (!transport) throw new Error('Group continuation transport unavailable');
  const groupContinuation = { transport, members, canContinue: (turn: string) => turn === 'turn:one', onAccepted };
  try {
    await app.render(group, { groupContinuation });
    await app.click('followUp.groupContinue');
    const select = getByRole(app.node, 'combobox', { name: 'followUp.groupMember' });
    expect(select.querySelectorAll('option')).toHaveLength(5);
    expect(document.activeElement).toBe(select);
    await act(async () => fireEvent.change(select, { target: { value: 'member-alpha' } }));
    await act(async () => fireEvent.change(select, { target: { value: 'member-gamma' } }));
    expect(followUpGroupChoice).toHaveBeenLastCalledWith({ subject: group, cardId: failure.id,
      expectedRevision: 2, memberId: 'member-gamma' });
    await act(async () => releaseOffer());
    expect(followUpGroupAccept).not.toHaveBeenCalled();
    await act(async () => fireEvent.change(getByLabelText(app.node, 'followUp.groupText'), { target: { value: ' Verify the failed check. ' } }));
    await app.click('followUp.groupAccept');
    expect(followUpGroupAccept).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      subject: group, cardId: failure.id, expectedRevision: 2, expectedPolicyRevision: 3, text: 'Verify the failed check.',
      choice: expect.objectContaining({ memberId: 'member-gamma', modelSelection: { provider: 'native', model: 'current-group-route' } }),
      approved: true,
    }));
    expect(app.node.textContent).toContain('followUp.saving');
    await app.render(bot, { groupContinuation });
    await act(async () => releaseAccept());
    expect(app.node.textContent).not.toContain('followUp.unknown');
    expect(queryByRole(app.node, 'button', { name: 'followUp.groupContinue' })).toBeNull();

    await app.render(group, { groupContinuation });
    await app.click('followUp.groupContinue');
    await act(async () => fireEvent.change(getByLabelText(app.node, 'followUp.groupText'), { target: { value: 'Different draft' } }));
    await act(async () => fireEvent.change(getByRole(app.node, 'combobox', { name: 'followUp.groupMember' }), {
      target: { value: 'member-beta' },
    }));
    expect((getByLabelText(app.node, 'followUp.groupText') as HTMLTextAreaElement).value).toBe('Verify the failed check.');
    expect(queryByRole(app.node, 'button', { name: 'followUp.groupAccept' })).toBeNull();
    await app.click('followUp.recheck');
    expect(followUpGroupAccept.mock.calls[1]).toEqual(followUpGroupAccept.mock.calls[0]);
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith('turn:continued');
  } finally { await app.close(); }
});

test('an unconfirmed group proposal becomes an active watch only after the owner receipt', async () => {
  const proposal = card(group, 'Verify the installer', { kind: 'watch', watchId: 'group-watch' }, {
    kind: 'approval-pending', completion: 'Owner verifies the installed version',
    wait: { reason: 'Install machine unavailable', request: 'Share an offline install result' },
  });
  let visible = proposal;
  const followUpAction = vi.fn(async (input: { commandId: string }) => {
    if (followUpAction.mock.calls.length === 1) return ok({ kind: 'unknown', commandId: input.commandId });
    visible = { ...proposal, revision: 3, condition: { kind: 'tracking', completion: 'Owner verifies the installed version' } };
    return receipt(input.commandId);
  });
  const app = surface({
    followUpSummary: async (subject: Subject) => ok(ready(subject, true, subject.kind === 'group' ? [visible] : [])),
    followUpPage: async ({ subject }: { subject: Subject }) => ok({ rows: subject.kind === 'group' ? [visible] : [] }),
    followUpAction,
  });
  try {
    await app.render(group);
    expect(app.node.textContent).toContain('followUp.condition.approval-pending');
    expect(app.node.textContent).toContain('Owner verifies the installed version');
    expect(app.node.textContent).toContain('Share an offline install result');
    expect(queryByRole(app.node, 'button', { name: 'followUp.complete' })).toBeNull();
    expect(followUpAction).not.toHaveBeenCalled();
    await app.click('followUp.confirmWatch');
    expect(followUpAction).toHaveBeenCalledExactlyOnceWith({
      subject: group, cardId: proposal.id, expectedRevision: 2, expectedPolicyRevision: 3, action: 'confirm-watch',
      commandId: expect.any(String),
    });
    expect(app.node.textContent).toContain('followUp.condition.approval-pending');
    await app.render(bot);
    expect(queryByRole(app.node, 'button', { name: 'followUp.confirmWatch' })).toBeNull();
    await app.render(group);
    await app.click('followUp.recheck');
    expect(followUpAction.mock.calls[1]).toEqual(followUpAction.mock.calls[0]);
    expect(app.node.textContent).toContain('followUp.condition.tracking');
    expect(queryByRole(app.node, 'button', { name: 'followUp.confirmWatch' })).toBeNull();
    expect(getByRole(app.node, 'button', { name: 'followUp.complete' })).toBeDefined();
  } finally { await app.close(); }
});

test('a closed follow-up can be explicitly forgotten in a read-only archived group', async () => {
  const original = { ...card(group, 'Private archived watch', { kind: 'watch', watchId: 'old-watch' },
    { kind: 'closed', reason: 'completed' }), state: 'closed' as const };
  let rows = [original];
  const followUpAction = vi.fn(async (input: { commandId: string }) => {
    rows = [];
    return receipt(input.commandId);
  });
  const app = surface({
    followUpSummary: async () => ok(ready(group, false)),
    followUpPage: async () => ok({ rows }),
    followUpAction,
  });
  try {
    await app.render(group, { editable: false });
    expect(app.node.textContent).not.toContain(original.title);
    await app.click('followUp.history');
    expect(app.node.textContent).toContain(original.title);
    expect(queryByRole(app.node, 'button', { name: 'followUp.stop' })).toBeNull();
    await app.click('followUp.forget');
    expect(followUpAction).toHaveBeenCalledExactlyOnceWith({
      commandId: expect.any(String), subject: group, cardId: original.id,
      expectedRevision: original.revision, expectedPolicyRevision: 3, action: 'forget',
    });
    expect(app.node.textContent).not.toContain(original.title);
  } finally { await app.close(); }
});

test('changing generation or hiding the page invalidates the old view and releases its subscriptions', async () => {
  const old = card(bot, 'Previous generation', { kind: 'watch', watchId: 'watch:old' }, { kind: 'tracking' });
  const newer: Subject = { kind: 'bot', bot: { ...bot.bot, botCreatedAt: 5 } };
  const current = card(newer, 'Current generation', { kind: 'watch', watchId: 'watch:new' }, { kind: 'tracking' });
  let settleOld: (status: ReturnType<typeof ok<FollowUpStatus>>) => void = () => {};
  const oldResponse = new Promise<ReturnType<typeof ok<FollowUpStatus>>>(resolve => { settleOld = resolve; });
  const followUpSummary = vi.fn((subject: Subject) => subjectKey(subject) === subjectKey(bot)
    ? oldResponse : Promise.resolve(ok(ready(newer, false, [current], true))));
  const app = surface({ followUpSummary, followUpPage: async () => ok({ rows: [] }) });
  try {
    await app.render(bot, { mode: 'summary' });
    await app.render(newer, { mode: 'summary' });
    await act(async () => settleOld(ok(ready(bot, true, [old]))));
    expect(app.node.textContent).not.toContain(old.title);
    expect(app.node.textContent).toContain(current.title);
    expect(app.node.textContent).toContain('followUp.legacyCi');
    const beforeHidden = followUpSummary.mock.calls.length;
    await app.render(group, { mode: 'summary', active: false });
    expect(followUpSummary).toHaveBeenCalledTimes(beforeHidden);
    expect(queryByRole(app.node, 'button', { name: 'followUp.pause' })).toBeNull();
  } finally { await app.close(); }
});
