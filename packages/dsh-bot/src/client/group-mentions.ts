import type { MentionBinding } from '../shared/group-mentions.js';
export { ignoredMentionPosition, resolveGroupMentions, type MentionBinding, type MentionTarget } from '../shared/group-mentions.js';

/** Keep identity only while its exact text survives an edit; ranges shift with adjacent edits. */
export function reconcileMentionBindings(before: string, after: string, bindings: MentionBinding[]) {
  let start = 0; while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length, nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  return bindings.map(binding => {
    if (binding.start < 0) {
      const restored = after.indexOf(binding.text);
      return restored >= 0 && !bindings.some(active => active !== binding && active.start === restored) ? { ...binding, start: restored, end: restored + binding.text.length } : binding;
    }
    const shifted = binding.end <= start ? binding : binding.start >= end ? { ...binding, start: binding.start + nextEnd - end, end: binding.end + nextEnd - end } : undefined;
    return shifted && after.slice(shifted.start, shifted.end) === shifted.text ? shifted : { ...binding, start: -1, end: -1 };
  });
}
