import { expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { nativePolicy } from '../../src/host/data-flow/native-policy.js';
import { flowFixture, alpha, beta } from './managed-flow-fixture.js';

it('requires exact approval after file results and permits approved MCP arguments and group return without losing copy provenance', async () => {
  const x = await flowFixture();
  try {
    const target = { kind: 'group' as const, groupId: 'group', groupCreatedAt: 1, members: [alpha, beta] };
    const input = x.flow.draft('group-input', alpha, 'clean', 'question', target, 'PUBLIC_GROUP_QUESTION');
    const inputId = await x.flow.admit(input); await x.flow.dispatch(inputId, async () => true);
    await x.flow.inherit('member', { readers: [alpha, beta], originTrust: 'candidate', restrictions: [], sourceVersions: [], grants: [], groupCopies: [inputId] });
    const definition = {}, approval = vi.fn(async () => 'rejected');
    const agent = { session: { id: 'member' }, ctx: { tools: { get: () => definition }, get: (name: string) => name === 'approval' ? { request: approval } : undefined } } as unknown as Agent;
    const policy = nativePolicy(agent, alpha, x.registry(), x.flow);
    const execution = { agent, name: 'read', signal: new AbortController().signal } as ToolExecution;
    await policy.dispatch(execution, async () => 'SYNTHETIC_PRIVATE_FILE');
    expect(x.flow.label('member')).toMatchObject({ readers: [alpha], groupCopies: [inputId] });
    const connector = x.flow.draft('connector', alpha, 'member', 'mcp-call', { kind: 'external', destination: 'exact-assigned-endpoint' },
      JSON.stringify({ name: 'mcp__fixture__query', arguments: { text: 'SYNTHETIC_PRIVATE_FILE' } }));
    await expect(x.flow.request(agent, connector, execution.signal)).rejects.toThrow('not approved');
    expect(approval).toHaveBeenCalledOnce();
    approval.mockResolvedValue('allowed-once');
    const grant = await x.flow.request(agent, connector, execution.signal);
    expect(grant).toBeDefined();
    await expect(x.flow.admit({ ...connector, content: 'DIFFERENT_BODY' }, grant)).rejects.toThrow();
    await expect(x.flow.admit({ ...connector, binding: { ...connector.binding, target: { kind: 'external', destination: 'different-endpoint' } } }, grant)).rejects.toThrow();
    const id = await x.flow.admit(connector, grant), send = vi.fn(async () => 'MCP_SENT');
    await expect(x.flow.dispatch(id, send)).resolves.toBe('MCP_SENT'); expect(send).toHaveBeenCalledOnce();
    await expect(x.flow.admit(connector, grant)).rejects.toThrow();
    const gamma = { botId: 'gamma', botCreatedAt: 3 }; x.current.set('gamma', 3);
    for (const changedTarget of [{ ...target, groupId: 'different-group' }, { ...target, members: [...target.members, gamma] }]) {
      const changed = x.flow.draft('group-result', alpha, 'member', 'changed-group', changedTarget, 'SYNTHETIC_PRIVATE_FILE');
      const exact = x.flow.checker.grants.issue(changed.binding, changed.content);
      await expect(x.flow.admit(changed, exact)).rejects.toThrow('audience');
    }
    const reply = x.flow.draft('group-result', alpha, 'member', 'reply', target, 'SYNTHETIC_PRIVATE_FILE');
    await expect(x.flow.admit(reply)).rejects.toThrow('authorization');
    const held = await x.flow.holdForReview(reply), review = x.flow.review(held);
    const approved = await x.flow.approveReview(held, review.digest);
    await expect(x.flow.dispatch(approved, async () => 'GROUP_SENT')).resolves.toBe('GROUP_SENT');
    expect(x.flow.label('member').readers).toEqual([alpha]);
    // A grant never revives a missing published source, even before the transport is invoked.
    const again = x.flow.draft('connector', alpha, 'member', 'another-call', connector.binding.target, connector.content);
    const secondGrant = await x.flow.request(agent, again, execution.signal);
    await x.f.kernel.domain.table('flows').delete(inputId);
    await expect(x.flow.admit(again, secondGrant)).rejects.toThrow('unavailable');
  } finally { await x.close(); }
});
