T12：按设计 §3 实现 dsh_bot_automation v1 存储域（routines/runs/control）、zod schema、Routine/Run 服务（CRUD、9 种 run 状态、去重键、reservation、每日额度计数、软删除）、Remote 契约。不影响 P1 dsh_bot；单测覆盖并发同 key、重启重建、坏记录拒绝。

公共规则：读 AGENTS.md、docs/P2-design.md（用户已批准，§9 七项默认值全部采纳）、docs/P2-codex-proposal.md。只用 scripts/pnpm、scripts/dsh、DSH_HOME=$PWD/.dsh-dev；只用 mock 模型（loopback），真实模型请求 0；不碰 ~/.dsh；不 commit。结束输出：改动文件、命令结果、验收逐条 PASS/FAIL、遗留问题。中文。
