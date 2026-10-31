# V063 onboarding Host evidence and API notes

Host implementation uses the existing Bot registry, native main Session, native Agent loop and public storage-domain. No real model/API-key session was started. Reference source is read-only `deepseek-harness@dsh-v0.2.1-rc.2`; the isolated executable reports rc.3, so runtime evidence below is for that executable, not a separate rc.2 binary.

## Contract and persistence

- `createForChat({operationId, bot, language}) -> BotRecord` commits Host-owned eligibility in the Bot record, with operation UUID, language, policy and canonical input digest. Same operation retries return the same generation; conflicting input is rejected. `BotCreateInput` and public patches cannot carry eligibility. Removal persists a minimal retired-operation marker before deleting the Bot so a lost-response retry cannot resurrect it.
- `startOnboarding({botId,operationId,sessionId})` and `retryOnboarding` return `OnboardingStatus`; ordinary `openConversation`, list, find and status never generate a message. The Client invokes start after successful native workspace navigation.
- `onboardingStatus(botId)` is read-only. A qualified Bot with bound main but no receipt reports `pending`, `retryable:true`, `reason:not-dispatched`; this is a safe manual recovery for a start RPC lost before Host arrival. Any persisted native input makes failure retry conservative; uncertain is never retryable.
- Separate `dsh_bot_onboarding.receipts` owns the fixed complete native input, Bot generation, operation, original main Session and transport state. The input is persisted before native followup. Recovery reads public SessionPersistence handles; it does not resolve/wake an Agent or generate a new input. Only exact input + same-turn assistant text + completed turn proves completed.
- `dsh-bot-onboarding` is a strict source with Bot ID/generation, creation operation, exact Session and input ID plus a short notice. Data-flow admission requires the complete persisted input, current Bot generation, exact persisted main and root Agent binding. It inherits only the Bot's candidate audience; unknown/restricted labels are not repaired.

## Public native API verification

- rc.2 `packages/core/agent/src/runtime-types.ts`: `followup`, `send`, `cancel({kind:'hook'}, {keepInbox:true})`, `whenIdle`, public Inbox `remove`, `agent/inbox/claimed`, `agent/inbox/inserted`, `agent/pre-step`, `agent/request`.
- rc.2 `packages/llm/llm/src/message.ts`: `createUserMessage`, `freezeMessage`, extensible MessageSourceMap; source context notice remains distinct from human source.
- rc.2 `packages/session/session-persistence/src/index.ts` and `handle.ts`: `open(id,'read')`, `read().events`, `close()` permit cold correlation without Agent creation. `storageDomain.get(name).table(name)` is public diagnostic access used only by crash fixtures.
- All registrations and receipt handles have ctx.effect-owned cleanup. Agent-owned text-only guards prohibit every tool during the welcome turn, regardless of memory-kernel availability. The exact welcome's claimed turn is retained before transcript admission so timeout/removal/close can cancel during assemble, request or provider preparation.
- Native `send()` captures `wakingAfterAbort` before emitting insertion. Cancelling inside its insertion observer does not itself latch the original wake. The bridge removes and re-sends that exact pending human item, with its original identity/content/target and a reentrancy guard, after cancellation. Assemble-window human messages already in the proposed batch are retained by filtering only the exact welcome from PreStepDecision. No artificial human message or new identity is constructed.
- Welcome output cap is native request/header state. The prior cap/route is kept in the receipt, and restored while the latest header belongs to the exact welcome turn, route matches, no newer model-selection event exists, and the resolved cap is still the welcome cap. Restoration is consumed only after observing a later admitted header; the exact native header remains authoritative if separate-store persistence loses that later header across a crash. Cancellation before header admission cannot strand the cap. A later deliberate 256 setting is not repeatedly rewritten. Provider-native retries remain outside application-level billing guarantees.

## Executed evidence

`DSH_HOME="$PWD/.dsh-dev" node scripts/onboarding-native-runtime.mjs --mock-only`

PASS: `.dsh-dev/onboarding-native/1793417239165-99128/` (`hot-result.json`, `cold-result.json`, exact event artifacts):

- real followup, separate strict source/notice, normal assistant event, zero human-source messages for the trigger;
- actual tool-call denial with zero synthetic side effects; later normal user reply and native output cap restoration;
- repeat start/retry does not add adapter calls;
- slow adapter greeting interrupted by a user message, followed by normal user reply;
- native assemble barriers: queue, steer and pure uploaded PNG each produce exactly one human event, one user model call/reply and zero admitted welcome input;
- native agent/request barriers: timeout and close abort before admission, produce zero adapter calls and drain;
- independent cold Host sees completed receipt without adapter registration or Agent wake.

`DSH_HOME="$PWD/.dsh-dev" node scripts/onboarding-crash-runtime.mjs --mock-only`

PASS: `.dsh-dev/onboarding-crash/1793417167895-96963/summary.json`. Each case has a durable barrier and matching PID, parent-process SIGKILL receipt, confirmed death, then a new independent Host:

| Crash boundary | Cold result | Automatic replay |
| --- | --- | --- |
| Before dispatching receipt write | pending qualification | none; status only |
| After durable dispatching receipt | uncertain | none |
| Before native flush | uncertain | none |
| After native flush | uncertain | none |
| Before submitted receipt commit | uncertain | none |
| After completed receipt commit | completed | none |

These are actual killed processes, not normal cold restarts or thrown exceptions. The first five hot processes made zero adapter calls at these schedules; the last made one synthetic call. The matrix demonstrates conservative recovery at those observed public boundaries; it does not promise cross-storage exactly-once billing.

Focused tests: `tests/onboarding.spec.ts`, `tests/onboarding-registry.spec.ts`, `tests/remote-contract.spec.ts`: 20/20 PASS before final root integration (including restoration retry after pre-header cancellation). Earlier `registry.spec.ts` plus onboarding/Remote matrix: 32/32 PASS. Host `tsc -p tsconfig.build.json` and package `tsc --noEmit` passed at the recorded implementation checkpoints. Focused Biome lint for new Host/shared/test files: PASS, no warnings after removal of non-null assertions. Final complete check/build/browser/package verification belongs to the root integration report.

## Remaining evidence boundaries

FAIL (NOT_RUN here): actual model wording/role-inference quality with a real provider, which project rules leave to the user. Browser display, theme/responsiveness, final all-package check and tgz are root-owned validation, not claimed by the Host-only evidence above. The synthetic tool-call test deliberately drives the native loop; it does not establish general model quality. Maximum output is a per-native-request cap plus a wall-clock timeout; no exactly-once cost claim is made.

## Final tgz verification

All three scripts were run sequentially against `DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.3.tgz` with the isolated `DSH_HOME`, using their artifact and installed-file audits. No product changes or builds occurred during these runs.

Artifact SHA-256: `01ffc3d4481e9abd2ba215cd0b7dbbe7ff93c36f660ed948d02f041798bd6dd1` (569 files).

- PASS: `.dsh-dev/onboarding-native/1793417982855-24509/` — actual installed tgz, hot/cold, tool/cap boundaries, user queue/steer/attachment priority and cancellation barriers.
- PASS: `.dsh-dev/onboarding-crash/1793418000905-25085/` — actual installed tgz, six independent SIGKILL/cold cases with strict state expectations and no automatic replay.
- PASS: `.dsh-dev/live-persona/1793418042508-26357/` — actual installed tgz, real `bot_manage` get/update, native approval preview and version conditions, committed role reuse in subsequent main prompt assembly, complete mode updates, history retention and an independent cold Host. This fixture does not run a group worker.

Each command exited 0; every suite recorded zero real model requests. These final receipts supersede the source-install runtime directories above for release verification.


## Final frozen release confirmation

The final delivery is `dist/dsh-bot-0.6.3.tgz`, SHA256 `8b911c6e643b53c9f4e5aad004772fdd8f17f35291eb11ab2ce5cc578fed705c`. Earlier runtime paths above are implementation checkpoints; the final installed-artifact runs are:

- Native hot/cold: `.dsh-dev/onboarding-native/1793419383527-67637/summary.json`, PASS.
- Actual SIGKILL six-boundary matrix: `.dsh-dev/onboarding-crash/1793419401191-68161/summary.json`, 6/6 PASS.
- Native approval, main persona and actual group-worker hot/cold: `.dsh-dev/live-persona/1793419436341-69323/summary.json`, PASS. Exact group delivery/child Session/preset/parent matches are captured in group-role.json and cold-group-role.json; both provider-facing systems contain only ROLE_FINAL, the group root makes zero model requests, and the complete main transcript remains unchanged.

Every profile verifies source/packed/installed artifacts before execution. All commands exited 0, real model requests are zero, and no Host is left running. Final full check and browser evidence are recorded in the V063 acceptance report.
