import { keyOf } from './store.js';
import { OperationError } from '../common/operations.js';
import { isWake, withoutWakeControls } from './wake.js';

import type { Agent } from '@deepseek-ai/dsh-agent';
import { getBotBinding } from '../bot-context.js';
import { MessagingRouting } from './reply-routing.js';
export { messagingDomain } from './store.js';
export type { MessagingAuthorization, MessagingCapabilities } from './core.js';
export class Messaging extends MessagingRouting {
  async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new OperationError('unavailable');
    const row = this.store.get(id);
    if (!row) throw new OperationError('not-found');
    const key = keyOf(row.envelope.to);
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
    if (!this.capabilities.processing) return;
    this.releases.push(
      this.ctx.on('session/event', (session, event) => {
        if (!['user/message', 'assistant/message', 'turn/end', 'agent/inbox/spliced'].includes(event.type))
          return;
        for (const r of this.store.rows())
          if (
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
      if (['queued', 'delivering', 'delivered', 'unknown'].includes(r.delivery))
        this.kick(r.envelope.id, true);
  }

}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotMessaging: Messaging;
  }
}
