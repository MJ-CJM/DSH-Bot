import { MemoryLineage } from '../data-flow/lineage.js';
import { mergeLabels } from '../data-flow/labels.js';
import { randomUUID } from 'node:crypto';
import { sameBot, type BotKey } from '../../shared/identity.js';
import { memoryAddSchema, memoryPatchSchema, memoryListOptionsSchema, memorySchema, normalizeMemoryContent,
  type MemoryAddInput, type MemoryRecord, type MemoryPatch, type MemoryListOptions } from '../../shared/schema.js';
import { parseInput } from '../errors.js';
import { missingMemory, nextTimestamp, missingBot, compareId } from '../stores/domain.js';
import { lexicalMemorySearch } from '../stores/memory.js';
import type { BotStore } from '../stores/bots.js';
import type { MemoryKernel } from './op-log.js';
import { readableFacts, rankFacts } from './query.js';
import { privateVersion } from './version.js';

const compare = (a: { id: string; pinned: boolean; updatedAt: number }, b: typeof a) =>
  Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || compareId(a.id, b.id);
export class V2MemoryStore {
  constructor(readonly kernel: MemoryKernel, private readonly bots: BotStore,
    private readonly queue = { tail: Promise.resolve() as Promise<unknown> }, private readonly bound?: BotKey) {}
  forBot(botId: string): V2MemoryStore { return new V2MemoryStore(this.kernel, this.bots, this.queue, this.owner(botId)); }
  captureEpoch(): number { return this.kernel.epoch; }
  assertEpoch(epoch: number): void { this.kernel.assertReadable(); if (epoch !== this.kernel.epoch) throw new Error('Stale memory epoch'); }
  private owner(botId: string): BotKey {
    const bot = this.bots.get(botId);
    const key = { botId, botCreatedAt: bot.createdAt };
    if (this.bound && !sameBot(this.bound, key)) throw missingBot(botId);
    return key;
  }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const epoch = this.captureEpoch();
    const result = this.queue.tail.then(() => { this.assertEpoch(epoch); return work(); });
    this.queue.tail = result.catch(() => {}); return result;
  }
  private compare = (a: { id: string; pinned: boolean; updatedAt: number }, b: typeof a): number => {
    const sourceId = (id: string) => {
      const v = this.kernel.snapshot.versions.get(id);
      return v && this.kernel.domain.table('payloads').get(v.contentRef)?.legacy?.id || id;
    };
    return compare({ ...a, id: sourceId(a.id) }, { ...b, id: sourceId(b.id) });
  };
  /** Read-only legacy DTO. Host version/provenance fields never enter the old Remote/tool contract. */
  records(botId: string): MemoryRecord[] {
    const owner = this.owner(botId), rows: MemoryRecord[] = [];
    for (const v of this.kernel.snapshot.versions.values()) {
      if (v.scope !== 'private' || !sameBot(v.ownerBotKey, owner) || v.status !== 'active') continue;
      if (v.labels.readers === 'shared' || !v.labels.readers.some(reader => sameBot(reader, owner)) ||
        v.labels.restrictions.some(r => r === 'revoked' || r === 'pending-cleanup')) continue;
      const payload = this.kernel.domain.table('payloads').get(v.contentRef);
      if (payload?.legacy) rows.push(memorySchema.parse({ ...payload.legacy, id: v.memoryId, content: payload.content }));
    }
    return rows.sort(this.compare);
  }
  listByBot(botId: string, options: MemoryListOptions): MemoryRecord[] {
    const f = parseInput(memoryListOptionsSchema, options);
    return this.records(botId).filter(r => (f.pinned === undefined || r.pinned === f.pinned) &&
      (f.tag === undefined || r.tags.includes(f.tag)) && (!f.query || lexicalMemorySearch.matches(r, f.query)) &&
      (!f.before || this.compare(r, f.before) > 0)).slice(0, f.limit);
  }
  readableByBot(botId: string, options: MemoryListOptions): (MemoryRecord & { scope?: 'private' | 'shared' })[] {
    const f = parseInput(memoryListOptionsSchema, options), owner = this.owner(botId);
    const facts = readableFacts(this.kernel, owner, { at: Date.now() });
    return rankFacts(facts, f.query ?? '', 10000, this.kernel.retrievalConfig).flatMap(({ version: v, payload: p }) => {
      const record = p.legacy ? memorySchema.parse({ ...p.legacy, id: v.memoryId, content: p.content, botId }) : memorySchema.parse({
        id: v.memoryId, botId, content: p.content, kind: 'fact', tags: [], pinned: false,
        createdAt: v.recordedAt, updatedAt: v.recordedAt,
      });
      if (f.tag !== undefined && !record.tags.includes(f.tag) || f.pinned !== undefined && record.pinned !== f.pinned) return [];
      return [{ ...record, ...(v.scope === 'shared' ? { scope: 'shared' as const } : {}) }];
    }).slice(0, f.limit);
  }
  countByBot(botId: string): number { return this.records(botId).length; }
  async add(input: MemoryAddInput): Promise<MemoryRecord> { return (await this.persist(input, false)).record; }
  async saveUnique(input: MemoryAddInput, signal?: AbortSignal) {
    const result = await this.persist(input, true, signal);
    return { id: result.record.id, deduplicated: result.deduplicated };
  }
  private persist(input: MemoryAddInput, deduplicate: boolean, signal?: AbortSignal) {
    const fields = parseInput(memoryAddSchema, input);
    return this.mutate(async () => {
      signal?.throwIfAborted();
      const owner = this.owner(fields.botId);
      const previous = deduplicate ? this.records(fields.botId).filter(r =>
        normalizeMemoryContent(r.content) === normalizeMemoryContent(fields.content))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0] : undefined;
      const record = memorySchema.parse(previous ? { ...previous, tags: [...new Set([...previous.tags, ...fields.tags])],
        pinned: previous.pinned || fields.pinned, updatedAt: nextTimestamp(previous.updatedAt) }
        : { ...fields, id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now() });
      await this.put(record, owner);
      return { record, deduplicated: !!previous };
    });
  }
  private async put(record: MemoryRecord, owner: BotKey): Promise<void> {
    const previous = this.kernel.snapshot.versions.get(record.id);
    const { version, payload } = privateVersion(this.kernel, record, owner, { memoryId: record.id,
      versionId: randomUUID(), contentRef: randomUUID(), revision: (previous?.revision ?? 0) + 1 },
      record.source?.by === 'model' ? 'model' : 'management');
    if (previous) {
      version.labels = mergeLabels(version.labels, previous.labels);
      version.labels.sourceVersions = [...new Set([...version.labels.sourceVersions, previous.versionId])];
      version.sourceRefs = [...previous.sourceRefs, ...version.sourceRefs, { parentVersionId: previous.versionId }];
    }
    if (record.source?.by === 'model' && record.source.sessionId) {
      const lineage = new MemoryLineage(this.kernel), seen = lineage.seen(record.source.sessionId);
      if (seen.length) version.labels = mergeLabels(version.labels, lineage.label(seen));
    }
    await this.kernel.commit({ opId: randomUUID(), kind: previous ? 'revise' : 'propose', subjectIds: [record.id],
      expectedRevision: this.kernel.seq, forgetEpoch: this.kernel.epoch, versions: [version], payloads: { [version.contentRef]: payload } });
  }
  async update(botId: string, id: string, patch: MemoryPatch): Promise<MemoryRecord> {
    const fields = parseInput(memoryPatchSchema, patch);
    return this.mutate(async () => {
      const record = this.records(botId).find(r => r.id === id);
      if (!record) throw missingMemory();
      const updated = memorySchema.parse({ ...record, ...fields, updatedAt: nextTimestamp(record.updatedAt) });
      await this.put(updated, this.owner(botId)); return updated;
    });
  }
  async remove(botId: string, id: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.records(botId).some(r => r.id === id)) throw missingMemory();
      await this.forget([id]);
    });
  }
  private async forget(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.kernel.commit({ opId: randomUUID(), kind: 'forget', subjectIds: ids,
      expectedRevision: this.kernel.seq, forgetEpoch: this.kernel.epoch + 1 });
  }
  async removeByBot(botId: string): Promise<number> {
    return this.mutate(async () => {
      const owner = this.owner(botId);
      const ids = [...this.kernel.snapshot.versions.values()]
        .filter(v => v.scope === 'private' && sameBot(v.ownerBotKey, owner)).map(v => v.memoryId);
      await this.forget(ids); return ids.length;
    });
  }
}
