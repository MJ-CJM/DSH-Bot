import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { routineOutcomes } from '../src/host/native-schedule/outcomes.js';

type Input = { type: string; data: unknown; surfaceOp?: string };
function replay(events: Input[], limit = 200) {
  const projection = routineOutcomes(limit);
  let state = { open: null, records: [] } as ReturnType<typeof projection.init>;
  events.forEach((event, seq) => {
    state = projection.apply(state, { ...event, seq, time: seq * 1000 } as SessionEvent);
    state = projection.stateSchema.parse(JSON.parse(JSON.stringify(state)));
  });
  return state.records;
}
const input = (id: string, kind = 'schedule', surfaceOp = 'append'): Input => ({
  type: 'user/message', data: { id, source: { kind }, content: [{ type: 'text', text: 'private task text' }] }, surfaceOp,
});
const start = (turn: number): Input => ({ type: 'turn/start', data: { turn } });
const end = (turn: number, kind = 'completed'): Input => ({ type: 'turn/end', data: { turn, reason: { kind } } });

describe('native schedule delivery versus response outcome', () => {
  it('never treats inbox acceptance or an unrelated completed turn as successful execution', () => {
    const rows = replay([
      { type: 'agent/inbox/spliced', data: { inserted: [{ id: 'scheduled' }], start: 0, target: 'queue' } },
      start(1), input('human', 'user'), end(1),
      start(2), input('scheduled'), end(2, 'error'),
      start(3), input('another', 'user'), end(3),
    ]);
    expect(rows).toEqual([{ messageId: 'scheduled', turn: 2, state: 'failed', at: 6000 }]);
    expect(JSON.stringify(rows)).not.toContain('private task text');
  });
  it.each([
    ['completed', 'responded'], ['aborted', 'stopped'], ['interrupted', 'stopped'],
    ['blocked', 'failed'], ['max-tokens', 'limited'], ['forked', 'unknown'],
  ])('maps %s to %s for all schedule messages consumed by the same turn', (kind, state) => {
    const rows = replay([start(1), input('one'), input('two'), end(1, kind)]);
    expect(rows.map(row => row.state)).toEqual([state, state]);
  });
  it('retains processing until its own ending and ignores surface rewrites and duplicated ids', () => {
    expect(replay([start(1), input('one'), input('one'), input('rewrite', 'schedule', 'replace'), end(2)]))
      .toEqual([{ messageId: 'one', turn: 1, state: 'processing', at: 1000 }]);
  });
  it('caps serialized observation history without retaining prompts', () => {
    const rows = replay([start(1), input('one'), end(1), start(2), input('two'), end(2)], 1);
    expect(rows.map(row => row.messageId)).toEqual(['two']);
  });
});
