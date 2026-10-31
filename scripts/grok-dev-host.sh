#!/bin/bash
# Foreground, repository-isolated Web Host. No OS service installation or model prompt.
set -euo pipefail
TASK_ROOT="$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)"
cd "$TASK_ROOT"
TASK_MODE=start
TASK_PORT=8765
TASK_OPEN=yes
usage() {
  cat <<'HELP'
Usage: scripts/grok-dev-host.sh [--help|--check|--init] [--port 8765] [--no-open]

Default: run the existing grok-web profile on 127.0.0.1 in the foreground.
--help     Show this help without changing files.
--check    Read-only checks of wrapper, local build and isolated profile presence.
--init     Create a NEW repo-local web profile and add the local Bot package.
           Existing profiles are preserved. CLI package installation may need network.
--port N   Explicit local port, 0 for an OS-assigned free port.
--no-open  Do not let the native CLI open its authenticated browser URL.

DSH_HOME is always this repository's .dsh-dev. Startup prints redacted logs;
authentication tokens are never echoed. Default native browser opening handles login.
Ctrl-C stops this foreground Host. No model session is created by this script.
HELP
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --check) TASK_MODE=check ;;
    --init) TASK_MODE=init ;;
    --no-open) TASK_OPEN=no ;;
    --port) shift; [ "$#" -gt 0 ] || { echo 'Missing port.' >&2; exit 2; }; TASK_PORT="$1" ;;
    *) echo 'Unknown option. Use --help.' >&2; exit 2 ;;
  esac
  shift
done
case "$TASK_PORT" in ''|*[!0-9]*) echo 'Port must be an integer from 0 through 65535.' >&2; exit 2 ;; esac
[ "${#TASK_PORT}" -le 5 ] && [ "$TASK_PORT" -le 65535 ] || { echo 'Port must be from 0 through 65535.' >&2; exit 2; }
TASK_PROFILE="$TASK_ROOT/.dsh-dev/profiles/grok-web"
# --check deliberately does not invoke the CLI, mkdir, resolve dependencies, or create caches.
if [ "$TASK_MODE" = check ]; then
  test -x scripts/dsh || { echo 'FAIL: scripts/dsh is not executable.' >&2; exit 1; }
  test -f packages/dsh-bot/lib/index.js && test -f packages/dsh-bot/lib/client.js || { echo 'FAIL: build the local package with scripts/pnpm build first.' >&2; exit 1; }
  echo 'PASS: local CLI wrapper and Bot build present; default bind is 127.0.0.1.'
  if [ -e "$TASK_PROFILE" ]; then echo 'PASS: isolated grok-web profile exists (runtime activation not tested).';
  else echo 'PENDING: isolated grok-web profile absent; run --init before startup.'; fi
  exit 0
fi
export DSH_HOME="$TASK_ROOT/.dsh-dev"
export DSH_AGENTS_HOME="$DSH_HOME/agents-home"
export XDG_STATE_HOME="$DSH_HOME/state"
export XDG_CACHE_HOME="$DSH_HOME/cache"
export XDG_CONFIG_HOME="$DSH_HOME/config"
export NODE_COMPILE_CACHE="$DSH_HOME/node-compile-cache"
export pnpm_config_store_dir="$DSH_HOME/pnpm-store"
export pnpm_config_cache_dir="$DSH_HOME/pnpm-cache"
export TMPDIR="$DSH_HOME/tmp"
export DSH_TELEMETRY_DISABLED=1
umask 077
mkdir -p "$TMPDIR"
# Native logs may include an authentication URL. Redact the complete query value on every line.
redact() { awk '{ gsub(/(token|access_token|key)=[^&[:space:]"<>]+/, "token=[redacted]"); print; fflush(); }'; }
if [ "$TASK_MODE" = init ]; then
  if [ -e "$TASK_PROFILE" ]; then echo 'Profile already exists; preserved. Use the default command to start.'; exit 0; fi
  test -f packages/dsh-bot/lib/index.js && test -f packages/dsh-bot/lib/client.js || { echo 'Build the local package first.' >&2; exit 1; }
  scripts/dsh --profile grok-web --from-default-profile web --dump-config >/dev/null
  scripts/dsh plugin --profile grok-web add "$TASK_ROOT/packages/dsh-bot" 2>&1 | redact
  echo 'Prepared the isolated grok-web profile. Run scripts/grok-dev-host.sh to start.'
  exit 0
fi
[ -e "$TASK_PROFILE" ] || { echo 'Isolated profile absent. Run scripts/grok-dev-host.sh --init first.' >&2; exit 1; }
TASK_ARGS=(--profile grok-web --host 127.0.0.1 --port "$TASK_PORT")
if [ "$TASK_OPEN" = no ]; then TASK_ARGS+=(--no-open); fi
scripts/dsh "${TASK_ARGS[@]}" 2>&1 | redact
