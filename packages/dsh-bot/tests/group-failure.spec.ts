import { describe, expect, it } from 'vitest';
import { Session, type SessionId } from '@deepseek-ai/dsh-session';
import { memberRunFailure } from '../src/host/groups/failure.js';
import { GROUP_FAILURE_MESSAGE_MAX, groupFailureSchema } from '../src/shared/groups.js';

const child = () => {
  const id = 'child' as SessionId;
  return { session: Session.create(id, undefined, { version: 4, id, createdAt: Date.now(), isSeeded: false }) };
};
const fail = (agent: ReturnType<typeof child>, turn: number, error: { message: string; code: string; status?: number }) => {
  agent.session.append('turn/start', { turn });
  agent.session.append('turn/end', { turn, reason: { kind: 'error', error } });
};

describe('member run failure', () => {
  it('reads the native LlmFailure facts from the child turn/end', () => {
    const agent = child(), startedAt = Date.now();
    fail(agent, 1, { message: 'Insufficient Balance (request_id: r-1)', code: 'QUOTA', status: 402 });
    expect(memberRunFailure(agent, startedAt)).toEqual({ code: 'QUOTA', status: 402, message: 'Insufficient Balance (request_id: r-1)' });
  });
  it('never attributes an earlier or later-successful turn to this run', () => {
    const agent = child();
    fail(agent, 1, { message: 'old failure', code: 'QUOTA' });
    expect(memberRunFailure(agent, Date.now() + 60_000)).toBeUndefined();
    agent.session.append('turn/start', { turn: 2 });
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
    expect(memberRunFailure(agent, 0)).toBeUndefined();
    expect(memberRunFailure(undefined, 0)).toBeUndefined();
  });
  it('bounds provider text to the shared schema without splitting a surrogate pair', () => {
    const agent = child();
    fail(agent, 1, { message: `${'x'.repeat(GROUP_FAILURE_MESSAGE_MAX - 2)}😀😀tail`, code: 'UNKNOWN' });
    const failure = memberRunFailure(agent, 0);
    expect(groupFailureSchema.safeParse(failure).success).toBe(true);
    expect(failure?.message.endsWith('x…')).toBe(true);
    expect(failure).not.toHaveProperty('status');
  });
});
