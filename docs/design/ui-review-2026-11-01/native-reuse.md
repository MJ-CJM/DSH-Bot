# 原生复用审计

结论：**重复主要集中在 UI 基础设施和入口组织；执行、调度、权限、MCP、凭据和思考渲染已经大量依赖原生能力。** 不应为了代码变少，删除承载 Bot 身份、群聊消息归属与记忆语义的适配层。

本轮对照安装的 `@deepseek-ai/dsh-* 0.2.1-rc.2` 公共声明与 README，运行截图来自 Host rc.5。声明核实与新集成实测分开：表中“直接复用”表示公共 API 与用途明确，仍需在 U0 跑集成验证，不表示迁移已经完成。

## A. 优先收敛：确有官方公共替代能力

| 当前实现 | 官方公共能力 | 判断与迁移边界 | 本轮证据 |
|---|---|---|---|
| `components/Modal.tsx` 手写焦点恢复、Tab 循环、Escape、dialog/backdrop；Bot、复制、删除、未保存确认共用 | `dsh-client-ui-primitives` 导出的 `Modal` / `useModalLayer` | 高收益；换公共 Modal，业务层仅保留 busy/dirty/删除后果。测试多层弹窗与菜单时 Escape 消费顺序，不能把 onClose 无条件接到丢弃 | 本地 Modal:16–98；官方 `lib/types/index.d.ts:39–40`、`Modal.d.ts`，官方 README 解释模态层和回焦 |
| 大量普通 button/input/checkbox 与重复 `.button/.field` 样式 | `Button`, `Input`, `Checkbox`, `Switch`, `StateDot`, `PathLabel` | 逐页迁移，减少亮暗、焦点、禁用态的重复实现。没有公开对应组件的 select/textarea 保留标准 HTML 和薄 token 样式，不假定存在 Select/Textarea 导出 | 70 个 TSX 文件中静态数出 215 个 `<button>`、69 个 `<input>`、13 个 `<select>`、18 个 `<textarea>`；这是出现次数，不是重复逻辑数量，也不是应全部替换的数量 |
| `RecentConversations`、Bot 详情和新建入口用 `details/summary` 充当操作菜单 | `Menu`, `MenuItemButton`, `MenuSurface` | 官方菜单负责定位、键盘、关闭与回焦；真正的内容折叠仍可用 disclosure，不能机械删除所有 details | 官方 index:25–29；项目 `RecentConversations.tsx` / `BotsTab.tsx` / `BotsPage.tsx`；40–41 展示群模型/权限菜单已在用官方组件 |
| `ManagementWorkspace`、`ManagementPanel`、BotEditor 的手写 role=tab 按钮 | `SegmentedTabs` / `SegmentedControl` | 小组切换复用原生键盘行为与 panel 关联；一级页面导航用 nav 语义，不能都当 tabs。长设置目录可用公开框架 + 插件轻量布局 | 官方 index:14–21；本地组件均已核对 |
| `BotsPage` 的 toast div 与关闭按钮 | `Toast` | 通用成功/失败瞬时提示换官方控件；持久错误仍需 inline alert，通知中心仍需记录/未读状态 | 官方 index:59、Toast 声明；本地 `BotsPage.tsx:131` |
| JSON 原始预览、路径和状态显示 | `JsonTree`, `JsonBlock`, `PathLabel`, `StateDot` | 值得在导入预览、能力诊断、状态行中使用；输入 JSON 仍需可编辑控件 | primitives 公共 index / README 已确认 |

当前只有 11 个 TSX 文件显式导入 primitives。该数字只用于定位覆盖面，不能用“原生组件占比”替代体验验收。

## B. 先验证契约，再决定收敛

| 候选 | 官方现成能力 | 为什么不能直接替换 | U0 验证 / 决策 |
|---|---|---|---|
| 整个插件设置外壳 | `dsh-client-ui-settings/client` 的 `settings.section`、`settings.plugins.tab`；`configForms`；primitives `SettingsForm/SettingsFormModel/SettingsValueField/SettingsSecretField` | 全局配置文档的 namespace/revision 与 Bot 记录 CRUD 不是同一契约。SettingsForm 声明离开即 discard，而我们有跨页脏草稿确认。slot 还依赖运行时 owner | 用一个真实插件级字段验证注册、读写、只读、返回和冲突；仅匹配的全局设置走原生，Bot 设置保持现有后端，必要时只复用表单控件 |
| 手写 SnapshotStore/listener 集合 | `dsh-client-store` 导出 `createSnapshotStore`, `defineStore`, `notifySubscribers`, `shallowEqual` | 项目 `state.ts` 还包含版本/epoch、请求取消、保留成功快照、首末订阅、共享轮询；官方 store 不替代这些语义，shallowEqual 也不等价于结构比较 | 最多先替换纯快照发布层；保留 scheduler、身份/版本栅栏和 effect 生命周期。低优先级，不和主 UI 改造捆绑 |
| 能力/技能面板 | 原生模型、工具、技能元数据与配置读取已有桥接 | 未验证存在公开的完整“Bot 能力编辑器”组件；原生配置格式与 Bot 生命周期有所不同 | 共用数据访问和公共原语，改善分组；完整 UI 复用必须先找到并验证公开 Factory |
| 单独的定时任务/后台任务 UI | 已有原生 schedule/subagents 服务、原生工作区会话和自动化入口 | 不能从另一个插件内部导入任务页；Bot 过滤、代际绑定和操作权限仍需插件负责 | 优先用公开导航打开官方完整页面；局部保留聚合行。有可注入且保留 Bot 过滤的公开 Factory 才进一步替换 |
| 执行详情的技术 prompt | 已使用公开 `conversation.content` Factory | 原生完整历史包含插件发给 worker 的真实 prompt；内部节点渲染器并非可随意替换 | 验证公开视图/slot 是否能默认定位过程或包装插件生成的输入摘要；不能则保留原生详情，改善外层标题与行内摘要，不能删事件日志 |

## C. 已经在复用，继续保留

| 能力 | 当前桥接 / 公共契约 | 结论 |
|---|---|---|
| 群内每 Bot 的思考 | `GroupMemberProcess.tsx` 从原生 `sessions.retain` 和 `uiConversation.binding(...).target('chat')` 取真实投影；`DisclosureRow` + `conversation.chat.reasoning.content` Factory | 已复用，截图38、43–46为运行证据。自有部分负责把 child 绑定到准确成员/问题，不再复制推理渲染 |
| 原生执行详情 | `group-execution.tsx:75` 使用 `conversation.content`，嵌入只读会话 | 已复用，不再造聊天页面。截图39是实际展示，不代表 prompt 分层已经实现 |
| 消息 Markdown / 附件 | `GroupMessageCard` 复用官方 `MarkdownText`；Host 通过 `fileUploads` 绑定原生 user receipt；群用户行仍由插件呈现 | 保留官方 Markdown 与文件 receipt；群消息身份、引用元数据和用户气泡布局属于插件，不能声称整个用户消息行已是原生组件 |
| 群模型和权限菜单 | `GroupModelControl` 用公共 Menu/Button 和官方目录；`GroupPermissionControl` 用 Menu/Button/RiskConfirmation，`group-permission-state` 调用 `remote.permissionPresets` | 控件与后端已原生化；组默认 → 成员覆盖 → Bot 默认的继承逻辑必须保留 |
| 并发子任务、恢复、停止 | 原生 `subagents.startActivation/sendMessage/interrupt/drainChildren`，插件保持精确 parent/child 与 group delivery | 使用原生执行器；插件有限并发、讨论唤醒、轮次/成员身份不属于重复 executor |
| 定时任务 | `automation-state.ts` 读 `remote.schedule.catalog/update/delete/history`；Host `native-schedule/service.ts` 关联 Bot/Session | 已是原生调度器。优化入口和展示即可，不应再写 scheduler，也不能直接移除 Bot 绑定 |
| 后台任务控制 | `background-work-state.ts` 复用 `remote.subagents` 的 prompt/interrupt | 聚合展示可优化；执行控制不必重造 |
| MCP / 凭据 | `host/connectors/service.ts` 复用 `dsh-mcp-client` 和 `credentialRef`；Client 使用 `remote.credentials` | 传输与密钥存储已原生化。插件保留按 Bot 绑定、版本和应用状态 |
| 原生 Team | `host/collaboration/service.ts` 调用 `ctx.get('agentTeams')` | 是官方 Team 的 Bot 绑定层，不是新 Team 引擎；本轮 Host 未启用，只捕获降级页 |
| 参考图谱后端 | `host/reference-memory/writer.ts` 复用 `dsh-mcp-client` | MCP 复用已做；参考记忆、写入治理与前端查询层仍是插件功能 |

## D. 必须保留或当前没有证据可以替换

- **Bot 领域**：职责/头像、主会话关系、代际身份与删除重建保护、与原生 preset/session 的关联。
- **群聊领域**：成员身份、问题/回复引用、讨论轮次与空闲终止、有界自动续跑、每成员模型继承、消息投递幂等、取消边界。
- **记忆领域**：私有/用户共享、候选/冲突/旧数据归属、版本与来源、遗忘预览和历史副本清理。原生会话持久化不是该功能的等价替代品。
- **导入导出**：可迁移字段、路径和凭据排除、文件预览、冲突判断。官方 JSON 控件只负责展示。
- **通知领域**：策略、额度/静默时段、持久意图、投递回执、未知结果与未读。原生 Toast 不是通知中心。
- **IM 门控**：`host/im/service.ts` 当前保持 `inboundSupported/outboundSupported=false`，即使探测到契约也有未验证消费门。不能只借原生 UI 的外观宣称能用，更不能因改版放开。
- **群输入框**：rc.2 不公开完整 InputBar、ModelSelect、PermissionSelect。继续通过公开 `conversation.composer` slot、公共控件和服务做最薄包装；不得引入内部组件路径。slash、语音、原生草稿若要接入，需要单独的行为验证。

## 复用迁移的退出标准

新组件必须删除或停止使用对应旧 UI 基础实现，而不是外面再包一层留下两套；同一后端只有一处状态事实来源。无法复用时留下具体公共 API 缺口与实测结果，而不是泛泛写“原生不支持”。

迁移验证覆盖卸载释放、数据变化、失联/重连、只读、并发更新、未保存草稿、焦点、菜单层级和窄屏。仅能 import 或类型检查通过不算运行验证。

相关既有证据：[API notes](../../dsh-api-notes.md)、[原生思考实现报告](../../verification/group-member-process/report.md)、[并发 API 验证](../../verification/group-collaboration/native-api.md)。这些既有结果与本轮截图分别保留，不冒充本轮重新执行的回归矩阵。
