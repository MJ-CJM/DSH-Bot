import type { GroupMessage } from '../shared/groups.js';

/** Compact plaintext context, never a second Markdown rendering surface. */
export function groupMessagePreview(text: string | undefined, limit = 180) {
  return (text ?? '').replace(/```[\s\S]*?```/g, '…').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2').replace(/(?<![\p{L}\p{N}])([*_])(\S(?:.*?\S)?)\1(?![\p{L}\p{N}])/gu, '$2').replace(/(?:^|\n)\s{0,3}(?:#{1,6}|>|[-*+])\s+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function isLongGroupText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 240 || trimmed.split(/\r?\n/).filter(line => line.trim()).length >= 6;
}

export function isLongGroupReply(message: GroupMessage): boolean {
  if (!message.speaker || (message.authorKind && message.authorKind !== 'bot') ||
    message.failure || ['aborted', 'error', 'expert-request', 'refusal', 'max-tokens'].includes(message.stopReason ?? '')) return false;
  return isLongGroupText(message.text);
}

/** Select a line of the published answer itself; never include its quoted message or execution data. */
export function groupReplyPreview(text: string, quotedText?: string): string {
  const question = groupMessagePreview(quotedText);
  let firstLine = '', fence = '', afterConclusionHeading = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (fence) {
      if (line.startsWith(fence) && [...line].every(char => char === fence[0])) fence = '';
      continue;
    }
    const openingFence = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (openingFence) { fence = openingFence; continue; }
    if (!line || /^(?:>|\||【[^】]+】$|[-*_\s]{3,}$)/.test(line)) continue;
    const plain = groupMessagePreview(line);
    if (!plain || plain === question || /^【[^】]+】$/.test(plain)) continue;
    const conclusion = /^(?:结论|小结|总结|结论先行|conclusion|summary|tl;?dr)\s*[:：]\s*(.+)$/i.exec(plain);
    if (conclusion?.[1]) return conclusion[1];
    if (/^(?:结论|小结|总结|结论先行|conclusion|summary|tl;?dr)\s*[:：]?$/i.test(plain)) {
      afterConclusionHeading = true;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue;
    if (afterConclusionHeading) return plain;
    firstLine ||= plain;
  }
  return firstLine;
}
