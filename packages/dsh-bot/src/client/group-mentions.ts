export interface MentionTarget { id: string; name: string; botId: string }
export interface MentionBinding { start: number; end: number; text: string; memberId: string }
export function ignoredMentionPosition(text: string, position: number) {
  const prefix = text.slice(0, position), line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  return (prefix.match(/```/g)?.length ?? 0) % 2 === 1 || /^\s*>/.test(line) || (line.match(/`/g)?.length ?? 0) % 2 === 1;
}
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
/** Bound selections win over display names and never silently disappear into natural broadcast. */
export function resolveGroupMentions(text: string, targets: MentionTarget[], selected: string[] = [], bindings: MentionBinding[] = []) {
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('und');
  const memberIds = new Set<string>(), issues: Array<{ mention: string; reason: 'unknown' | 'ambiguous' }> = [];
  let unbound = text;
  for (const binding of bindings) {
    if (binding.start < 0 || text.slice(binding.start, binding.end) !== binding.text) continue;
    if (binding.memberId === 'everyone') for (const target of targets) memberIds.add(target.id);
    else if (targets.some(target => target.id === binding.memberId)) memberIds.add(binding.memberId);
    else issues.push({ mention: binding.text.slice(1), reason: 'unknown' });
    unbound = unbound.slice(0, binding.start) + ' '.repeat(binding.end - binding.start) + unbound.slice(binding.end);
  }
  const aliases = targets.flatMap(target => [target.name, target.botId].filter(Boolean).map(name => ({ target, name: normalize(name) }))).sort((a, b) => b.name.length - a.name.length);
  const input = normalize(unbound);
  for (const occurrence of input.matchAll(/(^|[\s(（，,。:：])@/gu)) {
    const start = occurrence.index + occurrence[0].length;
    if (ignoredMentionPosition(input, start - 1)) continue;
    if (/^everyone(?:$|[\s.,!?，。！？:;：；)）])/u.test(input.slice(start))) { for (const target of targets) memberIds.add(target.id); continue; }
    const matches = aliases.filter(alias => input.startsWith(alias.name, start) && /^(?:$|[\s.,!?，。！？:;：；)）])/u.test(input.slice(start + alias.name.length)));
    const longest = matches[0]?.name;
    const candidates = [...new Map(matches.filter(alias => alias.name === longest).map(alias => [alias.target.id, alias.target])).values()];
    const chosen = candidates.filter(target => selected.includes(target.id));
    if (candidates.length === 1 || chosen.length === 1) for (const target of chosen.length ? chosen : candidates) memberIds.add(target.id);
    else issues.push({ mention: longest ?? input.slice(start).match(/^[^\s.,!?，。！？:;：；)）]+/u)?.[0] ?? '', reason: candidates.length ? 'ambiguous' : 'unknown' });
  }
  return { memberIds: [...memberIds], issues };
}
