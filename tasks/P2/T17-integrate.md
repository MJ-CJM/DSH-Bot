T17：集成收口：版本 0.2.0；全量 scripts/pnpm check；mock e2e 汇总脚本 scripts/p2-e2e（every60 出会话并完成、run_now、禁用停止、重启保留、补跑、额度/并发上限、delegate 回报）全部 PASS 并留证据；README/architecture 更新；docs/acceptance/P2.md；pack:plugin 生成 dist/dsh-bot-0.2.0.tgz 并在全新隔离 DSH_HOME 安装验证。

公共规则：读 AGENTS.md、docs/P2-design.md（用户已批准，§9 七项默认值全部采纳）、docs/P2-codex-proposal.md。只用 scripts/pnpm、scripts/dsh、DSH_HOME=$PWD/.dsh-dev；只用 mock 模型（loopback），真实模型请求 0；不碰 ~/.dsh；不 commit。结束输出：改动文件、命令结果、验收逐条 PASS/FAIL、遗留问题。中文。
遇阻断或决策点：不要停下，选推荐方案（仅公开 API、通用实现）继续，并在报告中以“决策：…理由：…”列出。
评审小改（T16 截图）：①运行历史区（标题、prompt、记录卡片）字号明显大于面板其余部分，统一为与 Routine 卡片一致的字号/层级；②every 规则按可读单位显示（3600 秒→每 1 小时，90 秒→每 90 秒），中英一致。改后由编排方复跑截图。
e2e 必须单列：every60 出会话并完成、run_now、禁用后不触发、重启保留、补跑（latest、24h、暂停期不补）、并发 2/每 Bot 每日 20 上限被拒、delegate 摘要回到原会话。产出 docs/acceptance/P2.md 汇总所有任务中的“决策：…理由：…”。不要 commit；pack 由你执行（scripts/pnpm pack:plugin）。
