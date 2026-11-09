import { randomUUID } from 'node:crypto';
import type { FollowUpGroupAbandonRequest, FollowUpGroupAcceptRequest, FollowUpGroupChoiceRequest, FollowUpGroupChoiceReply, FollowUpGroupReply } from '../../shared/proactive/group-follow-up.js';
import type { SuggestionActionReply } from '../../shared/proactive/remote-contract.js';
import { hasOperationCode } from '../../shared/operation-errors.js';
import type { Groups } from '../groups/service.js';
import type { ProactiveService } from './service.js';
import { digest } from './wire.js';

type Service = Pick<ProactiveService, 'read' | 'change' | 'ownsFollowUpSubject' | 'followUpSummary'>;
type NativeGroups = Pick<Groups, 'ownerFollowUpChoice' | 'startOwnerFollowUp'>;

async function context(service: Service, input: FollowUpGroupChoiceRequest | FollowUpGroupAcceptRequest) {
  const result = await service.read({ kind: 'follow-up-group-plan', input: {
    subject: input.subject, cardId: input.cardId, expectedRevision: input.expectedRevision,
  } });
  if (result.kind !== 'follow-up-group-plan') throw new Error('Group follow-up unavailable');
  return result;
}

export async function prepareGroupFollowUp(service: Service, groups: Pick<Groups, 'ownerFollowUpChoice' | 'ownerFollowUpUnstarted'> | undefined,
  input: FollowUpGroupChoiceRequest): Promise<FollowUpGroupChoiceReply> {
  if (!groups || !await service.ownsFollowUpSubject(input.subject)) throw new Error('Group unavailable');
  const { plan, card } = await context(service, input);
  if (plan) {
    const canAbandon = !plan.turnId && await groups.ownerFollowUpUnstarted(input.subject.group, plan.commandId);
    return { choice: plan.input.choice, existing: { commandId: plan.commandId, ...plan.input },
      ...(canAbandon ? { canAbandon: true as const } : {}) };
  }
  if (!card || card.revision !== input.expectedRevision || card.state !== 'open' ||
      card.origin.kind !== 'group-turn' || card.condition.kind !== 'failed') throw new Error('Follow-up changed');
  const summary = await service.followUpSummary(input.subject);
  if (!summary.policy.localEnabled) throw new Error('Follow-up paused');
  return { choice: await groups.ownerFollowUpChoice(input.subject.group, card.origin.turnId, input.memberId) };
}

export async function abandonGroupFollowUp(service: Service, groups: Pick<Groups, 'abandonOwnerFollowUp'> | undefined,
  request: FollowUpGroupAbandonRequest): Promise<SuggestionActionReply> {
  const { commandId, ...input } = request;
  if (!groups || !await service.ownsFollowUpSubject(input.subject)) return { kind: 'rejected', code: 'stale' };
  try {
    return await groups.abandonOwnerFollowUp(input.subject.group, input.operationId,
      () => service.change(commandId, { kind: 'follow-up-group-abandon', input }));
  } catch (error) {
    return hasOperationCode(error, 'conflict') ? { kind: 'rejected', code: 'conflict' } : { kind: 'unknown', commandId };
  }
}

export async function acceptGroupFollowUp(service: Service, groups: NativeGroups | undefined,
  request: FollowUpGroupAcceptRequest): Promise<FollowUpGroupReply> {
  const { commandId, ...input } = request;
  if (!groups) return { kind: 'rejected', code: 'unavailable' };
  const inputDigest = digest(input);
  let committed = false;
  let inspected = false;
  let rejection: FollowUpGroupReply | undefined;
  try {
    const prior = await context(service, request);
    inspected = true;
    if (prior.plan) {
      if (prior.plan.commandId !== commandId || prior.plan.inputDigest !== inputDigest) return { kind: 'rejected', code: 'conflict' };
      committed = true;
      if (prior.plan.turnId) return { kind: 'started', commandId, turnId: prior.plan.turnId };
      if (prior.plan.activationEpoch !== prior.activationEpoch) return { kind: 'rejected', code: 'forbidden' };
    }
    const verify = async () => {
      const { plan, activationEpoch } = await context(service, request);
      if (!plan || plan.commandId !== commandId || plan.inputDigest !== inputDigest || plan.activationEpoch !== activationEpoch)
        throw new Error('Accepted follow-up unavailable');
      // The manual admission is durable. A later Subject pause does not revoke it.
    };
    const turn = await groups.startOwnerFollowUp(input.subject.group,
      { operationId: commandId, text: input.text },
      { ...input.choice, cardId: input.cardId, cardRevision: input.expectedRevision },
      async () => {
        const result = await service.change(commandId, { kind: 'follow-up-group-accept', operationId: commandId, input });
        if (result.kind !== 'receipt') {
          rejection = result.kind === 'rejected'
            ? { kind: 'rejected', code: result.code === 'conflict' ? 'conflict' : result.code === 'forbidden' ? 'forbidden' : 'stale' }
            : { kind: 'unknown', commandId };
          throw new Error('Admission unresolved');
        }
        committed = true;
        await verify();
      }, verify);
    // A duplicate native turn can bypass admission; verify the original durable
    // grant again, including privacy revocation, before returning its identity.
    await verify();
    if (turn.inputSeq === undefined || turn.state === 'recovery_needed' || turn.operationId !== commandId ||
        digest(turn.group) !== digest(input.subject.group) || digest(turn.ownerFollowUp) !== digest({
          ...input.choice, cardId: input.cardId, cardRevision: input.expectedRevision,
        })) return { kind: 'unknown', commandId };
    const completed = await service.change(randomUUID(), {
      kind: 'follow-up-group-started', operationId: commandId, inputDigest, turnId: turn.id,
    });
    return completed.kind === 'receipt' ? { kind: 'started', commandId, turnId: turn.id } : { kind: 'unknown', commandId };
  } catch {
    return rejection ?? (committed || !inspected ? { kind: 'unknown', commandId } : { kind: 'rejected', code: 'stale' });
  }
}
