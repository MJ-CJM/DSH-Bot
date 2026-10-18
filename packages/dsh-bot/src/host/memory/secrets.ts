import { DshBotError } from '../errors.js';

// Deliberately narrow credential signatures, not a general secret classifier.
// Thresholds are part of the rejection policy, not tunable matching scores.
const credentials = [
  /\bsk-[A-Za-z0-9_-]{20,}/u,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/u,
  /\bxox[bp]-[A-Za-z0-9-]{20,}/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u,
];

/** Check unparsed model text first so validation failures cannot echo secrets. */
export function rejectModelSecrets(input: { content?: unknown; tags?: unknown }): void {
  const values = [input?.content, ...(Array.isArray(input?.tags) ? input.tags : [])];
  if (values.some((value) => typeof value === 'string'
    && credentials.some((pattern) => pattern.test(value.normalize('NFKC'))))) {
    throw new DshBotError('memory/rejected',
      'memory/rejected: Model memory contains a possible credential or private key. Remove it before saving.');
  }
}
