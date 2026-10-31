import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupActions } from '../groups-state.js';
import { GroupAvatar } from './GroupAvatar.js';
export interface GroupSessionRowInjected {
  hooks: { groups: GroupActions['catalog'] };
}
type Props = Pick<PropsRuntime<'sidebar.session.row.leading'>, 'sessionId'> &
  PropsLocale<'dsh-bot'> &
  InjectFace<GroupSessionRowInjected>;
export function GroupSessionLeading({ sessionId, useGroups, t }: Props) {
  const group = useGroups((snapshot) => snapshot.groups.find((row) => row.group.rootSessionId === sessionId));
  return group ? (
    <span
      data-group-session-leading={group.group.id}
      role="img"
      aria-label={t('row.group', { name: group.group.name })}
      title={t('row.group', { name: group.group.name })}
    >
      <GroupAvatar size={16} />
    </span>
  ) : null;
}
export function GroupSessionHover({ sessionId, useGroups, t }: Props) {
  const group = useGroups((snapshot) => snapshot.groups.find((row) => row.group.rootSessionId === sessionId));
  return group ? (
    <span data-group-session-hover={group.group.id}>{t('row.group', { name: group.group.name })}</span>
  ) : null;
}
