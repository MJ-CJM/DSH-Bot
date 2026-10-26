import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';

/** Preserve public Inbox boundaries even if native claim is rejected/cancelled before user/message commits. */
export function preserveInbox(agent: Agent, blocked: () => boolean) {
  type Target = 'next-step' | 'next-turn';
  const origins = new Map<string, Target>();
  const claimed = new Map<string, { message: UserMessage; target: Target }>();
  const remember = (message: UserMessage) => origins.set(message.id,
    agent.inbox.nextStep.some(m => m.id === message.id) ? 'next-step' : 'next-turn');
  for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) remember(message);
  const restore = (messages = [...claimed.values()].map(row => row.message)) => {
    const pending = new Set([...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(m => m.id));
    const rows = messages.flatMap(message => {
      const row = claimed.get(message.id); claimed.delete(message.id);
      return row && !pending.has(message.id) ? [row] : [];
    });
    for (const target of ['next-step', 'next-turn'] as const) {
      const inserted = rows.filter(row => row.target === target).map(row => row.message);
      if (inserted.length) agent.inbox.splice(target, 0, 0, inserted);
    }
  };
  const off = [
    agent.ctx.on('agent/inbox/inserted', ({ message }) => { remember(message); }),
    agent.ctx.on('agent/inbox/discarded', ({ message }) => { origins.delete(message.id); claimed.delete(message.id); }),
    agent.ctx.on('agent/inbox/claimed', ({ message }) => {
      claimed.set(message.id, { message, target: origins.get(message.id) ?? 'next-step' }); origins.delete(message.id);
    }),
    agent.ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'user/message') claimed.delete(event.data.id);
    }),
    agent.ctx.on('agent/status', ({ status }) => {
      if (status !== 'idle') return;
      if (blocked()) restore(); else claimed.clear();
    }),
  ];
  return { restore, dispose: () => { for (const dispose of off) dispose(); origins.clear(); claimed.clear(); } };
}
