import type { Context } from '@deepseek-ai/cordis';
import type { z } from 'zod';
import { capabilityResult, type CapabilitiesMethods } from '../shared/capabilities-contract.js';
import type { BotRecord } from '../shared/schema.js';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { createPollingCatalog, type BotCatalogOptions } from './state.js';
type Result = z.output<typeof capabilityResult>;
export type ModelCatalogData = Extract<Result, { kind: 'models' }>;
export function createModelCatalog(ctx: Context, options: BotCatalogOptions = {}) {
  const request = async (input: Parameters<CapabilitiesMethods['request']>[0]) => {
    const remote = ctx.get('remote.dshBot.capabilities') as CapabilitiesMethods | undefined;
    if (!remote) throw new Error('Capabilities unavailable');
    const result = await remote.request(input); if (!result.ok) throw result.error; return capabilityResult.parse(result.value);
  };
  const catalog = createPollingCatalog(ctx, { providers: [] as ModelCatalogData['providers'] }, async () => {
    const result = await request({ action: 'models' }); if (result.kind !== 'models') throw new Error('Unexpected model catalog'); return { providers: result.providers };
  }, options);
  return { catalog,
    async modelInfo(provider: string, model: string) { const result = await request({ action: 'modelInfo', provider, model });
      if (result.kind !== 'modelInfo') throw new Error('Unexpected model info'); return result.model; },
    async inspect(bot: Pick<BotRecord, 'id' | 'createdAt'>) { const result = await request({ action: 'inspect', bot: { botId: bot.id, botCreatedAt: bot.createdAt } });
      if (result.kind !== 'inspect') throw new Error('Unexpected capabilities'); return result; },
    async freshConversation(bot: Pick<BotRecord, 'id' | 'createdAt'>, expectedSessionId: string | null) {
      const result = await request({ action: 'freshConversation', bot: { botId: bot.id, botCreatedAt: bot.createdAt }, expectedSessionId });
      if (result.kind !== 'conversation') throw new Error('Unexpected conversation receipt');
      return result.sessionId;
    },
    openConversation(sessionId: string) { ctx.uiWorkspace.openSession(sessionId as SessionId); },
    async readSkill(bot: Pick<BotRecord, 'id' | 'createdAt'>, name: string) { const result = await request({ action: 'skillRead', bot: { botId: bot.id, botCreatedAt: bot.createdAt }, name });
      if (result.kind !== 'skill') throw new Error('Unexpected skill'); return result; },
    async writeSkill(bot: Pick<BotRecord, 'id' | 'createdAt'>, name: string, content: string, expectedHash: string | null) {
      const result = await request({ action: 'skillWrite', bot: { botId: bot.id, botCreatedAt: bot.createdAt }, name, content, expectedHash });
      if (result.kind !== 'skill') throw new Error('Unexpected skill'); return result; },
    async removeSkill(bot: Pick<BotRecord, 'id' | 'createdAt'>, name: string, expectedHash: string) {
      await request({ action: 'skillRemove', bot: { botId: bot.id, botCreatedAt: bot.createdAt }, name, expectedHash }); },
  };
}
export type ModelActions = ReturnType<typeof createModelCatalog>;
