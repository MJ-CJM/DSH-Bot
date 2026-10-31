#!/bin/zsh
# usage: scripts/codex-run.sh <runname> <effort> <prompt>   (stdin closed, one run at a time)
cd "$(dirname $0)/.." || exit 1
if pgrep -f "codex exec --sandbox" >/dev/null; then echo "codex already running"; exit 2; fi
echo "$1 dispatched (effort $2, model ${CODEX_MODEL:-default})" >> .codex/runs/PROGRESS.md
codex exec --sandbox workspace-write -c sandbox_workspace_write.network_access=true -c model_reasoning_effort=$2 ${CODEX_MODEL:+-c model=$CODEX_MODEL} --json -o .codex/runs/$1.result.md "$3" < /dev/null > .codex/runs/$1.jsonl 2>&1
echo "$1 finished rc=$?" >> .codex/runs/PROGRESS.md
