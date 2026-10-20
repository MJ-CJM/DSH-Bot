import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-subagent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import type { RunRecord } from '../../shared/automation.js';
import type { ExecutorRuntime } from './executor.js';
import type { DshBotRegistry } from '../registry.js';

export function dshExecutorRuntime(ctx: Context, bots: DshBotRegistry): ExecutorRuntime {
  const id = (run: RunRecord) => run.sessionId as SessionId;
  const agent = (run: RunRecord) => {
    const value = ctx.agents.get(id(run));
    if (!value) throw new Error('Run Agent is absent; refusing implicit recovery');
    return value;
  };
  return {
    async resolveBot(botId) {
      const bot = await bots.get(botId);
      const status = (await bots.status()).find(row => row.id === botId);
      if (status?.preset.state !== 'ok') throw new Error('Bot preset is unavailable');
      return { bot, presetId: status.presetId };
    },
    workspace: () => bots.ensureBotsWorkspace(),
    create: run => ctx.sessionController.create({ sessionId: id(run), workspaceId: run.workspaceId as WorkspaceId,
      agentPreset: run.snapshot.presetId }),
    async verify(run) {
      const inspection = await ctx.sessionController.inspect(id(run));
      const workspace = ctx.workspaceRegistry.get(run.workspaceId as WorkspaceId);
      if (inspection.meta.cwd !== run.cwd || inspection.meta.agentPreset !== run.snapshot.presetId
        || !workspace || workspace.path !== run.cwd || !workspace.sessionIds.includes(id(run))) throw new Error('Session placement mismatch');
      agent(run);
    },
    async rename(run, title) {
      const result = await ctx.sessionController.rename({ sessionId: id(run), title });
      if (result.title !== title) throw new Error('Session title mismatch');
    },
    async prompt(run, signal) {
      const receipt = await ctx.sessionController.prompt({ sessionId: id(run), requestId: run.requestId as SessionRequestId,
        mode: 'queue', content: [{ type: 'text', text: run.snapshot.prompt }], clientTimeZone: run.snapshot.timeZone }, signal);
      if (!receipt.accepted) throw new Error('Prompt not accepted');
    },
    async observe(run) {
      const live = agent(run);
      const children = await ctx.subagents.listDescendants(id(run));
      // Unknown catalogs / external execution cannot be proven stopped by absence of a local Session.
      return {
        events: live.session.snapshotEvents(), idle: live.status === 'idle',
        inboxEmpty: live.inbox.nextTurn.length === 0 && live.inbox.nextStep.length === 0,
        jobs: [id(run), ...children.filter(child => child.kind === 'child').map(child => child.id)]
          .flatMap(owner => ctx.jobs.list(owner).filter(job => job.owner === owner)),
        children: children.map(child => ({ id: child.id, activity: child.kind === 'diagnostic'
          || child.mode === 'external' ? 'unknown' as const : child.activity })),
      };
    },
    async stop(run) {
      const live = agent(run);
      live.cancel({ kind: 'user' });
      // Capture exact descendant owners before drain removes their resident Agents.
      const children = await ctx.subagents.listDescendants(id(run));
      for (const owner of [id(run), ...children.filter(c => c.kind === 'child').map(c => c.id)]) {
        for (const job of ctx.jobs.list(owner).filter(j => j.owner === owner && ['running', 'stopping'].includes(j.status))) {
          ctx.jobs.kill(job.id, owner, 'DSH-Bot run stopped');
        }
      }
      await ctx.subagents.drainDescendants([live]);
      await live.whenIdle();
    },
    flush: run => ctx.sessions.flush(agent(run).session),
  };
}
