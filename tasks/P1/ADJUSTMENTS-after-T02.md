# P1 task adjustments after T02 spike (read before T03–T10)

Source: docs/spikes/P1-api-spike.md. These override conflicting text in T03–T10.

- T03 storage: domain name must match `^[a-z][a-z0-9_]*$` → use `dsh_bot`. `put` does not validate; always `schema.parse` before write. File lives at `$DSH_HOME/storages/dsh_bot.json` (shared across profiles) — key rows by profile-independent bot id. Handle `already-open`.
- T04 presets: stable id `bot-<id>`; `register` throws on duplicate id, so update = serialized transaction: unregister → register → check `broken` → roll back to previous definition on failure (~0.5 ms not-found gap is acceptable). Do NOT use versioned ids (resume breaks).
- T04 Remote: single zod spec module → Host descriptor (`createTypertRemoteInfo`) + Client contribution with `$mount`; compile+runtime signature test (see spikes/remote contract-check). Register with `ctx.typert.register` for strict codec. Client build allowlist must permit bundling `@deepseek-ai/dsh-typert-protocol/remote-info` + own contract; keep cordis/zod/react external.
- T05 persona/template: build preset from `agentPresets.readDocument('standard')` parsed with `entryListSchema` (+ js-yaml); keep `{__jsExpr}` nodes untouched; inject skills by editing existing skill-filesystem row `customSkillDirs`. Do not wrap in `cordis:group`.
- T05/T06 per-bot scope: per-session work in an `agent/created` listener via `agent.ctx` (sections, `tools.restrict`); preset-level registrations are shared per generation. Memory section order ≈100 (configurable), not 9000.
- T06 tests: agent-loop-testkit, llm-mock-server, loader-smoke usable; must still verify model→tool loop with mock.
- T08/T09 client: `@deepseek-ai/dsh-client-test-runtime@0.2.1-rc.2` is broken (imports unpublished src) → use public cordis/slot APIs + own service doubles + React/jsdom. Refresh: refetch after mutations, on mount/visibility and `connection/reset`, plus configurable low-frequency polling (default 5 s) with request epoch/abort; custom `changed` events are NOT forwarded (host whitelist). Stream `watch()` is the fallback if real-time is required.
- T10 acceptance adds: real Desktop UI (link install into an isolated/dev profile first), cold-restart resume of bot sessions, mock-model text + tool loop.
