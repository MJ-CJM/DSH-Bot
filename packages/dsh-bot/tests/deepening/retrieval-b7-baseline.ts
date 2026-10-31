/** Frozen pre-B7 BM25 implementation. Never tuned with held-out results. */
import { defaultRetrievalConfig, type Config } from '../../src/host/memory/retrieval-config.js';
import { retrievalTerms } from '../../src/host/memory/retrieval-text.js';

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
  return scored.sort((a, b) => b.score - a.score || compare(a.row, b.row)).slice(0, limit).map(r => r.row);
}
