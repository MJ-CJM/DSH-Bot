import { ACTIVITY_PREVIEW_MAX_CHARS } from '../../shared/activity.js';
import { DshBotError } from '../errors.js';
import { rejectMemorySecrets } from '../memory/secrets.js';

export const ACTIVITY_HIDDEN_PREVIEW = '[已隐藏]';

function hasSecret(text: string): boolean {
  try { rejectMemorySecrets({ content: text }); return false; }
  catch (error) {
    if (error instanceof DshBotError && error.code === 'memory/rejected') return true;
    throw error;
  }
}

/** Full text is screened before markdown removal/truncation, and again after
 * cleanup so formatting cannot split a credential signature across markup.
 * No original text or rejection details leave this function.
 */
export function createActivityPreview(text: string): string {
  if (hasSecret(text)) return ACTIVITY_HIDDEN_PREVIEW;
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
  if (hasSecret(plain)) return ACTIVITY_HIDDEN_PREVIEW;
  const points = [...plain];
  return points.length <= ACTIVITY_PREVIEW_MAX_CHARS ? plain
    : `${points.slice(0, ACTIVITY_PREVIEW_MAX_CHARS - 1).join('')}…`;
}
