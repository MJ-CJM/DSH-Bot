import type { CSSProperties } from 'react';
import {
  AVATAR_COLOR_TOKENS,
  AVATAR_VARIANTS,
  type AvatarColor,
  type BotRecord,
  type WhaleVariant,
} from '../../shared/schema.js';
import { WhaleGlyph } from './WhaleGlyph.js';

// All colors derive from the host's aliases. A final foreground mix maintains
// non-text contrast in both locked themes; no fixed light/dark color overrides.
const blue = 'var(--dsw-alias-state-business-primary)';
const green = 'var(--dsw-alias-state-success-primary)';
const amber = 'var(--dsw-alias-state-warn-label)';
const red = 'var(--dsw-alias-state-error-primary)';
const foreground = 'var(--dsw-alias-label-primary)';
const mix = (a: string, b: string, weight = 50) => `color-mix(in srgb, ${a} ${weight}%, ${b})`;
const shade = (color: string) => mix(color, foreground, 72);
export const avatarColors = {
  '--dsw-alias-state-business-primary': { color: shade(blue), label: 'avatar.blue' },
  '--dsw-alias-state-success-primary': { color: shade(green), label: 'avatar.green' },
  '--dsw-alias-state-warn-label': { color: shade(amber), label: 'avatar.amber' },
  '--dsw-alias-state-error-primary': { color: shade(red), label: 'avatar.red' },
  teal: { color: shade(mix(green, blue, 65)), label: 'avatar.teal' },
  cyan: { color: shade(mix(blue, green, 70)), label: 'avatar.cyan' },
  indigo: { color: shade(mix(blue, red, 80)), label: 'avatar.indigo' },
  purple: { color: shade(mix(blue, red)), label: 'avatar.purple' },
  rose: { color: shade(mix(red, blue, 75)), label: 'avatar.rose' },
  orange: { color: shade(mix(amber, red, 65)), label: 'avatar.orange' },
  olive: { color: shade(mix(amber, green)), label: 'avatar.olive' },
  slate: { color: shade(mix(blue, foreground, 25)), label: 'avatar.slate' },
} as const satisfies Record<AvatarColor, { color: string; label: string }>;

function identityHash(id: string) {
  let hash = 2166136261;
  for (const codePoint of id) hash = Math.imul(hash ^ (codePoint.codePointAt(0) ?? 0), 16777619);
  return hash >>> 0;
}
export function defaultAvatarColor(id: string): AvatarColor {
  return AVATAR_COLOR_TOKENS[identityHash(id) % AVATAR_COLOR_TOKENS.length] ?? AVATAR_COLOR_TOKENS[0];
}
export function defaultAvatarVariant(id: string): WhaleVariant {
  // Separate hash domain avoids coupling six shapes to twelve palette positions.
  return AVATAR_VARIANTS[identityHash(`variant:${id}`) % AVATAR_VARIANTS.length] ?? 'classic';
}
export function resolvedAvatarVariant(bot: Pick<BotRecord, 'id' | 'avatarVariant'>): WhaleVariant {
  return bot.avatarVariant === 'auto' ? defaultAvatarVariant(bot.id) : (bot.avatarVariant ?? 'classic');
}

export interface BotAvatarProps {
  bot: Pick<BotRecord, 'id' | 'avatar' | 'avatarColor' | 'avatarVariant'>;
  size?: number;
  className?: string;
  label?: string;
}

/** Self-contained styles also work in passive sidebar and session slots where
 * the Bots page (and its stylesheet) has never been mounted. */
export function BotAvatar({ bot, size = 48, className, label }: BotAvatarProps) {
  const color = bot.avatarColor ?? defaultAvatarColor(bot.id);
  const variant = resolvedAvatarVariant(bot);
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: size,
    height: size,
    borderRadius: Math.max(5, size * 0.25),
    overflow: 'hidden',
    background: 'var(--dsw-alias-bg-base)',
    color: avatarColors[color].color,
    fontSize: size * 0.58,
    lineHeight: 1,
    verticalAlign: 'middle',
  };
  const image = bot.avatar?.startsWith('data:image/');
  return (
    <span
      className={className}
      style={style}
      role="img"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-bot-avatar={image ? 'image' : bot.avatar ? 'emoji' : 'whale'}
      data-avatar-color={color}
      data-avatar-variant={variant}
      data-bot-id={bot.id}
    >
      {image ? (
        <img src={bot.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        (bot.avatar ?? <WhaleGlyph size={size * 0.9} variant={variant} />)
      )}
    </span>
  );
}
