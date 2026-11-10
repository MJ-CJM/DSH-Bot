import { sameBot, type BotKey } from '../../shared/identity.js';
import type { CommandBody, Receipt } from '../../shared/proactive/protocol.js';
import type { SuggestionActionReply } from '../../shared/proactive/remote-contract.js';
import { supportsWorkContinuation, type ProactiveWork, type WorkContinuation } from '../../shared/proactive/work.js';
import { digest } from './wire.js';

interface ContinuationPorts {
  hasReceipt(commandId: string): Promise<boolean>;
  read(ticketId: string): Promise<ProactiveWork | null>;
  ownerCurrent(owner: BotKey): boolean;
  validateTarget(target: ProactiveWork['target']): unknown;
  change(commandId: string, body: CommandBody): Promise<SuggestionActionReply>;
  enqueue(work: ProactiveWork): void;
}

export async function runWorkContinuation(
  commandId: string, input: WorkContinuation, ports: ContinuationPorts,
): Promise<SuggestionActionReply> {
  const launches = input.action !== 'mark-waiting';
  const body = { kind: 'work-continuation' as const, operationId: commandId, input };
  const unknown = { kind: 'unknown', commandId } as const;
  const existing = await ports.hasReceipt(commandId).catch(() => undefined);
  if (existing === undefined) return unknown;
  if (!existing) {
    if (!ports.ownerCurrent(input.owner)) return { kind: 'rejected', code: 'stale' };
    const current = await ports.read(input.ticketId).catch(() => undefined);
    if (current === undefined) return unknown;
    if (!current || !sameBot(current.target.bot, input.owner) || current.assignmentId !== input.assignmentId ||
      current.revision !== input.expectedRevision) return { kind: 'rejected', code: 'stale' };
    if (!supportsWorkContinuation(current)) return { kind: 'rejected', code: 'unsupported' };
    if (launches) {
      try { ports.validateTarget(current.target); }
      catch { return { kind: 'rejected', code: 'forbidden' }; }
    }
  }
  const result = await ports.change(commandId, body);
  if (result.kind !== 'receipt' || !launches) return result;
  // A lost coordinator reply can leave a committed pending attempt. A recheck
  // starts only that exact attempt, and native claim still owns dispatch.
  const next = await ports.read(input.ticketId).catch(() => undefined);
  if (next === undefined) return unknown;
  if (next?.state === 'pending' && next.continuation?.operationId === commandId &&
    next.continuation.previousAssignmentId === input.assignmentId && sameBot(next.target.bot, input.owner)) {
    // The executor checks the exact target before claim and settles a stale
    // target as denied. Suppressing enqueue here would leave an occupied slot.
    ports.enqueue(next);
  }
  return result;
}

interface ReconcilePorts {
  receipt(commandId: string): Promise<Receipt | null>;
  assignment(assignmentId: string): Promise<ProactiveWork | null>;
  enqueue(work: ProactiveWork): void;
}

/** Reconcile an exact pending Work already read under the owner's detail fence. */
export async function reconcilePendingWorkContinuation(work: ProactiveWork, ports: ReconcilePorts): Promise<void> {
  const continuation = work.continuation;
  if (work.state !== 'pending' || work.admission !== 'manual' || !continuation || !supportsWorkContinuation(work))
    throw new Error('Accepted continuation unavailable');
  // Core writes this operation pointer and its receipt together after validating
  // the command digest. The old assignment proves which Work that receipt replaced.
  const [receipt, prior] = await Promise.all([
    ports.receipt(continuation.operationId),
    ports.assignment(continuation.previousAssignmentId),
  ]);
  if (!receipt || receipt.commandId !== continuation.operationId || receipt.status !== 'committed' || receipt.stored !== 1 ||
      !prior || prior.assignmentId !== continuation.previousAssignmentId || prior.ticketId !== work.ticketId ||
      prior.state !== 'superseded' || prior.supersededBy !== work.assignmentId || prior.generation + 1 !== work.generation ||
      digest(prior.target) !== digest(work.target)) throw new Error('Accepted continuation changed');
  ports.enqueue(work);
}
