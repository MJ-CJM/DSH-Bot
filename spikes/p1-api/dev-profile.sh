#!/bin/sh
set -eu
cd "$(CDPATH= cd "$(dirname "$0")/../.." && pwd)"
export DSH_HOME="$PWD/.dsh-dev"
export XDG_STATE_HOME="$DSH_HOME/state"
export NODE_COMPILE_CACHE="$DSH_HOME/node-compile-cache"
export pnpm_config_store_dir="$DSH_HOME/pnpm-store"
export pnpm_config_cache_dir="$DSH_HOME/pnpm-cache"
export TMPDIR="$DSH_HOME/tmp"
export DSH_TELEMETRY_DISABLED=1
mkdir -p "$TMPDIR" "$DSH_HOME/t02"
test "$(scripts/dsh --version)" = '0.2.1-rc.2'
if [ ! -d "$DSH_HOME/profiles/t02-web" ]; then
  scripts/dsh --profile t02-web --from-default-profile web --dump-config > "$DSH_HOME/t02/initial-dump.yml"
fi
scripts/dsh plugin --profile t02-web add "$PWD/spikes/p1-api"
scripts/dsh --profile t02-web --dump-config > "$DSH_HOME/t02/dump.yml"
grep -q '^# == dsh-bot-p1-spike' "$DSH_HOME/t02/dump.yml"
echo 'PASS isolated t02-web installation and dump; runtime follows.'
node spikes/p1-api/lib/run.js
