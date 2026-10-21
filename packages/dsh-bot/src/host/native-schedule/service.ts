import type { Context } from '@deepseek-ai/cordis';
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { scheduleBindingSchema, type ScheduleBinding, type NativeAggregate } from '../../shared/native-schedule.js';
import { routineRecordSchema } from '../../shared/automation.js';
import type { DshBotRegistry } from '../registry.js';
import { getBotBinding } from '../bot-context.js';
import { AutomationError } from '../automation/errors.js';

export const bindingDomain = defineDomain({ name: 'dsh_bot_native_schedule', version: 1,
  tables: { bindings: domainTable(scheduleBindingSchema) } });
// Unknown values are intentional: v0.2.0 corrupt rows must not block startup.
export const legacyDomain = defineDomain({ name: 'dsh_bot_automation', version: 1,
  tables: { routines: domainTable(z.unknown()), runs: domainTable(z.unknown()), control: domainTable(z.unknown()) } });
export class NativeSchedules {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private legacy?: Domain<typeof legacyDomain>;
  private legacyUnavailable = false;
  private bindings!: Domain<typeof bindingDomain>;
  private closing?: Promise<void>;
  private unsubscribe?: () => void;
  constructor(private readonly ctx: Context, private readonly bots: Pick<DshBotRegistry, 'list' | 'status'>) {}
  async start() {
    this.bindings = await this.ctx.storageDomain.open(bindingDomain);
    try { this.legacy = await this.ctx.storageDomain.open(legacyDomain); }
    catch { this.legacyUnavailable = true; this.ctx.logger.warn('[dsh-bot] legacy automation unreadable; disabled and left untouched'); }
    this.unsubscribe = this.ctx.effect(() => this.ctx.on('schedule/changed', () => {
      void this.aggregate().catch(() => this.ctx.logger.warn('[dsh-bot] native schedule binding refresh failed'));
    }), 'dsh-bot: native schedule changes');
    this.ctx.effect(() => () => this.close(), 'dsh-bot: native schedule stores');
    await this.aggregate();
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AutomationError('automation/unavailable', 'Native schedule aggregation closed'));
    const pending = this.tail.then(work); this.tail = pending.catch(() => {}); return pending;
  }
  private async reconcile(): Promise<ScheduleBinding[]> {
    const schedule = this.ctx.get('schedule');
    if (!schedule) return [];
    const catalog = await schedule.catalog();
    const bots = await this.bots.list();
    const statuses = await this.bots.status();
    const table = this.bindings.table('bindings');
    const visible: ScheduleBinding[] = [];
    for (const task of catalog) {
      let binding = table.get(task.id);
      if (binding && (binding.nativeScheduleId !== task.id || binding.sessionId !== task.sessionId)) continue;
      if (!binding) {
        const live = this.ctx.agents.get(task.sessionId);
        const bound = live ? getBotBinding(live) : undefined;
        const header = live?.session.header;
        let identity = bound && header && header.createdAt >= bound.botCreatedAt && !header.isSeeded
          && !header.parentSession && header.origin !== 'subagent' && !(header.delegationDepth ?? 0) ? bound : undefined;
        // A live Agent with no Bot binding is not inferred from its old header.
        if (!live) {
          try {
            const meta = (await this.ctx.get('sessionPersistence')?.stat(task.sessionId))?.header;
            if (!meta) continue;
            const target = bots.find(bot => meta.createdAt >= bot.createdAt
              && statuses.some(status => status.id === bot.id && status.presetId === meta.agentPreset));
            if (target && !meta.isSeeded && !meta.parentSession && meta.origin !== 'subagent' && !(meta.delegationDepth ?? 0)) {
              identity = { botId: target.id, botCreatedAt: target.createdAt };
            }
          } catch { /* Missing/unreadable sessions remain unassigned. No title inference. */ }
        }
        if (!identity || !bots.some(bot => bot.id === identity.botId && bot.createdAt === identity.botCreatedAt)) continue;
        binding = { ...identity, sessionId: task.sessionId, nativeScheduleId: task.id };
        await table.put(task.id, binding);
      }
      // Keep stale bindings as tombstones. Never rebind a replaced Bot.
      if (bots.some(bot => bot.id === binding.botId && bot.createdAt === binding.botCreatedAt)) visible.push(binding);
    }
    return visible;
  }
  aggregate(): Promise<NativeAggregate> {
    return this.serialize(async () => {
      const bindings = await this.reconcile();
      const legacy: NativeAggregate['legacy'] = []; let legacySkipped = 0;
      for (const [key, raw] of this.legacy?.table('routines').entries() ?? []) {
        const parsed = routineRecordSchema.safeParse(raw);
        if (!parsed.success || parsed.data.id !== key) { legacySkipped++; continue; }
        const r = parsed.data;
        if (r.deletedAt !== undefined) continue;
        legacy.push({ id: r.id, botId: r.botId, botCreatedAt: r.botCreatedAt, title: r.title, prompt: r.prompt });
      }
      return { bindings, legacy, legacySkipped, legacyUnavailable: this.legacyUnavailable, nativeAvailable: Boolean(this.ctx.get('schedule')) };
    });
  }
  async task(id: string): Promise<{ binding: ScheduleBinding; task: ScheduleCatalogEntry }> {
    const { bindings } = await this.aggregate();
    const binding = bindings.find(row => row.nativeScheduleId === id);
    const task = (await this.ctx.get('schedule')?.catalog() ?? []).find(row => row.id === id && row.sessionId === binding?.sessionId);
    if (!binding || !task) throw new AutomationError('automation/not-found', 'Bound native task not found');
    return { binding, task };
  }
  deleteLegacy(id: string) {
    return this.serialize(async () => {
      if (!this.legacy) throw new AutomationError('automation/unavailable', 'Legacy store unavailable');
      // Delete only the selected row. Unknown runs/control and every other row remain intact.
      await this.legacy.table('routines').delete(id);
    });
  }
  close(): Promise<void> {
    this.closing ??= (async () => { this.closed = true; this.unsubscribe?.(); await this.tail; await this.legacy?.close(); await this.bindings?.close(); })();
    return this.closing;
  }
}
