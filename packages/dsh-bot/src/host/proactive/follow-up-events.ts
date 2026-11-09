import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { DshBotRegistry } from '../registry.js';
import type { GroupFactPage } from '../groups/service.js';
import type { GroupKey } from '../../shared/groups.js';
import {
  followUpFactSchema, followUpIngestSchema, subjectKey, type FollowUpFact, type FollowUpPolicy, type Subject,
} from '../../shared/proactive/follow-up.js';
import { groupFollowUpFact } from './follow-up-facts.js';
import type { ProactiveService } from './service.js';

declare module '@deepseek-ai/cordis' {
  interface Context { dshBotFollowUpEvents: FollowUpEvents }
}
type GroupJob = { kind: 'group'; subject: Extract<Subject, { kind: 'group' }>; turnId?: string; page?: GroupFactPage };
type BotSubject = Extract<Subject, { kind: 'bot' }>;
type ParentJob = { kind: 'parent'; subject: BotSubject; parent: string; offset?: number;
  catalog?: { rows: readonly { id: string; createdAt: number }[]; offset: number } };
type ChildJob = { kind: 'child'; subject: BotSubject; parent: string; child: string; createdAt: number;
  scan?: { from: number; offset: number; pauseEpoch: number; descriptor?: number; title?: string; latest?: FollowUpFact } };
type Job = GroupJob | ParentJob | ChildJob | { kind: 'work'; subject: Subject };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const generation = (subject: Subject) => subject.kind === 'bot' ? subject.bot.botCreatedAt : subject.group.groupCreatedAt;

/** Uses the existing proactive maintenance tick. Event callbacks only coalesce
 * authoritative objects; no model, timer, transcript classification or Agent activation. */
export class FollowUpEvents {
  private policies = new Map<string, FollowUpPolicy>();
  private parents = new Map<string, Extract<Subject, { kind: 'bot' }>>();
  private urgent = new Map<string, Job>();
  private background = new Map<string, Job>();
  private dirty = new Map<string, Subject>();
  private refreshing = true;
  private forceBaseline = true;
  private refreshRevision = 0;
  private policyCursor?: string;
  private loadingPolicies = new Map<string, FollowUpPolicy>();
  private stopped = false;
  private flight?: Promise<void>;
  private abort = new AbortController();
  constructor(private ctx: Context, private registry: DshBotRegistry) {}
  reset(forceBaseline = true) {
    this.refreshing = true;
    this.forceBaseline ||= forceBaseline;
    this.refreshRevision++;
    this.policyCursor = undefined;
    this.loadingPolicies.clear();
  }
  private enqueue(job: Job, urgent = false) {
    const scope = subjectKey(job.subject);
    const target = job.kind === 'child' ? [job.child, job.createdAt] : job.kind === 'parent' ? job.parent : job.kind === 'group' ? job.turnId : undefined;
    const key = hash([scope, job.kind, target]);
    const existing = this.urgent.get(key) ?? this.background.get(key);
    if (!existing && this.urgent.size + this.background.size >= 512) {
      this.dirty.set(scope, job.subject);
      return;
    }
    const queue = urgent || this.urgent.has(key) ? this.urgent : this.background;
    if (queue === this.urgent) this.background.delete(key);
    queue.set(key, job.kind === 'child' && !job.scan && existing?.kind === 'child' && existing.scan ? existing : job);
  }
  changed(group: GroupKey, turnId?: string) {
    const subject = { kind: 'group', group } as const;
    if (this.policies.has(subjectKey(subject))) this.enqueue({ kind: 'group', subject, ...(turnId ? { turnId } : {}) }, true);
  }
  private boundParent(subject: BotSubject) {
    return this.registry.mainSessions?.boundSessionId(subject.bot.botId, subject.bot.botCreatedAt);
  }
  private baseline(subject: Subject) {
    this.enqueue({ kind: 'work', subject });
    if (subject.kind === 'group') this.enqueue({ kind: 'group', subject });
    else {
      const parent = this.boundParent(subject);
      if (parent) this.enqueue({ kind: 'parent', subject, parent });
    }
  }
  childChanged(parent: string, child: string, createdAt: number) {
    const known = this.parents.get(parent);
    const subject = known && this.boundParent(known) === parent ? known : [...this.policies.values()]
      .map(policy => policy.subject).find((item): item is BotSubject => item.kind === 'bot' && this.boundParent(item) === parent);
    if (!subject) return;
    this.parents.set(parent, subject);
    this.enqueue({ kind: 'child', subject, parent, child, createdAt }, true);
  }
  private title(subject: BotSubject, label?: string) {
    return label?.trim().slice(0, 500) || this.registry.directorySnapshot()
      .find(bot => bot.id === subject.bot.botId)?.name || subject.bot.botId;
  }
  private async seed(service: ProactiveService) {
    const revision = this.refreshRevision;
    const page = await service.read({ kind: 'follow-up-subjects', ...(this.policyCursor ? { cursor: this.policyCursor } : {}) });
    if (revision !== this.refreshRevision) return;
    if (page.kind === 'rejected' && page.code === 'stale') { this.reset(false); return; }
    if (page.kind !== 'follow-up-subjects') throw new Error('Follow-up policies unavailable');
    for (const policy of page.rows) this.loadingPolicies.set(subjectKey(policy.subject), policy);
    this.policyCursor = page.next;
    if (page.next) return;
    const oldPolicies = this.policies;
    const oldParents = new Set(this.parents.keys());
    this.policies = this.loadingPolicies;
    this.loadingPolicies = new Map();
    this.parents.clear();
    for (const [key, policy] of this.policies) {
      const parent = policy.subject.kind === 'bot' ? this.boundParent(policy.subject) : undefined;
      if (parent && policy.subject.kind === 'bot') this.parents.set(parent, policy.subject);
      if (this.forceBaseline || oldPolicies.get(key)?.revision !== policy.revision || (parent && !oldParents.has(parent)))
        this.baseline(policy.subject);
    }
    this.forceBaseline = false;
    this.refreshing = false;
  }
  private async checkpoint(service: ProactiveService, subject: Subject, sourceId: string, sourceGeneration = generation(subject)) {
    const reply = await service.read({ kind: 'follow-up-source', subject, sourceId, sourceGeneration });
    if (reply.kind !== 'follow-up-source') throw new Error('Follow-up source unavailable');
    return reply.cursor;
  }
  private async publish(service: ProactiveService, policy: FollowUpPolicy, sourceId: string,
    expectedCursor: string | null, nextCursor: string, facts: FollowUpFact[], sourceGeneration = generation(policy.subject)) {
    if (expectedCursor === nextCursor || this.stopped) return;
    if (this.refreshing || this.policies.get(subjectKey(policy.subject))?.revision !== policy.revision)
      throw new Error('Follow-up policy changed during observation');
    const reply = await service.ingestFollowUp(randomUUID(), followUpIngestSchema.parse({
      kind: 'local-task-state/v1', subject: policy.subject, sourceId,
      sourceGeneration, pauseEpoch: policy.pauseEpoch,
      expectedCursor, nextCursor, facts,
    }));
    if (reply.kind !== 'receipt') throw new Error('Follow-up source commit needs reconciliation');
  }
  private async group(service: ProactiveService, policy: FollowUpPolicy, job: GroupJob) {
    const groups = this.ctx.get('dshBotGroups');
    if (!groups) return;
    const snapshot = await groups.followUpFacts(job.subject.group, { ...job, since: policy.observationStart ?? 0 });
    for (const row of snapshot.rows) {
      // A proactive group stage is already represented by its original Ticket.
      if (row.turn.proactive) continue;
      const fact = { ...groupFollowUpFact(snapshot.group, row.turn, row.deliveries), current: true as const };
      const sourceId = `group:${hash(row.turn.id)}`;
      const before = await this.checkpoint(service, job.subject, sourceId);
      await this.publish(service, policy, sourceId, before, hash(fact), [fact]);
    }
    if (snapshot.next) this.enqueue({ ...job, page: snapshot.next });
  }
  private async discover(job: ParentJob) {
    if (this.boundParent(job.subject) !== job.parent) return;
    const parent = SessionId(job.parent);
    if (job.offset === undefined) {
      try {
        const catalog = job.catalog ?? { rows: (await this.ctx.subagents.listChildren(parent, this.abort.signal))
          .filter(row => row.mode === 'one-shot' || row.mode === 'continuable'), offset: 0 };
        const offset = catalog.offset + 16;
        const page = catalog.rows.slice(catalog.offset, offset);
        if (offset < catalog.rows.length) this.enqueue({ ...job, catalog: { ...catalog, offset } });
        for (const child of page) this.enqueue({ kind: 'child', subject: job.subject, parent, child: child.id, createdAt: child.createdAt });
        return;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code !== 'SUBAGENT_CONTROL_QUERY_UNAVAILABLE' && code !== 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE') throw error;
      }
    }
    // Minimal profiles can omit sessionQuery. Read the exact parent's own catalog
    // events in bounded pages. The child still has to prove its immutable lineage.
    if (!await this.ctx.sessionPersistence.stat(parent, { signal: this.abort.signal })) return;
    const reader = await this.ctx.sessionPersistence.open(parent, 'read', { signal: this.abort.signal });
    try {
      if (reader.header.parentSession || reader.header.origin === 'subagent') return;
      const page = await reader.read(Math.max(job.offset ?? 0, Number(reader.inheritedEventCount)), 256, { signal: this.abort.signal });
      const catalog = page.events.filter(event => event.type === 'subagent/catalog')
        .filter(event => event.data.mode === 'one-shot' || event.data.mode === 'continuable');
      const batch = catalog.slice(0, 16);
      for (const event of batch)
        this.enqueue({ kind: 'child', subject: job.subject, parent, child: event.data.childId, createdAt: event.data.childCreatedAt });
      const end = catalog.length > batch.length ? batch.at(-1) : page.events.length === 256 ? page.events.at(-1) : undefined;
      if (end) this.enqueue({ ...job, offset: Number(end.seq) + 1 });
    } finally { await reader.close(); }
  }
  private async child(service: ProactiveService, policy: FollowUpPolicy, job: ChildJob) {
    if (this.boundParent(job.subject) !== job.parent) return;
    const bot = await this.registry.get(job.subject.bot.botId).catch(() => undefined);
    if (bot?.createdAt !== job.subject.bot.botCreatedAt) return;
    const sourceId = `child-v1:${hash([job.parent, job.child])}`;
    const live = this.ctx.sessions.get(SessionId(job.child));
    if (live && !(await this.ctx.sessions.flush(live))) throw new Error('Native child durability unavailable');
    if (!await this.ctx.sessionPersistence.stat(SessionId(job.child), { signal: this.abort.signal })) return;
    const reader = await this.ctx.sessionPersistence.open(SessionId(job.child), 'read', { signal: this.abort.signal });
    try {
      if (reader.header.parentSession !== job.parent || reader.header.origin !== 'subagent' || reader.header.createdAt !== job.createdAt) return;
      const before = await this.checkpoint(service, job.subject, sourceId, job.createdAt);
      const checkpoint = before ? JSON.parse(before) as { offset: number; descriptor: number } : undefined;
      const offset = checkpoint?.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid native follow-up cursor');
      const scan = job.scan?.from === offset && job.scan.pauseEpoch === policy.pauseEpoch ? job.scan : undefined;
      const saved = checkpoint && !scan ? await reader.read(checkpoint.descriptor, 1, { signal: this.abort.signal }) : undefined;
      const start = Math.max(scan?.offset ?? offset, Number(reader.inheritedEventCount));
      const page = await reader.read(start, 256, { signal: this.abort.signal });
      const descriptor = (saved?.events ?? page.events).find(event => event.type === 'subagent/descriptor');
      const descriptorSeq = scan?.descriptor ?? (descriptor ? Number(descriptor.seq) : undefined);
      const title = scan?.title ?? (descriptor ? this.title(job.subject, descriptor.data.label) : undefined);
      const latest = page.events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
      let fact = scan?.latest;
      if (title && (latest?.type === 'turn/start' || latest?.type === 'turn/end')) {
        const condition: FollowUpFact['condition'] = latest.type === 'turn/start' ? { kind: 'tracking' }
          : latest.data.reason.kind === 'error' ? { kind: 'failed', reason: latest.data.reason.error.message.slice(0, 500) || 'error' }
          : latest.data.reason.kind === 'completed' ? { kind: 'closed', reason: 'resolved' }
          : latest.data.reason.kind === 'aborted' ? { kind: 'closed', reason: 'cancelled' } : { kind: 'closed', reason: 'resolved' };
        const payload = { origin: { kind: 'native-subagent' as const, sessionId: job.parent,
          childSessionId: job.child, turn: latest.data.turn }, title, condition };
        fact = followUpFactSchema.parse({ ...payload, nativeId: job.child, nativeRevision: Number(latest.seq),
          occurredAt: new Date(latest.time).toISOString(), current: true, payloadDigest: hash(payload) });
      }
      const end = page.events.at(-1);
      const next = end ? Number(end.seq) + 1 : scan?.offset;
      if (next === undefined || this.boundParent(job.subject) !== job.parent) return;
      if (page.events.length === 256) this.enqueue({ ...job, scan: { from: offset, offset: next, pauseEpoch: policy.pauseEpoch,
        descriptor: descriptorSeq, title, latest: fact } });
      else if (descriptorSeq !== undefined)
        await this.publish(service, policy, sourceId, before, JSON.stringify({ offset: next, descriptor: descriptorSeq }), fact ? [fact] : [], job.createdAt);
    } finally { await reader.close(); }
  }
  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.flight) return this.flight;
    const work = this.run(); this.flight = work;
    void work.finally(() => { if (this.flight === work) this.flight = undefined; }).catch(() => {});
    return work;
  }
  private async run() {
    const service = this.ctx.get('dshBotProactive');
    if (!service || this.stopped) return;
    for (let page = 0; page < 4 && this.refreshing; page++) await this.seed(service);
    if (this.refreshing) return;
    for (const [key, subject] of this.dirty) {
      if (this.urgent.size + this.background.size >= 512) break;
      this.dirty.delete(key);
      if (this.policies.has(key)) this.baseline(subject);
    }
    // One bounded batch per existing maintenance tick; live changes precede baseline pages.
    const retry: Job[] = [];
    for (let count = 0; count < 16 && !this.stopped && !this.refreshing; count++) {
      const queue = this.urgent.size && (count < 12 || !this.background.size) ? this.urgent : this.background;
      const first = queue.entries().next().value;
      if (!first) break;
      const [id, job] = first;
      queue.delete(id);
      const policy = this.policies.get(subjectKey(job.subject));
      if (!policy?.localEnabled) continue;
      try {
        if (job.kind === 'work') {
          const reply = await service.change(randomUUID(), { kind: 'follow-up-work-reconcile',
            input: { subject: job.subject, expectedPolicyRevision: policy.revision } });
          if (reply.kind !== 'receipt') throw new Error('Work baseline needs reconciliation');
          if (reply.receipt.stored === 100) this.enqueue(job);
        } else if (job.kind === 'group') await this.group(service, policy, job);
        else if (job.kind === 'parent') await this.discover(job);
        else await this.child(service, policy, job);
      } catch { retry.push(job); }
    }
    if (!this.stopped) for (const job of retry) this.enqueue(job);
  }
  async close() { this.stopped = true; this.abort.abort(); await this.flight?.catch(() => {}); this.urgent.clear(); this.background.clear(); }
}

export async function mountFollowUpEvents(ctx: Context, registry: DshBotRegistry) {
  await ctx.effect(() => {
    const bridge = new FollowUpEvents(ctx, registry);
    const off = [ctx.provide('dshBotFollowUpEvents', bridge),
      ctx.on('dsh-bot/group-fact-changed', (group, turnId) => bridge.changed(group, turnId)),
      ctx.on('dsh-bot/changed', () => bridge.reset(false)),
      ctx.on('session/event', (session, event) => {
        if ((event.type === 'turn/start' || event.type === 'turn/end') && session.header.parentSession && session.header.origin === 'subagent')
          bridge.childChanged(session.header.parentSession, session.id, session.header.createdAt);
        else if (event.type === 'subagent/catalog' && (event.data.mode === 'one-shot' || event.data.mode === 'continuable'))
          bridge.childChanged(session.id, event.data.childId, event.data.childCreatedAt);
      }),
    ];
    return async () => { for (const release of off) release(); await bridge.close(); };
  }, 'dsh-bot: local follow-up facts');
}
