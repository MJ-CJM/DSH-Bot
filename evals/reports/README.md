# Offline evaluation receipts

Run from the repository root after `scripts/pnpm -F dsh-bot build`:

```sh
node scripts/deepening/eval.mjs --mode mock
node scripts/deepening/eval.mjs --mode replay
```

Each invocation creates an exclusive `.dsh-dev/deepening/b8-eval-<mode>-<time>-<uuid>/` directory.
It contains the effective manifest, fixed-denominator results, durable reservation ledger and summary.
No evaluation data or runner is included in the published plugin.

`evals/manifests/offline.json` references the existing M1 catalog, whose original schema is reused for validation.
The new eval-manifest/fixture schemas describe executable synthetic cases and replay responses;
they do not change the historical catalog's schema or dispositions.
Every case points to an existing catalog case ID. All 13 fixture files are explicitly allowlisted and SHA256-checked.
Symlinks, additional/missing/duplicate case or response IDs, extra schema fields and unlisted paths are rejected.

The 20 memory cases, 10 workflows with two repetitions and 12 injection pairs test scoring/accounting mechanics.
They are small synthetic fixtures, with deliberately recorded errors, a timeout, a duplicate effect and a canary leak.
They are neither held-out retrieval evaluation nor real model answers. Mock uses deterministic input rules;
replay uses frozen synthetic responses. The gold fields are never passed to the mock adapter.
Memory scoring includes temporal correctness, Recall@5 and MRR; workflow scoring includes terminal state,
effect counts and grouped pass^2; injection scoring checks authorization and canary leakage.
Timeouts and failures remain in every denominator. Empty denominators produce null, not fabricated perfect scores.

Money is integer synthetic units, with the frozen synthetic price version in each reservation.
Synthetic token units are `ceil(UTF-8 bytes / 4)`, not measured/billed provider tokens.
Admission reserves the known input bound and manifest output ceiling before invoking an adapter.
Each retry needs its own reservation; duplicate reservation IDs never grant a second execution.
Settlements release only known differences. Timeout/crash retains the entire unknown reservation;
ambiguous persistence freezes the writer. A measured overrun durably blocks the ledger pending reconciliation.
Every run owns a unique ledger directory and one serialized writer. No shared multi-process ledger API is provided.
The actual currency cost is always N/A. Proposed future real-model caps are not authorized budgets.

The offline process blocks public HTTP/HTTPS, fetch, sockets, DNS, UDP, child processes and workers before loading adapters.
Negative tests count blocked attempts separately from actual I/O. This guard is defense in depth, not an OS sandbox.
There is no provider client, endpoint discovery, credential access, session discovery or external judge path.
`--mode real` and unknown modes exit before importing evaluation inputs/adapters.

Shadow consumes only synthetic native-style due identities (`scheduleId + scheduledAt`).
It never calls native create/runNow, emits notifications or writes memory, even when configured on.
It reuses the existing notification quiet-hours/time-zone/cooldown rules plus per-Bot and global budgets,
including in-app candidates. Its state is owned by a Cordis effect and public storageDomain.
An occurrence remains deduplicated across recovery; backward time is rejected. Recreated Bot IDs retain daily usage.
Organization has a default-off config/status scaffold only; no real organizer is implemented.
The 100-opportunity result proves fixture policy mechanics; real proactive precision/recall remains NOT_RUN.
