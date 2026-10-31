import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { executeRootSetup } from '../src/host/groups/root-guard.js';
import { withIntegrations } from './integration-support.js';

describe('group root setup permit', () => {
  it('requires exact Agent, id, complete message and live permit, then consumes once before work', () => withIntegrations(async f => {
    const agent = { ctx: f.ctx } as Agent, other = { ctx: f.ctx } as Agent;
    const message = createUserMessage({ source: { kind: 'dsh-bot-group-setup', group: { groupId: 'g', groupCreatedAt: 1 }, operation: 'restore', operationId: 'op' }, content: [{ type: 'text', text: 'Real workspace setup' }] });
    const run = vi.fn(async () => { expect(await executeRootSetup(agent, [message], 2)).toBe(false); });
    let live = true;
    const permit = { agent, messageId: message.id, fingerprint: JSON.stringify(message), valid: () => live, run, consumed: false, completed: false };
    expect(await executeRootSetup(agent, [message], 1)).toBe(false);
    const revoke = f.ctx.provide('dshBotGroupSetupPermit', permit);
    try {
      expect(await executeRootSetup(other, [message], 1)).toBe(false);
      expect(await executeRootSetup(agent, [{ ...message, content: [{ type: 'text', text: 'altered' }] }], 1)).toBe(false);
      expect(await executeRootSetup(agent, [{ ...message, source: { kind: 'user' } }], 1)).toBe(false);
      expect(await executeRootSetup(agent, [message, message], 1)).toBe(false);
      live = false; expect(await executeRootSetup(agent, [message], 1)).toBe(false); live = true;
      expect(await executeRootSetup(agent, [message], 1)).toBe(true);
      expect(await executeRootSetup(agent, [message], 1)).toBe(false);
      expect(run).toHaveBeenCalledTimes(1); expect(permit.completed).toBe(true);
    } finally { await revoke(); }
    expect(await executeRootSetup(agent, [message], 1)).toBe(false);
  }));
});
