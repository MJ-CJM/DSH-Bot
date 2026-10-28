import { z } from 'zod';
import { Serial } from '../common/operations.js';
import { sameBot } from '../../shared/identity.js';
import { policySchema, type NotificationPolicy } from '../../shared/notifications.js';
import type { ShadowStatus } from '../../shared/shadow.js';
import type { ShadowConfig } from './config.js';
import { dueSchema, type SyntheticDue } from './schedule-adapter.js';
import { localTime, notificationDecision } from './notification-adapter.js';
export const shadowStateSchema = z.strictObject({
  seen: z.array(z.string()), days: z.record(z.string(), z.number().int().nonnegative()),
  last: z.record(z.string(), z.number().int().nonnegative()),
  highWater: z.number().int().nonnegative(), opportunities: z.number().int().nonnegative(), candidates: z.number().int().nonnegative(),
});
export type ShadowState = z.output<typeof shadowStateSchema>;
export const emptyShadow = (): ShadowState => ({ seen: [], days: {}, last: {}, highWater: 0, opportunities: 0, candidates: 0 });
/** Reports only. No clock, schedule registration, Agent, send, memory, or model capability is accepted. */
export class ShadowPlanner {
  private queue = new Serial();
  private frozen = false;
  private state: ShadowState;
  constructor(private config: ShadowConfig, initial: ShadowState,
    private persist: (state: ShadowState) => Promise<void>) {
    this.state = shadowStateSchema.parse(initial);
  }
  status(): ShadowStatus {
    return { mode: 'offline-only', shadowEnabled: this.config.shadowEnabled,
      offlineOrganizeEnabled: this.config.offlineOrganizeEnabled,
      opportunities: this.state.opportunities, candidates: this.state.candidates, modelRequests: 0, notifications: 0, memoryWrites: 0 };
  }
  snapshot() { return structuredClone(this.state); }
  evaluate(raw: SyntheticDue, rawPolicy: NotificationPolicy) {
    return this.queue.run(async () => {
      if (this.frozen) throw Error('Shadow persistence unknown; reopen');
      const due = dueSchema.parse(raw), policy = policySchema.parse(rawPolicy);
      if (!sameBot(due.owner, policy.owner)) throw Error('Policy owner mismatch');
      if (!this.config.shadowEnabled) return { candidate: false, reason: 'disabled', mode: 'offline-only' };
      const next = this.snapshot();
      const bot = `bot:${due.owner.botId}`, botDay = `${bot}:${localTime(due.at, policy.timezone).day}`;
      const domainDay = `domain:${localTime(due.at, 'UTC').day}`;
      let reason = next.seen.includes(due.occurrenceId) ? 'duplicate' : due.at < next.highWater ? 'clock-backward' :
        notificationDecision(due.at, policy, next.days[botDay] ?? 0, next.last[bot]);
      if (reason === 'eligible' && (next.days[domainDay] ?? 0) >= this.config.shadowDomainDaily) reason = 'domain-budget';
      if (reason === 'eligible' && (next.days[botDay] ?? 0) >= this.config.shadowBotDaily) reason = 'bot-budget';
      if (reason === 'eligible' && !due.relevant) reason = 'irrelevant';
      const candidate = reason === 'eligible';
      next.opportunities++; next.highWater = Math.max(next.highWater, due.at);
      if (!next.seen.includes(due.occurrenceId)) next.seen.push(due.occurrenceId);
      if (candidate) {
        next.candidates++; next.days[domainDay] = (next.days[domainDay] ?? 0) + 1;
        next.days[botDay] = (next.days[botDay] ?? 0) + 1; next.last[bot] = due.at;
      }
      try { await this.persist(shadowStateSchema.parse(next)); }
      catch (error) { this.frozen = true; throw error; }
      this.state = next;
      return { candidate, reason, mode: 'offline-only' };
    });
  }
  async close() { await this.queue.close(); }
}
