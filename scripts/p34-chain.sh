#!/bin/zsh
# Orchestrator chain: waits for current codex, then runs remaining U tasks sequentially, committing after each.
cd "$(dirname $0)/.."
for t in U01 U02-03 U04-05 U06-08 U09-11 U12-13; do
  while pgrep -f "codex exec" >/dev/null; do sleep 20; done
  if ! grep -q "P34-$t finished" .codex/runs/PROGRESS.md; then
    [ -f .codex/runs/STOP ] && { echo "chain stopped before $t" >> .codex/runs/PROGRESS.md; exit 0; }
    CODEX_MODEL=gpt-6.1-sol scripts/codex-run.sh P34-$t high "执行 tasks/P34/$t.md"
  fi
  git add -A docs packages spikes scripts tasks README.md pnpm-lock.yaml package.json 2>/dev/null
  git commit -qm "feat(p3-p4): $t (Codex run; orchestrator review pending)" && git push -q && echo "$t $(git rev-parse --short HEAD) auto-committed+pushed" >> .codex/runs/PROGRESS.md
done
echo "chain done" >> .codex/runs/PROGRESS.md
