export interface MentionTarget {
  id: string;
  name: string;
  botId: string;
}
/** Display text resolves only against the current membership snapshot, never arbitrary Bot IDs. */
export function resolveGroupMentions(text: string, targets: MentionTarget[], selected: string[] = []) {
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('und');
  const input = normalize(text);
  const aliases = targets.flatMap((target) =>
    [target.name, target.botId].filter((name) => name.trim()).map((name) => ({ target, name: normalize(name) })),
  );
  aliases.sort((a, b) => b.name.length - a.name.length);
  const memberIds = new Set(selected.filter((id) => targets.some((target) => target.id === id)));
  const issues: Array<{ mention: string; reason: 'unknown' | 'ambiguous' }> = [];
  const starts = /(^|[\s(（])@/gu;
  for (const occurrence of input.matchAll(starts)) {
    const start = occurrence.index + occurrence[0].length;
    const matches = aliases.filter(
      (alias) =>
        input.startsWith(alias.name, start) &&
        /^(?:$|[\s.,!?，。！？:;：；)）])/u.test(input.slice(start + alias.name.length)),
    );
    const longest = matches[0]?.name;
    const candidates = [
      ...new Map(
        matches.filter((alias) => alias.name === longest).map((alias) => [alias.target.id, alias.target]),
      ).values(),
    ];
    const chosen = candidates.filter((target) => selected.includes(target.id));
    if (candidates.length === 1 || (candidates.length > 1 && chosen.length === 1)) {
      for (const target of chosen.length ? chosen : candidates) memberIds.add(target.id);
    } else {
      issues.push({
        mention: longest ?? input.slice(start).match(/^[^\s.,!?，。！？:;：；)）]+/u)?.[0] ?? '',
        reason: candidates.length ? 'ambiguous' : 'unknown',
      });
    }
  }
  return { memberIds: [...memberIds], issues: [...new Map(issues.map((issue) => [issue.mention, issue])).values()] };
}
