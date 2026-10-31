import type { Agent } from '@deepseek-ai/dsh-agent';
import type { BotKey } from '../../shared/identity.js';
import type { DshBotRegistry } from '../registry.js';
/** Agent-owned protection survives retained presets; a stopped service rejects old sources. */
export function protectOnboarding(agent: Agent, bot: BotKey, registry: DshBotRegistry) {
  return agent.ctx.effect(() => {
    let active = false;
    let rewaking = false;
    const pre = agent.ctx.on('agent/pre-step', async (payload, next) => {
      const messages = payload.messages.filter(m => m.source.kind === 'dsh-bot-onboarding');
      if (messages.length) {
        const service = registry.onboarding, [message] = messages;
        if (messages.length !== 1 || !message || !service?.owns(agent, bot, message)) {
          active = false; return { kind: 'reject' };
        }
        if (payload.messages.some(m => m.source.kind === 'user')) {
          active = false; service.userWon(agent, bot);
          const decision = await next();
          return decision.kind === 'enter' ? { ...decision, messages: decision.messages.filter(m => m.id !== message.id) } : decision;
        }
        const pendingStep = agent.inbox.nextStep.findLast(m => m.source.kind === 'user');
        const pendingTurn = agent.inbox.nextTurn.findLast(m => m.source.kind === 'user');
        const pending = pendingStep ?? pendingTurn;
        if (pending) {
          active = false; service.userWon(agent, bot);
          agent.cancel({ kind: 'hook', reason: 'onboarding-user-priority' }, { keepInbox: true });
          // Re-wake the original identified item after cancellation. No new
          // message is constructed, and its original inbox boundary is retained.
          if (agent.inbox.remove(pending.id)) agent.send(pending, pendingStep ? 'next-step' : 'next-turn', true);
          return { kind: 'reject' };
        }
        active = true;
      } else if (payload.messages.some(m => m.source.kind === 'user')) { active = false; registry.onboarding?.userWon(agent, bot); }
      return next();
    }, { prepend: true });
    const guard = agent.ctx.tools.guard(() => active ? 'New Bot introduction is text-only; wait for the user task before using tools' : undefined);
    const request = agent.ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next();
      return registry.onboarding?.requestConfig(agent, resolved, active) ?? resolved;
    }, { prepend: true });
    const inserted = agent.ctx.on('agent/inbox/inserted', ({ message }) => {
      if (active && !rewaking && message.source.kind === 'user') {
        const target = agent.inbox.nextStep.some(m => m.id === message.id) ? 'next-step' : 'next-turn';
        registry.onboarding?.userWon(agent, bot);
        agent.cancel({ kind: 'hook', reason: 'onboarding-user-priority' }, { keepInbox: true });
        // send() classifies wake-before-abort before emitting this insertion.
        // Re-submit the very same pending item after the cancellation to latch
        // its wake at driver convergence, suppressing this reentrant observer.
        if (agent.inbox.remove(message.id)) {
          rewaking = true;
          try { agent.send(message, target, true); } finally { rewaking = false; }
        }
      }
    });
    const end = agent.ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') active = false; });
    return () => { pre(); guard(); request(); inserted(); end(); };
  }, 'dsh-bot: text-only onboarding');
}
