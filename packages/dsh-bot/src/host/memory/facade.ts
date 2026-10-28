import { randomUUID } from 'node:crypto';
import { sameBot, type BotKey } from '../../shared/identity.js';
import { memoryVersionSchema, payloadSchema, type MemoryPayload } from '../../shared/memory-v2.js';
import { memoryQuerySchema, memoryCreateSchema, memoryReviseSchema, memoryResolveSchema, memoryConfirmSchema,
  type MemoryQuery, type MemoryCreate, type MemoryRevise, type MemoryResolve, type MemoryConfirm } from '../../shared/memory-management.js';
import type { BotStore } from '../stores/bots.js';
import { DshBotError } from '../errors.js';
import { rejectMemorySecrets } from './secrets.js';
import type { MemoryKernel } from './op-log.js';
import { temporalFacts, type Fact } from './temporal.js';
import { adjudicate, factKey } from './conflicts.js';
import { rankFacts } from './query.js';
import { retiredShard } from './shards.js';

/** Management capability only. Not registered as a model tool or accepted from model arguments. */
export class MemoryManagement {
  constructor(readonly kernel: MemoryKernel, private readonly bots: BotStore, private readonly journalDays = 30) {}
  private check(revision: number) {
    if (this.kernel.seq !== revision) throw new DshBotError('bot/conflict', 'Memory changed; compare before saving');
  }
  private bot(id: string) {
    const bot = this.bots.get(id), key = { botId: bot.id, botCreatedAt: bot.createdAt };
    if (retiredShard(this.kernel, key)) throw new Error('Bot shard retired');
    return { bot, key };
  }
  private fact(id: string): Fact {
    const version = this.kernel.snapshot.versions.get(id);
    const payload = version && this.kernel.domain.table('payloads').get(version.contentRef);
    if (!version || !payload) throw new DshBotError('memory/not-found', 'Memory not found');
    return { version, payload };
  }
  query(input: MemoryQuery) {
    const f = memoryQuerySchema.parse(input), { key } = this.bot(f.botId);
    if (f.revision !== undefined) this.check(f.revision);
    const time = { at: f.at ?? Date.now(), recordedBefore: f.recordedBefore, commitBefore: f.commitBefore };
    let facts = temporalFacts(this.kernel, time);
    // Management's all-state view must expose a newly saved future revision for review/editing.
    // Current facts/context still choose the revision effective at the queried valid time.
    if (f.view === 'all' && f.recordedBefore === undefined && f.commitBefore === undefined) {
      facts = [...this.kernel.snapshot.versions.values()].map(version => {
        const payload = this.kernel.domain.table('payloads').get(version.contentRef);
        if (!payload) throw new Error('Memory payload missing');
        return { version, payload };
      });
    }
    const quarantine = new Set([...this.kernel.domain.table('migration_items').entries()]
      .filter(([, item]) => item.quarantine).map(([, item]) => item.memoryId));
    // Management can see quarantined orphans, but ordinary Bot views cannot see another Bot's private rows.
    const judged = f.scope === 'quarantine' ? facts.filter(r => quarantine.has(r.version.memoryId) && r.version.status === 'proposed')
      .map(r => ({ ...r, state: r.version.status })) : adjudicate(facts, time.at, key);
    let rows = judged.filter(r => f.scope === 'quarantine' || (r.version.scope === f.scope &&
      (f.view === 'all' || (f.view === 'facts' ? r.version.kind !== 'user_event' && r.state === 'active' :
        f.view === 'journal' ? r.version.kind === 'user_event' && r.state === 'active' :
          f.view === 'candidates' ? r.state === 'proposed' || r.version.trust === 'candidate' && r.state === 'active' : r.state === 'disputed'))));
    if (f.view === 'journal' && !f.query?.trim()) rows = rows.filter(r =>
      (r.payload.valid.from ?? r.version.recordedAt) >= time.at - this.journalDays * 86400000);
    rows = rankFacts(rows, f.query ?? '', Number.MAX_SAFE_INTEGER);
    const total = rows.length;
    if (f.cursor) {
      const index = rows.findIndex(r => r.version.memoryId === f.cursor);
      if (index < 0) throw new DshBotError('bot/conflict', 'Page changed'); rows = rows.slice(index + 1);
    }
    const limit = f.limit ?? 50, page = rows.slice(0, limit);
    return { revision: this.kernel.seq, total,
      ...(rows.length > limit ? { next: page.at(-1)?.version.memoryId } : {}),
      rows: page.map(r => ({ ...structuredClone(r), deletedBot: !this.bots.list().some(b =>
        sameBot({ botId: b.id, botCreatedAt: b.createdAt }, r.version.provenance.bot)) })) };
  }
  async create(input: MemoryCreate) {
    const f = memoryCreateSchema.parse(input); rejectMemorySecrets(f); this.check(f.expectedRevision);
    const { bot, key } = this.bot(f.botId), id = randomUUID();
    const { botId: _botId, scope: _scope, kind: _kind, expectedRevision: _revision, ...body } = f;
    const payload = payloadSchema.parse({ ...body, botSnapshot: { name: bot.name, avatar: bot.avatar,
      avatarColor: bot.avatarColor, avatarVariant: bot.avatarVariant }, ...(f.scope === 'private' ? { legacy: {
      id, botId: bot.id, kind: 'fact', tags: [], pinned: false, createdAt: Date.now(), updatedAt: Date.now(),
      source: { by: 'user', at: Date.now() },
    } } : {}) });
    const version = memoryVersionSchema.parse({ schemaVersion: 2, memoryId: id, versionId: randomUUID(), contentRef: randomUUID(),
      userScope: this.kernel.scope.scope.id, revision: 1, commitSeq: this.kernel.seq + 1, kind: f.kind,
      recordedAt: Date.now(), sourceRefs: [],
      provenance: { channel: 'management', bot: key },
      trust: 'user_confirmed', status: 'active', scope: f.scope,
      ...(f.scope === 'private' ? { ownerBotKey: key, shard: key } : { shard: 'user' }),
      labels: { readers: f.scope === 'shared' ? 'shared' : [key], originTrust: 'user_confirmed', sourceVersions: [],
        restrictions: ['no-egress'], grants: [] } });
    await this.write('accept', [{ version, payload }], f.expectedRevision); return id;
  }
  private revision(fact: Fact, patch: Partial<MemoryPayload>, changes: Record<string, unknown> = {}): Fact {
    const payload = payloadSchema.parse({ ...fact.payload, ...patch }); rejectMemorySecrets(payload);
    // The legacy DTO remains available to private tools/UI after explicit reassignment or revision.
    if (payload.legacy) payload.legacy = { ...payload.legacy,
      ...(changes.scope === 'private' && changes.ownerBotKey ? { botId: (changes.ownerBotKey as BotKey).botId } : {}),
      updatedAt: Math.max(Date.now(), payload.legacy.updatedAt + 1) };
    const base = { ...fact.version, ...changes };
    if (base.scope === 'shared') delete (base as { ownerBotKey?: BotKey }).ownerBotKey;
    const version = memoryVersionSchema.parse({ ...base,
      versionId: randomUUID(), contentRef: randomUUID(),
      revision: changes.memoryId && changes.memoryId !== fact.version.memoryId ? 1 : fact.version.revision + 1,
      commitSeq: this.kernel.seq + 1, recordedAt: Math.max(Date.now(), fact.version.recordedAt + 1),
      sourceRefs: [...fact.version.sourceRefs, { parentVersionId: fact.version.versionId }] });
    return { version, payload };
  }
  async revise(input: MemoryRevise) {
    const f = memoryReviseSchema.parse(input); this.check(f.expectedRevision);
    const old = this.fact(f.id);
    if (old.version.status === 'proposed' && [...this.kernel.domain.table('migration_items').entries()]
      .some(([, item]) => item.quarantine && item.memoryId === f.id)) throw new Error('Assign this legacy item explicitly first');
    const row = this.revision(old, f.patch, { trust: 'user_confirmed', status: 'active',
      labels: { ...old.version.labels, originTrust: 'user_confirmed' } });
    await this.write('revise', [row], f.expectedRevision);
  }
  async confirm(input: MemoryConfirm) {
    const f = memoryConfirmSchema.parse(input); this.check(f.expectedRevision);
    const old = this.fact(f.id), { bot, key } = this.bot(f.botId);
    if (f.scope === 'shared' && old.version.status === 'proposed' && [...this.kernel.domain.table('migration_items').entries()]
      .some(([, item]) => item.quarantine && item.memoryId === f.id)) throw new Error('Assign this legacy item privately first');
    if (old.version.labels.restrictions.includes('secret') && f.scope === 'shared') throw new Error('Secret cannot be shared');
    if (old.version.scope === 'shared' && f.scope === 'private') throw new Error('Shared facts require an explicit new private copy');
    const promotion = old.version.scope === 'private' && f.scope === 'shared';
    if (promotion && old.version.scope === 'private' && retiredShard(this.kernel, old.version.ownerBotKey))
      throw new Error('Retired Bot cannot publish new contributions');
    const source = this.bots.list().find(b => sameBot({ botId: b.id, botCreatedAt: b.createdAt }, old.version.provenance.bot));
    const botSnapshot = old.payload.botSnapshot ?? (source ? {
      name: source.name, avatar: source.avatar, avatarColor: source.avatarColor, avatarVariant: source.avatarVariant,
    } : { name: old.version.provenance.bot.botId });
    const row = this.revision(old, {
      ...(promotion ? { legacy: undefined, sourceExcerpt: undefined, confirmation: undefined } : {}),
      botSnapshot: f.scope === 'shared' ? botSnapshot : { name: bot.name, avatar: bot.avatar,
      avatarColor: bot.avatarColor, avatarVariant: bot.avatarVariant } }, { scope: f.scope, trust: 'user_confirmed', status: 'active',
      ...(f.scope === 'private' ? { ownerBotKey: key, shard: key } : { ownerBotKey: undefined,
        shard: old.version.scope === 'private' ? old.version.ownerBotKey : old.version.shard }),
      ...(promotion ? { memoryId: randomUUID(), revision: 1 } : {}),
      provenance: f.scope === 'shared' ? old.version.provenance : { channel: 'management', bot: key },
      labels: { ...old.version.labels, readers: f.scope === 'shared' ? 'shared' : [key], originTrust: 'user_confirmed',
        sourceVersions: [...old.version.labels.sourceVersions, old.version.versionId], grants: [] } });
    // Strict union must not receive the private-only owner key when promoting.
    await this.write(promotion ? 'promote' : 'accept', [row], f.expectedRevision); return row.version.memoryId;
  }
  async resolve(input: MemoryResolve) {
    const f = memoryResolveSchema.parse(input); this.check(f.expectedRevision);
    const rows = f.ids.map(id => this.fact(id)), first = rows[0];
    if (!first || !factKey(first) || rows.some(r => factKey(r) !== factKey(first) || r.version.scope !== first.version.scope ||
      r.version.scope === 'private' && first.version.scope === 'private' && !sameBot(r.version.ownerBotKey, first.version.ownerBotKey)))
      throw new Error('Resolve only one fact in one permission domain');
    const revised = rows.map(row => this.revision(row,
      f.choice === 'coexist' ? { qualifiers: f.qualifiers?.find(q => q.id === row.version.memoryId)?.values } : {},
      { status: f.choice === 'reject' || f.choice === 'select' && row.version.memoryId !== f.selected ? 'rejected' : 'active',
        trust: 'user_confirmed', labels: { ...row.version.labels, originTrust: 'user_confirmed' } }));
    await this.write('resolve', revised, f.expectedRevision);
  }
  private async write(kind: 'accept' | 'revise' | 'promote' | 'resolve', rows: Fact[], expectedRevision: number) {
    const opId = randomUUID();
    const versions = rows.map(r => ({ ...r.version, sourceRefs: [...r.version.sourceRefs, { managementOpId: opId }] }));
    await this.kernel.commit({ opId, kind, subjectIds: rows.map(r => r.version.memoryId),
      expectedRevision, forgetEpoch: this.kernel.epoch, versions,
      payloads: Object.fromEntries(rows.map(r => [r.version.contentRef, r.payload])) });
  }
}
