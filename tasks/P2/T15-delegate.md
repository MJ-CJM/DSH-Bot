T15：bot_delegate 工具（审批、立即返回 runId/sessionId、身份来自 binding、仅传 task、深度 1 后台 run 禁止再委派/改 Routine）；完成后最终回复限长脱敏，经 agent.followup 回报发起会话一次（pending/sent/blocked）；发起会话不可达→blocked。mock e2e：委派→目标会话完成→原会话收到一次摘要。

公共规则：读 AGENTS.md、docs/P2-design.md（用户已批准，§9 七项默认值全部采纳）、docs/P2-codex-proposal.md。只用 scripts/pnpm、scripts/dsh、DSH_HOME=$PWD/.dsh-dev；只用 mock 模型（loopback），真实模型请求 0；不碰 ~/.dsh；不 commit。结束输出：改动文件、命令结果、验收逐条 PASS/FAIL、遗留问题。中文。
遇阻断或决策点：不要停下，选推荐方案（仅公开 API、通用实现）继续，并在报告中以“决策：…理由：…”列出。
