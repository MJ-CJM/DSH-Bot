# SHM-1：Bot 共享记忆设计（只读，只出设计，不改任何文件，不 commit）

背景：用户（佳民）要求 DSH-Bot 增加跨 Bot 的共享记忆，参考 Grok Bot：
- shared_profile（关于用户的稳定事实）/ shared_journal（关于用户近期事件）对该用户所有 Bot 可见；
- 每个 Bot 写自己的分片（shard），条目带 provenance（哪个 Bot 学到的）；
- 冲突规则：关于“用户本人”的事实，最新者胜；关于“Bot 自己角色/工作方式”的事实，Bot 私有记忆胜。

必须结合并与之保持一致：docs/deepening-proposal.md 的 M1–M5（尤其 M2 动态 context + 遗忘屏障、M3 op-log + 投影 + valid_from/valid_to/recorded_at/superseded_by/source_refs/status、M4 Host 数据标签与出站检查）。
阅读代码：packages/dsh-bot/src/host/bot-context.ts（记忆只算一次）、host/memory/*、host/stores/memory.ts、host/reference-memory/*（MCP 记忆后端与副本）、host/messaging/safety.ts 与 reply-routing.ts、shared/schema.ts、client 记忆面板；以及只读 DSH 源码（../deepseek-harness，system-prompt context、storage）。

请输出完整设计（中文），覆盖：
1. 数据模型：shared 与 private 作用域、每 Bot shard、provenance、kind（user_fact / user_event / bot_role / how_to_work）、与 M3 op-log 统一（同一操作日志还是独立日志？给出理由）、BotKey=(id,createdAt) 对 provenance 的影响（Bot 删除后其 shard 如何处理）。
2. 优先级与冲突：最新胜的精确定义（valid 时间还是 recorded 时间？用户确认事实是否压过模型推断？）、私有胜的范围、跨 Bot 互斥事实如何标 disputed、如何防止一个被注入的 Bot 用“最新胜”污染全体。
3. 读写权限：谁能写 shared（模型工具？需要什么门槛/审批？）、谁能读；队友消息/群聊/外部工具结果派生的事实能否进入 shared。
4. 进入上下文：每次请求刷新（复用 M2 动态 context），注入预算如何在 shared 与 private 间分配；遗忘屏障对 shared 条目同样适用，遗忘一个共享事实传播到所有 Bot（含活跃会话、MCP 副本），给出可测不变量。
5. 与 M4 出站标签关系：shared 条目标签是什么；private 内容被“提升”为 shared 需要什么；shared 是否可经 bot_message 流动；防止通过 shared 绕过 private 出站检查。
6. UI：查看/编辑/遗忘共享记忆，显示来源 Bot（鲸鱼头像）、冲突/disputed 处理，无闪烁（沿用现有轮询约定）。
7. 原生能力优先：哪些复用 DSH 原生（storage、systemPrompt.context、schedule 做离线整理、审批），哪些必须自建并说明原因。
8. 迁移：现有每 Bot 记忆如何迁移（默认全部 private？自动建议提升？），回滚。
9. 测试与不变量、验收指标（量化）。
10. 路线图：把共享记忆并入 M1–M5（建议放 M2/M3 内或其后新增里程碑），每个里程碑给：目标、范围、非目标、交付物、量化验收、依赖、Codex 模型（设计 gpt-6-astra / 实现 gpt-6.1-sol，均 high）、粗略工作量、哪些步骤需佳民授权（真实模型评测、真实会话日志）。保持“更深而非更大”。
11. 列出你认为需要佳民拍板的决策点，以及你对“最新胜”规则的风险评估和替代建议。
规则：只读，不运行模型，不读 ~/.dsh 或凭据。
