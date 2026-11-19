/** Public error identity shared by Host and Client; no Host runtime dependencies. */
export const OPERATION_CODES = {
  invalid: 'dsh-bot/invalid',
  conflict: 'dsh-bot/conflict',
  'not-found': 'dsh-bot/not-found',
  unavailable: 'dsh-bot/unavailable',
  unsupported: 'dsh-bot/unsupported',
  'approval-denied': 'dsh-bot/approval-denied',
  'budget-exhausted': 'dsh-bot/budget-exhausted',
  'route-loop': 'dsh-bot/route-loop',
  'member-limit': 'dsh-bot/member-limit',
  'recovery-needed': 'dsh-bot/recovery-needed',
  'group-data-blocked': 'dsh-bot/group-data-blocked',
  'group-export-preference-failed': 'dsh-bot/group-export-preference-failed',
  'group-export-sent-receipt-failed': 'dsh-bot/group-export-sent-receipt-failed',
} as const;
export type OperationCode = keyof typeof OPERATION_CODES;
export type OperationErrorCode = (typeof OPERATION_CODES)[OperationCode];
export function hasOperationCode(error: unknown, code: OperationCode): error is { code: OperationErrorCode } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === OPERATION_CODES[code];
}
