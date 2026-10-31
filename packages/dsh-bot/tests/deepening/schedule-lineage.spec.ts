import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';
import { inheritOwnSchedule } from '../../src/host/data-flow/tool-guard.js';
import { assertInteractiveOrigin } from '../../src/host/delegate/guard.js';
import { unknownLabel } from '../../src/host/data-flow/labels.js';
import type { DshBotRegistry } from '../../src/host/registry.js';
import type { RunService } from '../../src/host/automation/store.js';
import { flowFixture, alpha, beta } from './managed-flow-fixture.js';
function setupAgent(id: string, header: Partial<Agent['session']['header']> = {}) {
  const sessionId = SessionId(id);
  const session = Session.create(sessionId, undefined, { version: 4, id: sessionId, createdAt: 1, isSeeded: false, ...header });
  return { session } as Agent;
}
function registry(createdAt = 1, mainId = 'clean') {
  return { get: async () => ({ createdAt }), mainSessions: { find: async () => ({ sessionId: mainId }) } } as unknown as DshBotRegistry;
}
describe('current Bot native schedule lineage (no human authority)', () => {
  it('retains current main owner candidate and allows a later real user self-delegate without laundering schedule authority', async () => {
    const x = await flowFixture(); try {
      const agent = setupAgent('clean');
      await x.flow.inherit('clean', { readers: [alpha], originTrust: 'user_confirmed', sourceVersions: [], restrictions: [], grants: [] });
      expect(await inheritOwnSchedule(agent, alpha, registry(), x.flow)).toBe(true);
      expect(x.flow.label('clean').readers).toEqual([alpha]); expect(x.flow.label('clean').originTrust).toBe('candidate');
      agent.session.append('user/message', Object.assign({}, createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'native reminder' }] }), { source: { kind: 'schedule' } }) as ReturnType<typeof createUserMessage>, { surfaceOp: 'append' });
      expect(() => assertInteractiveOrigin(agent, {} as RunService)).toThrow('Background notices');
      agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'new human request' }] }), { surfaceOp: 'append' });
      expect(() => assertInteractiveOrigin(agent, {} as RunService)).not.toThrow();
      await expect(x.flow.admit(x.flow.draft('delegate-input', alpha, 'clean', 'human-self', { kind: 'bot', bot: alpha }, 'task'))).resolves.toBeTypeOf('string');
    } finally { await x.close(); }
  });
  it('does not broaden group scope or erase known versions/revoked/no-egress; old unknown stays held', async () => {
    const x = await flowFixture(); try {
      const before = x.flow.label('clean');
      await x.flow.inherit('clean', { ...before, readers: [alpha, beta], restrictions: ['revoked', 'no-egress'] });
      expect(await inheritOwnSchedule(setupAgent('clean'), alpha, registry(), x.flow)).toBe(true);
      expect(x.flow.label('clean')).toMatchObject({ readers: [alpha], sourceVersions: before.sourceVersions });
      expect(x.flow.label('clean').restrictions).toEqual(expect.arrayContaining(['revoked', 'no-egress']));
      await x.flow.inherit('clean', unknownLabel());
      expect(await inheritOwnSchedule(setupAgent('clean'), alpha, registry(), x.flow)).toBe(true);
      expect(x.flow.label('clean').readers).toEqual([]); expect(x.flow.label('clean').restrictions).toContain('no-egress');
    } finally { await x.close(); }
  });
  it.each(['child', 'wrong-main', 'recreated-bot', 'missing-main'] as const)('refuses %s schedule classification without changing lineage', async scenario => {
    const x = await flowFixture(); try {
      const agent = setupAgent('clean', scenario === 'child' ? { parentSession: SessionId('parent'), origin: 'subagent' } : {});
      const r = registry(scenario === 'recreated-bot' ? 2 : 1, scenario === 'wrong-main' ? 'other' : 'clean');
      if (scenario === 'missing-main') r.mainSessions = undefined;
      const before = x.flow.label('clean'); expect(await inheritOwnSchedule(agent, alpha, r, x.flow)).toBe(false);
      expect(x.flow.label('clean')).toEqual(before);
    } finally { await x.close(); }
  });
});
