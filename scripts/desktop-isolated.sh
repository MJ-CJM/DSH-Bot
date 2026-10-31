#!/bin/sh
# Run the installed DSH Desktop against an ISOLATED DSH_HOME (never ~/.dsh).
# usage: scripts/desktop-isolated.sh launch | install | status | web
# web = fallback: bundled `dsh` Web Host on isolated profile 'bot-web' (open the printed URL in a browser).
# Quit the normal DeepSeek Harness app (Cmd+Q) first: Desktop is single-instance.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="/Applications/DeepSeek Harness.app"
export DSH_HOME="${DSH_BOT_DESKTOP_HOME:-$ROOT/.dsh-desktop}"
case "$DSH_HOME" in "$HOME/.dsh"|"$HOME/.dsh/"*) echo "refusing: DSH_HOME is the real home" >&2; exit 1;; esac
mkdir -p "$DSH_HOME"
case "${1:-}" in
  launch)
    echo "DSH_HOME=$DSH_HOME"
    pgrep -f "$APP/Contents/MacOS/DeepSeek Harness" >/dev/null && { echo "DeepSeek Harness is running; quit it first (Cmd+Q)" >&2; exit 1; }
    exec "$APP/Contents/MacOS/DeepSeek Harness" ;;
  install)
    pgrep -f "$APP/Contents/MacOS/DeepSeek Harness" >/dev/null && { echo "quit the app first" >&2; exit 1; }
    [ -d "$DSH_HOME/profiles/desktop" ] || { echo "run 'launch' once and quit to initialize the isolated desktop profile" >&2; exit 1; }
    "$ROOT/scripts/pnpm" --filter dsh-bot build
    "$APP/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$ROOT/packages/dsh-bot"
    "$APP/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop list ;;
  status)
    echo "DSH_HOME=$DSH_HOME"; ls "$DSH_HOME/profiles" 2>/dev/null || true
    "$APP/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop list 2>/dev/null || true ;;
  web)
    DSH="$APP/Contents/Resources/runtime/cli/bin/dsh"
    if [ ! -d "$DSH_HOME/profiles/bot-web" ]; then
      "$DSH" --profile bot-web --from-default-profile web --dump-config >/dev/null
      "$ROOT/scripts/pnpm" --filter dsh-bot build
      "$DSH" plugin --profile bot-web add "$ROOT/packages/dsh-bot"
    fi
    [ "${2:-}" = "--dry-run" ] && { "$DSH" --profile bot-web --dump-config | grep -n 'dsh-bot' | head -5; exit 0; }
    exec "$DSH" --profile bot-web ;;
  *) echo "usage: $0 launch|install|status|web [--dry-run]" >&2; exit 2 ;;
esac
