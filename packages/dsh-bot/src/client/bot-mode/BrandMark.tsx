import { BOT_BRAND_PARTS, BOT_BRAND_VIEW_BOX } from '../../shared/bot-brand.js';

// The approved colors in assets/logo.svg belong to the artwork, not the UI
// theme. Reuse its shared contours so this mark stays identical to that asset.
const palette = { glasses: '#53D4AF', sleeping: '#777AF5', classic: '#3167FA' };
const ink = '#0B1739';

export function BrandMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox={BOT_BRAND_VIEW_BOX} fillRule="evenodd" aria-hidden="true" data-bot-brand="companions" data-bot-brand-color="">
      {BOT_BRAND_PARTS.map(({ id, outline, negative, details }) => (
        <g key={id} data-bot-brand-part={id}>
          <path fill={palette[id]} d={[outline, negative].filter(Boolean).join(' ')} />
          <path fill={ink} d={details} />
        </g>
      ))}
    </svg>
  );
}
