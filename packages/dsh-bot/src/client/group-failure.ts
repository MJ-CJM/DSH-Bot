import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupFailure } from '../shared/groups.js';

type Translate = PropsLocale<'dsh-bot'>['t'];

/**
 * Same code routing and wording as the native Chat failure row (`message.failure.*`
 * in dsh-client-ui-chat, not exported): known codes are localized, any other code
 * keeps the provider's own message.
 */
export function groupFailureText(failure: GroupFailure, t: Translate): string {
  switch (failure.code) {
    case 'QUOTA':
    case 'ACCOUNT_QUOTA': return t('groups.failure.quota');
    case 'AUTH': return t('groups.failure.auth');
    case 'ACCOUNT_SIGNED_OUT': return t('groups.failure.accountSignedOut');
    case 'ACCOUNT_SIGN_IN_REQUIRED': return t('groups.failure.accountSignInRequired');
    case 'INTERRUPTED': return t('groups.failure.interrupted');
    default: return failure.message;
  }
}

/** Machine facts kept beside the readable text, e.g. `QUOTA · 402`. */
export const groupFailureCode = (failure: GroupFailure) =>
  [failure.code, failure.status].filter(part => part !== undefined).join(' · ');

/** Readable cause for a non-completed native stop reason; the raw value is never shown alone. */
export function groupStopText(stopReason: string, failure: GroupFailure | undefined, t: Translate): string {
  if (stopReason === 'error') return failure ? groupFailureText(failure, t) : t('groups.stop.error');
  if (stopReason === 'aborted') return t('groups.stop.aborted');
  if (stopReason === 'max-tokens') return t('groups.stop.maxTokens');
  if (stopReason === 'refusal') return t('groups.stop.refusal');
  return stopReason;
}
