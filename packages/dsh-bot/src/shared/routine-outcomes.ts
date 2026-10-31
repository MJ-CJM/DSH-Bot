import { z } from 'zod';

export const routineOutcomeSchema = z.strictObject({
  messageId: z.string(),
  turn: z.number().int(),
  state: z.enum(['processing', 'responded', 'stopped', 'failed', 'limited', 'unknown']),
  at: z.number(),
});
export type RoutineOutcome = z.output<typeof routineOutcomeSchema>;
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    dshBotRoutineOutcomes: RoutineOutcome[];
  }
}
