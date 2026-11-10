import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_BRAND_PARTS, BOT_BRAND_VIEW_BOX } from '../packages/dsh-bot/src/shared/bot-brand.ts';

// Deterministic vector export of the approved B artwork. Browser UI uses the
// same contours with currentColor; these fixed colors belong to brand assets.
const root = fileURLToPath(new URL('../', import.meta.url));
const palette = { glasses: '#53D4AF', sleeping: '#777AF5', classic: '#3167FA' };
const ink = '#0B1739';
const combined = part => [part.outline, part.negative, part.details].filter(Boolean).join(' ');
const mono = BOT_BRAND_PARTS.map(part => `    <path data-bot-brand-part="${part.id}" d="${combined(part)}"/>`).join('\n');
const color = BOT_BRAND_PARTS.map(part => [
  `    <path fill="${palette[part.id]}" d="${[part.outline, part.negative].filter(Boolean).join(' ')}"/>`,
  `    <path fill="${ink}" d="${part.details}"/>`,
].join('\n')).join('\n');
const svg = content => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BOT_BRAND_VIEW_BOX}" fill-rule="evenodd">\n  <title>DSH-Bot</title>\n${content}\n</svg>\n`;
const assets = [
  ['icon.svg', svg(`  <rect width="100" height="100" rx="25" fill="${ink}"/>\n  <g fill="#FFFFFF" transform="translate(5 8) scale(.9)">\n${mono}\n  </g>`)],
  ['assets/logo.svg', svg(`  <g>\n${color}\n  </g>`)],
  ['assets/logo-monochrome.svg', svg(`  <g fill="currentColor">\n${mono}\n  </g>`)],
];
await mkdir(resolve(root, 'packages/dsh-bot/assets'), { recursive: true });
for (const [name, content] of assets) {
  const file = resolve(root, 'packages/dsh-bot', name);
  await writeFile(file, content);
  console.log(file);
}
