import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { MessageId } from '@deepseek-ai/dsh-llm';
import { getBotBinding } from '../bot-context.js';
import type { ReportMessage, ReportRuntime } from './reporter.js';
import type { DshBotRegistry } from '../registry.js';
import { reportMessageSchema } from '../../shared/automation.js';

export function dshReportRuntime(ctx: Context, bots: Pick<DshBotRegistry, 'get'>): ReportRuntime {
  return {
    async resolve(run) {
      const id = run.originSessionId as SessionId;
      const checkOrigin = async () => {
        if (!id || !run.originBotId || ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw new Error('Origin unavailable');
        // inspect never creates a replacement and fails for deleted sessions.
        await ctx.sessionController.inspect(id);
        const bot = await bots.get(run.originBotId);
        if (bot.createdAt !== run.originBotCreatedAt) throw new Error('Origin identity changed');
        if (ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw new Error('Origin archived');
      };
      await checkOrigin();
      const resolved = await ctx.sessionController.resolveAgent(id);
      if ('error' in resolved) throw new Error('Origin cannot be restored');
      const agent = resolved.agent;
      const validate = async () => {
        await checkOrigin();
        const binding = getBotBinding(agent);
        if (agent.session.id !== id || ctx.agents.get(id) !== agent || binding?.botId !== run.originBotId
          || binding?.botCreatedAt !== run.originBotCreatedAt) throw new Error('Origin binding changed');
      };
      await validate();
      const matches = (candidate: unknown, message: ReportMessage) => {
        const parsed = reportMessageSchema.safeParse(candidate);
        return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(message);
      };
      return {
        validate,
        evidence(message) {
          if (agent.session.snapshotEvents().some(e => e.type === 'user/message' && matches(e.data, message))) return 'committed';
          if ([...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(candidate => matches(candidate, message))) return 'pending';
          return 'absent';
        },
        followup(message) {
          const before = agent.session.snapshotEvents().length;
          agent.followup({ ...message, id: MessageId(message.id) });
          // followup wakes synchronously. The driver may already have claimed
          // the Inbox before user/message is committed; the new splice proves
          // this call enqueued this exact message, even across that brief gap.
          if (!agent.session.snapshotEvents().slice(before).some(e => e.type === 'agent/inbox/spliced'
            && e.data.inserted.some(candidate => matches(candidate, message)))) throw new Error('Missing followup receipt');
        },
        flush: () => ctx.sessions.flush(agent.session),
      };
    },
  };
}
