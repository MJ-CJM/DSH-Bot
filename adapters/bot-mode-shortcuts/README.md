# Repository-local rc.2 command-mode adapter

This adapter is for the independent local approval service only. It does not
change the reference repository, desktop installation, daily profile, dependency
lockfile, or model execution policy.

The `src` tree is copied from the MIT-licensed
`deepseek-ai/deepseek-harness` tag `dsh-v0.2.1-rc.2` (`687f282e`). The only changed
source files are `src/client/types.ts`, `src/client/registry.ts`, and
`src/client/index.ts`. `LICENSE` preserves the upstream license. All other copied
files retain the original implementation and are needed for a reproducible
browser bundle without importing private files from the reference checkout.

```sh
node scripts/build-bot-mode-adapter.mjs
scripts/pnpm exec tsc -p adapters/bot-mode-shortcuts/tsconfig.json
node --test adapters/bot-mode-shortcuts/test.mjs
```

The build uses the existing rc.2 installed package as the baseline for its Host
half, protocol, metadata, and declarations, then builds the reviewed copied
Client sources. The emitted package and manifest are under
`.dsh-dev/bot-mode-adapter/package`. It neither edits nor installs dependencies.
The adapter TypeScript configuration resolves existing locked dependency declarations
through the workspace dependency tree.

## Public Client contract

```ts
ctx.shortcuts.registerCommandMode({
  id: 'dsh-bot.bot-mode',
  priority: 100,
  commands: {
    'session.new': {
      label: () => localeText,
      resolve: context => ({ status: 'handled', run: chooseBot }),
    },
    'session.fork': {
      hidden: true,
      resolve: () => ({ status: 'blocked', reason: 'bot-mode' }),
    },
  },
}) // => { ready: Promise<void>, dispose(): Promise<void> }
```

A higher priority resolves first. `pass` proceeds to the next mode and then the
current native command; `blocked` consumes the matched key without executing;
`handled` runs once (repeat keys are still suppressed). Two modes at the same
priority cannot claim the same command. Input arbitration, regions, modal
ownership, composition, fixed commands, and command registration remain native.
Mode registrations are immutable snapshots and belong to one Client window.
The plugin must own the returned handle in `ctx.effect` and await `ready` before
showing its mode as active; it must await `dispose()` before reporting exit.
Directory publishing is synchronous in rc.2, so `ready` acknowledges this publish.
Errors during register, presentation, or disposal propagate to the caller.

`hidden` filters the visible catalog only; it leaves command definitions, binding
matching, conflicts, and dispatch intact. Mode removal rebuilds from the current
accepted configuration and current command registrations, never a saved catalog.
No call to shortcut preference `edit()` occurs on mode transitions.

Native keyboard and explicit menu selections already enter the same registry and
now use the same resolver. rc.2's real Electron File menu contains only
`page.close`, with native localized copy; it has no Session New/Search/Fork/
Archive menu items to relabel. This adapter covers Session command routing and
Client catalog presentation. It does not claim a new native menu presentation
protocol. Browser evidence cannot close the separate desktop acceptance gate;
the later native keyboard test below records that narrower result separately.

## Serve the actual adapted Client

Installing the package in a profile is not proof that the Client module resolver
uses it. Copy the isolated rc.2 runtime into a new directory inside `.dsh-dev`,
resolve `@deepseek-ai/dsh-client-shortcuts/package.json` from that copy's CLI
package, and replace that copy's package with this generated package **before**
starting its Host. Do not overwrite the shared test runtime or reference tree.
Use a new CLI wrapper targeting the copied CLI `lib/bin.js`; the original pnpm
`.bin/dsh` shim includes absolute `NODE_PATH` values and must not be reused as is.
Continue invoking that wrapper through `scripts/dsh` and `DSH_BOT_DSH_BIN`.

Verify the actual Browser combo response contains
`DSH_BOT_COMMAND_MODE_ADAPTER_RC2_V1`, record the response SHA-256, and verify the
adapter factory bytes against `adapter-manifest.json`. A copied/installed file
hash alone is not Browser provenance. Do not inject the adapter in a Playwright
response route to simulate installation.

The unit test uses a snapshot-store contract double because the Node-published
Client store has shell-supplied dependencies. It exercises real copied registry
code but is not native Host/Browser evidence; integration must additionally use
actual served artifacts and real keyboard events without HTTP rewriting.

## Isolated Browser evidence

```sh
DSH_HOME="$PWD/.dsh-dev" node adapters/bot-mode-shortcuts/browser.mjs
```

The runner uses the prepared independent approval runtime and a **separate**
private fixture package at `probe/`. Neither fixture half belongs to the product
package; this avoids the original same-package Client provenance problem.
The final runner performs no HTTP response rewriting. Its Playwright route only
allows local requests and rejects external hosts. It verifies the entire emitted
adapter `client.js` occurs byte-for-byte in the actual combo response, recording
both SHA-256 values, before accepting keyboard results.

On 2026-11-12, run
`.dsh-dev/bot-mode-adapter/browser/1794489199538-30058/result.json` passed real
New/Archive interception, hidden Fork blocking, preservation of the original
native Conversation, restored native New and Archive after awaited disposal,
and unchanged keybinding localStorage. Browser page errors were empty and real
model requests were zero. The screenshots are `01-mode-interception.png` and
`02-native-restored.png` in that directory. This is command-adapter evidence,
not acceptance of the final Bot-mode product UI or the macOS desktop bridge.
Earlier runs with test-only product apply response instrumentation are superseded
by this no-rewrite run; the one failed independent-fixture startup is retained
as a failed run and was fixed by correcting its network-guard relative import.

The baseline original Client SHA-256 is
`9940bd17d0ffe93e51d0aa9aefb5cb394f9181dfcfaac5ee379348af79c04a54`.
Each build manifest preserves that hash and source digests separately from the
adapter hash. Generated esbuild source comments include output paths, so compare
against the manifest for the **actual output directory**, rather than a hash
from another output directory. Rebuilding from an already adapted runtime copy
is supported and does not duplicate public declaration exports or methods.

## Actual isolated Electron keyboard evidence

The 2026-11-12 native test also passed on a repository-local copy of the actual
`0.2.2-rc.2` macOS application. This was a full Electron shell with its real
`keyboard` implementation and product preload, rather than a simulated native
API. The original application stayed running as `com.deepseek.dsh`; the copy
used `com.deepseek.dsh.botmode.isolated` and a separate `userData`, `DSH_HOME`,
HOME, logs, temporary directory, and synthetic profile under
`.dsh-dev/bot-mode-native/instance`.

Preparation scripts are intentionally separate from the normal Web approval
service:

```sh
node adapters/bot-mode-shortcuts/native-prepare.mjs
node adapters/bot-mode-shortcuts/native-profile.mjs
node adapters/bot-mode-shortcuts/native-launch.mjs
# Root agent uses CUA against com.deepseek.dsh.botmode.isolated.
node adapters/bot-mode-shortcuts/native-provenance.mjs
node adapters/bot-mode-shortcuts/native-result.mjs
node adapters/bot-mode-shortcuts/native-launch.mjs --stop
```

`native-prepare` copies the official installed app into the repository; it never
writes the installed original. The copy requires an explicit test-root switch
and fails before normal application startup without it. Its internal
`CFBundleName` remains unchanged because Electron uses it to locate Helper apps;
its bundle identifier and display name distinguish the isolated instance.
The copy has no URLTypes declaration, skips system protocol registration,
automatic updater and mandatory-update networking, and skips onboarding only for
this synthetic profile. The copy's main also captures test renderer receipts.
All changes are recorded with original and adapted archive/main hashes, the asar
header integrity is updated, and the copy is ad-hoc signed and verified.

The native Client resolver continued to select its packaged shortcuts despite an
absolute Host Loader path. Therefore, the final native preparation replaces
**only the copy's** packaged shortcuts `client.js` with the reviewed adapter and
updates the matching file hash/byte count in **the copy's**
`dsh/desktop-runtime.json`. The native shell/Host remains `0.2.2-rc.2`; the adapter
source baseline remains `0.2.1-rc.2`. This version combination is explicit in the
receipts and does not alter project dependency locks. The original native Client
hash is preserved separately. `fixture.json` asserts the actual public
`clientModules.clientPath` and adapter marker/hash before reporting ready.
`served-adapter.json` separately verifies the entire actual Host response factory
against the build output, without response rewriting.

The root agent's real CUA interaction selected `Shell Native Bot`, focused its
native composer, enabled the test mode, and pressed `super+n`, `alt+super+f`, and
`shift+super+a`. The visible native indicator showed `native: true`,
`runtime: desktop`, `mode: true`, `calls: new, archive`, and `blocked Fork: 1`;
the Bot main conversation stayed visible and unarchived. After awaited Dispose,
`super+n` returned to the native new-conversation hero. After reopening the same
Bot, `shift+super+a` archived its exact native main Session and cleared the chat.
The native keybinding preference file was not created. The copy was then stopped;
the original application's archive hash stayed unchanged.

Final native receipts are `.dsh-dev/bot-mode-native/native-result.json`,
`fixture.json`, `served-adapter.json`, `prepare.json`, and
`instance/renderer-probe.jsonl`. The result script checks the observed mode,
blocked Fork, disposal, exact archived Session, actual factory hash, and original
application hash. Earlier `fixture-error.json` and failed log entries are retained
as history and are superseded by the final ready fixture and result.

This closes the **actual native keyboard bridge and disposal** test only.
The complete final Bot-mode product desktop UI, native menu presentation,
deep links/cold-start product navigation, and native IME/terminal/modal/multiple
window matrix were not run in this fixture. They remain separate acceptance
gates; this result must not be presented as the whole B00 or final desktop UI
passing.
