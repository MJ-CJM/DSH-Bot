# P3+P4 设计（只调研+写文档，不写产品代码）
用户已授权一次性完成 P3+P4，设计不再等用户审批（编排方评审后直接实现）。先读 AGENTS.md（DSH 原生优先复用）、docs/PLAN.md §5 P3/P4、docs/P2-reuse-proposal.md（§6 重复能力盘点）、docs/architecture.md。DSH 源码 ~/ai-workspace/deepseek-harness 只读（dsh-v0.2.1-rc.2）。可在 .dsh-dev 隔离 profile 用 mock 探针。不碰 ~/.dsh、不读密钥/会话内容、不 commit。

范围：
P3：①每 Bot 单独分配 MCP/连接器（复用原生 mcp-client、credentials；不写协议/凭据库）②主动通知/推送（复用原生 Inbox/followup；系统级桌面通知找公开面，没有则给可行最小方案）③接 dsh-im 消息渠道（社区包：锁定 owner/repo/tag，核公开接口；不可用则写适配边界与 mock）。
P4：①多 Bot 协作（优先原生 Agent Teams，实验包）②**群聊**：用户可拉多个 Bot 进一个群对话——群创建、成员管理、轮流或 @ 路由、群会话 UI（鲸鱼头像）。群聊是独立一类会话（不违反“每 Bot 一个会话”），说明如何用原生会话/Teams/子代理实现路由与上下文共享③完整管理界面（Bot、连接器、通知、群、记忆、定时任务）④MCP 记忆后端（官方 memory MCP 参考配置；现有 MemoryStore 迁移/共存）⑤插件市场：打包与元数据（不实际发布）。
约束：每 Bot 一个会话、标题=Bot 名；不强制绑定工作区；后台刷新不闪；不读密钥。

输出 docs/P3-P4-design.md：每项写原生能力核实（文件:行号）、复用 vs 自研理由、数据模型、UI、风险、mock e2e 方案；列出你自行做的设计决策（“决策：…理由：…”）；最后给任务拆分 U01 起（每个含目标/验收），并给 0.3.0 截图清单（亮/暗：群聊、管理界面、连接器分配、通知）。中文。
