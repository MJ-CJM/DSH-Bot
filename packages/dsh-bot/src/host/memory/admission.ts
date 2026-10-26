import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { MemoryKernel } from './op-log.js';

export class MemoryAdmission {
  private kernel?: MemoryKernel;
  private stopped = false;
  private ready = false;
  private readonly agents = new Map<string, Agent>();
  private readonly leases = new Map<string, { agent: Agent; done: Promise<void>; finish: () => void }>();
  private readonly seen = new Map<string, string[]>();
  denied = 0;
  get inFlight(): number { return this.leases.size; }
  constructor(private readonly ctx: Context, private readonly presetPrefix = 'bot-') {
    ctx.effect(() => ctx.on('llm/stream', (options, next) => this.stream(options, next, this.kernel?.epoch)),
      'dsh-bot: memory final admission');
  }
  start(kernel: MemoryKernel): void {
    this.kernel = kernel; this.ready = true;
    kernel.listeners.add(this.changed);
  }
  private changed = () => {
    if (!this.kernel?.blocked && !this.stopped) return;
    // No whenIdle here: forget can be called from the very turn being cancelled.
    for (const agent of this.agents.values()) agent.cancel({ kind: 'hook', reason: 'Memory admission blocked' }, { keepInbox: true });
  };
  assertAllowed(): void {
    if (!this.ready || this.stopped || !this.kernel || this.kernel.blocked) throw new Error('Memory admission blocked');
    this.kernel.assertReadable();
    this.kernel.assertOwnership();
  }
  observed(sessionId: string, versionIds: string[]): void { this.seen.set(sessionId, [...versionIds]); }
  /** This effect is intentionally not returned to the preset/Host: it lasts until Agent disposal. */
  protect(agent: Agent): void {
    const id = agent.session.id;
    if (this.agents.get(id) === agent) return;
    this.agents.set(id, agent);
    const admission = this;
    agent.ctx.effect(() => {
      const offStep = agent.ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next();
        try { admission.assertAllowed(); } catch { return { kind: 'reject' as const, reason: 'Memory admission blocked' }; }
        return decision;
      });
      const offStream = agent.ctx.on('llm/stream', async function* (_options, next) {
        admission.assertAllowed(); yield* next();
      });
      const offTools = agent.ctx.tools.guard(() => {
        try { admission.assertAllowed(); } catch { return 'Memory cleanup pending; tool access blocked'; }
      });
      return () => {
        offStep(); offStream(); offTools();
        if (admission.agents.get(id) === agent) admission.agents.delete(id);
        admission.seen.delete(id);
      };
    }, 'dsh-bot: retained memory guard');
  }
  private async *stream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>,
    capturedEpoch: number | undefined): AsyncIterable<StreamChunk> {
    const agent = options.sessionId ? this.agents.get(options.sessionId) : undefined;
    if (!agent) {
      // During startup, unknown ownership, a pending cleanup or shutdown, block the whole runtime.
      try { this.assertAllowed(); } catch (error) { this.denied++; throw error; }
      const live = options.sessionId ? this.ctx.get('agents')?.get(options.sessionId) : undefined;
      const preset = live && this.ctx.get('agentPresets')?.composedPreset(live.ctx);
      if (preset?.startsWith(this.presetPrefix)) { this.denied++; throw new Error('Legacy Bot generation requires safe reattachment'); }
      yield* next(); return;
    }
    const kernel = this.kernel;
    if (!kernel) throw new Error('Memory admission is not ready');
    const epoch = capturedEpoch, id = randomUUID();
    if (epoch === undefined) throw new Error('Memory request predates readiness');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    try {
      await kernel.serial(async () => {
        this.assertAllowed();
        if (epoch !== kernel.epoch) throw new Error('Stale memory request epoch');
        // Every managed request records its actual context dependencies before dispatch.
        await kernel.domain.table('receipts').put(id, { id, epoch, sessionId: agent.session.id,
          versionIds: this.seen.get(agent.session.id) ?? [], state: 'read' });
        this.assertAllowed();
        this.leases.set(id, { agent, done, finish });
      });
      this.assertAllowed();
      if (epoch !== kernel.epoch) throw new Error('Stale memory request epoch');
      yield* next();
    } catch (error) { this.denied++; throw error; }
    finally { this.leases.delete(id); finish(); }
  }
  async close(): Promise<void> {
    this.stopped = true; this.changed();
    if (this.kernel) this.kernel.listeners.delete(this.changed);
    await Promise.all([...this.leases.values()].map(l => l.done));
  }
}
