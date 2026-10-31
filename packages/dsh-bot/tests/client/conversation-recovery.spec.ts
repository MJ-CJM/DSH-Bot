import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { CapabilitiesMethods } from '../../src/shared/capabilities-contract.js';
import { createModelCatalog } from '../../src/client/model-catalog-state.js';
const bot = { id: 'alpha', createdAt: 17 };
describe('explicit native conversation recovery action', () => {
  it('passes exact Bot lifetime and expected binding, then opens only a successful native receipt', async () => {
    const ctx = new Context(), request = vi.fn<CapabilitiesMethods['request']>(async () => ({ ok: true, value: { kind: 'conversation', sessionId: 'new-main' } }));
    const openSession = vi.fn();
    ctx.provide('remote.dshBot.capabilities', { request }); ctx.provide('uiWorkspace', { openSession } as unknown as Context['uiWorkspace']);
    try {
      const actions = createModelCatalog(ctx);
      expect(request).not.toHaveBeenCalled();
      await expect(actions.freshConversation(bot, 'old-main')).resolves.toBe('new-main');
      expect(request).toHaveBeenCalledWith({ action: 'freshConversation', bot: { botId: 'alpha', botCreatedAt: 17 }, expectedSessionId: 'old-main' });
      expect(openSession).not.toHaveBeenCalled();
      actions.openConversation('new-main'); expect(openSession).toHaveBeenCalledExactlyOnceWith('new-main');
      request.mockResolvedValueOnce({ ok: false, error: new RemoteError('dsh-bot/conflict', 'CAS', {}) });
      await expect(actions.freshConversation(bot, 'old-main')).rejects.toThrow();
      expect(openSession).toHaveBeenCalledTimes(1);
      request.mockResolvedValueOnce({ ok: true, value: { kind: 'removed' } });
      await expect(actions.freshConversation(bot, null)).rejects.toThrow('Unexpected conversation');
      expect(openSession).toHaveBeenCalledTimes(1);
    } finally { await ctx.fiber.dispose(); }
  });
});
