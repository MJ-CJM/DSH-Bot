import { withoutWakeControls } from './wake.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import type { MessageInput } from '../../shared/messaging.js';
import type { BotKey } from '../../shared/identity.js';
import { digest, OperationError } from '../common/operations.js';
import type { MessagingAuthorization } from './core.js';
// Explicitly audited local reads only. MCP, run_code and unknown tools always ask.
const reads = new Set(['bot_memory_search', 'bot_memory_list']);
export function teammateTurn(agent: Agent): boolean {
  const events = agent.session.snapshotEvents();
  const start = events.findLast((e) => e.type === 'turn/start')?.seq ?? -1;
  return events.some((e) => e.seq > start && e.type === 'user/message' &&
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
  async approve(agent: Agent, input: Exclude<MessageInput, { action: 'list' }>, target: BotKey, invocation = '') {
    const grant = this.grants.get(invocation);
    this.grants.delete(invocation);
    grant?.signal?.throwIfAborted();
    if (!this.active || !grant || grant.valid?.() === false
      || grant.agent !== agent || grant.digest !== digest(input) || digest(grant.target) !== digest(target))
      throw new OperationError('approval-denied');
    this.scopes.set(grant.id, grant.targets);
    return grant.id;
  }
  grant(agent: Agent, input: MessageInput, target: BotKey, invocation: string, targets: BotKey[], signal?: AbortSignal, valid?: () => boolean) {
    if (!this.active) throw new OperationError('unavailable');
    this.grants.set(invocation, { agent, digest: digest(input), target, id: `native:${randomUUID()}`, targets, signal, valid });
  }
  /** Guard ownership is the retained Agent, not the preset or Host plugin fiber. */
  protect(agent: Agent) {
    const ctx = agent.ctx;
    ctx.effect(() => {
      const decisions = new WeakSet<ToolExecution>();
      const wakeOff = ctx.on('agent/pre-step', async (payload, next) =>
        withoutWakeControls(payload.messages, await next()));
      const off = ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next();
        if (decision.kind === 'deny' || decision.kind === 'cancel') return decision;
        if (!teammateTurn(agent) || reads.has(exec.name) || exec.name === 'bot_message') return decision;
        decisions.add(exec);
        const displayReason = {
          en: `Teammate data is not user authorization. Approve ${exec.name}: ${JSON.stringify(exec.arguments)}`,
          zh: `队友消息不代表用户授权。请审批 ${exec.name}：${JSON.stringify(exec.arguments)}`,
        };
        if (decision.kind === 'ask') {
          displayReason.en += `\n${decision.displayReason?.en ?? decision.reason}`;
          displayReason.zh += `\n${decision.displayReason?.zh ?? decision.reason}`;
        }
        return { kind: 'ask', reason: displayReason.en, displayReason };
      }, { prepend: true });
      const guard = ctx.tools.guard((exec) => {
        if (exec.name === 'bot_message' && exec.parent !== undefined) return 'bot_message is disabled inside run_code';
        if (!teammateTurn(agent)) return;
        if (!this.active) return 'Messaging unloaded; teammate processing requires the safety adapter';
        if (exec.name === 'bot_delegate') return 'Teammate input cannot delegate';
        if (exec.name !== 'bot_message' && !reads.has(exec.name) && !decisions.has(exec))
          return 'Teammate tool approval missing';
      });
      return () => { off(); guard(); wakeOff(); };
    }, 'dsh-bot: retained teammate safety');
  }
}

declare module '@deepseek-ai/cordis' { interface Context { dshBotMessagingSafety: MessagingSafety; } }
