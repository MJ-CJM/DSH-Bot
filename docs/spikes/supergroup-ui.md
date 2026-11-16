# SG00：原对话卡片与模式入口

日期：2026-11-12。参考源码只读，`git describe --tags --exact-match` = `dsh-v0.2.1-rc.2`。本报告仅覆盖 UI/入口调查，不裁定 Teams/Groups 执行路线。

后续实施注记：编排方选择 checked Groups 路线后，已按本报告实现公开非 exclusive `supergroup-work` 投影、Config schema 与原工作停止按钮。每项工作仅在 `work.inputMessageId` 原问题下显示一张卡，准确后续输入仍可查询/接续而不增卡。卡片展示实际有效成员总数及全部 `work.turnIds` 的真实轮次，不将仅专家参与的后继轮次改写为三人轮次。新增 11 项单测及真实四场景 Host/Chromium 初轮通过；最终同包和图像证据单列于[界面验收](../verification/supergroup-ui.md)。下文保留 SG00 调查当时的证据等级，不能作为最终产品验收的替代。

## 结论与证据等级

最小公开扩展为 **非 exclusive Conversation Definition + 独有 `conversation.chat.node` keyed renderer**；保留原生输入消息、composer、View。现有 `GroupTurnExecution` 可以直接渲染准确 GroupView/GroupTurn 的折叠执行卡片。开启模式优先复用现有配置页面或 `conversation.session.header.utilities` 的小型入口，经 owner Remote 调用原生 ConfigEditor 保存；不改变当前 Bot 的 preset。

公开 rc.2 Client closure 的 registry/assembler 与已有卡片 JSDOM 夹具共 3 项 PASS。此结果不是原生完整 Chat builder、浏览器、真实 Host 模式开关或自动组队证明。模式切换保存及存活会话继续聊天的 Supergroup 新组合仍为 **FAIL (NOT_RUN)**，需 SG01/SG05 实测。

## 精确公开入口

参考树根：`~/ai-workspace/deepseek-harness`。以下路径只读核对，不从内部路径导入。

| 能力 | 公开包与类型/API | 参考源码依据 |
| --- | --- | --- |
| 事件投影 | `@deepseek-ai/dsh-client-ui-conversation/client` 的 `ConversationNodeDefinition`、`ctx.uiConversation.events.register(definition)`、返回 disposer | `packages/client/ui-conversation/src/client/{index.ts,contract/conversation.ts,conversation/event-registry.ts}` |
| 同事件多投影 | `match` 不返回 `exclusive`，可与原生 input-message 同时收到事件 | `packages/client/ui-chat/src/client/conversation-nodes/message.ts`；`packages/client/ui-conversation/src/client/conversation/assembler.ts` 的 dispatch claims |
| 渲染扩展 | `@deepseek-ai/dsh-client-ui-slots` 的 `PropsRuntime<'conversation.chat.node', Kind>`、`ctx.slots.inject/register`；`@deepseek-ai/dsh-client-ui-chat/client` 的 `ChatNode` / `ChatNodeDataMap` | `packages/client/ui-chat/src/client/contract/{slots.ts,chat-nodes.ts}` |
| 模式入口 | `conversation.session.header.utilities`；空白页可选 `conversation.hero.options`；均使用标准 `sessionId`，文案走 locale | `packages/client/ui-conversation/src/client/contract/slots.ts`；本包 `src/client/index.tsx`、`components/SessionBotBadge.tsx` |
| 资料/过程只读投影 | `sessions.retain({parentSessionId,childSessionId,mode:'unknown'}, ...)` → `reference.ready` → `uiConversation.binding(reference.binding).target('chat')`，退出 release | 本包 `src/client/components/GroupMemberProcess.tsx` 的 `useMemberChat`；`src/client/group-execution.tsx` |
| 配置保存 | `@deepseek-ai/dsh-config-editor` 的 `entries()/edit()`；Loader `locate(ctx.fiber)/resolve(id)`；Schemastery `.volatile()`；`loader/volatile-update` | 本包 `src/host/proactive/setup.ts`、`src/host/index.ts`、`src/host/proactive/lifecycle.ts` |

锁定 rc.2 的公开 SlotMap 没有每条 user message 的 after/footer list slot。`conversation.chat.turnTail` 仅在已完成 Turn 的操作区前渲染，不能满足运行中的原输入附近卡片。不要覆盖原生 `conversation.chat.node` 的 `user` / `steering`，也不要重新注册 `chat` / `trajectory` View ID。`conversation.chat.user.content` 是内容 factory，缺少这项工作需要的持久行身份，替换它也会扩大影响面。

## SG04 最小落点

1. 为真实 `user/message` append 建立独有的非 exclusive Definition，保存准确 message id；`source.kind === 'user'` 仅用于 UI 识别，不作为 Host 人工授权证据。新节点不追加或改写会话事件。后台/成员来源不生成普通人类工作卡片。
2. 节点使用 `target:'chat'`、真实 `anchorSeq`、原 `location`、`visibility:'visible'`，新 kind 可采用 `supergroup-work`。Chat 同位置排序最后比较 `node.key`：参考 `chat-snapshot-builder.ts` 的 `orderedVisibleChatNodes`。应选择排序在原生 `input-message` key 后的稳定独有 key，真实浏览器确认卡片在原问题之后；不能依靠注册顺序。不得假造 Session seq。
3. renderer 从标准 `sessionId` 与真实 message id 联结 Host 权威关联；未关联返回 null。关联必须同时固定 Bot 代际、工作/尝试、GroupKey、turn id/revision；不使用最近群、最后输入或当前全局活动工作。使用会话级共享只读关联源，避免每个已加载输入独立轮询。
4. 通过已有 `actions.messageView(GroupKey)` 订阅真实 GroupView。卡片不另建 messages/roster/deliveries 副本；选定后端是 Teams 时不能把 GroupView 当成第二个成员权威，必须改为该后端公开投影。
5. Groups 路线重用 `src/client/components/GroupTurnExecution.tsx`；它默认折叠，展开后重用 `GroupMemberProcess` 与统计源，保留 `executionBridge` 和 `renderFactorySlot`，就能在原页面展示真实 child 推理；现有“查看详情”是可选导航，不能成为最终结果交付的唯一入口。
6. **现有 cancel 仅停止一个 turn**：`actions.remote().cancel(GroupKey, turnId, revision)`。Supergroup 跨关联轮次时，整项工作停止必须先由 SG01/SG03 的 owner 合同阻断增员、回传和后续派工，再覆盖实际活动轮次并等待真实清理证明。不能直接把 turn cancel 按钮改名为 work stop。成员补充现有逻辑给群根 draft 写入并查询群 composer，也需要替换为原对话工作补充入口。
7. 失活/切换/卸载须释放关联订阅、messageView、child 引用和 slot 注册；异步 ready/refresh 继续核对完整身份。最终成果回传的 receipt 由 Host 保证，卡片上的 completed/idle 不代表业务完成或用户接受。

## SG01 模式与配置生命周期

当前 `src/host/index.ts` 已导出 `RegistryConfig.volatile()`，但 `loader/volatile-update` **只**在 `onlyProactiveChanged(previous,next)` 时替换主动子 fiber；其他变化调用 `ctx.fiber.restart()`。因此只添加 `supergroupEnabled` 后通过 ConfigEditor 保存会走整个 Host restart，不满足现有主会话保留要求。`DshBotRegistry` 还将 Config 复制为自己的静态快照，热设置不能直接读这个旧副本。

建议最小增量：

- 增加 strict schema 的 Supergroup 配置域与默认上限；ConfigEditor 限定 self entry，只允许 own mode/scope 字段，校验 expected config epoch/owner/Bot 代际。沿用 `src/host/proactive/setup.ts` 的定位和 edit 回调复核，不能接受任意 raw config。
- 扩展明确的 hot-update 分类：纯 Supergroup 变化只替换所属子 fiber；主动域和 Supergroup 同时变化分别替换两者；其他配置按现有显式 restart 合同。不能把所有 volatile 变化无条件判为无需重载。
- Host registry、记忆 kernel、主会话映射与 guard、owner Remote 保持稳定。服务读取最新已验证配置的 getter；先同步 stopAdmission，再串行释放/创建子 fiber。重开后旧 epoch 的 pending/回传不能自动入场。
- 已有 Bot preset 内工具注册/撤下可参考 `src/host/groups/recall-tool.ts` 的 `installLiveGroupRecall`：`agent.ctx.effect` 持有工具与 prompt disposer，提交后通知重新核对开关和代际。SG01 安装新的能力时必须验证存活 Agent 路径；不得 `agentPresets.select` 热换已有 preset。只更新模式配置不意味着它已经拥有新 tool。
- 模式开关不提供具体资料和执行权限。首次工作仍绑定真实主输入、可见资料、选人范围、预算及原生审批；保留现有 `bot_delegate` ask。

沿用生命周期夹具 `tests/v066-follow-up-lifecycle-profile.mjs` 的断言形态：保存前后同一 `agent`/`sessionId`/preset/mainSessionId/memoryKernel，真实新 prompt 含原记忆/工具/人格，原生审批仍工作；切换配置零模型请求；关闭后旧 pending/通知/邀请隔离；冷启动配置持久化。旧夹具的历史 PASS 不能算 Supergroup PASS。

## 实际命令与验收

新增夹具：`packages/dsh-bot/tests/client/supergroup-ui-projection.spec.tsx`。

| 验收项 | 本轮结果 |
| --- | --- |
| 公开 rc.2 registry/assembler 同事件保留原生输入 + 非 exclusive 工作投影，排除后台输入，注销后移除 | PASS，1 test；native input 是最小 stand-in，仅测公开 dispatch |
| 既有卡片嵌在原页面 native composer 旁，默认折叠；2→3 投影计数更新不丢 draft；停止提交准确 GroupKey/turn/revision | PASS，en/zh 2 tests；Remote double，不代表真实停止/增员 |
| `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/client/supergroup-ui-projection.spec.tsx` | PASS，3/3 |
| `scripts/pnpm -F dsh-bot typecheck` | PASS；初次发现 views.register 不接收泛型，修正后通过 |
| `scripts/pnpm exec biome lint packages/dsh-bot/tests/client/supergroup-ui-projection.spec.tsx` | PASS |
| Supergroup Host 模式保存/冷启动/存活 Bot/审批新组合 | FAIL (NOT_RUN)，本轮只读调查，不改正式配置/Remote |
| 原生完整 Chat builder 排序、实际浏览器、亮暗/窄屏、child 订阅释放、工作级真实停止 | FAIL (NOT_RUN)，需 SG04/SG05 同包运行 |
| `scripts/pnpm check` | FAIL (NOT_RUN by this subtask)，由编排方统一执行，不能用 focused test 代替全仓检查 |

本轮不修改生产 Client/Host、locales、package/lock、参考树或桌面 profile；未使用真实 key、模型或部署。剩余 UI 实现须待 SG00 执行来源/共享范围 gate 通过，不以本报告将整个 SG00 标记通过。
