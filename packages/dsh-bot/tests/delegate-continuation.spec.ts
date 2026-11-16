import { describe, expect, it, vi } from 'vitest';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { bindings } from '../src/host/data-flow/agent-binding.js';
import { protectDelegateContinuation, reserveDelegate } from '../src/host/delegate/continuation.js';
import { workerReservations, admitGroupInput, isAdmittedGroupInput } from '../src/host/groups/worker-tool.js';
const alpha = { botId: 'alpha', botCreatedAt: 1 }, beta = { botId: 'beta', botCreatedAt: 2 };
function fixture() {
  const live = new Map<string, Agent>();
  const subagents: { namesOf?: (agent: Agent) => { self: string } } = {};
  function create(id: string, parentSession?: string, preset = 'bot-beta') {
    let guard!: (_payload: unknown, next: () => Promise<{ kind: 'continue' }>) => Promise<unknown>;
    const agent = { id, session: { id, header: { parentSession, agentPreset: preset, ...(parentSession ? { origin: 'subagent' } : {}) } },
      ctx: { get: (name: string) => name === 'subagents' ? subagents : ({ get: (key: string) => live.get(key) }),
        effect: (install: () => () => void) => install(), on: (_event: string, callback: typeof guard) => { guard = callback; return () => {}; } },
    } as unknown as Agent;
    live.set(id, agent);
    const next = vi.fn(async () => ({ kind: 'continue' as const }));
    return { agent, next, step: () => guard({}, next) };
  }
  const owner = create('parent', undefined, 'bot-alpha'); bindings.set(owner.agent, alpha);
  return { create, owner, live, subagents };
}
describe('checked caller activation lease', () => {
  it('allows only the initial exact Agent, never a resumed Agent sharing its childId', async () => {
    const f = fixture(), release = reserveDelegate('child', f.owner.agent, alpha, beta, 'bot-beta');
    try {
      const initial = f.create('child', 'parent'); protectDelegateContinuation(initial.agent, beta, 'startup');
      expect(await initial.step()).toEqual({ kind: 'continue' });
      const resumed = f.create('child', 'parent');
      expect(() => protectDelegateContinuation(resumed.agent, beta, 'resume')).toThrow(); expect(resumed.next).not.toHaveBeenCalled();
      release(); expect(await initial.step()).toMatchObject({ kind: 'reject' });
    } finally { release(); bindings.delete(f.owner.agent); }
  });
  it('rejects legacy/cold self children without a caller lease and changed parent identity', async () => {
    const f = fixture(), release = reserveDelegate('child', f.owner.agent, alpha, beta, 'bot-beta');
    try {
      const initial = f.create('child', 'parent'); protectDelegateContinuation(initial.agent, beta, 'startup');
      bindings.set(f.owner.agent, { ...alpha, botCreatedAt: 99 });
      expect(await initial.step()).toMatchObject({ kind: 'reject' });
      const self = f.create('legacy-self', 'parent', 'bot-alpha');
      expect(() => protectDelegateContinuation(self.agent, alpha, 'resume')).toThrow();
    } finally { release(); bindings.delete(f.owner.agent); }
  });
  it('exempts only live owned group workers and closes the exemption on cancel', async () => {
    const f = fixture(), group = f.create('group-child', 'group-root', 'bot-beta'); let active = true;
    workerReservations.set('group-child', { childId: 'group-child', rootId: 'group-root', presetId: 'bot-beta',
      turnId: 't', deliveryId: 'd', agent: group.agent, audience: [alpha, beta], isActive: () => active });
    try {
      protectDelegateContinuation(group.agent, beta, 'startup');
      expect(await group.step()).toEqual({ kind: 'continue' });
      const resumed = f.create('group-child', 'group-root', 'bot-beta');
      expect(() => protectDelegateContinuation(resumed.agent, beta, 'resume')).toThrow();
      active = false; expect(await group.step()).toMatchObject({ kind: 'reject' });
    } finally { workerReservations.delete('group-child'); bindings.delete(f.owner.agent); }
  });
  it('requires a fresh group resume reservation and exact native relay content', async () => {
    const f = fixture(), root = f.create('group-root'), group = f.create('resume-child', 'group-root', 'bot-beta');
    const binding = { childId: 'resume-child', rootId: 'group-root', presetId: 'bot-beta', turnId: 'task', deliveryId: 'delivery',
      agent: group.agent, audience: [alpha, beta], isActive: () => true, resumeAllowed: true };
    workerReservations.set(binding.childId, binding);
    try {
      protectDelegateContinuation(group.agent, beta, 'resume');
      expect(await group.step()).toEqual({ kind: 'continue' });
      const content = [{ type: 'text' as const, text: 'checked request' }]; admitGroupInput(binding, content, root.agent);
      const relay = createUserMessage({ source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('group-root') },
        content: [{ type: 'text', text: 'Agent group-root sent a message: ' }, ...content] });
      expect(isAdmittedGroupInput(group.agent, relay)).toBe(true);
      expect(isAdmittedGroupInput(group.agent, { ...relay, content: [{ type: 'text', text: 'unadmitted request' }] })).toBe(false);
      expect(isAdmittedGroupInput(group.agent, { ...relay, source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('other') } })).toBe(false);
      workerReservations.delete(binding.childId);
      expect(isAdmittedGroupInput(group.agent, relay)).toBe(false);
      expect(await group.step()).toMatchObject({ kind: 'reject' });
    } finally { workerReservations.delete(binding.childId); }
  });

  it.each([false, true])('admits only the exact native relay prefix and exact live root (named=%s)', named => {
    const f = fixture(), root = f.create('group-root'), group = f.create('named-child', 'group-root', 'bot-beta');
    const binding = { childId: 'named-child', rootId: 'group-root', presetId: 'bot-beta', turnId: 'task', deliveryId: 'delivery',
      agent: group.agent, audience: [alpha, beta], isActive: () => true };
    if (named) f.subagents.namesOf = vi.fn(sender => { expect(sender).toBe(root.agent); return { self: 'lead' }; });
    workerReservations.set(binding.childId, binding);
    const content = [{ type: 'text' as const, text: 'exact authorized request' }];
    const relay = (name: string) => createUserMessage({
      source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('group-root') },
      content: [{ type: 'text', text: `Agent ${name} sent a message: ` }, ...content],
    });
    try {
      admitGroupInput(binding, content, root.agent);
      expect(isAdmittedGroupInput(group.agent, relay(named ? 'lead' : 'group-root'))).toBe(true);
      expect(isAdmittedGroupInput(group.agent, relay(named ? 'group-root' : 'lead'))).toBe(false);
      const exact = relay(named ? 'lead' : 'group-root');
      expect(isAdmittedGroupInput(group.agent, { ...exact, source: { kind: 'user' } })).toBe(false);
      expect(isAdmittedGroupInput(group.agent, { ...exact, source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('other-root') } })).toBe(false);
      expect(isAdmittedGroupInput(group.agent, { ...exact, content: [...exact.content, { type: 'text', text: 'tampered' }] })).toBe(false);
      expect(() => admitGroupInput(binding, content, { ...root.agent })).toThrow();
      expect(() => admitGroupInput(binding, content, f.owner.agent)).toThrow();
      f.create('group-root');
      expect(() => admitGroupInput(binding, content, root.agent)).toThrow();
    } finally { workerReservations.delete(binding.childId); }
  });

  it('does not fall back to Session ids when native namesOf fails or returns invalid data', () => {
    const f = fixture(), root = f.create('group-root'), group = f.create('unavailable-child', 'group-root', 'bot-beta');
    const binding = { childId: 'unavailable-child', rootId: 'group-root', presetId: 'bot-beta', turnId: 'task', deliveryId: 'delivery',
      agent: group.agent, audience: [alpha, beta], isActive: () => true };
    f.subagents.namesOf = () => { throw Error('native address unavailable'); };
    expect(() => admitGroupInput(binding, [], root.agent)).toThrow('native address unavailable');
    f.subagents.namesOf = () => ({ self: '' });
    expect(() => admitGroupInput(binding, [], root.agent)).toThrow();
  });

});
