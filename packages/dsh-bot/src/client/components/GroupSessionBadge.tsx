import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupActions } from '../groups-state.js';
import { GroupAvatar } from './GroupAvatar.js';
import styles from '../styles/groups.module.css';
import css from '../styles/groups.module.css?inline';
export interface GroupSessionBadgeInjected {
  hooks: { groups: GroupActions['catalog'] };
  onOpenGroup(id: string): void;
}
export function GroupSessionBadge({
  sessionId,
  useGroups,
  onOpenGroup,
  t,
}: Pick<PropsRuntime<'conversation.session.header.utilities'>, 'sessionId'> &
  InjectFace<GroupSessionBadgeInjected> &
  PropsLocale<'dsh-bot'>) {
  const group = useGroups((s) => s.groups.find((g) => g.group.rootSessionId === sessionId));
  return group ? (
    <button
      type="button"
      onClick={() => onOpenGroup(group.group.id)}
      title={`${t('groups.manage')} · ${group.group.name}`}
      aria-label={`${t('groups.manage')} · ${group.group.name}`}
      className={styles.sessionBadge}
    >
      <style>{css}</style><GroupAvatar size={20} />
      <span className={styles.sessionBadgeText}>{group.group.name} · {group.members.filter(member => member.enabled && member.removedAt === undefined).length}</span>
    </button>
  ) : null;
}
