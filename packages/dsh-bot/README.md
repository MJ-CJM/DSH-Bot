# DSH-Bot 0.4.0 / 个人智能体

Personal agents, persistent Bot conversations, per-Bot MCP connectors, in-app notifications,
deterministic group discussions, native Team task boards and optional reference memory.

个人智能体、持久主会话、每 Bot MCP 连接器、应用内通知、确定性群聊、原生 Team 任务板和可选参考图谱。

Requires DeepSeek Harness `0.2.1-rc.2`; declared compatibility: `>=0.2.1-rc.2 <0.3.0`.
The plugin version 0.4.0 does not imply support for Harness 0.3.0.

Install the prebuilt `dsh-bot-0.4.0.tgz` from Harness Plugins → Add plugin.
This release is a local artifact; no npm or online market publication is claimed.
IM inbound/outbound is disabled until the external-consumer gate is verified.
OS notifications are unsupported through the current public Host API.
Reference memory is an optional additional graph; internal memory remains authoritative.

请在 Harness 插件页安装预构建 tgz。IM 收发门禁未通过，系统通知无公开宿主 API；
参考图谱仅显式并存、单向复制，不替代或删除内部记忆。
0.3.2 新增主会话间 bot_message（提问、通知、逐层回复和独立审批的打断），默认开启普通互通。
例如：“去问问 Reviewer 这个方案有什么风险”。双方可看到折叠鲸鱼消息卡，Bot 详情显示最近往来和状态。
New threads require native approval. Replies and approved downstream read-only collaboration reuse the thread scope.
Unknown or high-risk recipient tools still ask. bot_message is disabled inside run_code; teammate-triggered run_code asks.
Cold recovery reconciles native input IDs; uncertain work is never automatically replayed.
关闭 messagingEnabled 不会撤回已进入原生 Inbox 的消息；未处理消息需显式取消，不确定状态需人工核查。
完整操作、验证结果及限制见仓库 README 与 docs/acceptance/V032-bot-to-bot.md。

### 共享记忆与工具改名（B5，不兼容变更）

现有记忆管理面板提供当前 Bot 私有、私有候选与历史、用户共享及待归属旧记忆。
共享正文只由用户明确新增、修订、确认或裁决；当前宿主缺可信人工输入证明，自动共享暂不可用。
共享可供本域之后新建的 Bot 读取，候选和冲突不进入共享 context。
删除 Bot 会退休其分片并保留已发布共享贡献；“遗忘该 Bot 的贡献”通过原有两级遗忘预览处理。
根指令、原生原始事件和外部备份仍不属于可承诺物理擦除的范围。

工具统一为 `bot_memory_save`、`bot_memory_search`、`bot_memory_list`、`bot_memory_forget`。
旧 `memory_save/search/list/forget` 不注册别名；旧会话应刷新工具定义。
模型保存仍写本 Bot 私有记忆；search/list 可读取自身私有及已发布共享条目，模型不能确认或发布共享。
启动会把本包 Bot 的精确旧 deny 名映射为新名，MCP 和带限定的社区名称保持原值。
同名社区插件仍拥有其旧名工具；不存在该工具时，旧调用会返回改名指引。

English: this is a breaking tool-name change with no legacy aliases. Use the four `bot_memory_*` tools.
Manual management alone publishes exact shared content; automatic sharing remains unavailable without verified human ingress.
Shared facts remain after deleting their contributing Bot. Use the separate contribution-forgetting preview to remove them.

### 0.4.0 离线层 / Offline scaffold

`shadowEnabled=false`、`offlineOrganizeEnabled=false` 为默认值。即使启用，也只生成合成机会报告，
不会创建活跃原生 schedule、调用模型、发送通知或改写记忆。UI 展示离线状态和计数，没有真实运行按钮。
The shadow scaffold is report-only. Real evaluation, real logs and external judges have no executable adapter.
升级迁移后旧插件被 Migration Fence 拒绝；不要把旧 tgz 直接装回同一存储继续写入。
完整强遗忘/provider 编码、自动共享、精确 rc.2 Host 等开放门禁见仓库 `docs/acceptance/deepening.md`。
