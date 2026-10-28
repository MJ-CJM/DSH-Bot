import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { flowBindingSchema, dataLabelSchema, type DataLabel, type FlowBinding } from '../../shared/data-flow.js';
import type { BotKey } from '../../shared/identity.js';
import type { MemoryKernel, Commit } from '../memory/op-log.js';
import type { OnceGrants, OnceGrant } from './grants.js';
import { canReadLabel, mergeLabels } from './labels.js';
import { MemoryLineage } from './lineage.js';

export interface EgressEnvelope { binding: FlowBinding; content: string; label: DataLabel }
export interface DispatchTicket { readonly id: string; state: 'admitted' | 'dispatching' | 'delivered' | 'unknown' | 'cancelled' }
/** Shared policy checker. ManagedOutlets persists actual outlet envelopes and checkpoints. */
export class EgressChecker {
  private stopped = false;
  private readonly tickets = new Map<DispatchTicket, { envelope: EgressEnvelope; grant?: OnceGrant; opId: string }>();
  constructor(readonly kernel: MemoryKernel, readonly grants: OnceGrants,
    private readonly currentBot: (key: BotKey) => boolean) {}
  check(envelope: EgressEnvelope, grant?: OnceGrant, admitted?: string, signal?: AbortSignal): void {
    if (this.stopped) throw new Error('Egress checker stopped');
    signal?.throwIfAborted(); this.kernel.assertReadable(); this.kernel.assertOwnership();
    const b = flowBindingSchema.parse(envelope.binding), l = dataLabelSchema.parse(envelope.label);
    if (this.kernel.blocked || b.userScope !== this.kernel.scope.scope.id || b.epoch !== this.kernel.epoch ||
      b.policyRevision !== this.kernel.policyRevision || !this.currentBot(b.bot) ||
      this.kernel.snapshot.retired.has(JSON.stringify(b.bot))) throw new Error('Stale egress identity, epoch or policy');
    if (b.target.kind === 'bot' && (!this.currentBot(b.target.bot) ||
      this.kernel.snapshot.retired.has(JSON.stringify(b.target.bot)))) throw new Error('Stale egress target');
    if (b.target.kind === 'group' && b.target.members.some(key => !this.currentBot(key) ||
      this.kernel.snapshot.retired.has(JSON.stringify(key)))) throw new Error('Stale group audience');
    if (!isDeepStrictEqual([...new Set(l.sourceVersions)].sort(), [...new Set(b.sourceVersions)].sort()))
      throw new Error('Unknown egress lineage');
    const sessionId = b.invocation.split('/')[0];
    if (!sessionId || new MemoryLineage(this.kernel).seen(sessionId).some(id => !b.sourceVersions.includes(id)))
      throw new Error('Egress omitted previously observed session lineage');
    const sessionLabel = sessionId ? this.kernel.domain.table('flow_sessions').get(sessionId)?.label : undefined;
    if (!b.sourceVersions.length && !sessionLabel) throw new Error('Unknown egress lineage');
    const live = [...this.kernel.snapshot.versions.values()];
    if (b.sourceVersions.some(id => !live.some(v => v.versionId === id && this.kernel.domain.table('payloads').get(v.contentRef))))
      throw new Error('Egress source version changed or disappeared');
    const refs = live.filter(v => b.sourceVersions.includes(v.versionId)).flatMap(v => v.sourceRefs);
    if (!isDeepStrictEqual(refs, b.sourceRefs)) throw new Error('Egress source references changed');
    const lineage = b.sourceVersions.length ? new MemoryLineage(this.kernel).label(b.sourceVersions) : sessionLabel;
    if (!lineage) throw new Error('Unknown egress lineage');
    const effective = mergeLabels(l, lineage, ...(sessionLabel ? [sessionLabel] : []));
    if (lineage.sourceVersions.some(id => !b.sourceVersions.includes(id)) ||
      effective.sourceVersions.some(id => !b.sourceVersions.includes(id)) ||
      effective.restrictions.some(r => ['revoked', 'pending-cleanup', 'secret'].includes(r))) throw new Error('Restricted egress source');
    // A supplied grant must match even when the route would otherwise be allowed.
    if (grant) this.grants.check(grant, b, envelope.content, admitted);
    const readable = b.target.kind === 'bot' && canReadLabel(effective, b.target.bot);
    const group = b.target.kind === 'group' && b.target.members.every(key => canReadLabel(effective, key));
    const inDomain = b.target.kind === 'shared' && effective.readers === 'shared';
    if (!readable && !group && !inDomain && !grant) throw new Error('Egress requires exact-content user authorization');
    // no-egress forbids external export unless this exact payload/destination was explicitly approved.
    if (b.target.kind === 'external' && !grant) throw new Error('Shared is not public');
  }
  async admit(envelope: EgressEnvelope, build: () => Commit, grant?: OnceGrant, signal?: AbortSignal): Promise<DispatchTicket> {
    const snapshot = structuredClone(envelope);
    const op = await this.kernel.transact(() => {
      this.check(snapshot, grant, undefined, signal);
      const input = build();
      if (input.grantUse || input.quotaCharge || input.autoPolicy) throw new Error('Egress command contains foreign authorization');
      if (input.versions?.some(v => v.labels.readers === 'shared')) throw new Error('Use exact memory confirmation for promotion');
      return { ...input, ...(grant ? { grantUse: grant.id } : {}) };
    });
    if (grant) this.grants.admitted(grant, op.opId);
    const ticket: DispatchTicket = { id: randomUUID(), state: 'admitted' };
    this.tickets.set(ticket, { envelope: snapshot, grant, opId: op.opId }); return ticket;
  }
  async dispatch<T>(ticket: DispatchTicket, send: (envelope: EgressEnvelope) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const row = this.tickets.get(ticket);
    if (!row || ticket.state !== 'admitted') throw new Error('Dispatch ticket already used or unknown');
    try {
      const pending = await this.kernel.serial(() => {
        if (ticket.state !== 'admitted') throw new Error('Dispatch already started');
        this.check(row.envelope, row.grant, row.grant ? row.opId : undefined, signal);
        ticket.state = 'dispatching';
        // Invoke immediately after the second check, before yielding the queue. Do not await the transport under the queue.
        return { sent: send(structuredClone(row.envelope)) };
      });
      const result = await pending.sent; ticket.state = 'delivered'; return result;
    } catch (error) { ticket.state = (ticket.state as DispatchTicket['state']) === 'dispatching' ? 'unknown' : 'cancelled'; throw error; }
  }
  close(): void { this.stopped = true; for (const ticket of this.tickets.keys()) if (ticket.state === 'admitted') ticket.state = 'cancelled';
    this.tickets.clear(); this.grants.close(); }
}
