import { keyOf } from './store.js';
import { OperationError } from '../common/operations.js';
import { isWake, withoutWakeControls } from './wake.js';

import type { Agent } from '@deepseek-ai/dsh-agent';
import { getBotBinding } from '../bot-context.js';
import { MessagingProjection } from './scoped-projection.js';
import type { BotKey } from '../../shared/identity.js';
export { messagingDomain } from './store.js';
export type { MessagingAuthorization, MessagingCapabilities } from './core.js';
export class Messaging extends MessagingProjection {
  async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new OperationError('unavailable');
    const row = this.store.get(id);
    if (!row) throw new OperationError('not-found');
    return this.exclusiveTarget(row.envelope.to, work);
  }
  /** Same target queue for native clean task execution and ordinary main-chat delivery. */
  async exclusiveTarget<T>(target: BotKey, work: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new OperationError('unavailable');
    const key = keyOf(target);
    const result = (this.targets.get(key) ?? Promise.resolve()).then(work);
    const done = result.then(() => {}, () => {});
    this.targets.set(key, done); this.track(done);
    void done.finally(() => { if (this.targets.get(key) === done) this.targets.delete(key); });
    return result;
  }
  retry(id: string) { this.kick(id, true); }
  async directory(agent: Agent, cursor?: string, limit = 50) {
    await this.exact(agent);
    const own = getBotBinding(agent)?.botId;
    const rows = this.registry.directorySnapshot().filter((b) => b.id !== own && (!cursor || b.id > cursor));
    const items = rows.slice(0, limit);
    return { items, ...(rows.length > limit ? { cursor: items.at(-1)?.id } : {}) };
  }
  async start() {
    await this.store.reconcile();
    for (const row of this.store.rows()) if (row.execution && ['pending', 'claimed'].includes(row.processing))
      await this.store.update(row.envelope.id, { processing: 'unknown', lastErrorCode: 'scoped-execution-unconfirmed' });
    if (!this.capabilities.processing) return;
    this.releases.push(
      this.ctx.on('session/event', (session, event) => {
        if (!['user/message', 'assistant/message', 'turn/end', 'agent/inbox/spliced'].includes(event.type))
          return;
        for (const r of this.store.rows())
          if (
            !r.execution &&
            r.envelope.toSessionId === session.id &&
            ['delivered', 'delivering', 'unknown'].includes(r.delivery)
          )
            this.kick(r.envelope.id);
      }),
    );
    this.releases.push(
      this.ctx.on(
        'agent/pre-step',
        async (payload, next) => {
          const decision = await next();
          for (const m of payload.messages) if (isWake(m)) this.wakes.delete(m.id);
          return withoutWakeControls(payload.messages, decision);
        },
        { global: true },
      ),
    );
    for (const r of this.store.rows())
      if (!r.execution && ['queued', 'delivering', 'delivered', 'unknown'].includes(r.delivery))
        this.kick(r.envelope.id, true);
  }

}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotMessaging: Messaging;
  }
}
