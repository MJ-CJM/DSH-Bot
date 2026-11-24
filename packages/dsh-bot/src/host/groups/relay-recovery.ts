import type { GroupDelivery, GroupRecord, GroupTurn } from '../../shared/groups.js';
import type { FlowEnvelope } from '../../shared/managed-flow.js';
import { sameBot } from '../../shared/identity.js';
import { digest } from '../common/operations.js';
import { outlets } from '../data-flow/tool-guard.js';
import { audience } from './data-flow.js';
import { sameGroupReaders } from './model.js';
import type { GroupRoot, GroupState } from './state.js';

/** Recover receipts only. Never append a group message, repeat an approval or start a worker at startup. */
export async function recoverRelayDecisions(state: GroupState, group: GroupRecord, turn: GroupTurn, root: GroupRoot) {
  const via = turn.guestQuestion?.via;
  if (!via || group.archived || turn.membershipRevision !== group.membershipRevision || turn.state === 'cancelled') return;
  const flow = outlets(state.registry);
  if (!flow) return;
  const affected = state.deliveries(turn.id).filter(d => d.childSessionId && d.childMessageId && d.acceptedAt !== undefined &&
    !d.outputMessageId && (d.state === 'unknown' || d.reasonCode === 'export-approval-required'));
  let changed = false;
  for (const d of affected) {
    const guest = d.ordinal === 0;
    if (d.id !== turn.id + ':' + d.ordinal || (guest ? !sameBot(d.bot, turn.guestQuestion!.bot) :
      d.ordinal !== 1 || !sameBot(d.bot, via.bot) || d.memberId !== via.memberId)) continue;
    const held = d.exportFlowId && flow.kernel.domain.table('flows').get(d.exportFlowId);
    if (held && held.state === 'awaiting-approval') continue;
    const target = audience(state, group);
    const matches = (e: FlowEnvelope) => e.outlet === 'group-result' && e.binding.invocation === d.childSessionId + '/' + d.id + ':result' &&
      sameBot(e.binding.bot, d.bot) && (guest ? e.binding.target.kind === 'bot' && sameBot(e.binding.target.bot, via.bot) :
        e.binding.target.kind === 'group' && e.binding.target.groupId === group.id && e.binding.target.groupCreatedAt === group.createdAt &&
        sameGroupReaders(e.binding.target.members, target.members));
    const rows = [...flow.kernel.domain.table('flows').entries()].map(([, row]) => row).filter(row => row.envelope &&
      matches(row.envelope) && (!held || held.envelopeDigest && row.grantUse && digest(row.envelope) === held.envelopeDigest));
    let recovered: Partial<GroupDelivery> | undefined;
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row?.state === 'awaiting-approval' && !held) {
      recovered = { state: 'failed', reasonCode: 'export-approval-required', exportFlowId: row.id, stopReason: 'completed' };
    } else if (row?.state === 'delivered' && row.envelope && guest) {
      try {
        const e = flow.deliveredBotResult(row.id, d.bot, via.bot);
        const msg = JSON.parse(e.content) as { source?: { kind?: string; turnId?: string; memberId?: string; guestReply?: boolean } };
        if (msg.source?.kind === 'dsh-bot-group' && msg.source.turnId === turn.id && msg.source.memberId === d.memberId && msg.source.guestReply)
          recovered = { state: 'completed', answeredAt: d.answeredAt ?? d.endedAt ?? turn.updatedAt, relayAnswerFlowId: row.id,
            reasonCode: undefined, exportFlowId: undefined, stopReason: 'completed' };
      } catch { /* A revoked source cannot be restored. */ }
    } else if (row?.state === 'delivered' && row.envelope && !guest) {
      try {
        flow.checker.checkGroupCopies([row.id], target);
        const visible = root.agent.session.surface?.nodes;
        const native = root.agent.session.snapshotEvents().filter(event => event.type === 'user/message' &&
          (!visible || visible.includes(event.seq)) && event.data.source.kind === 'dsh-bot-group' &&
          event.data.source.relayReply && event.data.source.turnId === turn.id && event.data.source.memberId === via.memberId &&
          sameBot(event.data.source.speaker.bot, via.bot) && JSON.stringify(event.data) === row.envelope!.content);
        const event = native.length === 1 ? native[0] : undefined;
        if (event?.type === 'user/message') recovered = { state: 'completed', outputMessageId: event.data.id, outputSeq: Number(event.seq),
          stopReason: 'completed', reasonCode: undefined, exportFlowId: undefined };
      } catch { /* Native history alone does not prove a currently readable disclosure. */ }
    }
    // A consumed or discarded review can never be reopened. Do not leave an unusable approval action.
    if (!recovered && d.exportFlowId && (!held || held.state === 'cancelled')) recovered = {
      state: held && !held.envelopeDigest ? 'failed' : 'unknown', reasonCode: held && !held.envelopeDigest ? 'export-blocked' : 'export-delivery-unknown', exportFlowId: undefined,
    };
    if (recovered) { await state.putDelivery({ ...d, ...recovered }); changed = true; }
  }
  if (changed) {
    const rows = state.deliveries(turn.id), current = state.table('turns').get(turn.id);
    if (!current || current.state === 'cancelled') return;
    const complete = rows.some(d => d.ordinal === 1 && d.state === 'completed' && d.outputMessageId);
    await state.putTurn({ ...current, state: complete ? 'idle' : rows.some(d => d.state === 'unknown' || d.ordinal === 0 && d.answeredAt && rows.length === 1)
      ? 'recovery_needed' : 'partial' });
  }
}
