import { defaultRetrievalConfig, type Config } from './retrieval-config.js';
import { retrievalTerms } from './retrieval-text.js';

export interface SearchPayload {
  content: string; subject?: string; factKey?: string; qualifiers?: Record<string, string>;
}
interface Field { terms: Map<string, number>; length: number; weight: number }
// Weak keys cannot retain forgotten payloads. Revisions receive new payloads; mutable callers are validated by stamp.
const documents = new WeakMap<SearchPayload, { stamp: string; fields: Field[] }>();
function fields(payload: SearchPayload, config: Config): Field[] {
  const values = [payload.content, payload.factKey ?? '', Object.entries(payload.qualifiers ?? {}).flat().join(' '),
    payload.subject ?? ''];
  const stamp = JSON.stringify([values, config]), cached = documents.get(payload);
  if (cached?.stamp === stamp) return cached.fields;
  const weights = [1, config.factKeyWeight, config.qualifierWeight, config.subjectWeight];
  const encoded = values.map((value, index) => {
    const terms = retrievalTerms(value);
    return { terms, length: Math.max(1, [...terms.values()].reduce((a, b) => a + b, 0)), weight: weights[index] ?? 1 };
  });
  documents.set(payload, { stamp, fields: encoded }); return encoded;
}
export interface SearchRow { payload: SearchPayload; version: { memoryId: string; commitSeq: number } }
/** BM25 per field with soft token matching. Caller must supply only authorized, time-filtered rows. */
export function retrievalRank<T extends SearchRow>(rows: readonly T[], query: string, limit = 200,
  config: Config = defaultRetrievalConfig): T[] {
  const compare = (a: T, b: T) => b.version.commitSeq - a.version.commitSeq ||
    a.version.memoryId.localeCompare(b.version.memoryId);
  if (!query.trim()) return [...rows].sort(compare).slice(0, limit);
  const terms = retrievalTerms(query);
  if (!terms.size) return [];
  const docs = rows.map(row => ({ row, fields: fields(row.payload, config) }));
  const averages = [0, 1, 2, 3].map(i => docs.reduce((sum, d) => sum + (d.fields[i]?.length ?? 0), 0) / Math.max(1, docs.length));
  const dfs = new Map([...terms.keys()].map(t => [t, docs.filter(d => d.fields.some(f => f.terms.has(t))).length]));
  const observedTerms = [...dfs.values()].filter(df => df > 0).length;
  const scored = docs.map(({ row, fields: fs }) => {
    let score = 0, covered = 0;
    for (const [term, weight] of terms) {
      let contribution = 0;
      for (const [index, field] of fs.entries()) {
        const tf = field.terms.get(term) ?? 0;
        // Lower body normalization avoids rewarding short navigation/catalogue fragments over full facts.
        const b = index === 0 ? config.bodyB : config.fieldB, k1 = config.k1;
        contribution += field.weight * tf * (k1 + 1) /
          (tf + k1 * (1 - b + b * field.length / Math.max(1, averages[index] ?? 1)));
      }
      if (contribution) covered++;
      const df = dfs.get(term) ?? 0;
      score += Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) * contribution * Math.min(1, weight);
    }
    // Prefer broader evidence coverage; no all-token gate, phrase requirement or permission expansion.
    score *= 0.5 + 0.5 * covered / terms.size;
    // Unknown wording must not be a hard AND gate. Among terms actually present in this view,
    // require a majority, so OLD_JOURNAL does not also return RECENT_JOURNAL on the generic tail alone.
    return { row, score: covered >= observedTerms * config.minCoverage ? score : 0 };
  }).filter(r => r.score > 0);
  scored.sort((a, b) => b.score - a.score || compare(a.row, b.row));
  // Bound reranking cost independently of the requested page size. Preserve every fact, including numeric variants.
  // Numeric queries retain exact BM25 ordering; diversity is for ambiguous broad searches.
  if (!config.diversityPenalty || /\p{N}/u.test(query)) return scored.slice(0, limit).map(r => r.row);
  const pending = scored.slice(0, config.diversityWindow).map(item => ({ ...item,
    body: new Set(fields(item.row.payload, config)[0]?.terms.keys()), similarity: 0 }));
  const selected: T[] = [];
  while (pending.length) {
    let best = 0;
    const adjusted = (index: number) => {
      const item = pending[index];
      return item ? item.score * (1 - config.diversityPenalty * item.similarity) : -Infinity;
    };
    for (let i = 1; i < pending.length; i++) if (adjusted(i) > adjusted(best)) best = i;
    const item = pending.splice(best, 1)[0]; if (!item) break;
    selected.push(item.row);
    for (const candidate of pending) {
      let common = 0; for (const term of item.body) if (candidate.body.has(term)) common++;
      const overlap = common / Math.max(1, Math.min(item.body.size, candidate.body.size));
      if (overlap >= config.diversityThreshold) candidate.similarity = Math.max(candidate.similarity, overlap);
    }
  }
  return [...selected, ...scored.slice(config.diversityWindow).map(r => r.row)].slice(0, limit);
}
