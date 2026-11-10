import { BOT_BRAND_PARTS, BOT_BRAND_VIEW_BOX } from '../../shared/bot-brand.js';

export function BotBrandGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={BOT_BRAND_VIEW_BOX}
      fill="currentColor"
      aria-hidden="true"
      data-bot-brand="companions"
    >
      {BOT_BRAND_PARTS.map(({ id, outline, negative, details }) => (
        <path key={id} data-bot-brand-part={id} fillRule="evenodd" d={[outline, negative, details].join(' ')} />
      ))}
    </svg>
  );
}
