import type { Agent } from '@deepseek-ai/dsh-agent';
import { isAgentLoopRequest, type UserMessage } from '@deepseek-ai/dsh-llm';
import { digest, OperationError } from '../common/operations.js';
import { isNativeAmbientSource } from '../common/native-ambient-source.js';

/** A blank main chat needs its native system head before its first display record. */
export function registerDisplayTurn(agent: Agent): () => void {
  return agent.ctx.on('llm/stream', async function* (options, next) {
    if (options.sessionId === agent.id && !options.purpose && isAgentLoopRequest(options)) {
      const events = agent.session.snapshotEvents();
      const step = events.findLastIndex(event => event.type === 'step/start');
      const input = events.slice(step + 1).filter(event => event.type === 'user/message' && !isNativeAmbientSource(event.data.source.kind));
      const messaging = agent.ctx.get('dshBotMessaging');
      // Newly mirrored display records can coexist. A real user input must still get its normal turn.
      if (step >= 0 && input.length && messaging && input.every(event =>
        event.type === 'user/message' && messaging.isDisplayMessage(agent, event.data))) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
    }
    yield* next();
  });
}

export async function appendDisplay(agent: Agent, message: UserMessage, signal: AbortSignal) {
  signal.throwIfAborted();
  if (agent.session.surface.nodes.length) return agent.session.append('user/message', message, { surfaceOp: 'append' }).seq;
  // When a human has already woken this chat, wait only for its first system head;
  // the caller may be waiting on this delivery inside another Bot's tool execution.
  const busy = agent.status !== 'idle' || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0;
  let off: (() => void) | undefined;
  try {
    await new Promise<void>((accept, reject) => {
      const onAbort = () => reject(signal.reason);
      const remove = agent.ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return;
        if (busy ? event.type === 'system/message' : event.type === 'user/message' && event.data.id === message.id) accept();
        else if (event.type === 'turn/end') reject(new OperationError('recovery-needed'));
      }, { global: true });
      signal.addEventListener('abort', onAbort, { once: true });
      off = () => { remove(); signal.removeEventListener('abort', onAbort); };
      if (!busy) agent.followup(message);
    });
    signal.throwIfAborted();
    if (busy) return agent.session.append('user/message', message, { surfaceOp: 'append' }).seq;
    const displayed = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === message.id);
    if (displayed?.type !== 'user/message' || digest(displayed.data) !== digest(message)) throw new OperationError('conflict');
    return displayed.seq;
  } finally { off?.(); }
}
