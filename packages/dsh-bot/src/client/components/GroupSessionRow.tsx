import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupActions } from '../groups-state.js';
import type { BotCatalog } from '../state.js';
import { GroupAvatar } from './GroupAvatar.js';
export interface GroupSessionRowInjected {
  hooks: { groups: GroupActions['catalog']; catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'> };
}
type Props = Pick<PropsRuntime<'sidebar.session.row.leading'>, 'sessionId'> &
  PropsLocale<'dsh-bot'> &
  InjectFace<GroupSessionRowInjected>;
export function GroupSessionLeading({ sessionId, useGroups, useCatalog, t }: Props) {
  const group = useGroups((snapshot) => snapshot.groups.find((row) => row.group.rootSessionId === sessionId));
  const entries = useCatalog((snapshot) => group && snapshot.loaded ? snapshot.entries : undefined);
  return group ? (
    <span
      data-group-session-leading={group.group.id}
      role="img"
      aria-label={t('row.group', { name: group.group.name })}
      title={t('row.group', { name: group.group.name })}
    >
      <GroupAvatar size={16}
        members={group.members.filter(member => member.removedAt === undefined)}
        bots={entries?.map(entry => entry.bot)} />
    </span>
  ) : null;
}
export function GroupSessionHover({ sessionId, useGroups, t }: Props) {
  const group = useGroups((snapshot) => snapshot.groups.find((row) => row.group.rootSessionId === sessionId));
  return group ? (
    <span
      data-group-session-hover={group.group.id}
      style={{
        display: 'block',
        padding: '4px 6px',
        borderRadius: 4,
        fontSize: 12,
        lineHeight: '16px',
        overflowWrap: 'anywhere',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
      }}
    >
      {t('row.group', { name: group.group.name })}
    </span>
  ) : null;
}
