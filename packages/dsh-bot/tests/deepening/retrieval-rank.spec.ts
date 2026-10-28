import { Config } from '../../src/host/registry-config.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import aliases from '../../src/host/memory/retrieval-aliases.json';
import { normalizeRetrieval, retrievalTerms } from '../../src/host/memory/retrieval-text.js';
import { rankFacts } from '../../src/host/memory/query.js';
import type { SearchPayload } from '../../src/host/memory/retrieval-rank.js';
import split from './retrieval-split.json';
const row = (id: string, payload: SearchPayload, seq = 1) => ({ payload, version: { memoryId: id, commitSeq: seq } });

describe('B5s bounded vocabulary, normalization and ranking regression', () => {
  it('keeps the pre-tuning supplement and split immutable and stratified', async () => {
    const bytes = await readFile(new URL('./retrieval-extra.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(split.supplementSha256);
    for (const [category, group] of Object.entries(split.categories)) {
      expect(group.tune).toHaveLength(7); expect(group['held-out']).toHaveLength(5);
      for (const ids of Object.values(group)) for (const id of ids) expect(id).toContain(category);
      const ordered = [...group.tune, ...group['held-out']].sort((a, b) => {
        const hash = (id: string) => createHash('sha256').update(`${split.seed}:${category}:${id}`).digest('hex');
        return hash(a).localeCompare(hash(b));
      });
      expect(ordered.slice(0, 7)).toEqual(group.tune); expect(ordered.slice(7)).toEqual(group['held-out']);
    }
  });
  it('bounds and reviews ordinary lexical data, with no stored/query-specific phrases', () => {
    expect(aliases.groups.length).toBeLessThanOrEqual(64);
    expect(aliases.maxGroups).toBe(64); expect(aliases.maxTermsPerGroup).toBe(12);
    const terms = aliases.groups.flat();
    expect(terms.length).toBeLessThanOrEqual(512); expect(new Set(terms).size).toBe(terms.length);
    expect(aliases.stopWords.length).toBeLessThanOrEqual(128);
    for (const group of aliases.groups) {
      expect(group.length).toBeGreaterThanOrEqual(2); expect(group.length).toBeLessThanOrEqual(12);
      for (const term of group) {
        expect(normalizeRetrieval(term)).toBe(term);
        expect(term.length).toBeLessThanOrEqual(24);
        expect(term).not.toMatch(/\s/);
        // No 4-character CJK spans or multiword English query phrases in the dictionary.
        if (/\p{Script=Han}/u.test(term)) expect([...term].length).toBeLessThanOrEqual(3);
      }
    }
  });
  it('exports validated Host configuration and applies field-weight overrides', () => {
    const config = Config({ memoryRetrieval: { factKeyWeight: 0, qualifierWeight: 0 } });
    expect(config.memoryRetrieval).toMatchObject({ k1: 1.2, factKeyWeight: 0, qualifierWeight: 0 });
    for (const patch of [{ k1: 0 }, { bodyB: 2 }, { minCoverage: 0 }, { subjectWeight: Infinity }])
      expect(() => Config({ memoryRetrieval: patch })).toThrow();
    const docs = [row('key', { content: 'Tuesday', factKey: 'availability' })];
    expect(rankFacts(docs, 'availability', 5)).toHaveLength(1);
    expect(rankFacts(docs, 'availability', 5, config.memoryRetrieval)).toEqual([]);
  });
  it('normalizes NFKC, case, punctuation and full width, while preserving literal numbers', () => {
    expect(normalizeRetrieval(' ＡＢＣ，FooBar！１２３ ')).toBe('abc foo bar 123');
    const docs = [row('full', { content: 'Visual studio code costs 123 dollars' }), row('other', { content: 'banana' })];
    expect(rankFacts(docs, 'ＶＩＳＵＡＬ—ＳＴＵＤＩＯ…ＣＯＤＥ')[0]?.version.memoryId).toBe('full');
    expect(rankFacts(docs, '123')[0]?.version.memoryId).toBe('full');
    expect(rankFacts(docs, 'unobserved jargon')).toEqual([]);
    expect(rankFacts(docs, 'the please')).toEqual([]);
  });
  it('matches compound CJK aliases and paraphrases without an all-token gate', () => {
    const docs = [row('bike', { content: '雨天乘地铁，晴天骑自行车' }), row('book', { content: '科幻故事' })];
    expect(rankFacts(docs, 'bike')[0]?.version.memoryId).toBe('bike');
    expect(rankFacts(docs, '科学幻想')[0]?.version.memoryId).toBe('book');
    expect([...retrievalTerms('电子信箱')].some(([t]) => t.startsWith('@'))).toBe(true);
  });
  it('weights fact keys and qualifier keys/values, and does not use provenance or receipt text', () => {
    const docs = [row('body', { content: 'availability' }),
      row('key', { content: 'Tuesday', factKey: 'availability', qualifiers: { project: 'orbital' } })];
    expect(rankFacts(docs, 'availability')[0]?.version.memoryId).toBe('key');
    expect(rankFacts(docs, 'orbital').map(r => r.version.memoryId)).toEqual(['key']);
    expect(rankFacts(docs, 'project').map(r => r.version.memoryId)).toEqual(['key']);
  });
  it('does not reuse stale lexical data after mutations, and preserves stable empty-query ordering', () => {
    const payload = { content: 'uniqueApple' }, docs = [row('b', payload), row('a', { content: 'uniquePear' })];
    expect(rankFacts(docs, 'apple').map(r => r.version.memoryId)).toEqual(['b']);
    payload.content = 'uniqueMango';
    expect(rankFacts(docs, 'apple')).toEqual([]);
    expect(rankFacts(docs, 'mango').map(r => r.version.memoryId)).toEqual(['b']);
    expect(rankFacts(docs, '').map(r => r.version.memoryId)).toEqual(['a', 'b']);
  });
  it('does not return a generic suffix as evidence for a two-term specific search', () => {
    const docs = [row('old', { content: 'OLD_JOURNAL' }), row('new', { content: 'RECENT_JOURNAL' })];
    expect(rankFacts(docs, 'OLD_JOURNAL').map(r => r.version.memoryId)).toEqual(['old']);
  });
  it('diversifies repeated evidence without deleting facts or changing numeric-query order', () => {
    const docs = [row('fact', { content: 'I take the train for travel', factKey: 'commute' }, 1),
      ...Array.from({ length: 6 }, (_, i) => row(`catalog-${i}`, { content: `train catalogue listing ${i}` }, i + 2))];
    const ranked = rankFacts(docs, 'train', 20);
    expect(ranked.slice(0, 5).some(r => r.version.memoryId === 'fact')).toBe(true);
    expect(new Set(ranked.map(r => r.version.memoryId)).size).toBe(docs.length);
    const disabled = { ...Config({}).memoryRetrieval, diversityPenalty: 0 };
    expect(rankFacts(docs, 'train 3', 20)).toEqual(rankFacts(docs, 'train 3', 20, disabled));
    expect(() => Config({ memoryRetrieval: { diversityWindow: 4 } })).toThrow();
  });
});
