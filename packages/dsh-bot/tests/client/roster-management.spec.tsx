// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { RosterManagement } from '../../src/client/components/RosterManagement.js';
import { MemberRemovalDialog } from '../../src/client/components/MemberRemovalDialog.js';
import type { GroupActions } from '../../src/client/groups-state.js';
import type { GroupView } from '../../src/shared/groups.js';
import type { BotRecord } from '../../src/shared/schema.js';
import { bots, view } from './group-fixture.js';
import { bot, button, click } from './helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

function required<T>(value: T | null | undefined): T { if (value == null) throw new Error('Missing fixture element'); return value; }

async function fixture(language: 'en' | 'zh' = 'en', configure?: (data: GroupView, records: BotRecord[]) => void, removal = false) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = view();
  const records = [...bots, bot({ id: 'gamma', name: 'Gamma' }), bot({ id: 'delta', name: 'Delta' })];
  const third = required(records[2]);
  data.members.push({ ...required(data.members[0]), id: 'member:gamma', bot: { botId: third.id, botCreatedAt: third.createdAt }, order: 2 });
  configure?.(data, records);
  const onClose = vi.fn();
  const editMembers = vi.fn(async (_key: unknown, input: { operationId: string }) => ({ ok: true as const, value: { operationId: input.operationId, status: 'saved' as const, group: data.group } }));
  const getMemberEditResult = vi.fn(async (_key: unknown, operationId: string) => ({ ok: true as const, value: { operationId, status: 'unknown' as const } }));
  const remote = { editMembers, getMemberEditResult, view: vi.fn(async () => ({ ok: true, value: data })) };
  const actions = { remote: () => remote, refreshRoster: vi.fn(async () => {}), memberEdits: new Map(), canAddBot: vi.fn(() => true) } as unknown as GroupActions;
  const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => (language === 'en' ? en : zh).ui[key]
    .replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? name))) as PropsLocale<'dsh-bot'>['t'];
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  let reopen: (() => void) | undefined;
  function Harness() {
    const [open, setOpen] = useState(true);
    reopen = () => setOpen(true);
    const close = () => { onClose(); setOpen(false); };
    return <><button type="button" data-origin="" onClick={() => setOpen(true)}>Manage</button>{open && (removal
      ? <MemberRemovalDialog view={data} member={required(data.members[2])} actions={actions} bots={records} t={t} onClose={close} />
      : <RosterManagement initial={data} actions={actions} bots={records} t={t} onClose={close} />)}</>;
  }
  await act(async () => root.render(<Harness />));
  return { element, data, records, remote, actions, onClose, t,
    remove: (id = 'gamma') => click(element.querySelector(`[data-roster-member="${id}"] button:last-child`) as HTMLButtonElement),
    reopen: () => act(async () => { reopen?.(); }),
    dispose: async () => { await act(async () => root.unmount()); element.remove(); },
  };
}

it.each(['en', 'zh'] as const)('%s roster includes disabled and deleted Bots, real count and only duplicate IDs', async language => {
  const f = await fixture(language, (data, records) => { required(data.members[0]).enabled = false; data.unavailableMemberIds.push(required(data.members[2]).id); records.splice(2, 1); });
  try {
    expect(f.element.querySelectorAll('[data-roster-member]')).toHaveLength(3);
    expect(f.element.textContent).toContain(f.t('groups.memberCapacity', { count: 3, limit: 6 }));
    expect(f.element.querySelector('[data-roster-member="alpha"]')?.textContent).toContain(f.t('navigation.memberDisabled'));
    expect(f.element.querySelector('[data-roster-member="gamma"]')?.textContent).toContain(f.t('groups.unavailable'));
    expect(f.element.querySelector('[data-roster-member="alpha"]')?.textContent).toContain('alpha');
    expect(button(f.element, f.t('integrations.save')).disabled).toBe(true);
    expect(f.element.querySelector('input[type="checkbox"]')).toBeNull();
  } finally { await f.dispose(); }
});

it('pure removal stages and undoes without history consent, then saves once', async () => {
  const f = await fixture();
  try {
    await f.remove();
    expect(f.remote.editMembers).not.toHaveBeenCalled();
    expect(f.element.querySelector('[data-roster-member="gamma"]')?.textContent).toContain(f.t('groups.roster.pendingRemove'));
    expect(f.element.textContent).not.toContain(f.t('groups.roster.historyScope', { names: 'Gamma' }));
    await f.remove(); expect(button(f.element, f.t('integrations.save')).disabled).toBe(true);
    await f.remove(); await click(button(f.element, f.t('integrations.save')));
    expect(f.remote.editMembers).toHaveBeenCalledTimes(1);
    const input = required(f.remote.editMembers.mock.calls[0])[1] as unknown as { members: unknown[]; historyConfirmed?: boolean };
    expect(input.members).toHaveLength(2); expect(input.historyConfirmed).toBeUndefined();
    expect(f.actions.refreshRoster).toHaveBeenCalledOnce(); expect(f.onClose).toHaveBeenCalledOnce();
  } finally { await f.dispose(); }
});

it('mixed changes show exact new readers and use one explicit confirm click', async () => {
  const f = await fixture();
  try {
    await f.remove(); await click(button(f.element, f.t('groups.roster.add')));
    expect(f.element.textContent).toContain(f.t('groups.roster.historyScope', { names: 'Delta' }));
    expect(f.element.querySelector('input[type="checkbox"]')).toBeNull();
    expect(f.remote.editMembers).not.toHaveBeenCalled();
    await click(button(f.element, f.t('groups.roster.confirmAddSave')));
    expect(f.remote.editMembers).toHaveBeenCalledOnce();
    expect(required(f.remote.editMembers.mock.calls[0])[1]).toMatchObject({ historyConfirmed: true, members: [expect.anything(), expect.anything(), { botId: 'delta', botCreatedAt: 1 }] });
  } finally { await f.dispose(); }
});

it('can undo a removal from an over-limit legacy roster', async () => {
  const f = await fixture('en', data => { for (let n = 3; n < 7; n++) data.members.push({ ...required(data.members[0]), id: `member:extra${n}`, bot: { botId: `extra${n}`, botCreatedAt: 1 }, order: n }); });
  try {
    await f.remove();
    const undo = required(f.element.querySelector<HTMLButtonElement>('[data-roster-member="gamma"] button:last-child'));
    expect(undo.disabled).toBe(false); await click(undo);
    expect(f.element.textContent).toContain(f.t('groups.memberCapacity', { count: 7, limit: 6 }));
    expect(button(f.element, f.t('integrations.save')).disabled).toBe(true);
  } finally { await f.dispose(); }
});

it('keeps a dirty draft when closing is cancelled', async () => {
  const f = await fixture();
  try {
    await f.remove(); await click(button(f.element, f.t('actions.cancel')));
    expect(f.element.querySelectorAll('dialog')).toHaveLength(2);
    expect(f.onClose).not.toHaveBeenCalled();
    await click(button(f.element, f.t('navigation.keepEditing')));
    expect(f.element.querySelector('[data-roster-member="gamma"]')?.textContent).toContain(f.t('groups.roster.pendingRemove'));
  } finally { await f.dispose(); }
});

it('queries unknown write receipts, preserves them over close/reopen, and never replays', async () => {
  const f = await fixture();
  try {
    f.remote.editMembers.mockRejectedValueOnce(new Error('connection lost'));
    await f.remove(); await click(button(f.element, f.t('integrations.save')));
    expect(f.remote.getMemberEditResult).toHaveBeenCalledOnce();
    expect(f.actions.memberEdits?.size).toBe(1);
    await click(button(f.element, f.t('actions.cancel'))); await f.reopen();
    expect(f.element.querySelector('[data-roster-member="gamma"]')?.textContent).toContain(f.t('groups.roster.pendingRemove'));
    expect(button(f.element, f.t('integrations.save')).disabled).toBe(true);
    f.remote.getMemberEditResult.mockResolvedValueOnce({ ok: true, value: { operationId: required(f.remote.editMembers.mock.calls[0])[1].operationId, status: 'saved', group: f.data.group } } as never);
    await click(button(f.element, f.t('groups.roster.checkReceipt')));
    expect(f.remote.editMembers).toHaveBeenCalledOnce(); expect(f.actions.memberEdits?.size).toBe(0);
  } finally { await f.dispose(); }
});

it('saved response plus refresh failure offers only refresh and persists across reopen', async () => {
  const f = await fixture();
  try {
    vi.mocked(f.actions.refreshRoster).mockRejectedValueOnce(new Error('offline'));
    await f.remove(); await click(button(f.element, f.t('integrations.save')));
    expect(f.element.textContent).toContain(f.t('groups.roster.savedRefreshFailed'));
    expect(f.onClose).not.toHaveBeenCalled();
    await click(button(f.element, f.t('actions.cancel'))); await f.reopen();
    expect(f.element.textContent).toContain(f.t('groups.roster.savedRefreshFailed'));
    await click(button(f.element, f.t('bots.refresh')));
    expect(f.remote.editMembers).toHaveBeenCalledOnce(); expect(f.actions.refreshRoster).toHaveBeenCalledTimes(2);
  } finally { await f.dispose(); }
});

it('conflict keeps the draft and requires reviewing the current roster before a fresh save', async () => {
  const f = await fixture();
  try {
    f.remote.editMembers.mockRejectedValueOnce({ code: 'dsh-bot/conflict' });
    f.data.group = { ...f.data.group, revision: 4, membershipRevision: 3 };
    await f.remove(); await click(button(f.element, f.t('integrations.save')));
    expect(button(f.element, f.t('integrations.save')).disabled).toBe(true);
    await click(button(f.element, f.t('groups.roster.reviewLatest')));
    expect(f.remote.editMembers).toHaveBeenCalledOnce();
    await click(button(f.element, f.t('integrations.save')));
    expect(required(f.remote.editMembers.mock.calls[1])[1]).toMatchObject({ expectedRevision: 4, expectedMembershipRevision: 3 });
  } finally { await f.dispose(); }
});

it('single removal has exactly one confirmation and stops only the named running member', async () => {
  const f = await fixture('en', data => {
    const member = required(data.members[2]);
    data.deliveries.push({ id: 'run', memberId: member.id, bot: member.bot, turnId: 'turn', ordinal: 2, botRevision: 1, presetId: 'bot-gamma', state: 'running', contextOutputMessageIds: [], contextTruncated: false });
  }, true);
  try {
    expect(f.element.querySelectorAll('dialog')).toHaveLength(1);
    expect(f.element.textContent).toContain(f.t('groups.roster.stopRemoved', { name: 'Gamma' }));
    await click(button(f.element, f.t('groups.roster.remove')));
    expect(f.remote.editMembers).toHaveBeenCalledOnce();
    expect(f.element.querySelector('dialog')).toBeNull();
  } finally { await f.dispose(); }
});

it('filters unavailable additions while keeping unavailable existing members removable', async () => {
  const f = await fixture('en', data => { data.unavailableMemberIds.push('member:gamma'); });
  try {
    f.actions.canAddBot = candidate => candidate.id !== 'delta';
    await f.remove(); // rerender evaluates the latest eligibility contract
    expect(f.element.textContent).not.toContain('Delta');
    expect(f.element.querySelector('[data-roster-member="gamma"]')?.textContent).toContain(f.t('groups.roster.pendingRemove'));
  } finally { await f.dispose(); }
});

it('conflict read failure can retry and direct removal must reconfirm the latest exact roster', async () => {
  const f = await fixture('en', undefined, true);
  try {
    f.remote.editMembers.mockRejectedValueOnce({ code: 'dsh-bot/conflict' });
    const fresh = structuredClone(f.data);
    fresh.group.revision = 7; fresh.group.membershipRevision = 4;
    f.remote.view.mockRejectedValueOnce(new Error('offline'));
    await click(button(f.element, f.t('groups.roster.remove')));
    expect(button(f.element, f.t('groups.roster.remove')).disabled).toBe(true);
    f.remote.view.mockResolvedValueOnce({ ok: true, value: fresh });
    await click(button(f.element, f.t('bots.refresh')));
    await click(button(f.element, f.t('groups.roster.reviewLatest')));
    expect(f.remote.editMembers).toHaveBeenCalledOnce();
    await click(button(f.element, f.t('groups.roster.remove')));
    expect(required(f.remote.editMembers.mock.calls[1])[1]).toMatchObject({ expectedRevision: 7, expectedMembershipRevision: 4 });
  } finally { await f.dispose(); }
});

it('recognizes an exact member already removed during conflict without removing another', async () => {
  const f = await fixture('en', undefined, true);
  try {
    const fresh = structuredClone(f.data); fresh.group.revision++;
    required(fresh.members[2]).removedAt = 90;
    f.remote.editMembers.mockRejectedValueOnce({ code: 'dsh-bot/conflict' });
    f.remote.view.mockResolvedValueOnce({ ok: true, value: fresh });
    await click(button(f.element, f.t('groups.roster.remove')));
    await click(button(f.element, f.t('groups.roster.reviewLatest')));
    expect(f.element.textContent).toContain(f.t('groups.roster.alreadyRemoved'));
    expect(button(f.element, f.t('groups.roster.remove')).disabled).toBe(true);
    expect(f.remote.editMembers).toHaveBeenCalledOnce();
  } finally { await f.dispose(); }
});

it.each(['archived', 'managed', 'recovery'] as const)('explains why a %s group cannot edit members', async state => {
  const f = await fixture('en', data => {
    if (state === 'archived') data.group.archived = true;
    if (state === 'recovery') data.group.state = 'recovery_needed';
    if (state === 'managed') data.group.supergroup = { workId: 'work', originSessionId: 'origin', originMessageId: 'message', owner: required(data.members[0]).bot, readers: data.members.map(member => member.bot), expiresAt: 1000 };
  });
  try {
    expect(f.element.textContent).toContain(f.t(`groups.roster.${state}`));
    expect(f.element.querySelector<HTMLButtonElement>('[data-roster-member="gamma"] button:last-child')?.disabled).toBe(true);
    expect(button(f.element, f.t('integrations.save')).disabled).toBe(true);
  } finally { await f.dispose(); }
});

it('minimum two members blocks the direct removal confirmation', async () => {
  const f = await fixture('en', data => { required(data.members[1]).removedAt = 2; }, true);
  try {
    expect(button(f.element, f.t('groups.roster.remove')).disabled).toBe(true);
    expect(f.element.textContent).toContain(f.t('groups.roster.minimum'));
    expect(f.remote.editMembers).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

it('rejects a mismatched saved receipt and keeps the operation unresolved', async () => {
  const f = await fixture();
  try {
    f.remote.editMembers.mockResolvedValueOnce({ ok: true, value: { operationId: 'wrong:operation', status: 'saved', group: f.data.group } });
    await f.remove(); await click(button(f.element, f.t('integrations.save')));
    expect(f.remote.getMemberEditResult).toHaveBeenCalledOnce();
    expect(f.onClose).not.toHaveBeenCalled();
    expect(f.element.textContent).toContain(f.t('groups.roster.unknown'));
  } finally { await f.dispose(); }
});
