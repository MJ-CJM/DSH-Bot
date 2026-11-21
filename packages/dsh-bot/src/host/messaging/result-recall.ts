import type { Agent } from '@deepseek-ai/dsh-agent';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import type { MessageRecord } from '../../shared/messaging.js';
import { isNativeAmbientSource } from '../common/native-ambient-source.js';
import type { DshBotRegistry } from '../registry.js';
import type { Messaging } from './service.js';

/** Resolve a pronoun only when the immediately preceding human turn started one ask. */
export function precedingPeerAsk(agent: Agent, messaging: Messaging, currentMessageId: string, peerId?: string) {
  const inputs = agent.session.snapshotEvents().filter(event => event.type === 'user/message' &&
    !isNativeAmbientSource(event.data.source.kind) && !messaging.isDisplayMessage(agent, event.data));
  const current = inputs.at(-1), previous = inputs.at(-2);
  if (current?.type !== 'user/message' || current.data.source.kind !== 'user' || current.data.id !== currentMessageId ||
    previous?.type !== 'user/message' || previous.data.source.kind !== 'user') return;
  const matches = messaging.store.rows().filter(({ envelope }: MessageRecord) => envelope.fromSessionId === agent.id &&
    envelope.mode === 'ask' && envelope.origin.sessionId === agent.id && envelope.origin.userMessageId === previous.data.id &&
    (!peerId || peerId === envelope.to.botId));
  if (matches.length === 1) return matches[0]!.envelope;
}

// These standalone questions explicitly request an existing result. Other phrasing is
// interpreted by the normal Bot, which can use the same read-only result tool.
const recall = /^(?:(?:他|她|它|对方)(?:查到|查出|返回|给出)的结果是什么|(?:刚才|上次)(?:的)?(?:调研|查询|协作)?结果是什么|what (?:was|is) (?:their|his|her|the) (?:result|answer)|what did (?:they|he|she) find)[?？。.!！]?$/iu;
export function registerResultRecall(agent: Agent, registry: DshBotRegistry) {
  return agent.ctx.on('llm/stream', async function* (options, next) {
    if (options.sessionId === agent.id && !options.purpose && isAgentLoopRequest(options)) {
      const messaging = agent.ctx.get('dshBotMessaging');
      const events = agent.session.snapshotEvents();
      const last = events.findLast(e => e.type === 'user/message' && !isNativeAmbientSource(e.data.source.kind));
      if (messaging && last?.type === 'user/message' && last.data.source.kind === 'user' &&
        last.data.content.length === 1 && last.data.content[0]?.type === 'text' && recall.test(last.data.content[0].text.trim()) &&
        !events.some(e => e.seq > last.seq && (e.type === 'assistant/message' || e.type === 'tool/result'))) {
        const ask = precedingPeerAsk(agent, messaging, last.data.id);
        if (ask) {
          const result = await messaging.peerResult(agent, ask.to.botId, ask.id);
          if (result.status === 'completed') {
            options.signal?.throwIfAborted();
            registry.memoryAdmission?.assertAllowed();
            const text = `${ask.toDisplay.name}\n\n${result.content}`;
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text };
            yield { type: 'block-end', index: 0, block: { type: 'text', text } };
            yield { type: 'finish', reason: { kind: 'stop' } };
            return;
          }
        }
      }
    }
    yield* next();
  });
}
