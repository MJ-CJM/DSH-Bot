import type { GroupMember } from '../../shared/groups.js';
export function nextRoundRobinMember(members: GroupMember[], completedMemberId: string) {
  const live = members.filter((m) => m.enabled && m.removedAt === undefined);
  const i = live.findIndex((m) => m.id === completedMemberId);
  return live[(i + 1) % live.length]?.id;
}
