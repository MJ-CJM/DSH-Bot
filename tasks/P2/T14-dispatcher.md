T14：Dispatcher：五类规则复用 dsh-schedule；timer+60s 兜底；补跑每 Routine 最多最近一次、24h 内、暂停期不补；run_now 不改锚点；同 Routine 不重叠；全局并发 2、每 Bot 每日 20（Config 可调，quotaTimeZone 默认系统时区）；虚拟时钟单测（DST/cron/跳变/补跑/额度）；真实 Host mock：every 60s 一轮产生会话并完成，禁用后不触发，重启后保留并补跑符合规则。

公共规则：读 AGENTS.md、docs/P2-design.md（用户已批准，§9 七项默认值全部采纳）、docs/P2-codex-proposal.md。只用 scripts/pnpm、scripts/dsh、DSH_HOME=$PWD/.dsh-dev；只用 mock 模型（loopback），真实模型请求 0；不碰 ~/.dsh；不 commit。结束输出：改动文件、命令结果、验收逐条 PASS/FAIL、遗留问题。中文。
遇阻断或决策点：不要停下，选推荐方案（仅公开 API、通用实现）继续，并在报告中以“决策：…理由：…”列出。
