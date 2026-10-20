import { ACTIVITY_HIDDEN_PREVIEW, ACTIVITY_PREVIEW_MAX_CHARS } from './activity.js';
import { hasCredential } from './secrets.js';

/** Full text is screened before markdown removal/truncation, and again after
 * cleanup so formatting cannot split a credential signature across markup.
 * No original text or rejection details leave this function.
 */
export function createActivityPreview(text: string): string {
  if (hasCredential(text)) return ACTIVITY_HIDDEN_PREVIEW;
  const plain = text
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/gu, '$1 ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/!\[[^\]]*\](?:\[[^\]]*\])?/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]*>/gu, '')
    .replace(/(?:^|\n)[ \t]*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gu, ' ')
    .replace(/(\*{1,2}|~~)(?=\S)([\s\S]*?\S)\1/gu, '$2')
    // Intraword underscores are ordinary text (identifiers, paths, etc.).
    .replace(/(?<![\p{L}\p{N}_])(_{1,2})(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}_])/gu, '$2')
    .replace(/`+([^`]+)`+/gu, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gu, (entity) => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    })[entity] ?? entity)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  if (hasCredential(plain)) return ACTIVITY_HIDDEN_PREVIEW;
  const points = [...plain];
  return points.length <= ACTIVITY_PREVIEW_MAX_CHARS ? plain
    : `${points.slice(0, ACTIVITY_PREVIEW_MAX_CHARS - 1).join('')}…`;
}
