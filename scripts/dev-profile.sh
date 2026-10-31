#!/bin/sh
set -eu

cd "$(CDPATH= cd "$(dirname "$0")/.." && pwd)"
export DSH_HOME="$PWD/.dsh-dev"
# The DSH CLI starts its own pnpm, so scripts/pnpm's environment is not enough.
export XDG_STATE_HOME="$DSH_HOME/state"
export NODE_COMPILE_CACHE="$DSH_HOME/node-compile-cache"
export pnpm_config_store_dir="$DSH_HOME/pnpm-store"
export pnpm_config_cache_dir="$DSH_HOME/pnpm-cache"
export TMPDIR="$DSH_HOME/tmp"
mkdir -p "$TMPDIR"

if [ "$(scripts/dsh --version)" != '0.2.1-rc.2' ]; then
  echo 'Expected DSH 0.2.1-rc.2; refusing to modify the dev profile.' >&2
  exit 1
fi
test -f packages/dsh-bot/lib/index.js
test -f packages/dsh-bot/lib/client.js

scripts/dsh plugin --profile dev add "$PWD/packages/dsh-bot"
scripts/dsh --profile dev --dump-config > "$DSH_HOME/dump.yml"
grep -q 'dsh-bot' "$DSH_HOME/dump.yml"
grep -q '^# == dsh-bot' "$DSH_HOME/dump.yml"
echo 'PASS: isolated dev installation and dsh-bot config layer (no runtime activation).'
