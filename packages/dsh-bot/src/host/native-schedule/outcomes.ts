import type {} from '@deepseek-ai/dsh-schedule';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import { z } from 'zod';
import { routineOutcomeSchema, type RoutineOutcome } from '../../shared/routine-outcomes.js';

const stateSchema = z.strictObject({ open: z.number().int().nullable(), records: z.array(routineOutcomeSchema) });
type State = z.output<typeof stateSchema>;
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { dshBotRoutineOutcomes: State }
}

/** Pure native-log view. A completed response is not proof of task or child completion. */
type Definition = ProjectionDefinition<'dshBotRoutineOutcomes', State>;
export function routineOutcomes(limit: number): Definition & { wire: NonNullable<Definition['wire']> } {
  return {
    key: 'dshBotRoutineOutcomes', stateVersion: limit, stateSchema,
    init: () => ({ open: null, records: [] }),
    apply(state, event) {
      if (event.type === 'turn/start') return { ...state, open: event.data.turn };
      if (event.type === 'user/message' && event.surfaceOp === 'append' && (event.data.source as { kind: string }).kind === 'schedule' && state.open !== null) {
        if (state.records.some(row => row.messageId === event.data.id)) return state;
        return { ...state, records: [...state.records, {
          messageId: event.data.id, turn: state.open, state: 'processing' as const, at: event.time,
        }].slice(-limit) };
      }
      if (event.type !== 'turn/end') return state;
      const kind = event.data.reason.kind;
      const outcome: RoutineOutcome['state'] = kind === 'completed' ? 'responded'
        : kind === 'aborted' || kind === 'interrupted' ? 'stopped'
        : kind === 'error' || kind === 'blocked' ? 'failed'
        : kind === 'max-tokens' ? 'limited' : 'unknown';
      return { open: state.open === event.data.turn ? null : state.open, records: state.records.map(row =>
        row.turn === event.data.turn && row.state === 'processing' ? { ...row, state: outcome, at: event.time } : row) };
    },
    wire: { viewSchema: z.array(routineOutcomeSchema), view: state => state.records },
  };
}
