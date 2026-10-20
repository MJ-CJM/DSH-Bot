T17：集成收口：版本 0.2.0；全量 scripts/pnpm check；mock e2e 汇总脚本 scripts/p2-e2e（every60 出会话并完成、run_now、禁用停止、重启保留、补跑、额度/并发上限、delegate 回报）全部 PASS 并留证据；README/architecture 更新；docs/acceptance/P2.md；pack:plugin 生成 dist/dsh-bot-0.2.0.tgz 并在全新隔离 DSH_HOME 安装验证。

公共规则：读 AGENTS.md、docs/P2-design.md（用户已批准，§9 七项默认值全部采纳）、docs/P2-codex-proposal.md。只用 scripts/pnpm、scripts/dsh、DSH_HOME=$PWD/.dsh-dev；只用 mock 模型（loopback），真实模型请求 0；不碰 ~/.dsh；不 commit。结束输出：改动文件、命令结果、验收逐条 PASS/FAIL、遗留问题。中文。
