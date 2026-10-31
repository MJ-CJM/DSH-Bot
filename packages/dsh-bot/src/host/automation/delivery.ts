import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import type { RunRecord, RunRequest } from '../../shared/automation.js';
import type { DshBotRegistry } from '../registry.js';
import type { RunService } from './store.js';
import { AutomationError } from './errors.js';

/** A durable explicit delivery receipt. DSH owns execution in the shared conversation. */
export class MainSessionDelivery {
  private readonly active = new Map<string, Promise<RunRecord>>();
  private stopped = false;
  constructor(
    private readonly ctx: Context,
    private readonly bots: DshBotRegistry,
    private readonly runs: RunService,
  ) {}
  async submit(request: RunRequest): Promise<RunRecord> {
    if (this.stopped) throw new AutomationError('automation/unavailable', 'Delivery is closing');
    const run = await this.runs.enqueue(request);
    const existing = this.active.get(run.id);
    if (existing) return existing;
    if (run.status !== 'queued') return run;
    const task = this.deliver(run.id).finally(() => this.active.delete(run.id));
    this.active.set(run.id, task);
    return task;
  }
  private async deliver(id: string) {
    let run = await this.runs.reserve(id);
    if (run.status !== 'running') return run;
    let submitted = false;
    try {
      const bot = await this.bots.get(run.botId);
      if (bot.createdAt !== run.botCreatedAt) throw new Error('Bot identity changed');
      const main = await this.bots.openConversation(run.botId);
      const current = await this.bots.get(run.botId);
      if (current.createdAt !== run.botCreatedAt) throw new Error('Bot identity changed');
      run = await this.runs.transition(id, 'running', run.revision, { sessionId: main.sessionId, step: 'submitting' });
      submitted = true;
      const receipt = await this.ctx.sessionController.prompt(
        {
          sessionId: main.sessionId as SessionId,
          requestId: run.requestId as SessionRequestId,
          mode: 'queue',
          content: [{ type: 'text', text: run.snapshot.prompt }],
          clientTimeZone: run.snapshot.timeZone,
        },
        new AbortController().signal,
      );
      if (!receipt.accepted) throw new Error('Prompt refused');
      // Delivered is explicitly NOT model completion. Never stop a user's shared session on unload/error.
      return await this.runs.transition(id, 'delivered', run.revision, {}, true);
    } catch {
      run = this.runs.get(id);
      return this.runs.transition(
        id,
        submitted ? 'recovery_needed' : 'failed',
        run.revision,
        { errorCode: submitted ? 'delivery/unconfirmed' : 'delivery/not-submitted' },
        !submitted,
      );
    }
  }
  async close() {
    this.stopped = true;
    await Promise.allSettled([...this.active.values()]);
  }
}
