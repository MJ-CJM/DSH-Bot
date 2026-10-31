import { bot, type mountClient } from './helpers.js';
import { GROUP_ROOT_PRESET, type GroupView } from '../../src/shared/groups.js';
export const bots = [
  bot({
    id: 'alpha',
    name: 'Same name',
    avatarVariant: 'glasses',
    avatarColor: 'teal',
  }),
  bot({
    id: 'beta',
    name: 'Same name',
    avatarVariant: 'spout',
    avatarColor: 'rose',
  }),
];
export function view(): GroupView {
  const group: GroupView['group'] = {
    id: 'group:one',
    operationId: 'create:one',
    createDigest: 'hash',
    name: 'Synthetic group',
    rootSessionId: 'group-root-one',
    rootPresetId: GROUP_ROOT_PRESET,
    cwd: '/synthetic',
    mode: 'mention' as const,
    membershipRevision: 1,
    revision: 1,
    archived: false,
    state: 'ready' as const,
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1 as const,
  };
  const key = { groupId: group.id, groupCreatedAt: 1 };
  return {
    group,
    unread: false,
    readRevision: 0,
    members: bots.map((b, order) => ({
      id: `member:${b.id}`,
      group: key,
      bot: { botId: b.id, botCreatedAt: b.createdAt },
      order,
      joinedAt: 1,
      enabled: true,
    })),
    unavailableMemberIds: [],
    running: false,
    turns: [],
    deliveries: [],
    messages: [
      {
        id: 'historic-beta',
        seq: 1,
        at: 1,
        text: 'Historic reply',
        turnId: 'turn:old',
        speaker: {
          bot: { botId: 'beta', botCreatedAt: 1 },
          name: 'Original beta',
          avatarColor: 'rose',
          avatarVariant: 'spout',
        },
      },
    ],
    hasEarlier: false,
  };
}
export function summary() {
  const { turns: _t, deliveries: _d, messages: _m, hasEarlier: _h, ...s } = view();
  return s;
}
export function configure(remote: Parameters<NonNullable<Parameters<typeof mountClient>[2]>>[0]) {
  remote.data.groupView = view();
  remote.data.groups = [summary()];
}
