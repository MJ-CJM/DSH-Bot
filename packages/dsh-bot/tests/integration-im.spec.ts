import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { imStatus } from '../src/host/im/service.js';
import { IM_PIN, IM_RUNTIME_VERIFIED } from '../src/shared/collaboration.js';
import { collaborationSpec } from '../src/shared/collaboration-contract.js';
describe('U04 optional IM gate', () => {
  it('keeps missing or incompatible services offline without importing the optional plugin', async () => {
    const ctx = new Context();
    try {
      expect(imStatus(ctx)).toMatchObject({ installed: false, reason: 'plugin-missing', pin: IM_PIN });
      const off = ctx.provide('dshIm', { send: vi.fn() });
      expect(imStatus(ctx)).toMatchObject({ installed: true, reason: 'contract-unavailable', inboundSupported: false, outboundSupported: false }); off();
    } finally { await ctx.fiber.dispose(); }
  });
  it('does not promote a fake public contract into verified exclusive intake or checked delivery', async () => {
    const ctx = new Context(); const calls = vi.fn(() => { throw new Error('No account access authorized by diagnostics'); });
    try {
      ctx.provide('dshIm', { contractVersion: 1, inboundVersion: 1, describeBot: calls, listBots: calls, listTargets: calls, consumeInbound: calls, replyChecked: calls, sendChecked: calls, send: calls });
      expect(imStatus(ctx)).toEqual({ pin: IM_PIN, installed: true, contractDetected: true, inboundSupported: false, outboundSupported: false, reason: 'consumer-gate-unverified' });
      expect(IM_RUNTIME_VERIFIED).toBe(false); expect(calls).not.toHaveBeenCalled();
      expect(Object.keys(collaborationSpec.methods).filter(k => k.startsWith('dshBot.im/'))).toEqual(['dshBot.im/status']);
    } finally { await ctx.fiber.dispose(); }
  });
});
