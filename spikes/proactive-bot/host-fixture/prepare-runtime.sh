#!/bin/sh
# Provision the published CLI in a repository-local, credential-free directory.
set -eu

spike_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
repo_root=$(CDPATH= cd "$spike_root/../.." && pwd)
cd "$repo_root"
if [ "${DSH_HOME:-}" != "$repo_root/.dsh-dev" ]; then
  echo 'Set DSH_HOME="$PWD/.dsh-dev" from the repository root.' >&2
  exit 2
fi

runtime="$DSH_HOME/proactive-bot/host-runtime"
mkdir -p "$runtime"
write_manifest() {
  destination="$runtime/$1"
  # Preserve an existing runtime selection unless it matches the fixture.
  if [ -e "$destination" ]; then
    cmp -s - "$destination" || {
      echo "Existing runtime manifest differs: $destination" >&2
      exit 2
    }
  else
    cat > "$destination"
  fi
}
write_manifest package.json <<'JSON'
{"name":"pb00-rc2-runtime","private":true,"dependencies":{"@deepseek-ai/dsh":"0.2.1-rc.2"}}
JSON
write_manifest pnpm-workspace.yaml <<'YAML'
packages: []
ignoredOptionalDependencies:
  - '@deepseek-ai/libreoffice-kit-darwin-arm64'
  - '@img/sharp-libvips-darwin-arm64'
  - sherpa-onnx-darwin-arm64
YAML
# These large native optional assets are unrelated to the keyless text fixture.
# Keep required published prebuilt modules available for genuine CLI boot.
if [ -f "$runtime/pnpm-lock.yaml" ]; then
  lock_flag=--frozen-lockfile
else
  lock_flag=--no-frozen-lockfile
fi
scripts/pnpm -C "$runtime" install --ignore-scripts --prefer-offline "$lock_flag"
version=$(DSH_BOT_DSH_BIN="$runtime/node_modules/.bin/dsh" scripts/dsh --version)
[ "$version" = '0.2.1-rc.2' ] || { echo "Expected DSH 0.2.1-rc.2, got $version" >&2; exit 2; }
printf 'Verified local DSH %s\n' "$version"
