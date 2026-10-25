/** Public error identity shared by Host and Client; no Host runtime dependencies. */
export const OPERATION_CODES = {
  invalid: 'dsh-bot/invalid',
  conflict: 'dsh-bot/conflict',
  'not-found': 'dsh-bot/not-found',
  unavailable: 'dsh-bot/unavailable',
  unsupported: 'dsh-bot/unsupported',
  'approval-denied': 'dsh-bot/approval-denied',
  'recovery-needed': 'dsh-bot/recovery-needed',
} as const;
export type OperationCode = keyof typeof OPERATION_CODES;
export type OperationErrorCode = (typeof OPERATION_CODES)[OperationCode];
export function hasOperationCode(error: unknown, code: OperationCode): error is { code: OperationErrorCode } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === OPERATION_CODES[code];
}
