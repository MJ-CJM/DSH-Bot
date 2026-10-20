T13：RunExecutor：reservation→ensureBotsWorkspace→create(workspaceId,preset)→rename“[Routine] 标题 · YYYY-MM-DD HH:mm TZ”→prompt→完成判定（设计 §4 编排口径）→flush→终态；超时 15min→timed_out；崩溃不明→recovery_needed；单 Host 锁。mock 实测：会话出现在 Bots 分组并 succeeded；error/超时用例。

公共规则：读 AGENTS.md、docs/P2-design.md（用户已批准，§9 七项默认值全部采纳）、docs/P2-codex-proposal.md。只用 scripts/pnpm、scripts/dsh、DSH_HOME=$PWD/.dsh-dev；只用 mock 模型（loopback），真实模型请求 0；不碰 ~/.dsh；不 commit。结束输出：改动文件、命令结果、验收逐条 PASS/FAIL、遗留问题。中文。
遇阻断或决策点：不要停下，选推荐方案（仅公开 API、通用实现）继续，并在报告中以“决策：…理由：…”列出。
