import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { bindings } from '../src/host/data-flow/agent-binding.js';
import { protectDelegateContinuation, reserveDelegate } from '../src/host/delegate/continuation.js';
import { workerReservations } from '../src/host/groups/worker-tool.js';
const alpha = { botId: 'alpha', botCreatedAt: 1 }, beta = { botId: 'beta', botCreatedAt: 2 };
function fixture() {
  const live = new Map<string, Agent>();
  function create(id: string, parentSession?: string, preset = 'bot-beta') {
    let guard!: (_payload: unknown, next: () => Promise<{ kind: 'continue' }>) => Promise<unknown>;
    const agent = { id, session: { id, header: { parentSession, agentPreset: preset, ...(parentSession ? { origin: 'subagent' } : {}) } },
      ctx: { get: () => ({ get: (key: string) => live.get(key) }),
        effect: (install: () => () => void) => install(), on: (_event: string, callback: typeof guard) => { guard = callback; return () => {}; } },
    } as unknown as Agent;
    live.set(id, agent);
    const next = vi.fn(async () => ({ kind: 'continue' as const }));
    return { agent, next, step: () => guard({}, next) };
  }
  const owner = create('parent', undefined, 'bot-alpha'); bindings.set(owner.agent, alpha);
  return { create, owner, live };
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
});
