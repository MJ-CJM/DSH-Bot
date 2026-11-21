import { outlets } from '../data-flow/tool-guard.js';
import { peerResultFromRows, type PeerResult } from './peer-result.js';
import type { PeerQueryInput } from '../../shared/messaging.js';
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
  async resolveQuery(agent: Agent, input: PeerQueryInput) {
    if (this.stopped || !this.store.config.messagingEnabled || !this.provenance(agent).userMessageId)
      throw new OperationError('approval-denied');
    const owner = await this.exact(agent);
    if (input.to === owner.botId) throw new OperationError('invalid');
    const status = (await this.registry.status()).find(row => row.id === input.to);
    if (status?.preset.state !== 'ok') throw new OperationError('unavailable');
    if (input.topic === 'capabilities') {
      const entry = this.registry.directorySnapshot().find(row => row.id === input.to);
      if (!entry) throw new OperationError('unavailable');
      return { status: 'completed' as const, ...entry };
    }
    const result = await this.peerResult(agent, input.to);
    return result.status === 'missing' ? undefined : result;
  }
  async peerResult(agent: Agent, peerId: string, requestId?: string, scopedOnly = false): Promise<PeerResult> {
    if (this.stopped || !this.store.config.messagingEnabled) throw new OperationError('unavailable');
    if (this.provenance(agent).parent) throw new OperationError('approval-denied');
    return this.peerResultForHumanInput(agent, peerId, requestId, scopedOnly);
  }
  /** Host pre-step may call this on the current native human input before its session event is appended. */
  async peerResultForHumanInput(agent: Agent, peerId: string, requestId?: string, scopedOnly = false): Promise<PeerResult> {
    if (this.stopped || !this.store.config.messagingEnabled) throw new OperationError('unavailable');
    const owner = await this.exact(agent);
    const peer = await this.registry.get(peerId), main = await this.registry.mainSessions?.find(peerId);
    if (!main || peer.id === owner.botId) return { status: 'missing' };
    const visible = new Set(agent.session.surface.nodes);
    const peerKey = { botId: peer.id, botCreatedAt: peer.createdAt };
    return peerResultFromRows(this.store.peerRows(owner, peerKey, requestId), owner, peerKey,
      agent.session.id, main.sessionId, agent.session.snapshotEvents().filter(event => visible.has(event.seq)), outlets(this.registry), requestId, scopedOnly,
      this.registry.supergroup?.peerReplyStatus?.bind(this.registry.supergroup));
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
