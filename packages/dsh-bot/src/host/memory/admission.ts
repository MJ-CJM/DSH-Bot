import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { isAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { preserveInbox } from './preserve-inbox.js';
import { removalNotice } from './history.js';
import type { MemoryKernel } from './op-log.js';

export class MemoryAdmission {
  private kernel?: MemoryKernel;
  private stopped = false;
  private ready = false;
  private readonly agents = new Map<string, Agent>();
  private readonly leases = new Map<string, { agent: Agent; done: Promise<void>; finish: () => void }>();
  private readonly seen = new Map<string, string[]>();
  private readonly audits = new Map<string, { inputId: string; admitted: boolean; request?: GenerateOptions }>();
  private readonly cleanupReads = new Map<string, Agent>();
  denied = 0;
  /** Exact one-call capability: no arbitrary tool or model bypass while the barrier is held. */
  async cleanupRead<T>(agent: Agent, callId: string, read: () => Promise<T>): Promise<T> {
    this.cleanupReads.set(callId, agent);
    try { return await read(); } finally { this.cleanupReads.delete(callId); }
  }
  assertToolAllowed(exec: { agent?: Agent; callId: string; name: string }): void {
    if (this.stopped || !this.ready) throw new Error('Memory admission stopped');
    this.kernel?.assertOwnership();
    if (exec.agent && exec.name === 'mcp__bot_memory_graph__read_graph' && this.cleanupReads.get(exec.callId) === exec.agent) return;
    this.assertAllowed();
    // Raw events are intentionally retained. After forgetting, unreviewed readers and side-effect tools stay closed.
    if (this.kernel?.snapshot.forgotten.size && !['bot_memory_save', 'bot_memory_search', 'bot_memory_list', 'bot_memory_forget',
      'mcp__bot_memory_graph__read_graph', 'mcp__bot_memory_graph__search_nodes',
      'mcp__bot_memory_graph__open_nodes'].includes(exec.name)) throw new Error('Raw history access is restricted after memory cleanup');
  }
  /** Native request assembly, captured at final admission without reaching any provider or executing a tool. */
  async verifyRequest(agent: Agent): Promise<GenerateOptions> {
    if (this.audits.has(agent.session.id)) throw new Error('Request verification busy');
    if (agent.inbox.nextStep.length || agent.inbox.nextTurn.length) throw new Error('Inbox requires review');
    const input = removalNotice(), audit = { inputId: input.id, admitted: false, request: undefined as GenerateOptions | undefined };
    this.audits.set(agent.session.id, audit);
    try {
      agent.followup(input); await agent.whenIdle();
      if (!audit.request) throw new Error('No complete native request captured');
      return audit.request;
    } finally { this.audits.delete(agent.session.id); }
  }
  private auditRequest(options: GenerateOptions): boolean {
    const audit = options.sessionId ? this.audits.get(options.sessionId) : undefined;
    const agent = options.sessionId ? this.agents.get(options.sessionId) : undefined;
    if (!audit?.admitted || !agent || !isAgentLoopRequest(options) ||
      !isDeepStrictEqual(options.messages, agent.session.deriveMessages()) ||
      !options.messages.some(message => 'id' in message && message.id === audit.inputId)) return false;
    if (audit.request) throw new Error('Duplicate verification request');
    audit.request = options; return true;
  }
  get inFlight(): number { return this.leases.size; }
  sessions(): Agent[] { return [...this.agents.values()]; }
  async drain(): Promise<void> {
    this.changed();
    await Promise.all([...this.leases.values()].map(l => l.done));
  }
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
      const inbox = preserveInbox(agent, () => {
        try { admission.assertAllowed(); return false; } catch { return true; }
      });
      const offStep = agent.ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        const audit = admission.audits.get(id);
        if (audit && payload.messages.length === 1 && payload.messages[0]?.id === audit.inputId) {
          audit.admitted = true; return decision;
        }
        try { admission.assertAllowed(); } catch {
          inbox.restore(payload.messages);
          return { kind: 'reject' as const, reason: 'Memory admission blocked' };
        }
        return decision;
      });
      const offStream = agent.ctx.on('llm/stream', async function* (options, next) {
        if (admission.auditRequest(options)) { yield { type: 'finish', reason: { kind: 'stop' } }; return; }
        admission.assertAllowed(); yield* next();
      });
      const offTools = agent.ctx.tools.guard(exec => {
        try { admission.assertToolAllowed(exec); } catch { return 'Memory cleanup pending; tool access blocked'; }
      });
      return () => {
        offStep(); offStream(); offTools(); inbox.dispose();
        if (admission.agents.get(id) === agent) admission.agents.delete(id);
        admission.seen.delete(id);
      };
    }, 'dsh-bot: retained memory guard');
  }
  private assertSurface(agent: Agent, options: GenerateOptions): void {
    if (this.kernel?.snapshot.forgotten.size && (!isAgentLoopRequest(options) ||
      !isDeepStrictEqual(options.messages, agent.session.deriveMessages()) ||
      !isDeepStrictEqual(options.toolHistory, agent.session.toolHistory()))) throw new Error('Stale memory request epoch or surface');
  }
  private async *stream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>,
    capturedEpoch: number | undefined): AsyncIterable<StreamChunk> {
    if (this.auditRequest(options)) { yield { type: 'finish', reason: { kind: 'stop' } }; return; }
    const agent = options.sessionId ? this.agents.get(options.sessionId) : undefined;
    if (!agent) {
      if (this.kernel?.snapshot.forgotten.size) throw new Error('Memory admission blocked: request ownership unknown after cleanup');
      // During startup, unknown ownership, a pending cleanup or shutdown, block the whole runtime.
      try { this.assertAllowed(); } catch (error) { this.denied++; throw error; }
      const live = options.sessionId ? this.ctx.get('agents')?.get(options.sessionId) : undefined;
      const preset = live && this.ctx.get('agentPresets')?.composedPreset(live.ctx);
      if (preset?.startsWith(this.presetPrefix)) { this.denied++; throw new Error('Legacy Bot generation requires safe reattachment'); }
      yield* next(); return;
    }
    const kernel = this.kernel;
    if (!kernel) throw new Error('Memory admission is not ready');
    this.assertSurface(agent, options);
    const epoch = capturedEpoch, id = randomUUID();
    if (epoch === undefined) throw new Error('Memory request predates readiness');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    try {
      await kernel.serial(async () => {
        this.assertAllowed(); this.assertSurface(agent, options);
        if (epoch !== kernel.epoch) throw new Error('Stale memory request epoch');
        // Every managed request records its actual context dependencies before dispatch.
        await kernel.domain.table('receipts').put(id, { id, epoch, sessionId: agent.session.id,
          versionIds: this.seen.get(agent.session.id) ?? [], state: 'read' });
        this.assertAllowed();
        this.leases.set(id, { agent, done, finish });
      });
      this.assertAllowed(); this.assertSurface(agent, options);
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
