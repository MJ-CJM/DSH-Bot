R01：Bot 会话只暴露原生 schedule_create/list/update/delete；移除 routine_* 工具注册及相关提示词，改为简短指引“定时任务用 schedule_*”。确保 Bot preset 保留 @deepseek-ai/dsh-tool-schedule；Bot.tools.deny 中残留的 routine_* 名不得导致 Agent 创建失败（兼容清理）。真实 ToolRuntime 测试：Bot 工具目录含 schedule_* 不含 routine_*；非 Bot 会话不受影响；scripts/pnpm check 通过。

公共规则：读 AGENTS.md（DSH 原生优先复用原则）、docs/P2-reuse-proposal.md（§10 为用户批准决策，方案 A）。DSH 源码 ~/ai-workspace/deepseek-harness 只读。只用 scripts/pnpm、scripts/dsh、DSH_HOME=$PWD/.dsh-dev；mock 模型；不碰 ~/.dsh；不读密钥；不 commit。遇阻断选推荐方案继续，报告中以“决策：…理由：…”列出。结束输出改动文件、命令结果、验收 PASS/FAIL。中文。
