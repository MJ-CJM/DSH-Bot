#!/bin/zsh
cd "$(dirname $0)/.."
for t in B01-03 B04-06; do
  while pgrep -f "codex exec" >/dev/null; do sleep 20; done
  grep -q "P34-$t finished" .codex/runs/PROGRESS.md || CODEX_MODEL=gpt-6.1-sol scripts/codex-run.sh P34-$t high "执行 tasks/P34/$t.md"
  git add -A docs packages scripts tasks README.md CHANGELOG.md pnpm-lock.yaml package.json 2>/dev/null
  git commit -qm "feat(bot-to-bot): $t (gpt-6.1-sol; orchestrator review pending)" && git push -q && echo "$t $(git rev-parse --short HEAD) auto-committed+pushed" >> .codex/runs/PROGRESS.md
done
echo "b2b chain done" >> .codex/runs/PROGRESS.md
