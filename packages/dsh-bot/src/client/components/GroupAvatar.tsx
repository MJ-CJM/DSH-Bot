import { WHALE_PATH } from './WhaleGlyph.js';

/** Two complete silhouettes stay distinct in the native 16px leading cell. */
export function GroupAvatar({ size = 24, label }: { size?: number; label?: string }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor"
    data-group-avatar="whales" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    style={{ flexShrink: 0, verticalAlign: 'middle', color: 'var(--dsw-alias-label-primary)' }}>
    <path d={WHALE_PATH} transform="translate(8 1) scale(.96)" />
    <path d={WHALE_PATH} transform="translate(0 17) scale(.78)" />
  </svg>;
}
