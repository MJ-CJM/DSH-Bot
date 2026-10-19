import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives';
import type { CSSProperties } from 'react';
import { AVATAR_COLOR_TOKENS, type AvatarColor, type BotRecord } from '../../shared/schema.js';

// FishLogo is a public, shell-seeded primitive (DSH dsh-v0.2.1-rc.2).
// Its currentColor graphic is used only as a Bot avatar, not a plugin brand.
// Blend the palette toward the theme's foreground so green/amber glyphs retain
// sufficient contrast on the base surface in both of the locked DSH themes.
export const avatarColors: Record<AvatarColor, { color: string; label: 'avatar.blue' | 'avatar.green' | 'avatar.amber' | 'avatar.red' }> = {
  '--dsw-alias-state-business-primary': { color: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 72%, var(--dsw-alias-label-primary))', label: 'avatar.blue' },
  '--dsw-alias-state-success-primary': { color: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 72%, var(--dsw-alias-label-primary))', label: 'avatar.green' },
  '--dsw-alias-state-warn-label': { color: 'color-mix(in srgb, var(--dsw-alias-state-warn-label) 72%, var(--dsw-alias-label-primary))', label: 'avatar.amber' },
  '--dsw-alias-state-error-primary': { color: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 72%, var(--dsw-alias-label-primary))', label: 'avatar.red' },
};

export function defaultAvatarColor(id: string): AvatarColor {
  // FNV-1a is deterministic across Client reloads, themes and locales.
  let hash = 2166136261;
  for (const codePoint of id) hash = Math.imul(hash ^ (codePoint.codePointAt(0) ?? 0), 16777619);
  return AVATAR_COLOR_TOKENS[(hash >>> 0) % AVATAR_COLOR_TOKENS.length] ?? AVATAR_COLOR_TOKENS[0];
}

export interface BotAvatarProps {
  bot: Pick<BotRecord, 'id' | 'avatar' | 'avatarColor'>;
  size?: number;
  className?: string;
  label?: string;
}

/** Self-contained styles also work in passive sidebar and session slots where
 * the Bots page (and its stylesheet) has never been mounted. */
export function BotAvatar({ bot, size = 48, className, label }: BotAvatarProps) {
  const color = bot.avatarColor ?? defaultAvatarColor(bot.id);
  const style: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    width: size, height: size, borderRadius: Math.max(5, size * 0.25), overflow: 'hidden',
    background: 'var(--dsw-alias-bg-base)', color: avatarColors[color].color,
    fontSize: size * 0.58, lineHeight: 1, verticalAlign: 'middle',
  };
  const image = bot.avatar?.startsWith('data:image/');
  return <span className={className} style={style} role="img"
    aria-label={label} aria-hidden={label ? undefined : true} data-bot-avatar={image ? 'image' : bot.avatar ? 'emoji' : 'whale'}
    data-avatar-color={color} data-bot-id={bot.id}>
    {image ? <img src={bot.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      : bot.avatar ?? <FishLogo size={size * 0.76} />}
  </span>;
}
