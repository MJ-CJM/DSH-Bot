import { describe, expect, it } from 'vitest';
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createToolResultMessage, createSystemMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { canary, fixture, input, forgetNotice } from './fixtures.js';

function replace(session: Session, start: number, end: number) {
  const nodes = session.surface.nodes.slice(start, end + 1);
  const first = nodes[0], last = nodes.at(-1);
  if (first === undefined || last === undefined) throw Error('Missing surface range');
  if (!toolPairingBalancedBefore(session, first) || !toolPairingBalancedAfter(session, last)) throw Error('Unbalanced');
  return session.append('user/message', forgetNotice(), {
    surfaceOp: { op: 'replace', startSeq: first, endSeq: last }, sourceEventSeqs: nodes,
  });
}
describe('I01 native maintenance / ordered replacement / real JSON snapshot reopen', () => {
  it('keeps identity, removes complete tool pairs, preserves raw events, and cold folds replacements', async () => {
    const f = await fixture();
    try {
      const agent = await f.harness.create(SessionId('dp-b1-unit-alpha'), { provider: 'dp-fixture', model: 'mock' });
      const session = agent.session;
      session.append('user/message', input(canary), { surfaceOp: 'append' });
      session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
        source: { provider: 'dp-fixture', model: 'mock' },
        content: [{ type: 'tool-call', id: ToolCallId('synthetic-call'), name: 'fixture', arguments: JSON.stringify({ canary }) }],
      }) }, { surfaceOp: 'append' });
      session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
        callId: ToolCallId('synthetic-call'), content: [{ type: 'text', text: canary }], isError: false,
      }) }, { surfaceOp: 'append' });
      session.append('user/message', input('SAFE_TAIL'), { surfaceOp: 'append' });
      expect(() => replace(session, 1, 1)).toThrow('Unbalanced');
      agent.cancel({ kind: 'hook', reason: 'synthetic-forget' }, { keepInbox: true });
      await agent.whenIdle();
      await agent.runMaintenance(async () => { replace(session, 0, 2); });
      // Replacing a prefix inserts a newer seq ahead of the old tail: surface order is non-monotonic.
      expect(session.surface.nodes[0]).toBeGreaterThan(session.surface.nodes[1] ?? Infinity);
      await agent.runMaintenance(async () => { replace(session, 0, 0); });
      expect(JSON.stringify(session.deriveMessages())).not.toContain(canary);
      expect(JSON.stringify(session.snapshotEvents())).toContain(canary);
      await f.domain.table('snapshots').put('alpha', { id: session.id, events: session.snapshotEvents() });
      const reopened = await f.reopen();
      const saved = reopened.table('snapshots').get('alpha') as { id: string; events: SessionEvent[] };
      const cold = Session.create(SessionId(saved.id), saved.events);
      expect(cold.id).toBe(session.id);
      expect(cold.surface.nodes).toEqual(session.surface.nodes);
      expect(JSON.stringify(cold.deriveMessages())).not.toContain(canary);
      expect(JSON.stringify(cold.snapshotEvents())).toContain(canary);
      expect(f.adapter.requests).toHaveLength(0);
    } finally { await f.close(); }
  });
  it('enforces exact system-head replacement at Surface level; durable idle grammar is a separate Host gate', () => {
    const s = Session.create(SessionId('dp-b1-system-head'));
    const head = s.append('system/message', { turn: 1, step: 1, message: createSystemMessage(canary) },
      { surfaceOp: 'append' }).seq;
    const tail = s.append('user/message', input(canary), { surfaceOp: 'append' }).seq;
    expect(() => replace(s, 0, 1)).toThrow('holds the system prompt');
    s.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Clean system') },
      { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] });
    expect(s.surface.nodes[0]).toBeGreaterThan(tail);
    replace(s, 1, 1);
    expect(JSON.stringify(s.deriveMessages())).not.toContain(canary);
    expect(JSON.stringify(s.snapshotEvents())).toContain(canary);
  });
  it('does not silently accept incomplete source references', () => {
    const s = Session.create(SessionId('dp-b1-bad-replacement'));
    s.append('user/message', input(canary), { surfaceOp: 'append' });
    s.append('user/message', input(canary), { surfaceOp: 'append' });
    const first = s.surface.nodes[0], last = s.surface.nodes[1];
    if (first === undefined || last === undefined) throw Error('Missing nodes');
    expect(() => s.append('user/message', input('safe'), {
      surfaceOp: { op: 'replace', startSeq: first, endSeq: last }, sourceEventSeqs: [first],
    })).toThrow();
    expect(JSON.stringify(s.deriveMessages())).toContain(canary);
  });
});
