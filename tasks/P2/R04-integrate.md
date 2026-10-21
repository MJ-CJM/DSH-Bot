R04：清理 scripts/p2-e2e（未跟踪，T17 遗留）：更新为新架构（原生任务聚合、立即运行、delegate）或删除；更新 docs/acceptance/P2.md、README、architecture；版本 0.2.1；scripts/pnpm check 全过；scripts/pnpm pack:plugin 生成 dist/dsh-bot-0.2.1.tgz；在全新隔离 DSH_HOME 安装验证；mock e2e：Bot 会话用 schedule_create 建任务→出现在 Bots 页该 Bot 下→原生 update/delete 生效→立即运行开新会话完成→0.2.0 旧数据存在时不崩溃→delegate 结果回到父会话。

公共规则：读 AGENTS.md（DSH 原生优先复用原则）、docs/P2-reuse-proposal.md（§10 为用户批准决策，方案 A）。DSH 源码 ~/ai-workspace/deepseek-harness 只读。只用 scripts/pnpm、scripts/dsh、DSH_HOME=$PWD/.dsh-dev；mock 模型；不碰 ~/.dsh；不读密钥；不 commit。遇阻断选推荐方案继续，报告中以“决策：…理由：…”列出。结束输出改动文件、命令结果、验收 PASS/FAIL。中文。
