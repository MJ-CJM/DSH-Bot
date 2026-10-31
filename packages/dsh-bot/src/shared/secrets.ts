// Deliberately narrow credential signatures, not a general secret classifier.
// Thresholds are part of the rejection policy, not tunable matching scores.
const credentials = [
  /\bsk-[A-Za-z0-9_-]{20,}/u,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/u,
  /\bxox[bp]-[A-Za-z0-9-]{20,}/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u,
];

/** Shared pure check so Host persistence and public Client titles use the same policy. */
export function hasCredential(text: string): boolean {
  return credentials.some((pattern) => pattern.test(text.normalize('NFKC')));
}
