# PB00 compatibility probes

This private, isolated workspace implements [PB00](../../tasks/proactive-bot/PB00-compatibility-spike.md). It does not register a production feature or modify the installed desktop. Results and limitations belong in the [compatibility report](../../docs/spikes/proactive-bot-compatibility.md).

Run from the DSH-Bot repository root. Use the repository wrappers for every pnpm / DSH command:

```sh
scripts/pnpm -C spikes/proactive-bot install --frozen-lockfile
scripts/pnpm -C spikes/proactive-bot build
scripts/pnpm -C spikes/proactive-bot prepare:source
scripts/pnpm -C spikes/proactive-bot typecheck
scripts/pnpm -C spikes/proactive-bot test
DSH_HOME="$PWD/.dsh-dev" spikes/proactive-bot/host-fixture/prepare-runtime.sh
DSH_HOME="$PWD/.dsh-dev" scripts/pnpm -C spikes/proactive-bot run host:rc2
scripts/pnpm check
scripts/pnpm check:docs
```

`prepare:source` retrieves exactly `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` into `.dsh-dev/proactive-bot/upstream`. If that directory exists it only verifies it; a changed tree or different revision is rejected. Package downloads and source retrieval require network access, but no real model, production Source, outbound message, or cloud report is authorized. Root-import controls may install the upstream's original locked alpha dependencies inside a separate `.dsh-dev/proactive-bot/upstream-root-probe` workspace. Those dependencies never enter the product workspace or rc.2 Host.

`vendor/superagent/src/core` and `vendor/superagent/LICENSE` are byte-identical MIT-licensed copies. The source/asset manifest verifies them against the fixed snapshot. Official Store/Effects/Outbox and policy code are bundled from that snapshot into each run's isolated artifact, with required package resources. This is our controlled probe artifact, not an upstream `/core` package export. The generated artifact is exercised without loading source files; production tarball distribution is a separate PB01 gate.

`test` records a fresh manifest, assertions and summary in `.dsh-dev/proactive-bot/core-<timestamp>-<pid>/`. `node spikes/proactive-bot/lib/run.js --gate core` selects the same core gate; it is not a Host test. A negative assertion can pass while the corresponding production capability remains `FAIL(CAPABILITY)`. Reports must retain both values.

`host:rc2` checks the CLI's actual version and uses a fresh isolated Web profile, synthetic loopback model, deterministic tools and native public services. The default machine CLI may have a different version. Only a repository-local rc.2 executable selected through `DSH_BOT_DSH_BIN` can satisfy this gate; the runner must refuse a different version. All registrations, agents, pipes and child processes must be released. No credentials or provider configuration are copied from `~/.dsh`.

`prepare-runtime.sh` installs the published rc.2 CLI below `.dsh-dev/proactive-bot/host-runtime`, preserving and freezing its local lockfile on subsequent runs. It omits three large macOS optional office/audio/image assets unused by this text-only fixture; required native CLI loader modules remain installed. It never upgrades the installed desktop. Current Host verification covers macOS arm64 only. The Host command intentionally exits `1` when a capability is missing, even when all infrastructure and negative controls ran correctly; read `host-summary.json` rather than changing the exit code to make the gate green.

The independent lockfile intentionally does not alter the root pnpm workspace. Run `scripts/pnpm check` separately: it covers the existing product, whereas these probes cover new compatibility contracts. Passing either one cannot substitute for the other.
