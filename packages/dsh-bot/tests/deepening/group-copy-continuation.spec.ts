import { expect, it } from 'vitest';
import { flowFixture, alpha, beta } from './managed-flow-fixture.js';
import { groupContextSession, autoExportAllowed, groupMessageDigests } from '../../src/host/groups/context-flow.js';
import { GROUP_ROOT_PRESET } from '../../src/shared/groups.js';
import type { GroupRecord } from '../../src/shared/groups.js';
import type { GroupState } from '../../src/host/groups/state.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
const target = { kind: 'group' as const, groupId: 'group', groupCreatedAt: 1, members: [alpha, beta] };
it('uses only approved published copies in later work, preserves private readers, and refuses changed audiences, unknown copies and revocation', async () => {
  const x = await flowFixture();
  try {
    const e = x.flow.draft('group-result', alpha, 'private', 'reply', target, 'APPROVED_COPY');
    const held = await x.flow.holdForReview(e), id = await x.flow.approveReview(held, x.flow.review(held).digest);
    await x.flow.dispatch(id, async () => true);
    const label = { readers: [alpha, beta], originTrust: 'candidate' as const, restrictions: ['no-egress' as const], sourceVersions: [], grants: [], groupCopies: [id] };
    await x.flow.inherit('next-child', label);
    const next = x.flow.draft('group-result', beta, 'next-child', 'reply', target, 'DERIVED_FROM_COPY');
    await expect(x.flow.admit(next)).resolves.toBeTypeOf('string');
    expect(x.flow.label('private').readers).toEqual([alpha]);
    await expect(x.flow.admit({ ...next, binding: { ...next.binding, target: { ...target, groupId: 'another' } } })).rejects.toThrow('audience');
    await expect(x.flow.admit({ ...next, binding: { ...next.binding, target: { kind: 'external', destination: 'elsewhere' } } })).rejects.toThrow('authorization');
    await x.f.alpha.update(x.privateId, { content: 'UPDATED_PRIVATE_SOURCE' });
    // Updating the original does not retroactively erase the already approved immutable copy.
    await expect(x.flow.admit(next)).resolves.toBeTypeOf('string');
    await x.reopen(); await expect(x.flow.admit(next)).resolves.toBeTypeOf('string');
    await x.f.kernel.commit({ opId: crypto.randomUUID(), kind: 'forget', subjectIds: [x.privateId], expectedRevision: x.f.kernel.seq, forgetEpoch: x.f.kernel.epoch + 1 });
    expect(() => x.flow.checker.checkGroupCopies([id], target)).toThrow('unavailable');
    expect(() => x.flow.checker.checkGroupCopies([crypto.randomUUID()], target)).toThrow('unavailable');
  } finally { await x.close(); }
});
it('reconstructs a separate group context from exact published history without clearing an already tainted root', async () => {
  const x = await flowFixture();
  try {
    const message = { id: 'reply-id', source: { kind: 'dsh-bot-group', group: { groupId: 'group', groupCreatedAt: 1 } }, content: [{ type: 'text', text: 'COPY' }] };
    const e = x.flow.draft('group-result', alpha, 'private', 'reply', target, JSON.stringify(message));
    const held = await x.flow.holdForReview(e), id = await x.flow.approveReview(held, x.flow.review(held).digest);
    await x.flow.dispatch(id, async () => true); await x.flow.inherit('root', e.label);
    const g = { id: 'group', createdAt: 1, rootSessionId: 'root', membershipRevision: 1 } as GroupRecord;
    const state = { registry: x.registry(), turns: () => [], members: () => [alpha, beta].map(bot => ({ bot, enabled: true })), record: () => g } as unknown as GroupState;
    const root = { session: { id: 'root', header: { agentPreset: GROUP_ROOT_PRESET }, snapshotEvents: () => [{ type: 'user/message', data: message }] } } as unknown as Agent;
    const context = await groupContextSession(state, g, root);
    expect(context).not.toBe('root'); expect(x.flow.label(context).readers).toEqual([alpha, beta]);
    expect(x.flow.label('root').readers).toEqual([alpha]);
    const renderedDigests = groupMessageDigests(g, root);
    message.content[0]!.text = 'TAMPERED';
    await expect(groupContextSession(state, g, root)).rejects.toMatchObject({ code: 'dsh-bot/group-data-blocked' });
    const changed = await x.flow.admit(x.flow.draft('group-input', alpha, 'clean', 'replacement', target, JSON.stringify(message)));
    await x.flow.dispatch(changed, async () => true);
    await expect(groupContextSession(state, g, root, [message.id])).resolves.toBeTypeOf('string');
    await expect(groupContextSession(state, g, root, [message.id], renderedDigests)).rejects.toMatchObject({ code: 'dsh-bot/group-data-blocked' });
    g.exportApprovals = [{ bot: alpha, members: [alpha, beta], membershipRevision: 1, enabledAt: Date.now() }];
    expect(autoExportAllowed(state, g, alpha)).toBe(true); expect(autoExportAllowed(state, g, beta)).toBe(false);
    g.membershipRevision = 2; expect(autoExportAllowed(state, g, alpha)).toBe(false);
  } finally { await x.close(); }
});

it('filters unreadable old history for a new member while admitting a fresh question and rechecks audience changes', async () => {
  const x = await flowFixture();
  try {
    const gamma = { botId: 'gamma', botCreatedAt: 3 }; x.current.set('gamma', 3);
    const old = { id: 'old', source: { kind: 'dsh-bot-group', group: { groupId: 'group', groupCreatedAt: 1 } }, content: [{ type: 'text', text: 'OLD_PRIVATE_COPY' }] };
    const e = x.flow.draft('group-result', alpha, 'private', 'reply', target, JSON.stringify(old));
    const held = await x.flow.holdForReview(e), id = await x.flow.approveReview(held, x.flow.review(held).digest);
    await x.flow.dispatch(id, async () => true);
    let current = { id: 'group', createdAt: 1, rootSessionId: 'root', membershipRevision: 2 } as GroupRecord;
    const g = { ...current }, roster = [alpha, beta, gamma];
    const state = { registry: x.registry(), turns: () => [], members: () => roster.map(bot => ({ bot, enabled: true })), record: () => current } as unknown as GroupState;
    const events = [{ type: 'user/message', seq: 1, data: old }];
    const root = { session: { id: 'root', header: { agentPreset: GROUP_ROOT_PRESET }, snapshotEvents: () => events } } as unknown as Agent;
    const { readableGroupMessages } = await import('../../src/host/groups/context-flow.js');
    expect([...readableGroupMessages(state, g, root)]).toEqual([]);
    await expect(groupContextSession(state, g, root, [old.id])).rejects.toMatchObject({ code: 'dsh-bot/group-data-blocked' });
    const fresh = await groupContextSession(state, g, root, []);
    expect(x.flow.label(fresh).readers).toEqual(roster);
    const question = { id: 'new', source: { kind: 'user' }, content: [{ type: 'text', text: 'NEW_QUESTION' }] };
    const input = x.flow.draft('group-input', alpha, fresh, 'fresh', { ...target, members: roster }, JSON.stringify(question));
    const inputId = await x.flow.admit(input); await x.flow.dispatch(inputId, async () => true);
    events.push({ type: 'user/message', seq: 2, data: question as typeof old });
    expect([...readableGroupMessages(state, g, root)]).toEqual(['new']);
    const selected = await groupContextSession(state, g, root, ['new']);
    expect(x.flow.label(selected).groupCopies).toEqual([inputId]);
    current = { ...g, membershipRevision: 3 };
    await expect(groupContextSession(state, g, root, ['new'])).rejects.toMatchObject({ code: 'dsh-bot/group-data-blocked' });
  } finally { await x.close(); }
});

it.each([10, 100, 1000])('indexes %s historical publications with one ledger scan and revalidates every selected copy', async count => {
  const { readableGroupMessages, groupPublicationIndex, publishedGroupCopy } = await import('../../src/host/groups/context-flow.js');
  const g = { id: 'group', createdAt: 1, rootSessionId: 'root', membershipRevision: 1 } as GroupRecord;
  const events = Array.from({ length: count }, (_, n) => ({ type: 'user/message', seq: n, data: {
    id: `message-${n}`, source: { kind: 'user' }, content: [{ type: 'text', text: `synthetic-history-${n}` }],
  } }));
  const records = new Map(events.map((event, n) => [`flow-${n}`, { envelope: {
    outlet: 'group-input', content: JSON.stringify(event.data), binding: { target },
  } }]));
  let scans = 0, checks = 0;
  const table = { entries: () => { scans++; return records.entries(); }, get: (id: string) => records.get(id) };
  const flow = { kernel: { domain: { table: () => table } }, checker: { checkGroupCopies: () => { checks++; } } };
  const state = { registry: { memoryKernel: {}, memoryOutlets: flow }, members: () => [alpha, beta].map(bot => ({ bot, enabled: true })), record: () => g } as unknown as GroupState;
  const root = { session: { id: 'root', header: { agentPreset: GROUP_ROOT_PRESET }, snapshotEvents: () => events } } as unknown as Agent;
  const started = performance.now();
  expect(readableGroupMessages(state, g, root).size).toBe(count);
  const elapsed = performance.now() - started;
  expect(scans).toBe(1); expect(checks).toBe(count);
  process.stderr.write(`publication-index benchmark: ${count} messages, ${elapsed.toFixed(2)} ms, ${scans} ledger scan\n`);
  const index = groupPublicationIndex(state.registry);
  records.delete('flow-0');
  expect(publishedGroupCopy(state.registry, g, events[0]!.data as never, target, index)).toEqual({ managed: true });
});
