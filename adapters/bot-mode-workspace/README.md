# Native implicit blank-preset preservation adapter

The locked native Workspace client finds a reusable blank Session in a Workspace
and sends `session.create({ workspaceId, sessionId })` when no preset was explicitly
requested. The native Host deliberately interprets an omitted preset as its
default. For an existing blank Bot main, that can log a genuine
`agent-preset/selected: standard` event and remove the live Bot composition.
Hiding the Session tree or changing keyboard actions does not stop the native
initial navigation effect that takes this path.

This adapter reuses the existing native `restoreBlank` path for that implicit
blank reuse. `restoreBlank` refreshes the Session's public projection values,
passes the recorded preset explicitly, and falls back to the Host default only
for a missing value or the native preset not-found/invalid errors. Explicit
preset requests remain untouched; no matching blank still creates a new default
Session. No Bot prefix, machine path, fake message, forced nonblank state, or
private product import is introduced. The preservation applies to implicit
native reuse generally, including when the Bot mode is off.

The native Workspace baseline Client SHA-256 must be exactly
`52765aacb6c7f96327da5d8709d8cbb30dd2957d4744a42da04c18e07fe264e5`.
`patch.mjs` checks the hash and two unique anchors. The first adds only the call
to existing `restoreBlank`; the second registers the live public capability
`workspace.blank-preset` through `ctx.effect`. If the registrar is absent or
cannot acknowledge the surface, no capability is advertised. The product can
therefore fail closed on an incomplete runtime. All remaining native bytes are
checked by a reverse-patch test.

```sh
node scripts/build-bot-mode-adapter.mjs
node scripts/build-bot-mode-workspace-adapter.mjs
node --test adapters/bot-mode-workspace/test.mjs
DSH_HOME="$PWD/.dsh-dev" node adapters/bot-mode-workspace/browser.mjs /absolute/repository/.dsh-dev/frozen-product.tgz
```

The helper exports `buildBotModeWorkspaceAdapter({ output })` with the same
package/hash result shape as the Chat adapter. Copy its `lib` into the actual
`dsh-client-ui-workspace` package resolved from the independent runtime CLI.
Package metadata is unchanged. The default output is
`.dsh-dev/bot-mode-adapter/workspace-package`. Original reference sources,
original runtime, installed app, and daily data are never changed.

Five unit tests cover exact reversible patching, refreshing a stale projection
before preserving the native preset, explicit preset selection, missing-blank
default creation, native not-found/invalid fallback, and non-fallback errors.
The Browser runner clones its own rc.2 runtime, installs all three adapters,
seeds four untouched blank Bot mains, visits fresh browser contexts, uses the
native New shortcut, and performs a real Host cold restart. It saves both
initial/cold maps and native selected-preset events. Its Playwright driver
TMPDIR is set inside the run before launching Chromium. The runner never
rewrites HTTP responses and requires the served Workspace factory to match the
built bytes. This is a narrow native reuse test, not the final complete UI E2E.

## Cold evidence distinction

Read-only inspection of validation-c showed that the creation headers of the
replaced `local-tech` Sessions still had `agentPreset: bot-local-tech`.
Their complete concatenated zstd logs contained a later selection event with
`standard`; the projection cache correctly reflected that event. The four
retired technical Sessions (`50357407`, `a2e0a272`, `de038bc1`, `e3c82ed9`) all
had this pattern; the latest `177a3cda` had no such event when inspected.
The durable main-pointer table was present and flushed. Therefore this failure
cannot be explained as a missing initial preset header or a lost pointer flush.
The native implicit-reuse code is a matching source-level cause; the runtime
Browser test verifies the fixed path separately.

For generic main eligibility, the public current-preset source is
`sessionQuery.observeSession(id)` with its exact projection snapshot, not a
creation header or direct cache-file read. The locked preset package explicitly
says reconstruction uses the `agentPreset` projection, since blank Sessions may
select another preset after creation. An absent projection/read failure should
remain unavailable rather than silently causing a replacement main. This adapter
does not edit `MainSessions` or restore an already-selected `standard` Session by
pretending its creation header is its current composition.

The real Browser/cold-Host run on 2026-11-12 passed at
`.dsh-dev/bot-mode-workspace/1794494034783-5533/result.json`:

- Four untouched blank Bot main IDs matched exactly before and after fresh-window
  navigation, the native New shortcut, and an actual Host stop/start.
- Actual `/api/session/create` requests carried the same original Session ID and
  its preserved native preset; no owned main was selected to `standard`.
- Three windows each served the complete reviewed Workspace factory bytes
  unchanged, with no HTTP response rewriting.
- Browser page errors and model turns were zero.

The run retains `initial-fixture.json`, `cold-fixture.json`, request bodies,
response hashes, three window states/screenshots, and hot/cold command receipts.
Prior test-only selector failures remain separate runs; they involved the native
button's case and duplicate responsive controls, not a weakened ownership check.
The adapter patch hash remained unchanged throughout. The independently cloned
runtime and its service were stopped by the runner; validation-c was only read.
