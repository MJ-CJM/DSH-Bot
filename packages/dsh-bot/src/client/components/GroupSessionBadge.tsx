import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupActions } from '../groups-state.js';
import { WhaleGlyph } from './WhaleGlyph.js';
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
      title={t('groups.routingHint')}
      style={{
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l3)',
        padding: '.4rem',
        borderRadius: '.5rem',
      }}
    >
      <WhaleGlyph size={20} />
      {t('groups.open')} · {group.group.name}
    </button>
  ) : null;
}
