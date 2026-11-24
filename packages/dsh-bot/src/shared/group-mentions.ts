export interface MentionTarget { id: string; name: string; botId: string }
export interface MentionBinding { start: number; end: number; text: string; memberId: string }
export function ignoredMentionPosition(text: string, position: number) {
  const prefix = text.slice(0, position), line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  return (prefix.match(/```/g)?.length ?? 0) % 2 === 1 || /^\s*>/.test(line) || (line.match(/`/g)?.length ?? 0) % 2 === 1;
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
  const repeated = new Map<string, { occurrences: number; selected: MentionTarget[] }>();
  for (const occurrence of input.matchAll(/(^|[\s(（，,。:：])@/gu)) {
    const start = occurrence.index + occurrence[0].length;
    if (ignoredMentionPosition(input, start - 1)) continue;
    if (/^everyone(?:$|[\s.,!?，。！？:;：；)）])/u.test(input.slice(start))) { for (const target of targets) memberIds.add(target.id); continue; }
    const matches = aliases.filter(alias => input.startsWith(alias.name, start) && /^(?:$|[\s.,!?，。！？:;：；)）])/u.test(input.slice(start + alias.name.length)));
    const longest = matches[0]?.name;
    const candidates = [...new Map(matches.filter(alias => alias.name === longest).map(alias => [alias.target.id, alias.target])).values()];
    const chosen = candidates.filter(target => selected.includes(target.id));
    if (candidates.length === 1 || chosen.length === 1) for (const target of chosen.length ? chosen : candidates) memberIds.add(target.id);
    else if (longest && chosen.length > 1) {
      const group = repeated.get(longest);
      if (group) group.occurrences++;
      else repeated.set(longest, { occurrences: 1, selected: chosen });
    }
    else issues.push({ mention: longest ?? input.slice(start).match(/^[^\s.,!?，。！？:;：；)）]+/u)?.[0] ?? '', reason: candidates.length ? 'ambiguous' : 'unknown' });
  }
  // Submitted requests carry distinct selected IDs, without the editor's per-occurrence bindings.
  for (const [mention, group] of repeated) {
    if (group.occurrences < group.selected.length) issues.push({ mention, reason: 'ambiguous' });
    else for (const target of group.selected) memberIds.add(target.id);
  }
  return { memberIds: [...memberIds], issues };
}
