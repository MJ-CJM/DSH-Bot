import type { Agent } from '@deepseek-ai/dsh-agent';
import type { BotKey } from '../../shared/identity.js';
export type BotBinding = Readonly<BotKey>;
export const bindings = new WeakMap<Agent, BotBinding>();
export function getBotBinding(agent: Agent): BotBinding | undefined { return bindings.get(agent); }
