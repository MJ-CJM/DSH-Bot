import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DshBotRegistry } from '../registry.js';
import type { Generator } from './consolidation.js';
import { assertModelBudget, observedModelUsage } from '../proactive/model-budget.js';
import { waitIdle } from '../proactive/execution.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-bot-memory-consolidation': { kind: 'dsh-bot-memory-consolidation'; form: 'notice'; summary: string };
  }
}
/** Native Agent lifecycle, scoped tool denial and one-request budget; no custom model runtime. */
export function nativeConsolidation(ctx: Context, registry: DshBotRegistry): Generator {
  return async ({ run, prompt, signal, check }) => {
    const config = registry.config.memoryConsolidation, cwd = join(registry.config.dataDir, 'memory-consolidation');
    await mkdir(cwd, { recursive: true, mode: 0o700 }); check();
    let requested = false, streamed = false;
    const handle = await ctx.agents.create({ sessionId: SessionId(run.sessionId), meta: { cwd }, signal,
      agentOptions: { provider: run.provider, model: run.model, maxTokens: config.maxOutputTokens },
      setup: async agentCtx => {
        await agentCtx.effect(() => {
          const restrict = agentCtx.tools.restrict({ allow: [] });
          const guard = agentCtx.tools.guard(() => 'Memory consolidation cannot execute tools');
          const request = agentCtx.on('agent/request', async () => {
            check(); if (requested) throw new Error('Consolidation request budget exhausted'); requested = true;
            return { provider: run.provider, model: run.model, maxTokens: config.maxOutputTokens };
          }, { prepend: true });
          const retry = agentCtx.on('agent/request-error', async () => undefined, { prepend: true });
          const stream = agentCtx.on('llm/stream', (options, next) => {
            check(); if (streamed || options.sessionId !== run.sessionId || options.provider !== run.provider || options.model !== run.model)
              throw new Error('Consolidation request identity changed');
            assertModelBudget(options, config.maxInputChars * 4 + config.maxOutputTokens + 8192);
            streamed = true; return next();
          }, { prepend: true });
          return () => { stream(); retry(); request(); guard(); restrict(); };
        }, 'dsh-bot: bounded memory consolidation');
      } });
    const { agent } = handle;
    try {
      check();
      if (agent.ctx.tools.schemas(agent).length) throw new Error('Consolidation tool restriction failed');
      registry.memoryAdmission.protect(agent);
      await registry.memoryAdmission.recordRead(agent.id, run.sourceIds);
      const message = createUserMessage({ source: { kind: 'dsh-bot-memory-consolidation', form: 'notice', summary: 'Owner-requested memory review' },
        content: [{ type: 'text', text: prompt }] });
      check(); agent.followup(message); await waitIdle(agent, signal); check();
      const events = agent.session.snapshotEvents();
      const start = events.findIndex(e => e.type === 'user/message' && e.data.id === message.id);
      const tail = events.slice(start + 1);
      const answer = tail.find(e => e.type === 'assistant/message');
      if (start < 0 || !streamed || answer?.type !== 'assistant/message' || answer.data.interrupted ||
        answer.data.message.source.provider !== run.provider || answer.data.message.source.model !== run.model ||
        answer.data.message.content.some(b => b.type === 'tool-call') || !tail.some(e => e.type === 'turn/end') ||
        !await ctx.sessions.flush(agent.session)) throw new Error('Native completion receipt unavailable');
      const usage = observedModelUsage(answer.data.usage);
      return { text: answer.data.message.content.filter(b => b.type === 'text').map(b => b.text).join(''), ...usage };
    } finally {
      agent.cancel({ kind: 'hook', reason: 'Consolidation finished' }, { keepInbox: false });
      await agent.whenIdle(); await handle.dispose();
    }
  };
}
