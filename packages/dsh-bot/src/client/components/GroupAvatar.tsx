import type { GroupMember } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';
import { BotAvatar } from './BotAvatar.js';
import { BotBrandGlyph } from './BotBrandGlyph.js';

export function GroupAvatar({ size = 24, label, members, bots = [] }: {
  size?: number;
  label?: string;
  members?: readonly GroupMember[];
  bots?: readonly BotRecord[];
}) {
  const faces = (members ?? []).flatMap(member => {
    const bot = bots.find(row => row.id === member.bot.botId && row.createdAt === member.bot.botCreatedAt);
    return bot ? [{ key: member.id, bot }] : [];
  }).slice(0, 4);
  if (faces.length) {
    const cell = Math.max(8, Math.floor((size - 3) / 2));
    return <figure role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
      data-group-avatar="members" data-group-avatar-count={faces.length}
      style={{ display: 'inline-grid', gridTemplateColumns: `repeat(2, ${cell}px)`, gap: 1, flexShrink: 0, margin: 0,
        width: size, height: size, alignContent: 'center', justifyContent: 'center', verticalAlign: 'middle' }}>
      {faces.map(({ key, bot }, index) => <BotAvatar key={key} bot={bot} size={cell} className={faces.length === 1 && index === 0 ? 'group-avatar-single' : undefined} />)}
    </figure>;
  }
  return <span
    data-group-avatar="whales" role="img" aria-label={label} aria-hidden={label ? undefined : true}
    style={{ display: 'inline-flex', width: size, height: size, flexShrink: 0, verticalAlign: 'middle', color: 'var(--dsw-alias-label-primary)' }}>
    <BotBrandGlyph size={size} />
  </span>;
}
