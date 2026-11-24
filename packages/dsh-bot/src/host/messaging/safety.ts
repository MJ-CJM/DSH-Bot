import { withoutWakeControls } from './wake.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import type { MessageInput, PeerQueryInput } from '../../shared/messaging.js';
import type { BotKey } from '../../shared/identity.js';
import { digest, OperationError } from '../common/operations.js';
import type { MessagingAuthorization } from './core.js';
import { isLiveScopedCollaboration } from '../supergroup/collaboration.js';
import { ownsWorkerCapability } from '../groups/worker-capabilities.js';
const reads = new Set(['bot_memory_search', 'bot_memory_list']);
export function teammateTurn(agent: Agent): boolean {
  const events = agent.session.snapshotEvents();
  const start = events.findLast((e) => e.type === 'turn/start')?.seq ?? -1;
  return events.some((e) => e.seq > start && e.type === 'user/message' &&
    !agent.ctx?.get?.('dshBotMessaging')?.isDisplayMessage?.(agent, e.data) &&
    ['dsh-bot-message', 'dsh-bot-message-sent', 'dsh-bot-message-wake'].includes(e.data.source.kind));
}
export function invocation(agent: Agent, exec: ToolExecution): string {
  return JSON.stringify([agent.session.snapshotEvents().findLast((e) => e.type === 'step/start' || e.type === 'turn/start')?.seq,
    exec.rootCallId, exec.callId]);
}
export class MessagingSafety implements MessagingAuthorization {
  private grants = new Map<string, { agent: Agent; digest: string;
    target: BotKey; id: string; targets: BotKey[]; signal?: AbortSignal; valid?: () => boolean }>();
  private scopes = new Map<string, BotKey[]>();
  targets(id: string) { const targets = this.scopes.get(id); this.scopes.delete(id); return targets; }
  active = true;
  revoke(key: string) { this.grants.delete(key); }
  close() { this.active = false; this.grants.clear(); this.scopes.clear(); }
  async approve(agent: Agent, input: Exclude<MessageInput, { action: 'list' }> | PeerQueryInput, target: BotKey, invocation = '') {
    const grant = this.grants.get(invocation);
    this.grants.delete(invocation);
    grant?.signal?.throwIfAborted();
    if (!this.active || !grant || grant.valid?.() === false
      || grant.agent !== agent || grant.digest !== digest(input) || digest(grant.target) !== digest(target))
      throw new OperationError('approval-denied');
    this.scopes.set(grant.id, grant.targets);
    return grant.id;
  }
  grant(agent: Agent, input: MessageInput | PeerQueryInput, target: BotKey, invocation: string, targets: BotKey[], signal?: AbortSignal, valid?: () => boolean) {
    if (!this.active) throw new OperationError('unavailable');
    this.grants.set(invocation, { agent, digest: digest(input), target, id: `native:${randomUUID()}`, targets, signal, valid });
  }
  /** Guard ownership is the retained Agent, not the preset or Host plugin fiber. */
  protect(agent: Agent) {
    const ctx = agent.ctx;
    ctx.effect(() => {
      const reason = (exec: ToolExecution) => {
        if (exec.name === 'bot_message' && exec.parent !== undefined) return 'bot_message is disabled inside run_code';
        if (!teammateTurn(agent)) return;
        if (!this.active || exec.agent !== agent || exec.parent !== undefined) return 'Teammate tool boundary is unavailable';
        const permitted = reads.has(exec.name) || exec.name === 'bot_message' ||
          (exec.name === 'bot_delegate' && isLiveScopedCollaboration(agent));
        if (!permitted || !ownsWorkerCapability(agent, exec.name))
          return 'Teammate turns can only use this Bot’s communication and private memory lookup tools';
      };
      const wakeOff = ctx.on('agent/pre-step', async (payload, next) =>
        withoutWakeControls(payload.messages, await next()));
      const off = ctx.on('tools/pre-execute', async (exec, next) => {
        const denied = reason(exec);
        return denied ? { kind: 'deny', reason: denied } : next();
      }, { prepend: true });
      const guard = ctx.tools.guard(reason);
      return () => { off(); guard(); wakeOff(); };
    }, 'dsh-bot: retained teammate safety');
  }
}

declare module '@deepseek-ai/cordis' { interface Context { dshBotMessagingSafety: MessagingSafety; } }
