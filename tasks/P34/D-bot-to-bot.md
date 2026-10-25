# 设计：Bot 间互通（用户 t40u/t41u）— 只出设计，不改产品代码，不提交。输出 docs/bot-to-bot.md（中文）。
读 AGENTS.md、docs/P3-P4-design.md、docs/architecture.md、packages/dsh-bot/src/host/{delegate,groups,collaboration,native-schedule,main-session.ts}；DSH 源码只读（.dsh 源码检出位置见 docs/dsh-api-notes.md）。
用户要求（照 Grok Bot 可见行为）：
1. 每个 Bot 上下文自动带“队友列表”（其他 Bot 的 id/名称/简介）。
2. 工具“给队友发消息”：投递到对方 Bot 自己的**主会话**，由对方用自己人设/记忆/连接器/工具处理；对方会话中标明来自哪个 Bot。两种模式：仅通知（不等回复）/ 提问等待回复；可标优先（打断对方当前轮）。
3. 异步回复：对方处理完用同一工具回复，回复作为“来自某 Bot 的消息”送回发起方会话并唤醒发起方，发起方告诉用户。发起方不阻塞、不轮询。
4. 安全：队友消息是数据而非用户授权，不得据此做用户没要求的高风险操作；需审批动作走原生审批。防循环：跳数/深度上限、同一对 Bot 限速、去重。
5. 任一 Bot 会话可看到与其他 Bot 的往来消息，折叠/弱化样式+对方鲸鱼头像。不新增任何 Bot 可见会话（每 Bot 仍仅一个主会话）。
6. 群聊保持现状。
要求：
- 原生优先：逐项核查 DSH 是否有跨会话投递+唤醒的公开能力（schedule 投递目标会话的机制、sessionController/agent.followup/steer、session 事件/消息 API、Teams mailbox 等），给出 API 名称与源码位置及能否用于插件；只有缺公开 API 处才自建，并说明原因。
- 决定 bot_delegate 的去留（并入/改走新机制/保留为“一次性子代理”），给理由。
- 数据模型：消息信封（id、from、to、threadId/correlation、hop、mode notify|ask|reply、priority、ts）、持久化与冷恢复（目标会话不在内存/桌面重启时如何投递）、幂等。
- 防循环细则：hop 上限（推荐值）、每对 Bot 速率、去重窗口、链 A→B→C→回复 A 的回复路由规则（回复给直接发送方 vs 原始发起方，择优）。
- UI：消息在会话中的渲染方式（原生 message/notice 渲染扩展点？），折叠、头像、来源标识；Bots 页是否显示往来概览。
- 与群聊、Teams、notifications、IM 的关系与边界。
- 测试方案：mock e2e 覆盖 A→B→回复A、A→B→C→回复链、循环被拦截、优先打断、冷恢复投递、无新增可见会话。
- 任务拆分（每项可单独验收），风险与回退。
- 标注每个决策为 [Codex]。
