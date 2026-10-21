R03：bot_delegate 改为原生子代理优先：普通委派使用原生 subagent spawn（agentPreset=目标 bot preset，不复制父上下文），结果经原生回报到父会话。仅在原生确实做不到处保留本包层（候选：父会话不在线时的持久回报、需要用户审批的子任务、Bot 身份/深度限制），逐项在 docs/architecture.md 说明理由；删除不再需要的执行/回报代码。mock e2e：委派→子代理以目标 Bot 人设完成→父会话收到结果。

公共规则：读 AGENTS.md（DSH 原生优先复用原则）、docs/P2-reuse-proposal.md（§10 为用户批准决策，方案 A）。DSH 源码 ~/ai-workspace/deepseek-harness 只读。只用 scripts/pnpm、scripts/dsh、DSH_HOME=$PWD/.dsh-dev；mock 模型；不碰 ~/.dsh；不读密钥；不 commit。遇阻断选推荐方案继续，报告中以“决策：…理由：…”列出。结束输出改动文件、命令结果、验收 PASS/FAIL。中文。
