import en from '../../../locale/en.json' with { type: 'json' };
import zh from '../../../locale/zh.json' with { type: 'json' };
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DataLabel, EgressTarget } from '../../shared/data-flow.js';
import { flowEnvelopeSchema, flowRecordSchema, type FlowEnvelope, type FlowRecord, type Outlet } from '../../shared/managed-flow.js';
import type { BotKey } from '../../shared/identity.js';
import type { EgressChecker } from './egress.js';
import type { OnceGrant } from './grants.js';
import { MemoryLineage } from './lineage.js';
import { mergeLabels } from './labels.js';
export interface NotificationCopyRef {operationId:string;sessionId?:string;flowId?:string;}
export interface ProactiveGroupCopyRef {
  sessionId?: string;
  outlet: 'group-input' | 'group-result';
}

/** Durable outlet state in the existing memory domain. No replay of uncertain native side effects. */
export class ManagedOutlets {
  private stopped = false;
  private readonly lifetime = new AbortController();
  private readonly permissions = new Map<string, OnceGrant>();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(readonly checker: EgressChecker) {}
  get kernel() { return this.checker.kernel; }
  private signal(input?: AbortSignal) { return AbortSignal.any([this.lifetime.signal, ...(input ? [input] : [])]); }
  stop() { this.stopped = true; this.lifetime.abort(new Error('Outlet owner stopped')); }
  async recover() {
    await this.kernel.serial(async () => {
      for (const [id, row] of this.kernel.domain.table('flows').entries()) {
        if (row.state === 'dispatching') await this.put({ ...row, state: 'unknown' });
        // Native grants are process-local. Unattempted rows may contain a lost permission too.
        else if (row.state === 'admitted' && row.grantUse) await this.put({ ...row, state: 'cancelled' });
        if (!row.envelope) this.permissions.delete(id);
      }
    });
  }
  async inherit(sessionId: string, label: DataLabel): Promise<void> {
    await this.kernel.serial(async () => {
      this.kernel.assertReadable(); this.kernel.assertOwnership();
      const old = this.kernel.domain.table('flow_sessions').get(sessionId)?.label;
      const next = old ? mergeLabels(old, label) : label;
      if (old && isDeepStrictEqual(old, next) && next.sourceVersions.every(id =>
        new MemoryLineage(this.kernel).seen(sessionId).includes(id))) return;
      await this.kernel.domain.table('flow_sessions').put(sessionId, { sessionId, label: next });
      const id = randomUUID();
      await this.kernel.domain.table('receipts').put(id, { id, sessionId, versionIds: next.sourceVersions,
        epoch: this.kernel.epoch, state: 'read' });
    });
  }
  label(sessionId: string): DataLabel {
    const lineage = new MemoryLineage(this.kernel), seen = lineage.seen(sessionId);
    const persisted = this.kernel.domain.table('flow_sessions').get(sessionId)?.label;
    const labels = [...(persisted ? [persisted] : []), ...(seen.length ? [lineage.label(seen)] : [])];
    if (!labels.length) throw new Error('Unknown session lineage');
    return mergeLabels(...labels);
  }
  draft(outlet: Outlet, bot: BotKey, sessionId: string, call: string, target: EgressTarget, content: string): FlowEnvelope {
    const label = this.label(sessionId), ids = [...new Set(label.sourceVersions)];
    const live = [...this.kernel.snapshot.versions.values()];
    return flowEnvelopeSchema.parse({ outlet, content, label, binding: {
      userScope: this.kernel.scope.scope.id, bot, invocation: `${sessionId}/${call}`, payloadVersion: randomUUID(),
      sourceVersions: ids, sourceRefs: live.filter(v => ids.includes(v.versionId)).flatMap(v => v.sourceRefs), target,
      epoch: this.kernel.epoch, policyRevision: this.kernel.policyRevision,
    } });
  }
  /** Data export approval is distinct from generic native tool execution approval. */
  async request(agent: Agent, envelope: FlowEnvelope, signal: AbortSignal): Promise<OnceGrant | undefined> {
    signal = this.signal(signal); signal.throwIfAborted();
    try { this.checker.check(envelope, undefined, undefined, signal); return; } catch (error) {
      if (!/authorization|Shared is not public/.test(String(error))) throw error;
    }
    const approval = agent.ctx.get('approval');
    if (!approval || agent.session.id !== envelope.binding.invocation.split('/')[0]) throw new Error('No export approval context');
    const describe = (dictionary: typeof en) => dictionary.tools['dataFlow.export.approval']
      .replace('{target}', () => JSON.stringify(envelope.binding.target)).replace('{content}', () => envelope.content);
    const reason = `${describe(en)}\n${describe(zh)}`;
    const outcome = await approval.request({ agent, toolName: `dsh_bot_export_${envelope.outlet}`, reason, signal });
    signal.throwIfAborted();
    if (outcome !== 'allowed-once') throw new Error('Data export not approved');
    const grant = this.checker.grants.issue(envelope.binding, envelope.content);
    this.checker.check(envelope, grant, undefined, signal); return grant;
  }
  async admit(envelope: FlowEnvelope, grant?: OnceGrant, signal?: AbortSignal): Promise<string> {
    signal = this.signal(signal); signal.throwIfAborted();
    const parsed = flowEnvelopeSchema.parse(envelope), id = randomUUID();
    // Grant consumption shares the single authoritative ops commit point; interrupted row write cannot reuse it.
    if (grant) {
      const op = await this.kernel.transact(() => {
        this.checker.check(parsed, grant, undefined, signal);
        return { opId: id, kind: 'cleanup', subjectIds: [], expectedRevision: this.kernel.seq,
          forgetEpoch: this.kernel.epoch, grantUse: grant.id };
      });
      this.checker.grants.admitted(grant, op.opId); this.permissions.set(id, grant);
    }
    await this.kernel.serial(async () => {
      this.check(parsed, grant, grant ? id : undefined, signal);
      await this.put({ id, state: 'admitted', envelope: parsed, ...(grant ? { grantUse: grant.id } : {}) });
    });
    return id;
  }
  async persist<T>(id: string, save: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.kernel.serial(async () => {
      const row = this.get(id);
      if (!row.envelope || row.state !== 'admitted') throw new Error('Outlet persistence denied');
      this.check(row.envelope, this.permissions.get(id), row.grantUse ? id : undefined, signal);
      return save();
    });
  }
  private check(envelope: FlowEnvelope, grant?: OnceGrant, id?: string, signal?: AbortSignal) {
    if (this.stopped) throw new Error('Outlet owner stopped');
    const session = envelope.binding.invocation.split('/')[0];
    if (!session) throw new Error('Missing outlet session');
    const current = this.label(session);
    if (!isDeepStrictEqual(mergeLabels(envelope.label, current), envelope.label)) throw new Error('Session lineage changed');
    this.checker.check(envelope, grant, id, signal);
  }
  get(id: string): FlowRecord {
    const row = this.kernel.domain.table('flows').get(id);
    if (!row) throw new Error('Missing outlet envelope'); return structuredClone(row);
  }
  async validate(id: string, content?: string, signal?: AbortSignal): Promise<void> {
    await this.kernel.serial(() => {
      const row = this.get(id);
      if (!row.envelope || row.state !== 'admitted' || (content !== undefined && row.envelope.content !== content))
        throw new Error('Outlet held, attempted or payload changed');
      this.check(row.envelope, this.permissions.get(id), row.grantUse ? id : undefined, signal);
    });
  }
  dispatch<T>(id: string, send: (envelope: FlowEnvelope, signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal,
    beforeAttempt?: () => Promise<void>): Promise<T> {
    const task = this.dispatchInternal(id, send, this.signal(signal), beforeAttempt);
    this.pending.add(task); void task.finally(() => this.pending.delete(task)).catch(() => {}); return task;
  }
  private async dispatchInternal<T>(id: string, send: (envelope: FlowEnvelope, signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal,
    beforeAttempt?: () => Promise<void>): Promise<T> {
    let attempted = false, refused = false;
    try {
      const result = await this.kernel.serial(async () => {
        const row = this.get(id);
        if (!row.envelope || row.state !== 'admitted') throw new Error('Outlet already attempted or held');
        const envelope = row.envelope, grant = this.permissions.get(id);
        this.check(envelope, grant, row.grantUse ? id : undefined, signal);
        await this.put({ ...row, state: 'dispatching' });
        // This check runs under the ledger queue and must not reacquire it.
        if (beforeAttempt) {
          try { await beforeAttempt(); }
          catch (error) { refused = true; throw error; }
        }
        // Awaiting can observe cancellation or identity changes. Invoke transport before yielding again.
        this.check(envelope, grant, row.grantUse ? id : undefined, signal); attempted = true;
        return { pending: Promise.resolve(send(structuredClone(envelope), this.signal(signal))) };
      });
      const value = await result.pending;
      await this.kernel.serial(async () => {
        const row = this.get(id); if (row.state === 'dispatching') await this.put({ ...row, state: 'delivered' });
      });
      this.permissions.delete(id); return value;
    } catch (error) {
      await this.kernel.serial(async () => {
        const row = this.get(id);
        if (row.state === 'admitted' || row.state === 'dispatching') {
          const envelope = row.envelope;
          // A rejected final check can follow a completed source forget.
          // Drop the staged body before propagating that known refusal.
          await this.put({ ...row, state: attempted ? 'unknown' : 'cancelled', ...(refused && envelope ? {
            envelope: undefined,
            envelopeDigest: createHash('sha256').update(JSON.stringify(envelope)).digest('hex'),
            redactedAt: Date.now(),
          } : {}) });
        }
      });
      this.permissions.delete(id); throw error;
    }
  }
  private notificationCopies(refs:readonly NotificationCopyRef[]) {
    return [...this.kernel.domain.table('flows').entries()].flatMap(([,row])=>{
      const ref=refs.find(ref=>row.id===ref.flowId || (row.envelope && ['notify-record','notify-send'].includes(row.envelope.outlet) && ref.sessionId &&
        [ref.operationId,`${ref.operationId}:display`,`${ref.operationId}:send`].some(call=>row.envelope?.binding.invocation===`${ref.sessionId}/${call}`)));
      return ref ? [{row,ref}] : [];
    });
  }
  /** Core operation IDs also locate retained envelopes whose visible notice has
   * already expired. Match both the serialized proactive source and invocation. */
  proactiveNotificationCopyRefs(operationIds:readonly string[]):NotificationCopyRef[] {
    const operations=new Set(operationIds),refs:NotificationCopyRef[]=[];
    for(const [,row] of this.kernel.domain.table('flows').entries()){
      const envelope=row.envelope;
      if(!envelope||!['notify-record','notify-send'].includes(envelope.outlet))continue;
      let source:{kind?:unknown;sessionId?:unknown}|undefined;
      try{source=(JSON.parse(envelope.content) as {source?:typeof source}).source;}catch{continue;}
      if(!source||!['proactive','proactive-review'].includes(String(source.kind))||typeof source.sessionId!=='string')continue;
      const prefix=`${source.sessionId}/`;
      if(!envelope.binding.invocation.startsWith(prefix))continue;
      const invocation=envelope.binding.invocation.slice(prefix.length);
      const candidates=[invocation,...(envelope.outlet==='notify-send'&&/:(display|send)$/.test(invocation)?[invocation.replace(/:(display|send)$/,'')]:[])];
      const operationId=candidates.find(candidate=>operations.has(candidate));
      if(operationId)refs.push({operationId,sessionId:source.sessionId,flowId:row.id});
    }
    return refs;
  }
  notificationCopyStatus(refs:readonly NotificationCopyRef[]) {
    return [...new Set(this.notificationCopies(refs).filter(({row})=>row.state==='dispatching'||row.state==='unknown').map(({ref})=>ref.operationId))];
  }
  async purgeNotificationCopies(refs:readonly NotificationCopyRef[]) {
    return this.kernel.serial(async()=>{
      this.kernel.assertReadable();this.kernel.assertOwnership();
      const rows=this.notificationCopies(refs),blockedOperationIds=[...new Set(rows.filter(({row})=>row.state==='dispatching'||row.state==='unknown').map(({ref})=>ref.operationId))];
      if(blockedOperationIds.length)return {purged:0,blockedOperationIds};
      const purged = await this.redactBodies(rows.map(({ row }) => row));
      return {purged,blockedOperationIds:[]};
    });
  }
  /** Group records own the turn/delivery IDs. Only their exact managed copies
   * are redacted here, without rewriting a native root or child session. */
  purgeProactiveGroupCopies(assignmentIds: ReadonlySet<string>, refs: ReadonlyMap<string, ProactiveGroupCopyRef>) {
    return this.kernel.serial(async () => {
      this.kernel.assertReadable(); this.kernel.assertOwnership();
      const copies: FlowRecord[] = [];
      for (const [, row] of this.kernel.domain.table('flows').entries()) {
        const envelope = row.envelope;
        if (!envelope || (envelope.outlet !== 'group-input' && envelope.outlet !== 'group-result')) continue;
        const callId = envelope.binding.invocation.split('/').at(-1);
        const ref = callId && refs.get(callId);
        if (ref) {
          if (ref.outlet !== envelope.outlet || !ref.sessionId ||
              `${ref.sessionId}/${callId}` !== envelope.binding.invocation ||
              row.state === 'dispatching' || row.state === 'unknown') return false;
          copies.push(row);
        } else if (envelope.outlet === 'group-input') {
          // A root envelope can be committed before the associated turn.
          // An unmatched proactive root is evidence of an incomplete scope.
          let source: { kind?: unknown; assignmentId?: unknown } | undefined;
          try { source = (JSON.parse(envelope.content) as { source?: typeof source } | null)?.source; } catch { continue; }
          if (source?.kind === 'dsh-bot-group-proactive' &&
              typeof source.assignmentId === 'string' && assignmentIds.has(source.assignmentId)) return false;
        }
      }
      await this.redactBodies(copies);
      return true;
    });
  }
  private async redactBodies(rows: readonly FlowRecord[]) {
    let purged = 0;
    for (const row of rows) {
      if (!row.envelope) continue;
      const envelopeDigest = createHash('sha256').update(JSON.stringify(row.envelope)).digest('hex');
      await this.put({ ...row, state: row.state === 'admitted' ? 'cancelled' : row.state, envelope: undefined, envelopeDigest, redactedAt: Date.now() });
      this.permissions.delete(row.id); purged++;
    }
    return purged;
  }
  private put(row: FlowRecord) { return this.kernel.domain.table('flows').put(row.id, flowRecordSchema.parse(row)); }
  async close() { this.stop(); await Promise.allSettled([...this.pending]); this.permissions.clear(); }
}
