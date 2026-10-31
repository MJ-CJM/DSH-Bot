# DP-design：深化实施设计（M1–M4 + M5 离线脚手架）。模型 gpt-6-astra / high。只写文档，不改产品代码，不 commit。

## 已批准（佳民 t48u），不要再询问，按此设计
依据：docs/deepening-proposal.md §6 路线图、docs/shared-memory-design.md（全文是权威设计）。决策已定：
1. 自动共享默认开，一键关闭；配额每 Bot 每日 5 条、全域每日 20 条（Host 持久计数）。
2. 只有用户在该 Bot 主会话中直接输入的陈述（Host 可验证的可信用户入口 + 可定位原文片段）才是 user_stated，参与“最新胜”；其余一律 candidate。
3. 以后新建的 Bot 能看到共享记忆。
4. 删除 Bot 保留其共享贡献，另提供“遗忘该 Bot 的贡献”操作。
5. journal 默认注入最近 30 天。
6. 强遗忘：预览影响，让用户选择；清理完成前阻断受影响请求。
7. 工具名冲突：选推荐方案——我们的记忆工具统一加 `bot_` 前缀（如 bot_memory_search/list/save…），旧名保留一个版本的兼容别名？请评估：若社区插件同名注册会导致 DSH 加载冲突，则直接改名不留别名，并在 README 写明。给出决定。
8. Bots 根目录 AGENTS.md：原生 agent-instructions 会把它注入所有 Bot。设计检测+界面警告（不自动删除用户文件），并在 Bot 上下文中声明其不受共享记忆规则约束；给出是否阻止的决定。
9. M5 未授权真实模型与真实会话：只做离线评测层（evals/ manifest、案例、mock/replay 适配器、评分器）、成本账本（预留式准入）、主动检查 shadow 模式脚手架，默认关闭，任何代码路径不得在测试中发真实请求。

## 复用原生（必须先核实 ../deepseek-harness dsh-v0.2.1-rc.2 源码中的确切 API 与签名）
systemPrompt.context（修 packages/dsh-bot/src/host/bot-context.ts:119 P0）、compaction / Agent runMaintenance / Session.append surfaceOp replace、session-query（只用代码路径与合成夹具）、storage-domain、原生 approval、原生 schedule、现有通知服务。

## 交付：写 docs/deepening/implementation-design.md，包含
- 每个里程碑（M1、M2、M3、M4、M5-scaffold）的：模块/文件变更清单（新增/修改哪些文件，保持单文件 ≤400 行、单行 ≤160 字符）、数据结构与 schema（含 migration v1→v2）、原生 API 调用点（带源码路径:行）、关键算法（冲突裁决、配额、遗忘屏障流程、标签传播、出站检查点）、UI 改动（记忆面板 私有/共享、候选/冲突、遗忘预览、来源鲸鱼头像、无闪烁）、测试清单（单元/属性测试 fast-check/强杀/loopback 请求捕获/浏览器 e2e mock）、量化验收与如何测得。
- 强遗忘 spike 计划：第一步先写可运行的 spike 测试验证公开 API 能否清理历史；若不能，降级方案与如何在验收中如实标注。
- TLA+ 小模型的范围与文件位置（如 formal/bot_message.tla + 运行脚本；若机器无 TLC 则说明如何以 NOT_RUN 处理）。
- 实施任务拆分：编号 I01…（每个任务能在一次 gpt-6.1-sol 运行中完成，约 30–60 分钟），列依赖、验收命令（scripts/pnpm check、e2e、截图）、明确不做的事。版本 0.4.0。
- 决策日志：每条标注来源（佳民已定 / Codex 建议）。
规则：DSH_HOME 只用仓库内隔离 .dsh-dev*；不读 ~/.dsh、凭据、会话内容；不调用真实模型；不 commit；不动 pnpm-workspace.yaml。
