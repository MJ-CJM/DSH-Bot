/** Isolated mock-only background Session probe. No real provider is configured. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-cordis-host-runner';
import Schema from '@deepseek-ai/schemastery';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const name = 'dsh-bot-mock-session-spike';
export const inject = ['loader', 'agentPresets', 'agentDefaultModel', 'sessionController', 'sessions'];
export interface Config { cwd: string; outputDir: string; expectedReply: string; baseURL: string }
export const Config: Schema<Config> = Schema.object({
  cwd: Schema.string().required(), outputDir: Schema.string().required(),
  expectedReply: Schema.string().required(), baseURL: Schema.string().required(),
});
export function apply(ctx: Context, config: Config): void {
  console.log('T02_MOCK_ACTIVATED');
  ctx.effect(() => {
    const abort = new AbortController();
    let settled = false;
    const task = (async () => {
      await ctx.loader.await();
      settled = true;
      if (abort.signal.aborted) return;
      assert.equal(new URL(config.baseURL).hostname, '127.0.0.1');
      const selection = ctx.agentDefaultModel.currentSelection();
      assert.equal(selection.provider, 'deepseek-official');
      assert.equal(selection.model, 'deepseek-flash');
      await ctx.effect(() => ctx.agentPresets.register({
        id: 'bot-mock-spike', name: 'Mock Bot', description: 'Local mock only', plugins: [],
      }));
      const created = await ctx.sessionController.create({ cwd: config.cwd, agentPreset: 'bot-mock-spike' });
      const resolved = await ctx.sessionController.resolveAgent(created.sessionId);
      if ('error' in resolved) throw resolved.error;
      const receipt = await ctx.sessionController.prompt({
        sessionId: created.sessionId, requestId: randomUUID() as SessionRequestId,
        mode: 'queue', content: [{ type: 'text', text: 'Reply with the local mock fixture.' }],
      }, abort.signal);
      const deadline = Date.now() + 45_000;
      while (!abort.signal.aborted && Date.now() < deadline) {
        const events = resolved.agent.session.snapshotEvents();
        const message = events.find(event => event.type === 'assistant/message');
        if (message?.type === 'assistant/message') {
          const text = message.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('');
          assert.equal(text, config.expectedReply);
          const flushed = await ctx.sessions.flush(resolved.agent.session);
          assert.equal(flushed, true);
          const inspection = await ctx.sessionController.inspect(created.sessionId);
          const result = { status: 'PASS', sessionId: created.sessionId, preset: inspection.meta.agentPreset,
            selection, receipt, flushed, text, eventTypes: events.map(event => event.type) };
          await writeFile(resolve(config.outputDir, 'session-result.json'), `${JSON.stringify(result, null, 2)}\n`);
          console.log('T02_MOCK_DONE');
          return;
        }
        await new Promise(accept => setTimeout(accept, 50));
      }
      throw new Error(`No assistant message; events=${resolved.agent.session.snapshotEvents().map(event => event.type).join(',')}`);
    })().catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      await writeFile(resolve(config.outputDir, 'session-error.json'), JSON.stringify({ message }));
      console.log(`T02_MOCK_FAILED ${message}`);
    });
    return async () => { abort.abort(); if (settled) await task; };
  });
}
