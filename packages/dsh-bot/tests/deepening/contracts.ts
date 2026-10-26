/** Target v2 semantics, deliberately exercised against v1 in shared-contracts.
 * This is a test contract, not a shared-memory implementation or publishing adapter.
 * v1 saves are private. No test grants v1 model writes shared authority.
 */
export const contractCases = {
  S01: 'A later trusted correction at another Bot supersedes a stale private user fact without exposing private content',
  S02: 'A quoted/model-derived assertion remains a candidate and cannot enter active shared context',
  S03: 'An unverified self-reported future date cannot win a current fact query',
  S04: 'A stale managed copy cannot recreate a forgotten version',
  S05: 'Private promotion requires exact content and scope authorization; never alias save as share',
  S06: 'Deleting and recreating a Bot ID cannot inherit the previous BotKey private shard',
  S07: 'Automatic publishing commits quota charges atomically and never exceeds either daily bucket',
  S08: 'A grant approved before forget cannot commit after the epoch changes',
} as const;
