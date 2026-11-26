import type { Agent } from '@deepseek-ai/dsh-agent';
import type { BotKey } from '../../shared/identity.js';
import type { BotRecord } from '../../shared/schema.js';
import type { DshBotRegistry } from '../registry.js';

/** Read a committed BotRecord by exact BotKey without entering DshBotRegistry.tail.
 * Real DshBotRegistry instances always provide botSnapshot/onboardingSnapshot;
 * only minimal unit-test doubles without snapshot helpers fall back to async get(). */
export async function committedBot(registry: DshBotRegistry, key: BotKey): Promise<BotRecord | undefined> {
  if (typeof registry.botSnapshot === 'function') return registry.botSnapshot(key.botId, key.botCreatedAt);
  if (typeof registry.onboardingSnapshot === 'function') return registry.onboardingSnapshot(key.botId, key.botCreatedAt);
  try {
    const bot = await registry.get(key.botId);
    return bot.createdAt === key.botCreatedAt ? bot : undefined;
  } catch {
    return undefined;
  }
}

/** Read a committed BotRecord by ID without entering DshBotRegistry.tail. */
export async function committedBotById(registry: DshBotRegistry, botId: string): Promise<BotRecord | undefined> {
  if (typeof registry.botSnapshot === 'function') return registry.botSnapshot(botId);
  try {
    return await registry.get(botId);
  } catch {
    return undefined;
  }
}

/** Verify a live main Agent against MainSessions' committed binding without entering queues.
 * Real MainSessions always provides isBoundLiveMain; minimal unit-test doubles fall back to find(). */
export async function isCommittedLiveMain(registry: DshBotRegistry, key: BotKey, agent: Agent): Promise<boolean> {
  const mainSessions = registry.mainSessions;
  if (!mainSessions) return false;
  if (typeof mainSessions.isBoundLiveMain === 'function') {
    return mainSessions.isBoundLiveMain(key.botId, key.botCreatedAt, agent);
  }
  if (typeof mainSessions.boundSessionId === 'function') {
    return mainSessions.boundSessionId(key.botId, key.botCreatedAt) === agent.session.id;
  }
  const main = await mainSessions.find(key.botId);
  return main?.sessionId === agent.session.id;
}

/** Read a Bot incarnation's committed main session ID without entering queues. */
export async function committedMainSessionId(registry: DshBotRegistry, key: BotKey): Promise<string | undefined> {
  const mainSessions = registry.mainSessions;
  if (!mainSessions) return undefined;
  if (typeof mainSessions.boundMainSnapshot === 'function') {
    return mainSessions.boundMainSnapshot(key.botId, key.botCreatedAt)?.sessionId;
  }
  if (typeof mainSessions.boundSessionId === 'function') {
    return mainSessions.boundSessionId(key.botId, key.botCreatedAt);
  }
  return (await mainSessions.find(key.botId))?.sessionId;
}
