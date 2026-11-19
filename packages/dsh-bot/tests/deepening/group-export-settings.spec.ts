import { expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { GroupExportSettings } from '../../src/host/groups/export-settings.js';
import { groupResult } from '../../src/host/groups/data-flow.js';
import { Serial, OperationError, need } from '../../src/host/common/operations.js';
import { groupRecordSchema, type GroupRecord } from '../../src/shared/groups.js';
import { groupsSpec } from '../../src/shared/groups-contract.js';
import type { GroupState } from '../../src/host/groups/state.js';
import { flowFixture, alpha, beta } from './managed-flow-fixture.js';

const key = { groupId: 'group', groupCreatedAt: 1 };
function settingsFixture() {
  let g = groupRecordSchema.parse({ id: key.groupId, createdAt: 1, updatedAt: 1, schemaVersion: 1,
    operationId: 'create', createDigest: 'fixture', name: 'Group', rootSessionId: 'root', rootPresetId: 'dsh-bot-group-root',
    cwd: '/fixture', mode: 'mention', membershipRevision: 1, revision: 1, archived: false, state: 'ready' });
  const roster = [alpha, beta].map((bot, order) => ({ bot, enabled: true, removedAt: undefined as number | undefined, order }));
  const birthdays = new Map([['alpha', 1], ['beta', 2]]);
  const putGroup = vi.fn(async (next: GroupRecord) => { g = groupRecordSchema.parse(next); });
  const bot = vi.fn(async (b: typeof alpha) => {
    if (birthdays.get(b.botId) !== b.botCreatedAt) throw new OperationError('conflict');
    return { name: b.botId.toUpperCase() };
  });
  const state = { queue: new Serial(), reasons: new Map(), supergroupAuthorities: new Map(), record: () => g,
    members: () => roster, bot, putGroup } as unknown as GroupState;
  return { state, settings: new GroupExportSettings(state), roster, birthdays, putGroup, bot,
    get g() { return g; }, replace(next: Partial<GroupRecord>) { g = { ...g, ...next }; } };
}

it('enables future exact-content egress without publishing held replies or modifying private readers; disabling restores review', async () => {
  const x = await flowFixture(), s = settingsFixture();
  try {
    Object.assign(s.state, { registry: x.registry() });
    const target = { kind: 'group' as const, ...key, members: [alpha, beta] };
    const held = await x.flow.holdForReview(x.flow.draft('group-result', alpha, 'private', 'pending', target, 'PENDING_PRIVATE'));
    const preview = await s.settings.get(key);
    expect(preview).toMatchObject({ groupRevision: 1, membershipRevision: 1, eligibleBots: [alpha, beta], enabledBots: [], canEnable: true });
    expect(preview.readers).toEqual([{ bot: alpha, name: 'ALPHA' }, { bot: beta, name: 'BETA' }]);
    await s.settings.set(key, alpha, true, 1, 1);
    expect(x.flow.review(held).envelope.content).toBe('PENDING_PRIVATE');
    const send = vi.fn(async () => 'sent'), signal = new AbortController().signal;
    await expect(groupResult(s.state, s.g, alpha, 'private', {} as Agent, 'FUTURE_EXACT_REPLY', 'future', send, signal)).resolves.toBe('sent');
    expect(send).toHaveBeenCalledOnce();
    expect(x.flow.label('private').readers).toEqual([alpha]);
    expect(x.f.kernel.snapshot.versions.get(x.privateId)?.labels.readers).toEqual([alpha]);
    await s.settings.set(key, alpha, false, s.g.revision, 1);
    expect((await s.settings.get(key)).enabledBots).toEqual([]);
    await expect(groupResult(s.state, s.g, alpha, 'private', {} as Agent, 'NEW_PRIVATE', 'future-2', send, signal, true))
      .rejects.toMatchObject({ reasonCode: 'export-approval-required' });
    expect(send).toHaveBeenCalledOnce();
    expect(x.flow.review(held).envelope.content).toBe('PENDING_PRIVATE');
  } finally { await x.close(); }
});

it.each(['group-revision', 'membership-revision', 'nonmember', 'removed', 'disabled', 'recreated', 'recreated-reader', 'archived', 'recovery'] as const)
('rejects stale or ineligible %s before persisting an enable', async mutation => {
  const s = settingsFixture(); let selected = alpha;
  if (mutation === 'group-revision') s.replace({ revision: 2 });
  if (mutation === 'membership-revision') s.replace({ membershipRevision: 2 });
  if (mutation === 'nonmember') selected = { botId: 'gamma', botCreatedAt: 3 };
  if (mutation === 'removed') need(s.roster[0]).removedAt = 4;
  if (mutation === 'disabled') need(s.roster[0]).enabled = false;
  if (mutation === 'recreated') s.birthdays.set('alpha', 9);
  if (mutation === 'recreated-reader') s.birthdays.set('beta', 9);
  if (mutation === 'archived') s.replace({ archived: true });
  if (mutation === 'recovery') s.replace({ state: 'recovery_needed' });
  await expect(s.settings.set(key, selected, true, 1, 1)).rejects.toThrow();
  expect(s.putGroup).not.toHaveBeenCalled();
});

it('rechecks membership after async identity checks and honors cancellation', async () => {
  const s = settingsFixture();
  s.bot.mockImplementation(async () => { s.replace({ membershipRevision: 2 }); return { name: 'BOT' }; });
  await expect(s.settings.set(key, alpha, true, 1, 1)).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
  const aborted = new AbortController(); aborted.abort();
  await expect(s.settings.set(key, alpha, true, 1, 2, aborted.signal)).rejects.toThrow();
  expect(s.putGroup).not.toHaveBeenCalled();
});

it('exposes full Supergroup readers but cannot enable without the existing live authority, and still allows disabling', async () => {
  const s = settingsFixture(), owner = { botId: 'owner', botCreatedAt: 3 };
  s.birthdays.set('owner', 3);
  s.replace({ supergroup: { workId: 'work', originSessionId: 'origin', originMessageId: 'message', owner,
    readers: [owner, alpha, beta], expiresAt: Date.now() + 1000 }, exportApprovals: [{ bot: alpha,
    members: [owner, alpha, beta], membershipRevision: 1, enabledAt: 1 }] });
  const snapshot = await s.settings.get(key);
  expect(snapshot.readers.map(row => row.bot)).toEqual([owner, alpha, beta]);
  expect(snapshot.eligibleBots).toEqual([alpha, beta]); expect(snapshot.canEnable).toBe(false);
  await expect(s.settings.set(key, alpha, true, 1, 1)).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
  await s.settings.set(key, alpha, false, 1, 1);
  expect(s.g.exportApprovals).toEqual([]);
});

it('retains hard data restrictions despite an enabled preference', async () => {
  const x = await flowFixture(), s = settingsFixture();
  try {
    Object.assign(s.state, { registry: x.registry() });
    await s.settings.set(key, alpha, true, 1, 1);
    await x.flow.inherit('restricted', { ...x.flow.label('private'), restrictions: ['secret'] });
    const send = vi.fn();
    await expect(groupResult(s.state, s.g, alpha, 'restricted', {} as Agent, 'SECRET', 'blocked', send, new AbortController().signal, true))
      .rejects.toMatchObject({ reasonCode: 'export-blocked' });
    expect(send).not.toHaveBeenCalled();
  } finally { await x.close(); }
});

it('strictly encodes settings identity and expected revision contracts', () => {
  const p = groupsSpec.methods['dshBot.groups/setExportApproval'].parameters;
  expect(p[1].codec.create().safeParse({ botId: 'alpha', botCreatedAt: 1, extra: true }).success).toBe(false);
  expect(p[2].codec.create().safeParse('always').success).toBe(false);
  for (const index of [3, 4] as const) expect(p[index].codec.create().safeParse(0).success).toBe(false);
});
