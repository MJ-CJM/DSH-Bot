import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import { expect, it, vi } from 'vitest';
import { digest } from '../../src/host/common/operations.js';
import { flowFixture, alpha, beta } from './managed-flow-fixture.js';

it('previews the exact private body once, localizes both identities and binds the grant to all wire bytes', async () => {
  const x = await flowFixture();
  try {
    const content = 'First line\nSecond {to} $&';
    const packet = { schemaVersion: 1, id: 'message', from: alpha, to: beta, fromSessionId: 'private', toSessionId: 'peer-main',
      threadId: 'message', correlationId: 'message', origin: { bot: alpha, sessionId: 'private', userMessageId: 'human' },
      hop: 1, depth: 1, mode: 'notify', priority: 'normal', ts: 1, expiresAt: 2, path: [alpha, beta],
      content, contentDigest: digest(content), fromDisplay: { name: 'Craft' }, toDisplay: { name: 'Jarvis' }, authorizationId: 'host' };
    const bytes = JSON.stringify({ envelope: packet, nativeInput: { id: 'internal-record' } });
    const draft = x.flow.draft('message', alpha, 'private', 'call', { kind: 'bot', bot: beta }, bytes);
    const approve = vi.fn<(_request: ApprovalRequest) => Promise<string>>().mockResolvedValueOnce('rejected').mockResolvedValue('allowed-once');
    const agent = { session: { id: 'private' }, ctx: { get: () => ({ request: approve }) } } as unknown as Agent;
    const signal = new AbortController().signal;
    await expect(x.flow.request(agent, draft, signal)).rejects.toThrow('not approved');
    await expect(x.flow.admit(draft)).rejects.toThrow('authorization');
    const grant = await x.flow.request(agent, draft, signal);
    expect(approve).toHaveBeenCalledTimes(2);
    const question = approve.mock.calls[0]![0];
    expect(question.reason).toBe(`Share this private message from "Craft (alpha)" with "Jarvis (beta)"?\n\n${content}`);
    expect(question.displayReason?.zh).toBe(`允许 "Craft (alpha)" 向 "Jarvis (beta)" 分享以下私有内容吗？\n\n${content}`);
    await expect(x.flow.admit({ ...draft, content: bytes + ' ' }, grant)).rejects.toThrow('Grant invalid');
    const accepted = await x.flow.admit(draft, grant);
    expect(x.flow.get(accepted).state).toBe('admitted');
    await expect(x.flow.admit(draft, grant)).rejects.toThrow();
  } finally { await x.close(); }
});
