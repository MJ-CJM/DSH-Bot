import aliases from './retrieval-aliases.json' with { type: 'json' };

export const normalizeRetrieval = (text: string): string => text.normalize('NFKC').replace(/([\p{Ll}])([\p{Lu}])/gu, '$1 $2').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stops = new Set(aliases.stopWords);
const concepts = new Map(aliases.groups.flatMap((group, id) => group.map(term => [term, `@${id}`] as const)));

/** Local vocabulary only: bounded, reviewable data; never learns from queries or stored memories. */
export function retrievalTerms(input: string): Map<string, number> {
  const text = normalizeRetrieval(input), terms = new Map<string, number>();
  const add = (term: string, weight = 1) => {
    if (stops.has(term)) return;
    terms.set(term, (terms.get(term) ?? 0) + weight);
    const concept = concepts.get(term);
    if (concept) terms.set(concept, Math.max(terms.get(concept) ?? 0, 0.8));
  };
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike || stops.has(segment)) continue;
    add(segment);
    const chars = [...segment];
    if (/^\p{Script=Han}+$/u.test(segment) && chars.length > 2)
      for (let i = 0; i < chars.length - 1; i++) add(chars.slice(i, i + 2).join(''), 0.5);
  }
  // Word boundaries differ for compounds such as 黑咖啡/电子信箱. Match CJK aliases within compounds too.
  for (const [term, concept] of concepts) if (/\p{Script=Han}/u.test(term) && text.includes(term))
    terms.set(concept, Math.max(terms.get(concept) ?? 0, 0.8));
  return terms;
}
