# Profile-owned Bot mode compatibility

## Accepted configuration route: web-app replacement

The `web-app-replacement` build mode resolves the settings failure documented
below. It copies every file and all five declaration layers from the candidate's
official `@deepseek-ai/dsh-web-app` bundle. Only three plugin `name` fields in the
main declaration change to point at the reviewed nested Client adapters. Every
root Loader ID remains unchanged and unique, including `ui-chat`; its native
settings namespace, editor, defaults and public mutations continue to work.
Other declarations and all preset layers remain byte-identical. Native runtime
glue still references the installed official package through its public entry.

```sh
node scripts/build-bot-mode-profile-compat.mjs \
  --mode web-app-replacement \
  --app "$PWD/.dsh-dev/official-desktop-rc3/download/DeepSeek Harness.app" \
  --patch-module "$PWD/adapters/bot-mode-desktop022/rc3.mjs" \
  --output "$PWD/.dsh-dev/official-desktop-rc3/web-app/package-final"
```

The new bundle is named `dsh-bot-web-app`. In an isolated profile or an authorized
cold deployment, replace the selected `@deepseek-ai/dsh-web-app` bundle with it
at the same position. Do not enable both, and remove the earlier
`dsh-bot-native-compat` selection. Keep the base and product bundles and all
unrelated profile dependencies/configuration. The official application remains
unchanged.

Preserve the user's original profile text. A config override qualified by the
old canonical plugin name no longer matches the adapted file entry. Append an
override on the original ID without a name assertion, carrying the user's
complete original config. For the audited daily Chat values this is:

```yaml
- id: ui-chat
  config:
    transcriptView: standard
    performanceUsage: detailed
```

This is a configuration migration, not a preset or preference change. Future
native settings edits update that original `ui-chat` namespace through the
normal editor. Restoring the official web-app selection preserves the latest
generic-ID override and the untouched original qualified row. Do not bake user
values into the distributable bundle; `--entry-config` is rejected for this mode.

Actual official rc.3 Host source selection and a `ui-chat` settings mutation
`detailed → compact → detailed` passed in
`.dsh-dev/official-desktop-rc3/web-app/host-settings/host-provenance.json`.
The test used only isolated profile configuration, created no session, and did
not modify the candidate application. Browser and desktop input remain separate
acceptance gates.

The public `dsh.bundle.patch` contract is a static file name or ordered file-name
array; the audited loader does not offer a dynamic bundle function selecting a
different composition after an update. This replacement bundle declares its
exact reviewed DSH release. A different-version application skips it, leaving
the web surface absent until an orchestrator restores the official web-app
selection or installs a reviewed replacement. This is safe refusal, not an
automatic native fallback. Official signed updates can still install normally;
the profile compatibility step must be reviewed again. Do not grant a version
exemption to bypass that gate. A same-version rebuild additionally requires the
read-only baseline checker below. No updater or launch interception is installed.

The sections below retain the earlier independent disabled+insert experiment
and its limitations for audit; it is not the accepted configuration route.

The independent rc.3 regression suite reads the actual candidate ASAR, executes
its extracted native Workspace methods against controlled service fixtures, and
checks preset restoration, explicit preset/archived/no-blank behavior, precise
error fallback, exact code reversibility and hash-drift refusal. It also executes
the unchanged new `workspace.picker` factory registration and verifies its
directory-flow and workspace-creation callbacks:

```sh
node --test adapters/bot-mode-desktop022/test-rc3.mjs
```

The default input is the official rc.3 download above. `DSH_BOT_RC3_ASAR` can name
another exact rc.3 archive. Six tests passed; log:
`.dsh-dev/official-desktop-rc3/web-app/rc3-unit.log`. These method/factory tests are
not desktop UI evidence. The frozen-package review independently verified 212
native files, all 32 official web-app files, all five patch layers, and exact
reversal of the three name fields back to the official declaration. Receipt:
`.dsh-dev/official-desktop-rc3/web-app/final-independent-review.json`.

This local bundle selects three reviewed Client adapters through public profile
composition. It does not modify the official application, its ASAR archive, its
signature, the reference checkout, or daily data. The bundle keeps the original
Host entries, package manifests, canonical browser module IDs, and dependency
edges; only the three reviewed Client files change.

The ordinary installation resolver is installation-first. Installing another
package with an official name into a profile does not override the in-box
package. Instead this bundle disables the original `shortcuts`, `ui-chat`, and
`ui-workspace` Loader entries, then inserts file entries for copies held under its
own `adapters/` directory. DSH anchors those relative entries beside the bundle
patch. The native Client module service discovers each actual Host file's
nearest package manifest and serves that package's declared Client export.
Keeping the canonical manifest names also keeps native `dsh.client.inject`
edges and Client factory IDs intact. There must be exactly one active source for
each canonical package.

The outer bundle declares Cordis and Schemastery as shared peers. This declaration
is necessary for linked external bundle directories: peer-aware ancestor lookup
then resolves the untouched native Host's Schemastery import to the installation
instance. The nested native package manifests remain byte-for-byte originals.

## Build from an official candidate

Run from the DSH-Bot repository. Use a new output directory each time:

```sh
node scripts/build-bot-mode-profile-compat.mjs \
  --app "$PWD/.dsh-dev/official-desktop-rc3/download/DeepSeek Harness.app" \
  --inspect

node scripts/build-bot-mode-profile-compat.mjs \
  --app "$PWD/.dsh-dev/official-desktop-rc3/download/DeepSeek Harness.app" \
  --patch-module "$PWD/adapters/bot-mode-desktop022/rc3.mjs" \
  --output "$PWD/.dsh-dev/bot-mode-profile-compat/rc3-package"
```

The optional patch module is a reviewed repository module exporting `VERSION`,
`patchShortcuts`, `patchChat`, and `patchWorkspace`. Each transform must enforce
its exact original Client SHA before applying reviewed anchors, as the existing
rc.2 transforms do. The builder refuses an unmatched release before creating
output. No rc.3 patch is assumed by this README: the second example only works
after that reviewed module exists. Without `--patch-module`, only the existing
strict `0.2.2-rc.2` transforms are available.

Linked or unpacked files inside one of the three native package directories are
rejected for review rather than silently omitted. Output directories must not
already exist.

`--entry-config /repository/path/to/config.json` accepts an object whose optional
keys are `shortcuts`, `ui-chat`, and `ui-workspace`. Values become the new Loader
entries' complete configs. An orchestrator must copy the existing native entries'
effective configs when preserving custom settings. Existing overrides targeting
the disabled original IDs do not automatically configure the new IDs. JSON input
does not represent `!!js` expressions; such deployment configuration needs an
explicit reviewed profile override targeting `dsh-bot-compat-<original-id>`.

`compatibility.json` records the candidate archive SHA, original Client and Host
SHAs, every emitted native file, copied Host identity, and final application SHA
comparison. The generated package is installable through the ordinary plugin
mechanism. Construction is not an installation, Host verification, UI test, or
proof that a future application release remains compatible.

## Isolated acceptance and rollback

Use the candidate's own CLI through `scripts/dsh`, a repository-owned DSH home,
and an isolated Web profile. Install the generated bundle there, disable model
providers/automatic model features, then start its Host without submitting a
session. The probe in this directory observes only public Loader entries and
`clientModules.clientPath()`; it records all three actual native Client paths and
checks they point inside the generated package. Fetch the real authenticated
Client responses and compare exact factory bytes before exercising Bot mode.

Required runtime checks include command-mode surfaces, New/Search routing,
Fork/Archive blocking, stale Branch callbacks, blank preset preservation,
exit/disposal, reconnect, and cold restart. Retain the original Renderer and
native keyboard/IME arbitration. Desktop OS input remains a separate gate from
Web keyboard tests. Do not route-fulfill Client responses or weaken the existing
Bot capability guard to make a test pass.

For rollback, disable/remove this compatibility bundle and remove any explicit
overrides disabling the three original entries. Preserve later user data. The
official application's bytes do not participate in this rollback. Upstream
updates retain their signature chain, but every changed release requires a new
adapter review and runtime acceptance; the generated bundle declares its exact
reviewed DSH release.

The public composition and Client discovery behavior was audited in the
`dsh-v0.2.1-rc.2` reference and the original `0.2.2-rc.2` desktop archive. The
complete signed-app/profile combination still needs its own runtime evidence.

The actual original rc.2 desktop CLI has started an isolated Web Host with this
bundle and confirmed all three Client paths under its own directory. Receipt:
`.dsh-dev/bot-mode-profile-compat/rc2-host-peer2/host-provenance.json`. This proves
Host source selection only; it does not prove Browser, desktop input or rc.3.

To repeat that bounded Host check without sending a session:

```sh
node adapters/bot-mode-profile-compat/verify.mjs \
  --app /absolute/path/to/unmodified/DeepSeek\ Harness.app \
  --package "$PWD/.dsh-dev/bot-mode-profile-compat/rc3-package" \
  --run "$PWD/.dsh-dev/bot-mode-profile-compat/rc3-host-check"
```

## Settings audit limitation discovered on rc.3

The frozen initial rc.3 bundle passed actual Host source selection at
`.dsh-dev/official-desktop-rc3/compat/host-source-independent/`. It has a separate
configuration compatibility failure and must not be treated as fully accepted:
native Chat and desktop onboarding request the `ui-chat` settings namespace,
while the replacement Host entry publishes `dsh-bot-compat-ui-chat`. Copying the
old config to the new row preserves the Host value but does not provide the
namespace native consumers request. The actual isolated receipt is
`.dsh-dev/official-desktop-rc3/compat/host-settings-independent/host-provenance.json`.

In the read-only daily audit the old complete Chat override was
`{ transcriptView: 'standard', performanceUsage: 'detailed' }`. The original
profile row must remain available for standard-mode fallback. Do not modify the
user's values to hide the namespace failure. A candidate migration should keep
that original text and add a complete config to an accurately addressed adapted
row only after its actual read/write namespace has been proved.

Inserting another root row named `ui-chat` restores reads but fails a real public
`settings.update()` roundtrip: the loader uses the last duplicate row while the
configuration editor's effective-value check sees the first. The test receipt is
`.dsh-dev/official-desktop-rc3/compat/host-settings-native-id/host-provenance.json`.
Nested Includes also have separate configuration ownership. Neither workaround
is an accepted settings bridge. The verifier's `--entry-config <json>` and
`--chat-native-id true` are test options for reproducing these findings, not
deployment instructions.

The exact `engines.dsh` declaration makes a normal different-version upgrade skip
this bundle, restoring native rows that were disabled only by its patch. Keep
compatibility exemptions absent. A same-version rebuilt application is not
detected by the version range. The read-only baseline checker compares the
entire ASAR and all three original Client/Host hashes and exits nonzero on any
drift:

```sh
node adapters/bot-mode-profile-compat/check-baseline.mjs \
  --app /absolute/path/to/DeepSeek\ Harness.app \
  --package /absolute/path/to/installed/dsh-bot-native-compat
```

This checker does not install an updater or launch hook. Automatic same-version
drift refusal remains unimplemented; do not describe the manual preflight as an
automatic runtime guard or add unconditional profile adapter insertions that
would outlive the bundle's version gate.
