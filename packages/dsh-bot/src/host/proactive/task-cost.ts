import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ProactiveWork } from '../../shared/proactive/work.js';
import { proactiveMemberModel } from '../groups/model-selection.js';
import { observedModelUsage } from './model-budget.js';

/** On-demand projection from existing task receipts and native sessions.
 * Unknown measurements never become zero and external fees stay separate. */
export async function taskCost(ctx: Context, attempts: ProactiveWork[]) {
  let knownNativeTokens = 0, unknownMeasurements = 0;
  let externalUnits = 0;
  for (const work of attempts) {
    if (!work.groupRepair) {
      if (work.usage) knownNativeTokens += work.usage.inputTokens + work.usage.outputTokens;
      else if (!['pending', 'denied'].includes(work.state)) unknownMeasurements++;
    }
    externalUnits += work.externalEvidence?.units ?? 0;
    const key = work.groupReview?.group ?? work.groupRepair?.group;
    if (!key) continue;
    try {
      const groups = ctx.get('dshBotGroups');
      if (!groups) throw new Error();
      const view = await groups.view(key);
      const turns = view.turns.filter(turn => turn.proactive?.ticketId === work.ticketId && turn.proactive.assignmentId === work.assignmentId);
      if (!turns.length) { unknownMeasurements++; continue; }
      for (const turn of turns) {
        const review = turn.proactive;
        if (!review) { unknownMeasurements++; continue; }
        for (const memberId of turn.orderedMemberIds) {
          try {
            const deliveries = view.deliveries.filter(row => row.turnId === turn.id && row.memberId === memberId && row.reasonCode !== 'message-published' && !row.joinedDeliveryId);
            const delivery = deliveries[0];
            if (deliveries.length !== 1 || !delivery?.childSessionId || !delivery.childMessageId || delivery.state !== 'completed') throw new Error();
            const session = await ctx.sessionController.inspect(SessionId(delivery.childSessionId));
            const inputIndex = session.events.findIndex(event => event.type === 'user/message' && event.data.id === delivery.childMessageId && event.data.source.kind === 'dsh-bot-group-proactive' && event.data.source.assignmentId === work.assignmentId && event.data.source.ticketId === work.ticketId && event.data.source.turnId === turn.id);
            if (inputIndex < 0) throw new Error();
            const events = session.events.slice(inputIndex + 1);
            const answers = events.filter(event => event.type === 'assistant/message');
            const answer = answers[0], end = events.findLast(event => event.type === 'turn/end');
            const model = proactiveMemberModel(review, memberId);
            if (answers.length !== 1 || answer?.type !== 'assistant/message' || answer.data.interrupted || end?.type !== 'turn/end' || end.data.turn !== answer.data.turn || end.data.reason.kind !== 'completed' || answer.data.message.source.provider !== model.provider || answer.data.message.source.model !== model.model) throw new Error();
            const usage = observedModelUsage(answer.data.usage);
            if (!usage) throw new Error();
            knownNativeTokens += usage.inputTokens + usage.outputTokens;
          } catch { unknownMeasurements++; }
        }
      }
    } catch { unknownMeasurements++; }
  }
  return { attempts: attempts.length, knownNativeTokens, unknownMeasurements, externalUnits };
}
