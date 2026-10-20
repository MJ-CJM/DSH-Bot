import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { z } from 'zod';
export type AutomationErrorCode = 'automation/invalid' | 'automation/conflict' | 'automation/not-found'
  | 'automation/unavailable' | 'automation/read-only' | 'automation/busy' | 'automation/quota' | 'automation/clock';
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'automation/invalid': Record<string, never>; 'automation/conflict': Record<string, never>;
    'automation/not-found': Record<string, never>; 'automation/unavailable': Record<string, never>;
    'automation/read-only': Record<string, never>; 'automation/busy': Record<string, never>;
    'automation/quota': Record<string, never>; 'automation/clock': Record<string, never>;
  }
}
export class AutomationError extends RemoteError<AutomationErrorCode> {
  constructor(code: AutomationErrorCode, message: string, options?: ErrorOptions) { super(code, message, {}, options); }
}
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AutomationError('automation/invalid', 'Invalid automation input', { cause: result.error });
  return result.data;
}
export function unavailable(error: unknown): AutomationError {
  return error instanceof AutomationError ? error : new AutomationError('automation/unavailable', 'Automation storage unavailable', { cause: error });
}
