# DSH API 核实记录

## T08e：原生工作区会话行 Bot 头像

通过公开 `sidebar.session.row.leading` / `sidebar.session.row.hover`（均 root/list）追加贡献，id 分别为 `dsh-bot-avatar` / `dsh-bot-identity`，`order:0`，所有注册归 `ctx.effect`。owner 只有 `sessionId`；用已有 activity 的 `sessionId → botId` 再查现有 Bot catalog，不绑定或激活 Session、不猜 preset 前缀。两个 catalog 首次读取成功前返回 null；没有 activity、Bot 已删除或摘要已淘汰同样返回 null，不增加占位。刷新期间沿用最近成功快照；跨 Client 删除在下一次成功轮询后反映，不声称即时一致性。

源码基线只读核实为 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`：

| 公开合同 / 布局事实 | 来源（相对参考仓库） | 取舍 |
| --- | --- | --- |
| `SessionRowScheduleOwnerProps`、root/list 两 slot；公开 `/client` 导出 | `packages/client/ui-workspace/src/client/contract/slots.ts:106-136`、`index.ts:61-67` | 复用现有精确 devDependency，无新依赖或 Host/Remote API |
| 行高 32px、leading cell 固定 16×20、标题左距 4px | `ui-workspace/src/client/rows/Rows.module.css:109-128` | 复用 `BotAvatar size={16}`，默认着色鲸鱼；保留既有自选 emoji/图片约定，无额外未读点 |
| schedule-mark / schedule-tasks 均 `order:10`，mark 占 16×20 | `ui-schedule/src/client/index.ts:231-244`、`SessionScheduleMark.module.css:3-11` | 两个 16px 图标不能安全并排。Bot 排前但在有后序 DOM 元素时用自身 `.leading:has(~ :not(style))` 隐藏；保留原生时钟，hover 仍显示 Bot 名称。只设置自身 CSS，不改父格、标题或其它插件 |
| `data-slot` 是公开样式 anchor；list 渲染 Fragment，没有每项布局 wrapper | `ui-renderer/src/client/scoped-slots.tsx:1062-1100,1239-1251` | 后序贡献返回 null 时不触发退让；对其它后序元素（即使它自身隐藏）也保守退让，不依赖 schedule 私有类、marker 或独立查询 |
| leading 仅非 blank/非 archived/primary idle 行挂载，搜索结果无该 slot；hover 与状态独立 | `ui-workspace/src/client/rows/Rows.tsx:430-444,627-635` | 运行中、待交互和原生新消息状态继续显示宿主状态点；不承诺所有 Bot 行始终可见鲸鱼 |

所有行复用现有两个 catalog 的主动订阅，各最多一个共享 timer，沿用 Config.pollIntervalMs、visibility/reset、epoch 与最后订阅卸载语义，不为每行新增查询。比原有被动徽标多持有 Bot catalog 的轮询 lease，以更新原生列表中其他 Client 的修改/删除。无身份时连 style 标签也不输出；有身份时样式属于该 React 树，卸载即移除。hover 文字从 `row.bot` 双语 locale 读取，同时设置 alias 背景与前景（宿主 hover 卡背景固定暗色）。

截图脚本新增 `--workspace-only` 的 zh light/dark 原生列表，默认矩阵增加同样两张；检查真实 treeitem、头像 16px、垂直对齐与不覆盖标题。完整运行结果、Chromium 沙箱阻塞及未验证边界见 [T08e 验收](acceptance/P1-T08e.md)。组件/jsdom 与 mock Host 通过不代表亮暗截图通过。

## T08d r1：宿主截图活动读取失败的根因与修复

宿主截图 `dist/screenshots/2026-10-19T04-41-47.579Z-63798/` 的活动错误已用**正式浏览器 factory + 独立 Cordis Client 插件作用域 + 真实 Gateway/Connection/Host + mock 持久活动**复现。修复前 `.dsh-dev/t05/run-2026-10-19T04-47-02.994Z-67384/client-activity-completed-mock.json` 报 `cannot get property "remote.dshBot.activity" without inject`。请求在 Client 子服务访问时就失败，并非 `lastEventSeq` 解码失败。

rc.2 每个 namespace 是独立 Cordis service。`ctx.get('remote.dshBot')` 只读取父服务，其追踪后的 `.activity`/`.memory` 属性仍触发子服务的 inject 检查。根 Context profile 没有该限制，普通嵌套对象 doubles 也不会模拟它，因此此前真实 HTTP profile 和组件测试都漏过这个**插件作用域差异**。修复为分别通过公开 `ctx.get('remote.dshBot.activity')` / `ctx.get('remote.dshBot.memory')` 取准确服务名；不把自己负责挂载的 namespace 加进 assembly 的启动 inject，避免自等待。来源：`vendor/cordis/src/reflect.ts:144-165,225-235`（property 检查及公开 get 的免 inject 读取），`packages/api/gateway/src/client/index.ts:368-379,647-654`（namespace service 的构造）。Memory 读取和计数/修改入口有同一模式，一并修正以保持管理可达。

Store 原本已通过移除 `lastEventSeq` 的投影返回公开数据，本轮进一步改为逐字段白名单（包括 lastMessage 子字段），让未来存储内部字段也不透传，`list` 和两条 `markRead` 返回分支共用它。此外核实 **strict/create 不等于输出自动校验**：Host `encodeRpcResult` 仅调用可选 encode（`api/gateway/src/index.ts:1106-1115`）；Client 仅调用显式 decode（`src/client/index.ts:461-466`）；`createTypertRemoteInfo` 不会从 create 自动生成两者（`typert/protocol/src/remote-info.ts:49-59`）。因此活动的 list/markRead result 现显式声明 `encode/decode = schema.parse`，Host 输出和 Client wire 都执行相同严格合约。未将 lastEventSeq 加入公开合约。

新增 `tests/fixtures/client-activity-probe.mjs` 执行真实 `lib/client.js` factory，仅视觉/shell services 为 doubles；生产插件自行挂载真实 Remote，其页面 activity catalog 执行 list/markRead。Composer profile 在 mock 完成后和冷恢复后分别检查持久 lastEventSeq 存在、decoded list 不含它、unread true→false、严格返回合约。截图 `--seed-only` 也运行该 production-scope probe，不再仅用根 Context 验证。另有 real Gateway + Connection JSON parser 的负例，确保 wire 中多一个 lastEventSeq 会拒绝，并保留上一份成功快照。

UX 调整：markRead 尽力而为。真实失败仅记录本地化 `activity.readFailed` warning，不记录原始异常/载荷，仍打开会话；保留导航取消/卸载门禁。轮询失败继续保留最近成功的 sessions/bots，显示带重试提示的错误；成功重取再清错误。最终运行与宿主重截边界见 [T08d r1 验收](acceptance/P1-T08d.md#r1-宿主截图-fail-修复)。

## T08d：双栏 Bots、活动展示与当前会话已读

正式 Client 仍注册公开 `main` 的 `dsh-bot` keyed entry，不嵌入原生会话。`main.conversation` 由 ui-conversation 独占，rc.2 没有整段会话 Factory；历史会话使用 `ctx.uiWorkspace.openSession(id)`，新会话仍走既有 `openWorkspace(workspaceId, beforeOpen, { agentPreset: status.presetId })`。页面、footer 弹层及记忆来源链接统一先尝试 `activity.markRead` 再导航；`activity/not-found` 表示空白、安装前或被淘汰摘要，直接允许打开；其他写入失败也不阻止导航，仅记录无载荷的本地化 warning（r1 修订）。

| 公开 API / 语义 | 锁定源码位置（相对 `deepseek-harness@dsh-v0.2.1-rc.2`） | T08d 用法 |
| --- | --- | --- |
| `sessions.list` / `SessionListState` / `SessionSummary` | `packages/api/session-controller/src/client/sessions/service.ts:27-65,243` | `ids` 是 Host authoritative membership；`byId` 还可能含保留投影。按 Host status 的精确 presetId 分组，排除 subagent 与公开 archivedSessionIds；活动补充预览/未读，`running` 仍由宿主提供。没有 currentSelection 字段 |
| `usePanelInfo` / `PanelInfo.activePanelId` | `packages/client/ui-layout/src/client/index.ts:48-50`、`service.ts:18-21,28-41` | 全局标准 hook 可在 header slot 取得；`null` 为原生 Conversation，选择其它全局页面不会清当前会话 |
| `retainedBy.mainView` | `packages/client/ui-session/src/client/index.ts:189-192`、`ui-workspace/src/client/navigation.ts:499-519` | 公开主视图引用来源；结合 session-bound `sessionId` 与 `activePanelId===null` 判断当前原生会话。上游 `ui-layout/src/client/DocumentTitle.tsx:17-22` 也用此方式识别当前会话 |
| `conversation.session.header.utilities` | `packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx:70,131-135` | 已有徽标在 Bot 映射有效、当前主会话、文档可见且活动 unread 时 markRead；新回复的活动轮询也会触发。空白 hideChrome 不挂此 slot，且没有 assistant 未读 |
| `layout.beginNavigation(): AbortSignal` | `packages/client/ui-layout/src/client/service.ts:41,73-85` | 在等待 markRead 前持有公开导航 signal；期间其它导航/面板选择使其 aborted，晚响应不得抢回旧会话。Host markRead 已提交的读状态不会回滚 |
| `sidebar.footer.action` | `packages/client/ui-sidebar/src/client/contract/slots.ts:49-53` | additive list slot 允许自定义 React 组件，本轮在其按钮直接加未读红点，使用 `--dsw-alias-state-error-primary`，不需要私有 API/DOM 注入 |

新增共享 activity catalog 复用原 `createPollingCatalog`，`list()` 严格零参数。页面、常驻 footer 和徽标共享最多一个活动轮询，默认沿用 Config.pollIntervalMs=5000；文档 hidden 停 timer，卸载最后订阅者停止 timer/reset/visibility 监听和本地等待。重新显示、connection reset、显式刷新、成功修改 Bot/标已读都重取。footer 常驻时保持活动轮询以便红点更新，Bot 元数据 catalog 在 footer/徽标中仍为被动订阅。并发同 session markRead 合并；成功写入后 supersede 旧读，重新读取 Host 状态，因此写后出现的新回复仍可保持未读。unary Remote 没有取消 Host 操作参数，epoch/AbortController 仅取消本地等待与拒绝晚响应。

持久与 Remote schema 保持原 string 字段，新增保留 ASCII 哨兵 **`[dsh-bot:hidden]`**，适用于 `lastMessage.preview` 和脱敏 `title`。常量与识别函数通过 `dsh-bot/remote` 导出；Client 对新哨兵及旧 **`[已隐藏]`** 都显示 locale 的“内容已隐藏 / Hidden”。旧数据可直接读，不重写存储、不升级 schemaVersion；普通字符串恰等于保留哨兵时同样显示为隐藏。Host 不写 UI 语言。`Intl.RelativeTimeFormat` 的 locale 从随 UI 翻译切换的 `activity.locale` 读取。

UI 使用公开 primitives/slot、既有 BotAvatar 与 alias tokens；按实际 main 宽度 `<760px` 切为列表→详情，并管理键盘选择、焦点恢复与轮询重排后的选中保持。Client 显式依赖 `sessions`，在共享 TS program 中以公开 `ISessions`/`ObservableSnapshot<SessionListState>` 隔离 Host 同名 Context 声明；这只影响类型，不读取 Host 私有状态。

验证层级：公开 Cordis/SlotCore + React/jsdom 测试覆盖导航顺序、可见性、竞争与卸载；真实 Registry/Composer profile 和截图 `--seed-only` 验证 Host/Remote/mock 活动。**r0 未运行 Chromium；编排方随后实测首轮 FAIL，r1 已按上节修复，修复后宿主矩阵待重跑，不将组件/profile/seed 结果称为真实浏览器视觉通过。** 截图脚本默认 7 张（中英亮暗宽屏 4、中文亮窄屏 1、中文亮暗弹层 2），mock 种子包含 3 个 assistant 回复、1 已读/2 未读。脚本使用 `.dsh-dev/screenshots/<run>` 与独立 storage root，保留此前 `.dsh-shot` 证据。详见 [T08d 验收](acceptance/P1-T08d.md)。

## T08c：Bot 会话活动（Host + Remote）

正式代码为 `packages/dsh-bot/src/host/activity/`、共享 `activity.ts` 和既有 Registry/Store 扩展，无 spike import、无 UI 改动。运行证据与边界见 [T08c 验收记录](acceptance/P1-T08c.md)。下列源码路径相对只读参考 `deepseek-harness@dsh-v0.2.1-rc.2`。

| 公开 API | 来源 | 用法与理由 |
| --- | --- | --- |
| `agent/created` | `packages/core/agent/src/runtime-types.ts:248-261`、`src/index.ts:539-556` | 创建和冷恢复都安装活动观察器，不按 source 跳过恢复；使用所属 Agent effect 清理 |
| `session/event(session,event)` | `packages/core/session/src/index.ts:64-74,872-889,1210-1223` | post-commit 完整事件，按真实 Session 对象隔离；`agent.ctx.sessions.enter` 绑定 Agent scope，见 `core/agent-loop/src/index.ts:654`；无每 token 写入 |
| `user/message` / `assistant/message` | `packages/core/session/src/types.ts:303-350`、`core/agent-loop/src/agent.ts:434,465-482,529-546` | 只收 `surfaceOp:'append'`、human `source.kind:'user'` 和未中断 assistant 的 text blocks；排除 synthetic user、reasoning、工具调用、图片、失败 attempt、compaction replacement 和流式 delta |
| `SessionEvent.time/seq` | `packages/core/session/src/types.ts:494-501`、`src/index.ts:817-823` | time 为毫秒，seq 单会话单调；内部持久 `lastEventSeq` 排除重复/过时消息，对外不暴露 |
| `sessionProjections.snapshot(session).values.title` | `packages/session/session-projection/src/index.ts:330-352`、`session-title/src/index.ts:269-281` | 在消息完成时读取公开 title view，runtime narrow 为 string；缺服务/无标题时省略；标题同样脱敏，重命名在下一条完成消息时刷新 |
| `agent-preset/selected`、`agents.get`、`scopeOf/scopeChainOf` | `packages/preset/agent-preset-registry/src/index.ts:66-71,348-360`、`packages/core/scope/src/index.ts:87-103` | 空白会话 recompose 不重发 created，按精确 preset 代际交接活动 lease；不依赖可能过期的创建 header 或仅匹配稳定 id |

事件观察只同步提交任务到 Registry 串行队列，Host 卸载先 drain 再关闭原有 `dsh_bot` Domain。Agent/preset 两方均持有 disposer；正常 Bot 更新不改变仍活跃旧代际的所有权。**必须从声明 inject 的 preset `ctx.dshBots` 捕获 sink，不能直接访问 loop 所有的 `agent.ctx.dshBots`**：后者未注入服务，会同步抛错。Agent ctx 只拥有监听器/effect；同步和异步写失败均输出固定信息，不泄露 cause。该差别经真实 profile 失败诊断、公开 Cordis 依赖隔离回归及修复后的完整 profile 验证。

存储写入前校验 Bot 存在及创建时间，防止已删除旧 Agent 的迟到事件重新生成活动；Registry 的候选 preset 和持久 Bot 共享创建时间，避免注册耗时导致身份不一致。同一 Host 内新 Bot 创建时间单调递增，重启从现存记录最大值起算，防止同毫秒删除/同 id 重建及系统时钟回退复用旧身份。纯图片的真实用户消息仍记录 user + 空 preview，以更新最后消息和未读状态；无可见文本的 assistant 工具/推理步骤不覆盖预览。

`dsh_bot` version 1 增加 `activities` 表，旧域缺表可按公开 Domain 行为打开，测试确认既有 Bot/记忆不变。记录存 `sessionId/botId/title?/lastMessage/updatedAt/lastReadAt?`，Remote 再计算 `unread = role==='assistant' && at>(lastReadAt??0)`。仅在完成消息时写入；同一 Agent 的 token 流不落盘。Config 导出 `activityMaxSessionsPerBot=50`、`activityMaxSessionsTotal=1000`，均为正安全整数；按 updatedAt 降序保留，sessionId 破同时间平局，启动时也应用降低后的上限。markRead 不更改 updatedAt 或 LRU；删除 Bot 无论 deleteMemories 真假都清理活动。后台没有跨表事务，失败时可能已部分清理，但 Bot 保留以便重试。

完成事件 `at=max(event.time,previous.at+1,lastReadAt+1)`；`markRead` 写 `max(Date.now(),lastMessage.at,previous.lastReadAt)`。该微小逻辑时钟补偿同毫秒消息与系统时钟回退，保证严格 `>` 的未读规则在读后新回复时成立。相同时间重复 markRead 不再写盘；重复/旧 seq 不改预览或读状态。

预览对完整原文先复用 T06 `memory/secrets.rejectMemorySecrets`，清洗 markdown/代码块/图片及控制字符后再次检查，再按 Unicode 码点截到最多 120（含 `…`）。T08c 命中原用 `[已隐藏]`，T08d 改为上节的 locale 无关哨兵并兼容旧值；原文、原始标题及异常 cause 不进入活动存储或观察器日志。此为原有签名启发式检测，无法保证识别所有秘密。

Remote 继续使用单一手写 Zod spec、`TypertRemoteService` + `@Remote`、Host `ctx.typert.register` 与已有 Client `$mount`。新增 `dshBot.activity/list` → `{sessions,bots}`（所有现存 Bot 均有聚合，尚无消息时 `lastActivityAt:0,unreadCount:0`）；`dshBot.activity/markRead(sessionId)` → 带 unread 的 session。未知/已淘汰活动返回结构化 `activity/not-found`；存储不可用时 list 降级为 `{sessions:[],bots:[]}`、markRead 返回 `store/unavailable`。**list 是零参数**：rc.2 Client `prepareInvocation` 强制实参数量（`api/gateway/src/client/index.ts:508-518`），不能以 TS 可选参数伪装真正的 `list()`；本轮不提供可选 Bot 过滤端点，调用方可对完整结果筛选。合约类型经公开 `dsh-bot/remote` 导出，未引入 Client Host-only 事件转发；T08d 仍需轮询/重取。

冷恢复时历史 seed 不会重发 `session/event`（`core/session/src/index.ts:550-560`），因此读取已持久活动并订阅后续消息；不扫描历史日志补齐首次安装之前的消息。

## T08b：原生布局、平台头像与侧栏会话入口（0.1.1）

- 最后一轮截图补充：`--extras-only` 仅中文宽屏亮/暗的编辑器和 Bot 会话弹层，共 4 张。复用公开 `@deepseek-ai/dsh-llm-mock-server` 根出口 `startMockLlmServer`，隔离 profile 的 deepseek provider 只指向 `127.0.0.1` 动态端口，两次 success 响应。使用公开 `session/create({request:{workspaceId,agentPreset}})`、`session/prompt({request:{sessionId,requestId,mode:'queue',content}})`、`session/rename({request:{sessionId,title}})`；preset 来自本包 Host status。`session/list` 的原始 wire 参数名是 **`_request`**（`api/session-controller/src/index.ts:276`），summary 的 blank/running 见 `types.ts:178`；`session/projections.values.sessionStats.turns` 为公开 view（`session/session-stats/src/projection.ts:200`），不使用内部 turnBoundary。`--seed-only` 在真实 rc.2 Host 实测两条非空会话、两次 mock completed，无真实模型；浏览器截图受沙箱限制待宿主运行。既有完整 16 张矩阵已于 `2026-10-19T03-15-49.355Z-573` PASS，最低实测对比度 4.7265:1，取代下文历史待验结论。详见[最后一轮报告](acceptance/P1-T08b-review.md)。
- `@deepseek-ai/dsh-client-ui-primitives` **根出口**公开 `Button`、`Menu`、图标和 `FishLogo`，且在锁定 Web 平台表内。正式 Client 将其 external，由宿主 factory require 共享，未内联宿主 UI、未复制 SVG。来源：`packages/client/ui-primitives/src/index.ts:12,26,46`、`package.json:16`，`packages/client/web/src/platform.ts:13`、`seed.ts:40`。精确 devDependency rc.2，Client-only 不新增 Node peer。官方图形仅用于 Bot 头像，未更改插件名称、宣传或插件图标；已读根 `BRAND_GUIDELINES.zh.md`。
- 原生全局页面没有公开 PageLayout 组件，按其度量重建：960px 内容、24–48px 横距、48px 底距、28px header 顶距；macOS 另加锁定版 48px 系统条留白；20/28/500 标题、13/20 副标题、32px 主按钮。出处及响应式网格取舍见 [T08b 验收](acceptance/P1-T08b.md)。`ResizeObserver` 按实际 main 宽度切换窄/宽 class，React 卸载清理。
- 可选 `avatarColor` 存四个受限 alias token 名，shared schema、Remote codec、存储 patch、duplicate、`bot_manage` 显式 input/output schema 同步；`null` 清空，无字段旧记录继续有效，不升 schemaVersion、不主动迁移。统一 `BotAvatar` 优先图片，其次已设 emoji，否则按 id FNV-1a 选色鲸鱼。颜色与主题主文字混合保证锁定亮暗主题非文本图形对比度 ≥3:1（最低 3.96:1）；这不是浏览器视觉验证或自定义主题保证。
- 工作区选择由页面/侧栏共用 launcher 在聊天时进行。单工作区直接用；多个时每次选择并预选上次成功导航的工作区。记忆只在当前 Client 插件闭包内，卸载清空；在公开 `beforeOpen` 通过取消检查后记忆，避免 `selectPanel` 立即卸载页面导致成功选择丢失，也不记忆被 supersede 的导航。`onStart` 仍重新读取 Host status，只用其 presetId。来源：`ui-workspace/src/client/navigation.ts:40,276,280,303,509`。5 秒轮询 Config 保留，页面头部无刷新间隔控件。
- **rc.2 不支持追加与工作区并列的常驻区块。** `sidebar.workspaces` 是 single，`sidebar.panellist` 只承载导航图标，公开 additive 入口是 `sidebar.footer.action`。本轮采用 footer action 打开 Bots 会话对话框，保留管理入口和原工作区；未替换 single、未挂载私有组件、未用 DOM 注入伪造区块。来源：`ui-sidebar/src/client/contract/slots.ts:35,42,53`，`ui-sidebar/src/client/SidebarRoot.tsx:295`；`docs/subsystems/slots.zh.md:54,62`。该降级不算“并列常驻区块”验收通过。
- 通过公开 `useSessions` 读取宿主 `sessions.list`，仅从 `ids` authoritative membership 取行，`projectionValues.agentPreset` 按 Host `status.presetId` 精确分组，按 `updatedAt` 倒序；默认每 Bot 5 条，可“更多”。Config `sidebarSessionLimit` 整数 1–50。仅本弹层排除 archived/subagent，工作区会话列表没有公开全局过滤扩展，仍显示 Bot 会话。打开使用 `ctx.uiWorkspace.openSession`，新建复用 `openWorkspace`。来源：`ui-session/src/client/index.ts:157,677`、`api/session-controller/src/client/sessions/service.ts:26`、`ui-workspace/src/client/index.ts:292`。
- 侧栏 catalog 使用 `observe` 被动订阅，不持有轮询 lease；会话跟随宿主共享 store。页面进入后仍按原 catalog 策略轮询，写入后刷新所有消费者。注册、样式树、监听及 pending chooser 在卸载时释放。其他 Client 改 Bot，在只有被动消费者时仍依赖重显、connection reset、手动刷新或管理页轮询；不声称跨 Client 实时推送。
- rc.2 npm primitives 根入口直接在 Node import 时缺其仅在 devDependencies 声明的 `clsx`。React/jsdom 单测采用明确标记的公开平台 atom doubles；bundle 测试核对平台 require 和不内联宿主。未修改宿主或 node_modules，也未把 doubles 当作真实 SVG/CSS 验证。
- 评审修正：卡片操作组对齐 `ui-plugin-manager/src/client/PluginManagerPage.module.css:397` 的 inline-flex、flex:none、8px gap；两按钮均使用公开 `Button size="sm"`（`ui-primitives/src/Button.module.css:27`，高 28px），主按钮不再伸展。移除卡片 216px/简介 40px 最小高度，保留网格等高。footer 名称为“Bot 会话 / Bot chats”，气泡加鲸鱼角标；弹层标题与“管理 Bots”按钮均调用原有公开管理页导航。
- 截图第 2 轮评审：`02-57-22.716Z-88001/summary.json` 证实原通用 Close 规则误关本包工作区选择。现改成**精确标题＋精确动作白名单**，仅 Preview Notice → Continue、预览说明/预览版说明 → 继续、Add an API key to get started → Configure later、添加一个 API Key 开始使用 → 稍后配置。自动 handler 的 locator 本身也限定这些标题；其他对话框不匹配、不点击，主动扫描仅记录 ignored。已知标题缺少指定动作才 blocked，绝不回退 Close。已核实宿主 `ui-settings-models/src/client/index.ts:147`、`:153` 只注册这两种首启流程；`locale/src/client/index.ts:255` 与 `ui-theme/src/client/index.ts:242` 切换流程未发现额外确认弹窗（源码结论，矩阵待宿主实测）。每个新页面/语言/主题组合仍执行白名单检查，重入保护保留。
- 截图脚本主动完成业务工作区选择：保存公开 `workspace/create` 的 `value.workspace.workspaceId`（`api/workspace-controller/src/types.ts:70`），点击开始聊天后等待工作区 dialog 或空白会话输入区；出现选择框时按本包 locale 的 combobox 标签选择准确 ID，再点击本地化开始聊天。单工作区直接进入空白会话。summary.workspaceChoices 记录 selected/direct 与工作区 ID，不按标题或下拉框第一项猜选，不改变产品逻辑。
- 第 3 轮根因是截图脚本对空白态的错误预期，未发现产品调用链故障。编排方 `03-04-36.876Z-93136` 记录 selected；该 run 的 workspace.json 将所选工作区绑定到 `session-b01656d9-b4aa-41e5-ba65-e48a99b452de`，projection cache 中 `agentPreset=bot-shot-assistant`、`sessionListMetadata.blank=true`、0 turns。rc.2 `ui-workspace/src/client/navigation.ts:200`、`:280` 创建/复用实际 Session；`ui-conversation/src/client/skeleton/ConversationHeader.tsx:15`、`:24` 对空白态传 hideChrome，`ConversationSession.tsx:70`、`:132` 因而不渲染 utilities。此时会话已经存在，不是等一会就会出现徽标。
- 无模型截图改为 Bots 页＋blank-session（8+8 张）：检查宿主 DOM 的 `data-conversation-session`、`data-content-phase="hero"` 和 role=textbox、Bot preset 按钮；读取公开 `session/projections({sessionId})`，校验 `kind=sequenced`、`values.agentPreset` 等于 Host status 的 presetId（`api/session-controller/src/types.ts:433`、`index.ts:548`）。未读取 React/Client 私有状态。summary.conversationChecks 记录真实 sessionId/presetId 与 headerBadgeExpected:false；空白态没有 BotAvatar，不将其计作非空会话徽标或对比度验证。真实非空徽标截图仍需独立的无真实模型方案。
- 失败处理在关闭当前页面之前调用 screenshot，输出 `failure-<step>.png`，并向 summary.failureEvidence / failure.json 写入当前 URL、可见 dialog 标题、main 文本及诊断异常（全部 token 脱敏）。rc.2 shell 无 main role 时使用本包页面或宿主 conversation DOM 标记，标明 fallback；不依赖 CSS 类或私有 store。Chromium 未启动/页面已关闭时无法生成真实 PNG，明确记 screenshotError，不伪造图片。诊断失败不覆盖原始错误。
- 每张截图的 `avatars` 与 summary 的 `contrastChecks` 记录每个可见 BotAvatar 的 computed foreground/background、SVG fill、sRGB 合成前景/背景和 WCAG 对比度；任一已测头像 <3:1 或目标 Bot 测量缺失即失败。读取实际浏览器 computed style，经 canvas 转换 color-mix 等颜色；不是 fixture 估计，也不是截图逐像素采样。`overlays` 记录各矩阵上下文的处理结果，`cardLayouts` 记录实际按钮/卡片尺寸。
- 第 3 轮评审 `check` **310 tests** + strict/build/lint PASS，`check:spikes` PASS；新增失败证据/脱敏测试与双语真实表单确认 → public openWorkspace 参数断言。两个 profile 结果见[评审修正报告](acceptance/P1-T08b-review.md)。脚本语法/入口通过。依编排方指示本轮不在受限沙箱重试 Chromium，**修正后 16 张 Bots/空白会话矩阵仍 FAIL/待宿主运行**。入口 `scripts/screenshot.mjs`、实现在正式包内，固定 `.dsh-shot`，token 仅内存鉴权、日志脱敏，不下载浏览器。

## T09 评审补充：被动徽标订阅、删除状态与头像读取兼容

- catalog 现在有两种订阅：`subscribe` 为页面持有轮询 lease，`observe` 为徽标持有被动订阅。共用同一快照和 mutation 后 refresh；只剩徽标时保留 mount/visibility/connection reset 监听，**没有 setInterval**。第一个页面订阅进入时刷新并开启轮询，最后一个页面退出立即清除定时器；document 隐藏同样清除定时器、恢复可见时刷新和恢复页面轮询。记忆页签沿用主动订阅且离开即释放。徽标不再造成聊天期间的常驻 list/status 调用。React/jsdom 测试覆盖实际徽标独占、真实 Bots 页进出、写后共享更新与无定时器断言。
- 单 spec 新增 `dshBot/catalogInfo() → {presetIdPrefix}`，由 Host Config 返回，经过现有队列与 readiness guard；当前共 **14 endpoints**。每轮 catalog 将 list/status/catalogInfo 共同读取，额外的 info 为廉价元数据查询。即使所有 Bot 都删除或重启，仍可取得当前前缀。没有改 status 的数组形态。
- 已存在 Bot 继续用 `status.presetId` 精确映射。已成功加载且无刷新/错误、status 完整时，若会话 preset 在 Host 返回的当前前缀下但没有对应 Bot，则显示弱化、不可点击的本地化“已删除的 Bot”及历史会话恢复提示。非本插件前缀、空 ID、加载失败均不冒充已删除。使用当前 Host 命名空间作为判断依据，不保存历史 tombstone，也不假定旧配置前缀仍受当前 Host 管理。删除后重建相同 ID 会重新显示可点击徽标。
- 共用 `avatarSchema` 只接受原有单 emoji 或非空、格式完整的 `data:image/(png|jpeg|gif|webp);base64,...`，保留整体 64 KiB UTF-8 上限。拒绝 SVG、HTML、其它 MIME、非 base64、错误 padding/字符、空载荷。未做图片解码或真实性鉴定；这是 URI/MIME/base64 白名单，不保证解码后能显示图片。Host 写入、Client 表单与 wire result 使用同一严格 schema。
- 仅 storage read schema 对历史 avatar 字段容错，其它 Bot 字段仍严格校验。BotStore 对外返回严格 BotRecord，屏蔽不合规 avatar；原数据不在读取时修改或删除。Host 启动记录不带原始内容的 `avatar/invalid bot=<id>` 诊断，status 可选 `warnings:['avatar/invalid']` 传给卡片和编辑器，完整列表与 preset 健康状态继续可用。公开 storageDomain 在 open 时解析所有行（参考 `packages/storage/storage-domain/src/index.ts:121-140`），因此不能仅在 list 捕获错误或启用 backup-and-skip 来丢弃整个 Bot。
- 修复必须显式替换/清空 avatar；存在不合规头像时，只改其它字段会返回固定 `bot/invalid` 诊断，避免静默丢失旧头像。读取、轮询、重启都不改原文件；UI 保存编辑器会提交当前头像或 null。共享 schema 的严格写入不会因为兼容旧读而放宽。
- 最终 `check` 266 tests + strict/build/lint PASS，`check:spikes` PASS；真实独立 profile：Registry 83 checks、Composer 90 checks PASS，0 prompts，既有 `.dsh-dev/storages/dsh_bot.json` SHA256 前后相同。Registry 新增真实 Remote prefix、严格 SVG 拒绝、T09 memory CRUD、旧头像冷启动诊断/无写入/显式修复，仍含 failed-startup guard。路径和首轮断言修正记录见 T09 验收报告。未运行真实浏览器视觉验收，不修改 spikes 源码。


## T09 初轮：记忆管理 Remote、详情页签与会话徽标

- 单一 `src/shared/remote-contract.ts` spec 新增 `dshBot.memory/{list,search,save,update,delete,count}`，总计 13 个端点。公开 `TypertRemoteService` 以 `namespace:'dshBot.memory'` 注册 `dshBotMemory`；Client 通过原 `$mount` 得到 `ctx.remote.dshBot.memory`。rc.2 Client namespace 的 `remove` 是保留方法，故 wire 用 `delete`、Host `@Remote('delete') remove`，与 Bot 删除一致。锁定参考源码：`packages/api/gateway/src/client/index.ts:638-717,765`、`packages/typert/protocol/src/index.ts:24-35`。本轮已用已发布 Gateway + Cordis 实测 nested namespace 挂载、调用与卸载；不是只靠类型推断。
- 所有方法走既有 `dshBots.memoryFor(botId)` → BotMemoryService → MemoryStore，复用 `dsh_bot`、注册表队列、Bot 存在性与归属检查、已有错误码。`list/search` 接受可选 limit、before、tag、pinned，search 必带 query；Client 必须显式传 options（如 `{}`）。新增服务 query/update 不扩大 T06 模型工具入参。`count(botId)` 计数全量记录而非当前分页；Bot 删除确认等待计数成功，失败显示重试并阻止删除，文案明确数量可能随后变化。
- 手工新增由 Host 写入 `source:{by:'user',at:Date.now()}`，Client 无 source 字段；去重仍遵循 T06，命中已有记录时保留原始来源，而不改写历史。update 禁止传 source/id/botId/时间。UI save/update 在 Host 复用 T06 相同秘密启发式，**直接拒绝**并返回 `memory/rejected`，无确认绕过；UI 显示固定中英文提示，不回显失败输入。取舍：可能误报的签名也拒绝，避免用户误将凭据持久化；该规则不是完备秘密检测，既有存量不扫描、不迁移。T06 Host-only 手工 save 行为保持不变。
- Bot 编辑器增加“设置/记忆”页签，保留未保存表单；记忆列表显示内容、类型、标签、来源与时间，提供词法搜索、分页、编辑、置顶、二次确认删除、手工新增。完整人设遮蔽提示与关闭记忆提示均本地化；关闭记忆不禁止管理已保存记录。说明新/冷恢复会话读取新快照、存活 Agent 快照不变，沿用 T06 KV cache 边界。
- 从 T08 catalog 抽取共用 `createPollingCatalog`，Bot 与记忆均保持 epoch/本地 Abort、首次订阅/visibility/connection reset、可配置轮询及最后订阅释放语义；每次写成功后重新读取，读失败保留旧数据并显示错误。分页使用稳定 pin/time/id cursor；单页默认 50、读取多一条判定下一页，Client `Config.memoryPageSize` 整数 1–199（Host 每次最多 200）。记忆分页的 records/count 两个调用没有共同 revision，不能视为原子快照；编辑/其他 Client 写入可能移动分页位置，可返回首页。所有 store/slot/字典归 effect，切出记忆页签释放其 store，插件卸载阻止迟到导航/刷新。
- 徽标使用公开 `conversation.session.header.utilities`（list/session）；读取 `useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset)`，避免创建 header 在空白会话切换后陈旧。只用 catalog 的 `status.presetId` 精确映射 Bot ID，不拆拼前缀；standard/minimal/未知 preset/找不到映射不显示。Broken Bot 仍显示，允许进入详情修复。来源：`packages/client/ui-conversation/src/client/contract/slots.ts:234-239`、`packages/client/ui-agent-preset/src/client/AgentPresetLabel.tsx:16-17,43-49`。
- 点击徽标通过 effect-owned 的一次性详情请求 store + 公开 `ctx.layout.selectPanel('dsh-bot')` 打开并定位；请求在成功读取 catalog 后消费，避免定时刷新反复打开。layout 已加入 inject；manifest 增加 ui-conversation Client owner（原有精确 devDependency，无新增 runtime peer）。来源：`packages/client/ui-layout/src/client/service.ts:27-41,71-78`，根出口 `index.ts:29-30`。来源会话按钮调用公开同步 `ctx.uiWorkspace.openSession(sessionId)`；宿主负责导航与会话恢复诊断，不发明 permalink，不宣称捕获该 void API 内的异步失败。来源：`packages/client/ui-workspace/src/client/navigation.ts:40-44,276-278`。
- 测试继续用公开 Cordis/SlotCore + fake services + React/jsdom，无 client-test-runtime、无内部组件或 spike import。新增 Host 真 JSON 存储单测、完整 Host/Client 编译与运行签名/codec 检查、Gateway nested namespace 实测、UI 实际 slot 接线与清理测试；主题 token 继续由锁定版亮暗 fixture 验证。实际结果及未执行的浏览器视觉验证见 [T09 验收记录](acceptance/P1-T09.md)。本节覆盖后文 T08“等待 T09 计数契约”的历史说明。

## T08：Bot 全局首页与 Client 生命周期

- 正式 Client 使用公开 `sidebar.panellist`（root/list，`id:'dsh-bot'`）和 `main`（root/keyed，`key:'dsh-bot'`）。侧栏只贡献图标，宿主负责导航按钮，图标尺寸来自 owner 的 `size`；label 通过动态 `ctx.locale.bind` 读取。两处注册都在 `ctx.effect(() => ctx.slots.inject(...))` 内。评审后已删除 T01 composer 演示徽标、对应 locale 与注册测试，不再向任何会话贡献该徽标；T09 的会话专属徽标另行实现。来源：锁定源码 `packages/client/ui-sidebar/src/client/contract/slots.ts:30-35,68-74`、`ui-sidebar/src/client/index.ts:49-63`、`ui-layout/src/client/index.ts:53-73`、`ui-renderer/src/client/registry.ts:196-253`。
- 页面不接收 Context；通过 slot `inject.hooks.catalog` 交出 getSnapshot/subscribe，renderer 将它绑定为 `useCatalog`，其余业务函数来自 apply closure。来源：`docs/subsystems/slots.zh.md` 的组件输入/开发者 injection；`packages/client/ui-slots/src/index.ts:549-595`。测试使用公开 Cordis、SlotCore 和自有 remote/slots/locale/uiWorkspace doubles，由 React/jsdom 模拟公开的 hook 绑定约定，不使用损坏的 client-test-runtime，也没有导入参考源码内部模块。
- `list()` 与 `status()` 同轮查询、一次发布，使用 epoch 和 AbortController 丢弃迟到响应；无 signal 参数的既有 unary Remote 不支持网络取消，此处 Abort 仅结束本地等待。缺 status、刷新中或读取失败时禁用开始聊天，旧成功数据保留并显示错误/重试，不将失败解释为空列表。二者无共同 revision，因此不是原子快照；点击开始时再次调用 status 核实 state，只采用返回的 presetId，并处理缺失/失败。
- 成功 create/update/duplicate/delete 后重新读取，且不会复用写入前的读取。首个页面订阅、页面重新显示、`connection/reset` 触发读取；默认每 5 秒在可见页面轮询，慢读取不被周期轮询反复取消。最后订阅者退出时清理 timer、reset/visibility 监听和本地等待，插件卸载永久释放 store；所有资源归 effect。第三方 changed 事件不受宿主转发，因此跨 Client、工具修改为轮询周期级可见，不宣称实时推送。来源：`packages/client/connection/src/client/index.ts:21-28`、`packages/api/remotes/src/remote-events.ts:25-55`、Cordis `events.ts:254-301` / `fiber.ts:485-568`。
- Client 导出 `Config` 和 Schemastery schema：`pollIntervalMs` 默认 5000，整数范围 1000–60000。页面下拉可调整；设置保留于该 Client 插件的存活期，不写 localStorage、不影响其他 Client。默认 rc.2 Loader 只以 `{name:id}` 创建 Client 行，不转发 Host 配置（`packages/client/modules/src/client/entries.ts:179-187`）；不能把 Host 行的字段当作已生效的 Client 设置。
- 评审后开始聊天使用公开 `ctx.workspaces.list` 的目录（`workspaceCatalog` 私有 hook，不覆盖全局 useWorkspaces）选择工作区。唯一工作区默认选中，多个时由用户明确选择；无工作区、目录加载中/错误、选择失效均显示本地化 Toast。status() 读取前后复查工作区，然后 `await ctx.uiWorkspace.openWorkspace(workspaceId, beforeOpen, {agentPreset:status.presetId})`；异步 Host 拒绝会冒泡到页面通知，可重试。`beforeOpen` 在页面/插件已卸载时抛错阻止迟到导航，不承诺撤销 Host 已接受的会话创建，也不清空既有草稿。来源：`packages/api/workspace-controller/src/client/service.ts:35-51`、`model.ts:31-41`，`packages/client/ui-workspace/src/client/navigation.ts:44-64,280-305`。**替换原因：** 同文件 `startSession` 返回 void（320–352），无 workspace 且不初始化草稿时只 `clearMain()`（335–341），异步拒绝内部 catch（350–351），调用者无法 await；本轮采用评审允许的公开 async API，不复制私有 recentWorkspace/seat staging。

- 表单复用正式 shared schema 校验 ID/名称/人设/记忆条数，编辑 ID 只读，顶层 persona patch 保留 suffix/complete，未展示的 model/skills/defaultCwd/order 等保持不变。清空头像传 `null`。工具限制使用文本输入精确名称：当前没有可直接作为全局 Bot 工具目录的既有 Remote，Agent 的工具目录依赖实际组合。复制调用正式 duplicate，仅填写新 ID，不复制记忆；删除确认增加默认勾选的“同时删除该 Bot 的记忆”，显式传 `{deleteMemories}`；取消勾选时说明记忆仍关联原 Bot ID、同 ID 重建会重新关联，成功通知区分删除/保留记忆。两种选择均保留历史会话恢复限制提示。当前七个 Remote 方法没有 memory list/count；Host-only count 不能从 Client 使用，因此按评审允许先不展示记忆数量、不伪造 0，等待 T09 契约。保存提示新会话/冷恢复采用新配置、存活会话保留原配置。
- 样式使用包内 CSS modules，构建在每轮开始清空 CSS 编译缓存，同轮的 `.module.css` 与 `?inline` 共享一次编译，分别导出类名与 CSS 字符串。构建插件不注入 DOM；BotsPage 在自身树中渲染唯一的 `<style data-dsh-bot-styles>`，React 重绘复用它，页面退出及 slot 注销后由 renderer 卸载它。热重载先卸载旧注册再挂新注册，因此不会叠加；不向 document.body 追加应用或样式。仅引用 `--dsw-alias-*`，亮暗 token 来源为 `ui-theme/src/styles/design-platform.css`。构建继续精确拒绝 React/Cordis/Zod、Host 与 spike 内联；额外仅允许独立 Config validator 的 Schemastery 3.18.5 公开 ESM 入口与其 Cosmokit 1.8.6 公开入口，不扩展共享 resolver，也不把它们误列为宿主平台模块。Client-only 服务包与 React 仍只在精确 devDependencies，不增加 Host peer。

### T08 评审：主题 token 出处与离线检查

只读核实 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`，来源文件为参考源码 **`packages/client/ui-theme/src/styles/design-platform.css`**，SHA256 `809b20ae477324fdf5181a2d338655a19919cabbf1b0e60adc149908462c5a66`。当前正式 CSS/TSX 所用 9 个 token 全部存在，无需替换；下表是定义行，不是使用行。

| token | 亮色 `body` 行 | 暗色 `body[data-ds-dark-theme]` 行 |
| --- | ---: | ---: |
| `--dsw-alias-bg-base` | 167 | 285 |
| `--dsw-alias-bg-layer-1` | 171 | 289 |
| `--dsw-alias-border-l3` | 188 | 306 |
| `--dsw-alias-interactive-bg-hover` | 213 | 331 |
| `--dsw-alias-label-primary` | 222 | 340 |
| `--dsw-alias-label-secondary` | 223 | 341 |
| `--dsw-alias-label-tertiary` | 225 | 343 |
| `--dsw-alias-state-business-primary` | 240 | 358 |
| `--dsw-alias-state-error-primary` | 250 | 368 |

- 维护脚本 `packages/dsh-bot/build/generate-theme-tokens.mjs <reference-checkout>` 验证 HEAD 对应锁定 tag 且主题文件与 tag 完全相同，只读提取所有 101 个 alias，输出版本、commit、源文件 SHA256、亮/暗定义行到 `tests/fixtures/dsh-theme-tokens-0.2.1-rc.2.json`。重新生成仅由维护者显式运行，不是构建的一部分。
- 构建 `build/theme-tokens.ts` 扫描全部 `src/client/**/*.css/ts/tsx`，包括未被 bundle 引用的文件；所有 `var(--dsw-alias-*)` 都必须存在于仓库内的 fixture 中。正常构建、测试和产品运行均不读取参考源码，也不依赖本机路径；测试包含不存在 token 即使带 fallback 仍拒绝的负例。
- CSS 生命周期测试执行真实 `lib/client.js` 闭包工厂和其中的 CSS，在公开 SlotCore 订阅 + React/jsdom 下验证：factory 本身不注入、重绘只有一个 style、离页移除、插件卸载移除、连续三次加载新工厂不叠加。另用 esbuild context 实际 rebuild 验证改动 CSS 后不复用旧缓存，类名映射和 inline CSS 一致。这是生命周期/产物测试，不是浏览器主题视觉证明。

本轮命令、测试结果与真实浏览器验证边界见 [T08 验收记录](acceptance/P1-T08.md)。

## T07：对话内 Bot 管理与审批

### 评审补充：具体审批、自身修改及模型摘要

- 审批文案由 `locale/{en,zh}.json` 模板插值：create 包含 input.id/name；update 包含 id 与排序后的顶层字段名；delete 包含 id、deleteMemories 的实际默认/显式值，true 时醒目显示当前完整记忆数。字符串参数用 JSON 引号转义，防止名字中的换行与引号混淆说明；不把 input 的长内容复制到审批提示。`reason` 使用英文，`displayReason` 同时提供中英；下游已有 ask 时仍补齐本操作说明并保留它的本地化说明，deny/cancel 不改写。
- 新增 Host-only `BotMemoryService.count(signal)` → `MemoryStore.countByBot(id)`。计数通过现有 Registry 队列，在一个同步读槽内遍历本 Bot 全部记录，不受默认 list limit 或 200 条分页上限影响，不返回内容、不打开新域；包含 pinned 与 unpinned，不包含其它 Bot。失败保留 store/unavailable 等业务码并阻止发起审批和删除。计数发生在审批前，文案明确这是当时的数量；审批期间没有持有存储锁，其他会话可能继续写入，delete 仍按批准的“删除全部记忆”语义执行，不承诺数量锁定。
- Bot 上下文把自身 botId 作为工具注册闭包参数，随精确代际工具 lease 交接；不信任模型入参或创建时的 session header，也不循环依赖 bot-context 的绑定查询。update/delete 命中当前 Bot 时增加中英警示；修改 tools.deny 的说明强调当前 live Agent 仍保留原限制，后续新建/冷恢复的 Agent 才采用新配置。审批机制与原有代际隔离未更改。
- 模型视图是副本：所有返回 Bot 的 action 将 data URL avatar 替换成固定 `[data-url avatar]`，emoji 保留。list 的 persona.prefix/suffix 共用 `Config.botManagePersonaPreviewChars` 个 Unicode 码点预算（默认 200、正安全整数）；不切开 surrogate pair，超出时 `persona.truncated=true`，complete 原样保留。get/create/update 返回完整 persona。结构化 output schema 明确投影视图字段，render 只序列化已投影的规范结果；Store、Registry 和 UI/Remote 完整记录不变。
- 本轮测试覆盖 205 条混合记忆的精确计数与跨 Bot 隔离、false/0 条/失败、已有 ask、当前 Bot update/delete 和非自身操作、64 KiB 头像、Unicode/200 边界/共享 suffix 预算/自定义预算/不改存储。deny 测试同时确认没有注册本地 bot_manage，restrict 只接收 inherited_tool，schema 和实际 dispatch 都拒绝该管理工具；不依赖同层 restrict 的调用先后。
- 最新产品 `check` 为 177 tests 全通过，check:spikes 通过。真实隔离 Web profile `.dsh-dev/t05/run-2026-10-18T18-47-28.436Z-14206/` 为 90 checks 全通过：测试主动打开/关闭一个 Session turn，直接调用正式 bot_manage，由真实 ApprovalService 和限定 callId 的测试 responder 批准；审计含 asked/allowed-once，旧 live Agent 的 read 仍 UNKNOWN_TOOL，新 Agent 的 read 可见。无模型请求、无浏览器；这是工具/审批/注册表/代际的直接运行测试，不是模型发起或人类点击审批卡验证。完整命令、初次 strict 问题和改动清单见 [T07 报告的评审补充](acceptance/P1-T07.md#评审补充)。

### 初轮机制及边界（以上评审补充覆盖旧的输出与静态审批文案说明）

- 正式工具位于 `packages/dsh-bot/src/host/tools/bot-manage.ts`，单一 `bot_manage` 直接调用现有 `ctx.dshBots.list/get/create/update/remove`，与 Remote/UI 共用存储、严格 schema、稳定 preset id 和串行回滚。参数按 action 严格校验：`list` 不带其它参数；`get` 带顶层 id；`create` 的 input 是包含 id/name 的 BotCreateInput；`update` 带顶层 id 和 BotPatch input；`delete` 带顶层 id，可选 input `{deleteMemories}`，默认 true。拒绝未知/不适用字段；patch 替换整个顶层字段，沿用 null 清空可选字段约定。结果为 `{action,bots}`，list 返回全量、get/create/update 返回单条、delete 返回空数组，render 附简短英文说明和 JSON。
- 选用任务允许的最弱公开机制：Agent 的 `tools/pre-execute` waterfall。只处理所属 Agent 的 bot_manage；参数先校验，list/get 委托 next；写操作先等待 next，保留已有 deny/cancel/ask，仅将 allow 提升为 ask。审批 reason/displayReason 来自随包中英 locale。DSH 在 dispatch 前调用 `approval.request`，只有 allowed-once 才执行工具正文；rejected/cancelled/unavailable、缺服务均拒绝。来源：锁定参考源码 `docs/subsystems/approval.zh.md`、`packages/core/tools/src/index.ts:145-154,602-612,1513-1548,1725-1775`。不自行实现应答 UI、不默认批准、不缓存许可；`never` 由 DSH 服务强制拒绝。
- 该 waterfall 是宿主可扩展策略入口，不是隔离任意第三方插件的安全边界；其它更外层策略可以短路或重写结果（`packages/core/tools/tests/scoped.spec.ts:284-318`）。本任务沿用 DSH 的协作式插件模型，不额外引入工具正文二次询问或全局 guard。审批等待期间取消由 DSH 阻止 dispatch；工具正文再次检查 owner 与 signal。调用 registry 进入写队列之后沿用其事务语义，不声称取消能撤销已接受的写入。
- `DshBotError` 通过既有公开 `@deepseek-ai/dsh-llm` 根入口的 HarnessError 保留 code，不把失败伪造成成功 value。DSH 原生审批拒绝只提供错误 message，没有稳定的 error.info.code，本包不伪造拒绝码。来源：`packages/core/tools/src/index.ts:655-665,1752-1775`。
- 所有 Bot preset 的 bot-context 在 scoped `agent/created` 中挂载，独立于 memory.enabled；tools.deny 中包含 bot_manage 时省略本地定义，避免 rc.2 restrict 同层限制错误。注册和 pre-execute hook 归 agent.ctx.effect，Bot preset 插件保留 disposer；Agent 销毁或插件卸载均清理，旧代际保留原 deny 策略。另监听公开 `agent-preset/selected`，通过 `ctx.agents.get(sessionId)` 查询 live Agent，使用公开 scopeOf/scopeChainOf 检查精确代际归属（不能只比较稳定 id），为管理工具处理空白会话切换。模块 WeakMap 只协调本包的管理工具：新 owner 先释放旧 lease，旧 disposer 不会删除新 lease，旧 owner 的 Map 同步清理，消除不同监听顺序的重复注册。来源：`packages/core/scope/src/index.ts:87-103,154-156`、`packages/preset/agent-preset-registry/src/index.ts:66-71,349-360`。未改写 T05 的绑定、记忆或模型切换逻辑。
- Host Config `enableBotManageInStandard` 默认 false。开启后在 agent/created 和 agent-preset/selected 中仅匹配公开 `ctx.agentPresets.composedPreset(agent.ctx) === 'standard'`，为该 Agent 注册同一工具；不修改 standard preset，不扩散到 minimal/其它非 Bot preset/无 preset 会话。不能使用 session.header.agentPreset：header 仅代表创建时选择，空白会话可切换，冷恢复使用持久选择投影（`packages/preset/agent-preset-registry/src/session.ts:1-13`）。composedPreset 查询当前实际挂载组合（同包 `src/index.ts:314-318`）。覆盖启用后新建、冷恢复及空白选择事件；启用时不扫描并追溯已有 live Agent。Host 同样持有 Agent disposer，双 owner 清理。
- 新增精确 rc.2 devDependency `@deepseek-ai/dsh-user-approval` 只供测试使用，生产通过 tools 自带审批桥接，不新增其 runtime import/peer。scope 新增 runtime import，保留精确 rc.2 dev 并补兼容 peer。测试使用公开 ApprovalService、真实 Session 的 open turn、公开 ToolRuntime、正式 Registry 与真实 JSON 后端；preset 激活采用 double。运行结果及验证边界见 [T07 验收报告](acceptance/P1-T07.md)。

## T06：每 Bot 记忆服务、Agent 工具与静态提示词

- 正式实现位于 `packages/dsh-bot/src/host/memory/{service,tools,prompt}.ts`。Host-only `dshBots.memoryFor(botId)` 从已有 `dsh_bot` 域创建绑定 Bot 的服务门面；所有操作经过注册表队列，执行时确认 Bot 仍存在，Host 卸载先排空已接受操作再关闭域。不另开领域、不从 spike 导入，也不新增 Remote 端点（UI 契约留给 T09）。服务直接复用 T03 的严格 schema、2 KiB UTF-8 限制、词法检索、归属校验和持久化。
- `defineTool`、`ToolRunContext`、`ValueSchemaSpec` 均来自公开 `@deepseek-ai/dsh-tools` 根入口。四工具为 `memory_save/search/list/forget`；参数不含 botId/source，业务层 strict schema 还拒绝隐式开放工具根对象中的额外键。返回规范值分别为 `{id, deduplicated}`、MemoryRecord 数组、MemoryRecord 数组、null；`output.render` 仅渲染结果。工具闭包同时绑定服务与 Agent，保存来源为真实 `owner.session.id`、`by:'model'` 和当前时间，取消信号在队列实际执行前复查。开始持久写入后不承诺取消回滚。来源：`docs/cookbook/adding-a-tool.zh.md`；`core/tools/src/schema.ts:483-600`，`core/session/src/index.ts:546`。
- 每个 preset 的 `agent/created` 回调读取最新记忆一次，再在原有双 owner `agent.ctx.effect` 内注册工具与 section，并由插件保存 disposer。Agent 销毁或插件卸载均清理；读取期间卸载不会补注册迟到资源。`bot.memory.enabled=false` 不读取记忆、不注册工具和 section。Bot 配置沿用 T05 的代际快照语义，存活旧 Agent 的 memory 开关与 prompt 不因 Bot 编辑自动改变。
- `snapshot(injectLimit)` 在一个队列槽内同步分页，候选顺序为全部置顶、最近 injectLimit 条非置顶；各组沿用 updatedAt 降序、id 升序，置顶不占普通条数、不重复。格式化后总 JS UTF-16 长度（包括说明与截断标记）不超过 `maxInjectChars`，默认 4000；不切开有效 surrogate pair。预算不足时按该顺序逐条打包，放不下的整条略过，继续尝试后续较短记录；为固定英文尾行 `[N more memories available via memory_search]` 预留空间，N 为本次候选中未注入的整条数量（不含 injectLimit 之外的记录）。只有单条置顶连同标题本身就超出总预算时，才按 Unicode 码点缩短内容并重新 JSON.stringify，保留闭合引号/转义，并加 `[truncated]` 标记；该条不计入整条遗漏数。极小预算不足以容纳完整尾行时返回空文本；没有半截 JSON、说明或尾行。故“全部置顶”表示全部参与候选，不能保证超出总预算的置顶全文都可注入。空记忆或零预算不注册空 section，工具仍可用。
- `systemPrompt.section({name:'dsh-bot:memory', order, text, interpolate:false})` 只注册静态字符串，不为记忆增加 assembly 监听器。关闭插值保证记忆中的 `{{...}}` 原样保留；保存、删除或后续工具查询不重算现有 Agent 的提示词。来源：`docs/subsystems/system-prompt.zh.md:44-70`；`core/system-prompt/src/index.ts:131-164,478`。Host Config 新增 `memorySectionOrder` 默认 100（校验 `0 < order < 800`，位于 persona prefix 0 与首个工具策略 PTC_ONLY 800 之间），`maxInjectChars` 为非负安全整数，`memoryListLimit` 默认 20、范围 1–200。memory 工具若在 Bot deny 列表中则不注册；继承工具继续使用 restrict，因为 rc.2 不允许 restrict 同层工具。
- **宿主语义限制：** persona 的 `complete:true` 会令该 persona 成为唯一有效 section，记忆 section 也会被宿主遮蔽；本实现保留 DSH 的 complete 契约，不改写 assembly 绕过它。要同时注入记忆，应使用普通 persona prefix/suffix。当前快照采用词法、时间和置顶选择，不调用模型生成摘要，也不实现向量检索。
- 依赖：`dsh-tools` 新增兼容 peer（已有精确 rc.2 dev），因为正式 Host 新增其 runtime import；system-prompt/agent 仍是类型导入。测试新增精确 rc.2 dev：agent-loop-testkit、llm-mock-server、llm-deepseek-api-key、session；适配器只连接测试中的 127.0.0.1 mock，dummy key 不用于真实服务。Windows 原生路径边界沿用 T02，未修改 install hook 策略。

本轮运行结果与复现命令见 [T06 验收报告](acceptance/P1-T06.md)：评审补充后产品 145 tests、strict/build/lint 与 check:spikes 均通过；真实 AgentLoop 经 loopback HTTP mock 执行 memory_save，新 Agent 的实际请求含记忆，旧 Agent 后续请求保持原系统提示。评审补充另有真实隔离 profile 的空闲会话跨 Host 冷恢复证据（见下节），不把它扩大为恢复后模型请求或 Desktop/UI 验收。

### T06 评审补充：去重、秘密保护与恢复语义

- `MemoryStore.saveUnique` 在同一个 Domain 的共享写队列内完成匹配与落盘，因此不同 BotMemoryService / MemoryStore 实例的并发保存仍串行。对同 Bot 的内容按 **NFKC → trim → 连续空白合并为一个空格** 比较，不转小写、不做语义相似推断。命中时返回原 id / `deduplicated:true`，updatedAt 严格递增，tags 按已有顺序取并集，pinned 做 OR；保留原 content/kind/source/createdAt。新记录返回 `deduplicated:false`。既有历史重复不自动批量合并或删除，匹配多个时选 createdAt 最早、id 最小的记录。本锁仅覆盖同一 Host/Domain，沿用 T03 不支持跨 Host 并发写同一 JSON 域的边界。
- 新增 `memory/rejected` 到 DshBotErrorCode、公开 RemoteErrorDetailsMap 和本文错误表。只在可信 source.by=model 的服务保存入口执行检查，早于业务 schema 解析和去重，避免超长错误回显密钥，也避免模型借命中用户手工记录来改变 tags/pinned。检查 content 及 tags 的 NFKC 文本：`sk-` 后至少 20 个字母/数字/下划线/连字符，`ghp_` 或 `github_pat_` 后至少 20 个字母/数字/下划线，`xoxb-`/`xoxp-` 后至少 20 个字母/数字/连字符，`AKIA` 加 16 个大写字母/数字，以及 `-----BEGIN … PRIVATE KEY-----`。短前缀说明和 PUBLIC KEY 不拒绝。这是保守签名匹配，有误报/漏报可能，不保证识别所有凭据，也不扫描或迁移已存数据。手工 `by:user` 路径不受此策略限制，T09 应另行选择允许并提示的交互。
- rc.2 ToolRuntime 只将 `HarnessError` 转成结构化 error.info.code（`core/tools/src/index.ts:662-665`）。因此工具适配层仅把 `memory/rejected` 转成公开 `@deepseek-ai/dsh-llm` 根入口的 `HarnessError(message,code)`，不保留带原始输入的 cause；模型可见文本也包含固定 `memory/rejected`。服务/未来 Remote 仍抛 DshBotError，契约错误码不变。没有假造成功返回或仅靠描述警告。

**冷恢复与 KV cache：** 同一个仍存活 Agent 的重复 resolve 使用现有对象，不重算记忆；Host 重启后或 Agent 销毁后冷恢复则会重算。SessionController 的 `resumeObserved` 读取持久 header 中的 preset id，重新 compose/mount 当前稳定 id 的定义，再调用 agents.resume；恢复也经过 `agent/created`，本插件不按 source 跳过，因此从当前存储读取新快照，而非恢复最初的 memory 文本。来源：`api/session-controller/src/agent.ts:387-401,420-444`，`core/agent/src/index.ts:192-202,536-555`。稳定 id 冷恢复还可能采用更新后的人设/开关配置，沿用 T02/T05 语义。

已实测：扩展后的 composer-profile 在同一隔离 profile 启动两个独立 Host。第一进程保存记忆、新建 Agent、再保存另一条记忆，验证其快照不变并 flush；第二进程 resolve 同一个 sessionId，原先不是 live Agent，组装的 memory section 已包含两条记录。该测试没有发模型请求。恢复后的下一次真实请求如何持久化新 system/message 由 DSH AgentLoop 负责：`core/agent-loop/src/agent.ts:407-424` 调用 `SystemPromptProjection.project`，`runtime-context.ts:98-115` 按是否新 series、provider 的 in-history 能力决定替换或追加系统消息。插件不修改历史日志或直接操作 KV cache。**保证仅为同一存活 Agent 的 memory section 稳定；不保证跨冷恢复前缀相同、不保证提供商缓存命中率。** 本轮 HTTP mock 验证了存活 Agent 的 wire system 稳定，未将空闲冷恢复结果称为“冷恢复后继续请求/缓存命中”验证。

**T09 提示约定：** 当 `bot.memory.enabled && bot.persona.complete === true` 时，应在 Bot 编辑器、记忆页显示非阻断提示：“完整人设会覆盖记忆提示词；记忆工具仍可用。要自动注入记忆，请关闭完整人设模式。” 英文对应 “Complete persona overrides injected memory. Memory tools remain available. Disable complete persona to inject memory automatically.” UI 应从 get/list 返回的 BotRecord 推导并本地化，不把此配置标记为 preset broken/missing，也不禁用开始聊天。当前 status 的职责仍是 preset 可用性，本次不改其 wire shape；若后续需要集中诊断，可经契约版本化增加独立 warnings（例如 memory/prompt-suppressed），不能复用 broken。上述是交给 T09 的 UI 设计约定，本轮未实现/验收 UI 提示。

## T05：运行时模板、Agent 策略和技能目录（2026-10-18）

- `composeBotPreset(bot, ctx)` 默认使用 Host registry Config，亦接受显式第三参数供注册表启动和测试调用；异步调用公开 `agentPresets.readDocument(bot.template)`；用 `@deepseek-ai/cordis-plugin-include@1.0.10` 的 `entryListSchema` 和 `js-yaml@4.1.1` 解析，再调用 registry 根出口 `entryListProblem` 校验。`!!js` 保持 `{__jsExpr}`，不求值、不转字符串。锁定模板原文仅放测试 fixture，并校验 SHA256；正式代码无 vendored 模板、无同步脚本、无 spike import。来源：`preset/agent-preset-registry/src/index.ts:213-229`、`src/definition.ts`；`vendor/include/src/index.ts:9-23`。
- persona 顶层行必须唯一，完整替换其 config 为 Bot 的 prefix/suffix/complete；minimal 原有 `complete/includeRuntimeContext` 不暗中覆盖 Bot 输入。standard 修改唯一的顶层 skill-filesystem 行，保留其它 provider 配置并替换 `customSkillDirs`；minimal 原模板没有该行，因此补一行。拒绝嵌套/重复技能 provider 和任意层已有 bot-context，避免健康列表掩盖重复绑定。不会把整棵模板包进额外 `cordis:group`。来源：`bundle/web-app/presets/{standard,minimal}.patch.yml`；`skill/skill-filesystem/README.zh.md`。
- Host 在创建、复制、恢复存量 Bot 与 reconcile 时递归创建 `<dataDir>/bots/<id>/skills`；模板读取与目录准备在注销旧 preset **之前**完成，失败为 `bot/preset-failed` 且保留 cause。删除、失败回滚和复制均不删除/复制技能内容，避免覆盖用户文件。存储地址仍由 `storageDomain` 配置决定。
- 新增公开本包子路径 `dsh-bot/bot-context`，行 config 只有 `{botId}`。注册表的非 Remote 同步 `presetBot(botId)` 返回激活候选/当前 lease 的深克隆；插件在 apply 捕获策略，避免在持有写队列的 register 中再次排队 get 造成死锁。lease 同时保存 Bot 快照；失败回滚恢复旧定义和旧策略；status 比较配置时忽略持久化时间戳。
- scoped `agent/created` 通过 `agent.ctx.effect` 绑定只读 Bot 身份及 `tools.restrict({deny})`，同时由 Agent 和插件生命周期清理（见本节评审补充）；`getBotBinding(agent)` 供后续 T06 读取。未知、同层和保留工具（如 `run_code`）沿用 DSH 的拒绝语义，拒绝创建而非静默忽略。有效工具限制只作用于该 Agent；**preset healthy 不等于任意 deny 名称都能创建会话**。来源：`core/tools/src/index.ts:1065-1125,1170-1226`、`core/agent/src/runtime-types.ts:248-261`。
- T02 未实测独立 Bot model，且 rc.2 没有 `dsh-agent-model` 包。Host `agentDefaultModel` 是共享默认，不能通过新增 preset 内同名服务改变 SessionController。T05 使用公开 `system-prompt/assemble` / `agent/request` waterfall 的 `prepend:true`：仅在没有 `agent.session.requestHeader()` 且公开 `sessionProjections.stateOf(session,'modelSelection').pending` 为空时，用 Bot model 作为初始默认；每次 assembly 捕获同一选择供 request 使用，省略 reasoningEffort 时清除继承值。显式会话选择及历史请求优先，未指定 Bot model 时完全沿用 Host。不能调用 `sessionController.selectModel` 来初始化 Bot，因为它还会保存共享默认。来源：`core/agent/src/model-selection.ts`、`api/session-controller/src/agent.ts:289-340`、`src/commands.ts:157-182`、`src/model-selection-projection.ts`。运行验证包括真实空闲 Agent 的提示词变量与请求路由 waterfall，**不等于实际模型请求或回复验证**。
- 真实 T05 profile 暴露 T04 的 Remote 注册竞态：`typert-loader` 自动发现 `exports['./typert']` 后注册，而 Host apply 也手动注册，先后顺序会造成 `package face "dsh-bot#host" is already registered`。现在导出改为 `dsh-bot/host-contract`，保留 Host `ctx.effect(() => ctx.typert.register(TYPERT))` 为唯一 owner；Client `/remote` 不变。不禁用宿主 loader、不吞重复错误。来源：`typert/loader/src/index.ts:39-40,399-448`。原 `dsh-bot/typert` 调用者须改用新路径。
- 依赖：registry 根出口 `entryListProblem` 和 llm 根出口 `ReasoningEffortId` 是新增 Host runtime import，因此新增相应兼容 peer，dev 均精确 rc.2；include/YAML 作为独立依赖。session-projection、api-session-controller 仅类型 dev，scope 仅测试 dev。Client 产物不包含新增 Host 模块。

本轮实际命令、运行证据与边界见 [T05 验收报告](acceptance/P1-T05.md)。DSH 升级须复核模板结构、entry-list 表达式、模型 waterfall 顺序与 Remote 注册所有权。

### T05 评审补充：双 owner、模型机制选择及模板诊断

生命周期按 `packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md` 的 Principles 2 / Stability 每 Agent 条款修订：插件自己的一个 effect 保存 `Map<Agent, disposer>`；每个 Agent 的绑定、restrict 和两个模型监听器统一放入一个 `agent.ctx.effect`。Agent 先销毁时清除 map 项；插件先卸载时移除创建监听器，再释放全部 Agent disposer；重复清理幂等。异步目录校验返回后检查插件是否停止，不注册迟到资源；已进入 assembly/request 的校验若遇到插件卸载，也不再覆盖下游结果。

**注销 preset 不等于卸载旧代际。** rc.2 registry `src/index.ts:81-100,148-151,264-277` 将代际标记 retired，只有 users=0 才 dispose。真实 profile 验证中，更新 Alpha 为 deny=[] 后，旧 live Agent 仍是同一个对象，仍绑定 alpha、保持旧 persona，read 仍不可见；新 Agent 的 read 可见且 persona 更新。测试对象是仍在 Host 中存活的 idle Agent，没有发送模型 prompt；没有声称已测正在流式生成的 turn。显式卸载 bot-context 插件则必须释放限制，这是双 owner 的既定行为，与保留代际不同。

模型设置的较弱公开机制调研（路径相对锁定参考源码）：

| 候选 | 核实结果 / 未采用原因 |
| --- | --- |
| `sessionController.create` 参数 | `api/session-controller/src/types.ts:287-305` 只接受 workspaceId/cwd/sessionId/agentPreset，没有 model/selection；不能传未声明参数 |
| 直接 `agents.create({agentOptions})` | 适用于自行拥有创建入口的调用者；Bot 插件必须覆盖宿主标准选择器经 SessionController 创建的 Agent，不能替换该入口或修改只读 options |
| `sessionProjections.stateOf(session,'modelSelection')` | `session/session-projection/src/index.ts:313-329` 明确返回只读派生状态；没有供插件设置选择的 setter，不能直接改返回对象 |
| append 已有 `model/selection` 事件 | Controller 的 `selectionFor` 在安装时只读取一次 pending 并持有私有 picked 引用；`composeAgent` 又先安装 selection、再 mount preset。单纯在 agent/created append 不会更新已安装引用（`api/session-controller/src/agent.ts:289-340,387-401`），所以没有这样写事件 |
| `sessionController.selectModel` | 公开方法可更新会话，但还异步调用 `agentDefaultModel.saveSelection` 保存共享默认；没有关闭该副作用的参数（`src/commands.ts:157-182`）。不适合作 Bot 私有初始默认 |
| `agentDefaultModel.currentSelection/saveSelection` | 前者返回拷贝，后者写拥有该服务的 profile 配置；Controller 持有 Host 服务，preset 内另建服务不会改变它（`core/agent-default-model/src/index.ts:67-99`） |
| `systemPrompt.variables` 或再次 `installModelSelection` | 单纯 variables 贡献仍会被 Controller 的 assembly waterfall 覆盖；`installModelSelection` 也是 assembly/request/pre-step 监听器组合，未开放替换 Controller selection ref 或这两项的 prepend 选项（`core/agent/src/model-selection.ts:82-147`），不是更弱的会话 setter |

因此锁定 rc.2 保留 **仅变量与路由** 的 `system-prompt/assemble` + `agent/request` 外层 waterfall。它不增删 section、context、tool 或文本；先等待 next，再保留其整个结果，只覆盖当前 Bot 初始选择的 provider/model（请求另处理 reasoningEffort）。单测同时挂载真实 `installModelSelection` 和另一贡献者，逐一验证 sections/contexts/tools 引用、其它变量、扩展字段、请求 maxTokens 都保留；显式会话选择/历史优先及卸载均有覆盖。风险是公开 waterfall 的顺序与字段语义会随升级变化，第三方更外层监听器仍可能再改路由；升级必须重跑组合测试。未访问 Controller 的私有 selections/agents 状态。

bot-context 新增注入 `llm`，通过公开 `llm.listProviders()` / `llm.listModels(provider)` 校验将实际采用的 Bot route；失败抛 `DshBotError('bot/preset-failed', ...)`，包含 botId/provider/model/原因并保留 cause，不回退 Host 模型。检查发生在 Agent 创建及采用初始 Bot 模型的 assembly/request，以捕获创建后 provider 消失；显式选择或历史路由优先时不验证未使用的 Bot 默认。与 GUI 的目录选择政策一致，仅接受 provider 广告目录内的模型：DSH core 本可路由未列出模型，此处选择明确拒绝而非猜测（`llm/llm/src/index.ts:251-261,711-740`；`api/session-controller/src/catalog.ts:modelAvailable`）。目录查询可能由适配器执行远程元数据请求，存在延迟/失败；目录可用不证明凭据有效或模型回复成功。真实 profile 用公开 `LlmAdapter` 注册仅目录 fixture，stream 永远抛错并计数，最终 streamCalls=0；不存在的 provider 和 model 均在新建 Agent 时明确拒绝。

**模板跟随运行中宿主。** Bot 每次启动/创建/更新组合时读取当前 DSH 的 standard/minimal；宿主升级或模板编辑可能改变之后生成的 Bot 行为，测试 fixture 的 SHA256 只锁定回归输入，不能锁定生产模板，也不在生产读取。已挂载代际不会因一次 status 查询被替换。`status()` 每次按不同模板做一次 `readDocument`，失败返回 broken 与具体原因（即便旧代际仍健康或启动未注册成功），恢复后重新查询可清除该临时诊断。单测覆盖启动读失败、运行后读失败、修复和查询不注销旧 preset。

真实跨 preset 探针已新增原生 standard Agent：没有 Bot binding、read 可见、无私有技能、提示词变量和请求路由均为 Host 默认。测试 fixture 复制到隔离 profile 运行，从宿主加载 `dsh-agent` 的公开 helper；不能从正式包的 dev-only agent 副本构造 scope carrier，否则不同 scope 模块的私有 Symbol 会使测试分发错误地扩大到全局。初次失败证据保留，最终以正确宿主模块的 probe 为准。

## T04：注册表、严格 Remote 契约与关闭协调（2026-10-18）

本节沿用 T02/T03 的锁定版本；实现与完整验收见 `docs/acceptance/P1-T04.md`。新增正式代码均位于 `packages/dsh-bot/`，没有从 `spikes/` 导入。

- `DshBotRegistry` 注册 `ctx.dshBots`，`static inject = ['storageDomain', 'agentPresets']`。读写统一排队；稳定 preset id 默认为 `bot-<id>`。更新先等待旧 disposer，再注册候选并检查 `list().broken`，健康后才提交 BotStore；失败清理候选、恢复旧定义。记录尚未提交，因而无需覆盖原记录或改变其时间戳。补偿失败返回 `bot/rollback-failed`，置 failed 闩锁；读操作仍可用，下一次写入在同一队列内先 reconcile：对照 Store 与 `agentPresets.list()`，清理本实例持有 disposer 的多余、broken、缺项或与记录不同的定义，重注册所需定义，全部健康才清除 failed 并执行原写入。失败仍返回 `bot/unavailable`，后续写入可再重试。只凭前缀不能认定所有权，不会注销其它插件的同前缀 preset；外部同 id 冲突不能自动抢占。
- `agentPresets.list()` 会对等待依赖的行调用 Host `loader.await()`，不能在 Host Loader 行自身的激活中等待（只读源码 `packages/preset/agent-preset-registry/src/index.ts:127-145`）。Host 入口显式 inject `loader`，立即提供 guard service，在 Loader settled 后后台初始化；未就绪时调用返回 `bot/unavailable`。逐个存量 Bot 注册失败或 broken 只记录该 Bot 状态，继续其它 Bot，仍允许修复或删除；日志包含 `preset startup failed bot=<id>` 与原因。整个存储打开失败才属致命启动失败：清理已得资源，保留 service 返回 `bot/unavailable`，日志 `startup failed bot=*` 附领域/记录校验原因。只有初始化结束才记录 loaded；它不意味着每个 Bot 都健康。
- `@Remote('delete')` 让 Host 的 `remove()` 在 wire 上叫 `dshBot/delete`；严格描述符同时声明 `implementation: 'remove'`。**真实 Node Gateway Client `$mount` 拒绝名为 `remove` 的方法**，因为它与 `RemoteNamespaceService` 自身的 `remove` 方法冲突。公开源码依据：`packages/api/gateway/src/client/index.ts` 的 `RemoteNamespaceService.assertMethodAvailable` / `remove`；Host 实现映射见 `packages/typert/protocol/src/types.ts` 的 `InvocationDescriptor.implementation` 与 `packages/api/gateway/src/index.ts` 的 `callReceiver` 分派。没有修改宿主，也没有覆盖 Client 内部方法。
- Client 七个业务端点为 `list/status/get/create/update/duplicate/delete`，Host 对应 `list/status/get/create/update/duplicate/remove`。`status()` 返回 `{ id, presetId, preset: { state: 'ok' | 'broken' | 'missing', reason? } }[]`，由同一严格 Zod spec 派生 Host/Client 签名和描述符；查询实时 roster，不持久化运行状态。Client 必须使用返回的 presetId，不得自行拼接可配置前缀。现有 CRUD 返回值保持不变。Client 调用删除必须传两个参数：`ctx.remote.dshBot.delete(id, options)` 或 `ctx.remote.dshBot.delete(id, undefined)`。rc.2 Gateway 的 `prepareInvocation` 按描述符数量严格检查 JS 实参数量，不会因为 `acceptsUndefined` 自动补省略的尾参数（`api/gateway/src/client/index.ts:499-518`）。Host 直接调用仍可省略 options。
- 单一 Zod spec 派生 Host/Client 参数及结果类型、严格描述符；Host 用公开 `ctx.typert.register(TYPERT)`，Client 在 effect 内等待 `$mount(TYPERT_REMOTE)`。`DshBotError` 移到 Host 模块并继承真实 `RemoteError`，保留原错误码、name/cause；新增 `bot/preset-failed`、`bot/rollback-failed`、`bot/unavailable`。业务错误 details 使用空对象 `{}`，不可用 undefined；rc.2 Connection 的失败帧要求 details 为对象，丢失该字段会被判为无效 carrier 响应并折成 `gateway/internal`。
- Client 仅内联公开无状态 `/remote-info` 工厂和本包共享 schema/contract；Cordis、Zod、React 使用平台模块。构建按 canonical path 精确允许该工厂，拒绝 Host、spike 和其它依赖实现。protocol 因 Host runtime import 增加 peer+精确 dev；loader、gateway、connection、typert-registry 仅类型/测试用途为 dev。Schemastery 使用独立普通运行依赖，无共享 resolver 状态。
- Cordis `Fiber._unload()` 并行启动兄弟 effect 的 disposer（`vendor/cordis/src/fiber.ts`）；仅在 registry disposer 等待队列不能阻止 Store 的独立 effect 提前关闭域。`openBotStores` 新增可选 `beforeClose`，registry 用它先停止接收并排空已接收的 API 操作，再让 Store 标记 closing 和关闭。自动卸载与显式 close 仍共享同一个 Promise。已添加“挂起 create + 已排队 update + unload”的故障测试。
- `dsh_bot` 领域新增 `registry_state` 表保存 examples 的 pending/complete 标记；仍为 schema version 1 的加表扩展。官方 JSON parser 对缺失的声明表视空（`packages/storage/storage-json/src/format.ts`），旧 T03 bots/memories 记录保持原样；pending 初始化会只补缺失示例，不覆盖已写记录。complete 后即使删空也不再种例；不支持用旧版写入器降级回写后保持新表。
- `dataDir` 默认 `$DSH_HOME/dsh-bot`，只作为后续技能目录配置，不改变 storageDomain 的后端地址。当前 composer 是 persona 最小占位，尚不实现 standard/minimal 模板、模型、技能或工具限制（T05）。`duplicate` 复制 Bot 配置，不复制记忆；`remove` 默认清记忆，显式 false 保留原 botId 的记忆，同 id 重建会重新关联这些保留记录。沿用 T03 非跨表事务边界：记忆删除途中失败可能已删除部分记忆，Bot 和 preset 恢复后可重试。
- `dsh-bot/changed` 在提交后通过 `ctx.parallel` 发布 Host 事件，不等待监听器，避免监听器重新读取时阻塞写队列；监听失败不改变已提交结果。事件不进入宿主的 Remote 白名单。T08 沿用成功修改后 refetch、挂载/显示/connection reset 刷新、低频轮询方案；本任务没有实现或声称即时跨 Client 推送。
- Remote 编辑通过 `null` 清空 `avatar/model/defaultCwd/order`，wire schema 保留 null，Host 再规范化为 undefined 后执行原有 Store 更新。省略字段保持原值；Host 直接调用仍支持显式 undefined。HTTP 的 JSON.stringify 会丢弃 undefined 属性，Client 直接传 `{avatar: undefined}` 不会清空，必须使用 `{avatar: null}`；严格 codec 的参数 schema 并不会自动在官方 Client 发包前执行。单测覆盖四字段、必填字段 null 拒绝及落盘重开，真实 HTTP 验证头像、默认目录、order 清空后读回均无对应属性。

Remote 可用性边界：上述 `bot/unavailable` 以 Host apply 已执行、Client contribution 已 mount 为前提。Client 未 mount 时 `remote.dshBot` 不存在（四轮真实 profile 均验证）；Host 根本未加载/依赖未满足时，若仍有 descriptor，Gateway 找不到 receiver 返回 `gateway/service-unavailable`（源码 `packages/api/gateway/src/index.ts:810-817`），不经过 Bot guard。T08 应把 namespace/服务缺失统一呈现为“Bot 服务尚未就绪或加载失败”，保留错误详情和重试入口，不显示成空 Bot 列表。损坏存储需修复数据/配置并重启；写前 reconcile 不会自动重开致命失败的存储。

删除与历史会话：删除 Bot 不删除历史会话，但其 preset 不再可解析，底层查询/新建为 `agent-preset/not-found`。**冷恢复经 SessionController 在 rc.2 实际返回 `gateway/internal`，message 含 `Unknown agent preset: <id>`**；这是 T02 的跨进程实测（[第 1 节](spikes/P1-api-spike.md#1-动态-preset更新和重启)）和 `packages/api/session-controller/src/agent.ts:235-256` 的 catch 包装，不应写成冷恢复直接返回 not-found。仍活跃的 Agent 保持旧代际；重建同 id 后可恢复，使用当前定义而非历史快照。本轮只新增真实缺失 preset 查询验证，没有重新创建/冷恢复会话。

T08 文案方向：仅 `ok` 启用“开始聊天”，用 status 返回的 presetId；`broken/missing` 显示“此 Bot 暂不可用：{reason}”，提供编辑修复、删除和刷新。删除确认提示“删除后，依赖此 Bot 的历史会话将无法恢复；历史记录不会一并删除。”更新提示“活跃会话继续使用原配置，新会话及重新恢复的会话使用当前配置。”读取 list/status 需统一刷新并处理两次查询之间的变更；状态为瞬时快照，发起会话仍需处理缺失/无效 preset 错误，不能只依赖禁用按钮。国际化文案和真实 UI 由 T08 实现。

验证范围：真实隔离 Web profile 中通过已鉴权 Node Gateway Client 测试正式 bundle；未启动模型会话、Desktop 或浏览器。评审后 `.dsh-dev/t04/run-2026-10-18T17-43-46.125Z-58357/summary.json` 记录四次 Host 启动、74 项检查全部 PASS，包括自定义 `review-` 前缀状态、示例健康、删除后缺失 preset 的错误码和致命启动失败的 Remote `bot/unavailable`。存量坏 Bot 隔离、自愈失败/重试、清理 owned orphan/保留外部同前缀定义由单测验证。具体命令和证据见 T04 验收报告。

参考源码根目录：`~/ai-workspace/deepseek-harness`（只读），锁定 tag：`dsh-v0.2.1-rc.2`。下表完整路径均相对此目录；同一单元格内的短文件名与其前方的 `src/index.ts` 同目录。

T00 仅建立依赖与 API 索引。下列包的名称、版本及根入口导出已核对源码 manifest；五个 DSH 包另经 `npm view <包名>@0.2.1-rc.2 name` 核实存在。Cordis `4.0.5`、Schemastery `3.18.5` 与 vendor manifest 及 T00 npm `latest` 查询一致；开发依赖仍使用精确版本，DSH peer 使用 `>=0.2.1-rc.2 <0.3.0`，Cordis peer 使用 `^4.0.5`。

“源码已核实”仅表示可在锁定版本中找到公开入口和声明，不表示本项目已通过宿主加载、作用域隔离、热卸载、Remote 或 UI 运行验证。运行行为由 T02 spike 及后续任务补充证据。

| API | 包 | 源码路径 | 用途 | 核实状态 |
| --- | --- | --- | --- | --- |
| `Context`、`ctx.effect` | `@deepseek-ai/cordis@4.0.5` | `vendor/cordis/package.json`；`vendor/cordis/src/index.ts`、`context.ts`、`fiber.ts` | 插件上下文与资源生命周期；effect 收集 disposer 并在卸载时清理 | 包与源码入口已核实；项目运行待验证 |
| 默认导出 `Schema` | `@deepseek-ai/schemastery@3.18.5` | `vendor/schemastery/package.json`；`vendor/schemastery/src/index.ts` | 声明 `Config`、校验参数和默认值 | 包与源码入口已核实；项目运行待验证 |
| `defineTool`、`ctx.tools.register`、`ctx.tools.restrict` | `@deepseek-ai/dsh-tools@0.2.1-rc.2` | `packages/core/tools/package.json`；`packages/core/tools/src/index.ts`、`schema.ts` | 定义和注册 Bot 工具、限制 agent 可见工具 | 包与公开导出已核实；作用域与注销行为待 T02 |
| `PresetDefinition`、`ctx.agentPresets.register` | `@deepseek-ai/dsh-agent-preset-registry@0.2.1-rc.2` | `packages/preset/agent-preset-registry/package.json`；`packages/preset/agent-preset-registry/src/index.ts`、`definition.ts` | 动态注册 Bot preset；返回异步注销函数 | 包与公开导出已核实；组合、更新与代际行为待 T02 |
| `defineDomain`、`domainTable`、`ctx.storageDomain.open` | `@deepseek-ai/dsh-storage-domain@0.2.1-rc.2` | `packages/storage/storage-domain/package.json`；`packages/storage/storage-domain/src/index.ts`、`spec.ts`、`domain.ts` | 声明 Bot/记忆存储领域，打开后由调用方负责关闭 | 包与公开导出已核实；后端与持久化行为待 T02 |
| `PromptSection`、`ctx.systemPrompt.section` | `@deepseek-ai/dsh-system-prompt@0.2.1-rc.2` | `packages/core/system-prompt/package.json`；`packages/core/system-prompt/src/index.ts` | 按作用域与顺序注入记忆提示词片段，返回 disposer | 包与公开导出已核实；agent 隔离与顺序待 T02 |
| `Agent`、`AgentRegistry`、`ctx.agents` | `@deepseek-ai/dsh-agent@0.2.1-rc.2` | `packages/core/agent/package.json`；`packages/core/agent/src/index.ts`、`types.ts`、`runtime-types.ts` | 读取活跃 agent、使用公开 agent 上下文和生命周期类型 | 包与公开导出已核实；组合运行待 T02 |
| Remote namespace 与 Client slot 接入 | 待 T02 按公开导出确认并补充 | 待 T02 补充 | Host 方法调用、Bot 页面与会话徽标 | 未核实；T00 不建立运行结论 |

后续核实每个 API 时补充使用的符号、准确源码位置、依赖注入、返回值与 disposer、作用域限制、验证命令、结果和证据路径。DSH 升级须逐条复核。

已发现的待验证细节：锁定源码中 `agentPresets.register` 返回 `Promise<() => Promise<void>>`，且相同 ID 已注册时会抛出 `Duplicate agent preset`（`packages/preset/agent-preset-registry/src/index.ts:81-85`）。T02 必须验证“同 id 更新 preset”的可行顺序，不能直接把计划中的“先注册新代际再注销旧的”当作已支持行为：

- 同 id 先等待旧 preset 注销完成，再注册新定义：验证空窗期对列表、并发创建新会话及已有会话的影响，并验证新注册失败时恢复旧定义的可行性。
- 使用带版本后缀的新 id：验证先注册新 id、切换 Bot 到 preset 的映射、再注销旧 id 的顺序，以及旧会话引用、UI 选择和旧版本清理的影响。

以上均为待验证候选方案，T02 需记录运行证据后再确定实现。

依赖共享与 manifest 规则来源：`docs/user/develop/basic/publish.zh.md`。需要宿主共享实例的包同时放入 `peerDependencies` 与 `devDependencies`；bundle manifest、Client 打包与实际激活属于 T01 及后续任务。

Schemastery 当前仅预备用于常规 Config schema，没有共享自定义 resolver 注册表的需求；按上述规则及官方 `packages/preset/persona/package.json` 将 Schemastery 放入普通 `dependencies` 的用法判断，T00 不新增 Schemastery peer，保留精确 devDependency。引入运行时 Config 时按需补普通运行依赖；若后续需跨宿主共享 `Schema.extend()` 注册状态，再复核并增加 `^3.18.5` peer。

## T01：最小 bundle（2026-10-18）

本次只实现 Host 生命周期日志与输入区徽标，不实现 Bot 注册表、Remote 或其他 T02 API spike。下表路径仍相对只读参考源码。

| API / 契约 | 准确来源 | 本项目用法与验证边界 |
| --- | --- | --- |
| `dsh.bundle.patch`、exports / files、peer / dev | `docs/user/develop/basic/publish.zh.md`；`packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md` | 一个 patch 插入 `id/name: dsh-bot`；隔离 CLI 安装与 dump 层通过；tarball 实际文件清单通过 |
| `Context`、`ctx.effect`、`ctx.logger.exporter` | `vendor/cordis/src/context.ts`；`fiber.ts:415-418`；`logger.ts:226-237` | Host effect 返回卸载日志 disposer；Client 直接声明 `inject: ['slots', 'locale']`，注册均归当前上下文 effect；独立 Cordis 测试验证 Host 和 Client 清理各一次。安装后 Host 的 loaded 日志另有实际 CLI 证据 |
| 闭包 `window.__ModuleLoader__.load({id,factory(require)})` | `packages/client/tsdown.client.ts:515,664-670`；`packages/client/web/src/platform.ts:9-15` | 本仓库自写 esbuild 配置；所有指定平台包 external，经 metafile 拒绝嵌入任何 node_modules 实现；VM 验证注册阶段不访问 require，factory 仅请求 `react/jsx-runtime` |
| `dsh.client`、`./client`、boot graph | `docs/subsystems/client-modules.zh.md`；`packages/client/modules/src/index.ts:640-672` | manifest 指定 web / immediately / ui-conversation；隔离 Web 实际 boot graph 含 dsh-bot，带 revision 的脚本路由返回正确 bundle。此结果不代表浏览器已执行 apply |
| `ctx.slots.inject/register`、`PropsLocale`、`LocaleNamespaceMap` | `packages/client/ui-slots/src/index.ts:31-38,90-98,829-835`；`packages/client/ui-renderer/src/client/index.ts:48-51`；`registry.ts:195-209,242,269,741-746` | 从公开入口导入类型；等待 dock 声明，注册 id=dsh-bot；inject 的 disposer 清理注册；slot 注册声明 locale 以取得翻译函数 t |
| `conversation.composer.dock` | `packages/client/ui-conversation/src/client/contract/slots.ts:274`；`apply.ts:460` | 徽标只占用此公开 slot；未创建额外页面、根节点或覆盖层 |
| `ctx.locale.register(namespace, {en,zh})` | `packages/client/locale/src/client/index.ts:83-85,378-400` | 从随包 JSON 读取 ui 字典；返回幂等 disposer，由当前 Client 上下文 effect 收集。中英 meta/ui 键集测试通过 |
| 亮 / 暗主题 token | `packages/client/ui-theme/src/styles/design-platform.css:171,185,223,289,303,341` | 使用 `--dsw-alias-bg-layer-1`、`--dsw-alias-border-l1`、`--dsw-alias-label-secondary`；源码 token 已核实，实际两主题显示未验证 |

评审后 peer 仅保留项目约定的 `@deepseek-ai/cordis: ^4.0.5`。Host 目前只有类型导入；其余 Host 服务定义包在真实 runtime import 前只保留精确 devDependency。DSH Client 包的 devDependency 仍为 `0.2.1-rc.2`，React 为 `18.3.1`；Client 服务入口只作 type import，浏览器运行时 React 来自注入的模块表，不经 Node 解析，不声明 Node peer。本任务没有可调业务参数，因此没有新增 Config schema 或 Schemastery 运行依赖。

默认 Web 组合在 `packages/bundle/web-app/cordis.patch.yml:257-258` 无条件声明 locale；Web 模板采用此 bundle（`packages/boot/app-boot/src/profile.ts:183-185`），Desktop 也使用 `WEB_PROFILE.bundles`（`apps/desktop/src/project-manager.ts:142,167`）。因此 Client 简化为直接依赖 slots 和 locale，不再创建 locale 子 fiber；自定义组合若缺少服务，由 Cordis 的正常依赖等待机制处理。

Client sourcemap 使用 **linked** 模式：`lib/client.js` 引用相邻 `client.js.map`，map 含 `sourcesContent`，`files: ["lib", ...]` 同时收录 JS 与 map。来源为 `docs/subsystems/client-modules.zh.md:102` 和 `packages/client/modules/src/index.ts:323-344`：combo-map 首次请求读取 `${clientPath}.map`，校验 Source Map v3 后组合 sections。本地测试验证闭包 banner 后的生成位置能映射回 TSX 原始声明；尚未把本地 map 检查当作桌面调试器实测。

持久化设计约束：**进程收到 SIGTERM 时插件 dispose 不保证执行，持久化写入不能依赖卸载钩子。** 关键写入应在业务操作完成前持久化，卸载钩子只用于尽力清理。这里的“不保证”是本项目的保守可靠性约束，不是声称已证明当前 DSH 会跳过 dispose：`.dsh-dev/t01-host-evidence.json` 记录 SIGTERM 子进程退出 0、loaded=true、unloaded=false，仅证明 observer 未捕获卸载日志；而 `apps/cli/src/profile-boot.ts:285,302-307` 明确走关闭流程并尝试 `fiber.dispose()`。日志观测与实际 dispose 执行不能等同。独立 Cordis 卸载测试仍通过；按本轮评审不继续追查 SIGTERM 日志。

实测命令、文件与完整验收见 [P1-T01 报告](acceptance/P1-T01.md)。重要边界：

- `--dump-config` 是静态组合，不启动插件：`apps/cli/src/dump-config.ts:2-5`。
- Web ready 行在 Loader settled 与启动审计之后输出：`packages/bundle/web-app/src/index.ts:244-254`。没有发送 prompt 或创建模型会话。
- 参考 tag HEAD 为 `687f282e8625c6b8d11ff58211a90524be2e4317`；实际桌面自带 CLI Web release metadata 为 version `0.2.1-rc.2`、commit `332895e`。只确认版本号一致，没有把不同 commit 当作同一源码构建。
- 浏览器安全审批拒绝本机 origin。Client 的 apply 只在 Cordis + service doubles 测试中执行；真实浏览器激活、徽标、插件页图标和亮暗主题验收未执行。未以静态 token 或 boot graph 替代视觉证据。

## T02：真实隔离 Web API spike（2026-10-18）

最新运行结论见 [P1 API spike 完整报告](spikes/P1-api-spike.md)。本节覆盖前文 T00 的“待验证”状态；T01 的浏览器/桌面验收边界仍保留。可复现代码在 `spikes/`，不属于正式 bundle。

| API / 公开包入口 | 本轮实际结果 | 约束与后续设计 |
| --- | --- | --- |
| `agentPresets.register/list/readDocument`；`dsh-agent-preset-registry` | 动态注册/注销、重复 id、坏定义、旧/新代际和跨进程恢复实测 | register 返回异步 disposer，必须 await 并归属 effect；激活失败可能只体现在 `list().broken`。同 id 注销再注册有真实空窗。稳定 id 冷恢复取当前定义；版本 id 缺失时拒绝恢复 |
| `entryListSchema`；`@deepseek-ai/cordis-plugin-include@1.0.10` + `js-yaml@4.1.1` | 从 standard document 解析 22 行，替 persona 加 bot-context 得 23 行，healthy 且创建成功 | `!!js` 是 `{__jsExpr: string}`。普通字符串不会执行；函数 structuredClone 失败。inventory 缺 config，不能当模板。库从公开根入口导入 |
| `systemPrompt.section`、`tools.register/restrict`、`agent/created`；system-prompt/tools/agent/scope | Host dshBots 可见；alpha/beta/plain/global 隔离，alpha 两会话的独立 section 实测 | preset apply 发生在代际 standing scope。每会话记忆和继承工具限制放 scoped `agent/created` 中，使用 agent.ctx.effect。9000 在工具引导后，不满足“工具之前”的顺序要求 |
| `defineDomain/domainTable/storageDomain.open`；storage-domain | 原名 `dsh-bot` 被拒；替代 `dsh_bot` 在 Web 下写入、并发 update、close/reopen、重启读回成功 | 名称正则 `^[a-z][a-z0-9_]*$`。默认 `$DSH_HOME/storages/dsh_bot.json`。open 校验已存值；put/update 不校验，正式写入需 schema.parse。同名 open: already-open；closed 句柄访问: closed |
| `TypertRemoteService/Remote/createTypertRemoteInfo`；typert-protocol | Host bare decorator/SRC fallback 和显式 strict contribution 两条路径均经鉴权 HTTP 成功 | Host strict 契约可用公开 `ctx.typert.register`，由 effect 注销；不能把 SRC JSON 形态检查当业务 schema 校验 |
| `installConnection`；client-connection/client，`api-gateway/client`，typert-registry | 实际 Node 条件入口调用 `ctx.remote.dshBot.list()`；未鉴权 401，mount 前缺 namespace，unmount 后消失 | Client 必须 `$mount(contribution)` 并 await；消费方 inject remote 与 remote.dshBot。本轮以内存启动 token 交换 cookie，未读取凭据文件。没有打开浏览器 |
| `WorkspaceTypertGenerator/WorkspaceAnalyzer`；typert-generator | **FAIL：外部 npm protocol .d.ts 的 Remote 标记未被识别，invocations=0** | `spike:generator` 保留失败复现。本轮手写 public metadata fixture 只证明通信，不能视作官方生成成功；T04/T08 需先决定正式契约方案 |
| `sessionController.create/resolveAgent/inspect`；api-session-controller，`sessions.flush`；session | 第三方 Host 创建、落盘、重启恢复 PASS；评审补充的 mock prompt PASS | 对每个使用的 service 声明 inject；Session Controller 拥有创建的 Agent，裸 Agent 不是可销毁 handle。初轮未发送 prompt；本页末尾追加了隔离 profile 的 mock 回复证据 |
| agent-loop-testkit / llm-mock-server / loader-smoke / client-test-runtime | 四包精确 rc.2 可安装；前三个外部最小示例 PASS，Client 根入口 import **FAIL** | Client 包引用 renderer 未发布的 src/client/bind.ts。不要深导入参考源码绕过。独立 mock SSE 不代表 profile 模型或工具闭环完成 |

关键源码定位（相对参考根）：

- preset：`packages/preset/agent-preset-registry/src/index.ts:81-121,213-273,318-327`；`src/mount.ts:92-122,194-214`。
- 表达式：`vendor/include/src/index.ts:9-23`；`vendor/loader/src/config/utils.ts:11-32`；`packages/boot/app-boot/src/compatibility-preflight.ts:89-95`。
- scope：`packages/core/system-prompt/src/index.ts:131-164,470-487,614-640`；`packages/core/tools/src/index.ts:1065-1125,1170-1226`；`packages/core/agent/src/runtime-types.ts:248-261`。
- storage：`packages/storage/storage/src/backend.ts:10`；`storage-domain/src/spec.ts:108-109`、`src/index.ts:120-128`、`src/domain.ts:307-344`；默认组合 `packages/bundle/base/cordis.patch.yml:175-190`。
- Remote：`docs/api-gateway.zh.md:64,90-144`；`packages/api/gateway/src/index.ts:862-993`；`src/client/index.ts:214-222`；`packages/typert/generator/src/analyzer.ts:1395-1401,2084-2100,2770-2777`。
- 会话：`packages/api/session-controller/src/index.ts:295-303`、`src/agent.ts:235-256,387-398,563-577`；`packages/core/session/src/index.ts:1306-1335`。
- Client 测试包：`packages/test-support/client-runtime/src/index.ts:25-30` 对比 `packages/client/ui-renderer/package.json:52-56` 的 files。

版本与生命周期：新增 DSH dev 包均 `0.2.1-rc.2`、Cordis `4.0.5`、Schemastery `3.18.5`；需要共享实例的 Host runtime 包声明兼容 peer。测试 schema 与 protocol 的 Zod 类型出现 4.4.3/4.6.7 分裂，workspace override 固定 `zod:4.4.3`，与参考源码一致。异步注册/打开资源在 effect 内取得并收集 disposer；Host 正常完成后才停止。没有将未执行的中途取消故障注入计为验证通过。

T02 不改变正式包的 Config、UI 或 locale。Desktop 只确认组合源码，实际 Desktop、浏览器显示/亮暗主题、自定义 Remote 事件、独立 Bot model 仍待后续验收；profile mock prompt 已在评审补充通过。任务单修订由编排方负责。

## T02 评审补充：检查隔离、依赖和生产接口建议（2026-10-18）

### 产品检查与 Zod override

根 `build/test/typecheck` 使用 `--filter './packages/*'`，`lint` 只检查 `packages`，因此 `scripts/pnpm check` 不再构建或检查 spike。`scripts/pnpm check:spikes` 单独覆盖三个 spike workspace 的 build/typecheck、`biome lint spikes`、Remote 签名/codec/公开 exports 检查和三个可运行测试工具（含 fs-local 原子写入）。真实 Host 与 mock profile 是独立显式命令，见 spike 报告；已知失败的 generator、client-test-runtime 保留独立复现命令，未静默当作通过。**检查隔离不等于依赖隔离**：它们仍共享 workspace lockfile 和 override。

`pnpm-workspace.yaml` 中 `overrides.zod: 4.4.3` 是本 workspace 的统一解析约束。原因是 protocol 的 `^4.4.3` 曾解析成 4.6.7，而 registry 与本 spike 的 schema factory 使用 4.4.3，公开 `ZodType` 的 `validate/validateAsync` 等类型出现版本分裂；锁到参考 rc.2 所用 4.4.3 后 strict 编译与实际 Remote codec 通过。源码 manifest：`packages/typert/protocol/package.json:38-40`、registry `package.json:55-56`；当前实际依赖树见 `.dsh-dev/t02-review-zod-why.log`（`scripts/pnpm -r why zod`，仅 4.4.3）。

影响范围与移除条件：

- override 作用于**整个仓库所有 importer 及传递依赖**，包括 `packages/dsh-bot` 的开发类型/测试依赖，并非只影响 `spikes`。今后加入要求其他 Zod 版本的包时，要检查强制替换的兼容性，不能仅以安装通过判断。
- 当前产品 Host `packages/dsh-bot/lib/index.js` 没有任何 runtime import，仅注册日志 effect；源码只有 type import。因此当前 Host 运行不依赖 Zod，本次 override 不改变其 Host 行为。未来 Host 加入 Zod、storage 或 Remote runtime imports 后，本地开发依赖会受 override 约束，须重新验收，不能沿用此结论。
- 当前 Client 也未使用 Zod；后续 Client 的 `zod` import 必须来自**宿主平台模块表**（参考 `packages/client/web/src/platform.ts:8-15`；本仓库 `packages/dsh-bot/build/client.config.ts:11-20,44-55` external/产物检查）。workspace override 不替换已安装 DSH 平台的 Zod，也不修改桌面安装内容或宿主全局依赖。开发类型锁定与浏览器运行时共享实例是两个层面。
- 可移除时机：上游统一所需版本/修复跨版本公共类型，或在独立 spike workspace 中局部固定；移除后重新解析 lockfile，核对 `pnpm why zod`、产品/spike strict 检查、Host strict Remote 编解码及 Client 平台 schema 兼容性。不要只删除 override 而保留旧 lockfile，误判问题已解决。T04 引入正式 Remote 后应重审一次，DSH 升级时再次重审。

### koffi install hook

实际命令 `scripts/pnpm -r why koffi` 的唯一链（完整输出 `.dsh-dev/t02-review-koffi-why.log`）：

```text
dsh-bot-spike-test-tools (devDependencies)
  -> @deepseek-ai/dsh-agent-loop-testkit@0.2.1-rc.2
  -> @deepseek-ai/dsh-fs-local@0.2.1-rc.2
  -> koffi@3.1.1
```

`allowBuilds.koffi@3.1.1: false` 保留。fs-local manifest 在 `packages/fs/fs-local/package.json:33-36` 声明它；`src/win32.ts:46-54` 才动态 import Koffi，加载 `advapi32.dll`/`kernel32.dll`，用于 Windows DACL 与 ReplaceFileW。`src/fsio.ts:605-649` 仅 win32 替换路径调用这些函数，POSIX 路径使用 link/rename。

运行确认：`spikes/test-tools/src/run.ts` 通过公开 testkit `{workingDirectory:true}` 挂载真实 fs-local，再通过公开 `ctx.fs.resolve/writeText` 执行 createIfAbsent、替换已有文件、读取校验，结果 `platform:darwin, create:create, replace:update, text:second`，见 `.dsh-dev/t02-test-tools/results.json` 的 `fsLocalWithoutKoffiHook`。因此禁用 hook **不影响本次 macOS 会用到的文件创建/替换、Agent harness、mock 和 Loader 功能**；产品 Host 当前没有这条依赖链。没有据此声称 Windows 原生绑定可用，Windows/其他原生路径未验证，扩展平台前需单独检查预编译绑定与 hook 策略。

### T04 Remote 与 T08 刷新

详见 [spike 第 5 节的完整模板与源码证据](spikes/P1-api-spike.md#t04-推荐写法)：单一 Zod schema 派生 Host/Client 类型，同一 `createTypertRemoteInfo` 产物供 Host `ctx.typert.register` 和 Client `$mount` 使用。签名测试检查实际 service 方法与 Client 声明、descriptor 和正负 codec 样本；公开 npm exports 和符号检查输出 `.dsh-dev/t02-review/public-exports.json`。`createTypertRemoteInfo` 根出口及公开 `/remote-info`、registry 根出口和 register 合同、gateway `/client` 及继承的 `$mount` 都在已安装 rc.2 包内核对过；没有从参考源码内部路径 import。

Client 建议用无 runtime imports 的公开 `@deepseek-ai/dsh-typert-protocol/remote-info` 工厂，随本包契约内联；Zod 保持平台 external。该工厂不在平台模块表，T04 必须精确调整 T01 的“禁止任何 node_modules 内联”检查，不能把 protocol 根入口当平台 require。本轮只提供可编译模板，没有改产品构建或业务代码。

刷新调研结果：ui-schedule/plugin-market 使用内置 changed 白名单 + `connection/reset` 触发重新查询；第三方 `dsh-bot/changed` 不会自动进入宿主唯一 Remote 事件源。P1 推荐提交成功后 refetch + 页面可见/首次订阅 + reset + 活动页面可配置轮询（建议 5 秒），防旧读覆盖新读、卸载清理并保留手动刷新。若要求即时跨 Client/工具更新，备选自定义 stream Remote，配合 `$stream`/`RemoteSnapshotStream`，每代一个 opening snapshot 后跟 delta；Host 负责一致性、revision 与队列边界。**本项仅源码调研，未将自定义 stream 或浏览器刷新计为运行通过。**

### P2 mock 新会话闭环

评审补充已取代上文初轮“profile prompt 未验证”：`DSH_HOME="$PWD/.dsh-dev" node spikes/test-tools/src/mock-profile.ts` 创建全新默认 Web profile，将其 `cordis.patch.yml` 中 `agent-default-model` 指向 `deepseek-official/deepseek-flash`，覆盖 `llm-deepseek` 的 loopback `/v1` baseURL 和独立 `DSH_BOT_MOCK_KEY` 引用。仅子进程 launch env 提供 `mock-key`；停用其他模型 provider、title LLM、重试和遥测/远程日志，不读取任何凭据文件。`--dump-config` 后 `--no-open --host 127.0.0.1 --port 0` 实际启动。

最终证据 `.dsh-dev/t02-review/t02-mock-1792342631862/{dump.yml,host.log,session-result.json,result.json}`：Host 激活；`create({cwd,agentPreset:'bot-mock-spike'})`；`prompt` 返回 accepted=true；实际 `assistant/message` 文本 `T02_ROUTINE_MOCK_OK`；flush=true；mock 恰好一条 `/v1/messages`、behavior=success/outcome=completed。会话为 `session-cc048c8f-e320-4665-ac15-6e1d55159c66`。正常关闭退出 0，无浏览器，无真实模型调用。

新增使用公开包：`@deepseek-ai/dsh-agent-default-model` 根入口（dev 精确 rc.2，type import），`currentSelection()` 用于验证默认 provider/model；`SessionRequestId` 与 `sessionController.prompt` 来自 `dsh-api-session-controller` 根入口；`ctx.fs` 的类型声明来自 `@deepseek-ai/dsh-fs` 根入口（dev 精确 rc.2）。源码 `core/agent-default-model/src/index.ts:67-73`、`api/session-controller/src/types.ts:344-359`、`src/index.ts:462-485`。prompt 回执只保证进入 Inbox，必须另等 assistant 事件；本例验证了文本回复，**工具调用、routine 调度/并发、错误重试和冷恢复后续执行仍未验证**。

## T03：正式数据模型与访问层

正式实现位于 `packages/dsh-bot/src/shared/{schema,ids}.ts` 和 `src/host/store.ts`，不导入 spike。领域为 `dsh_bot`、version 1、`bots` / `memories` 两表。类型从 Zod 推导；patch 只替换顶层可编辑字段，拒绝身份、时间戳、schemaVersion 和未知字段。内容 trim 后须非空，按 UTF-8 **2048 字节**校验；头像上限 **65536 字节**。Bot name trim 后最多 **64 个 Unicode 码点**，persona.prefix 按 UTF-8 最多 **16 KiB**；导出常量 `BOT_NAME_MAX_CHARS` / `PERSONA_PREFIX_MAX_BYTES`。创建 Bot 默认 memory 为 enabled=true / injectLimit=20，可通过 Bot 输入修改，不是 Host 配置项。这些固定 schema 上限是持久记录契约，不是可调 Host 配置；改变上限须复核既有数据。旧记录若不符合新增约束，open 会报 store/unavailable 并保留原始校验 cause，不自动删除或迁移。

| 公开 API / 依赖 | 来源（相对锁定参考源码） | T03 用法 |
| --- | --- | --- |
| `defineDomain`、`domainTable`、`Domain`、`DomainError` | `packages/storage/storage-domain/src/index.ts:22-29`；`src/spec.ts` | 仅从已发布根入口导入；新增 storage-domain peer `>=0.2.1-rc.2 <0.3.0`，保留精确 rc.2 dev |
| `KvTable.get/entries/put/delete/update` | `packages/storage/storage-domain/src/domain.ts:42-97,289-344` | 同步读、持久写；真实方法名为 delete。put/update 不校验，本层先 parse。update 回调内比较 expectedUpdatedAt；下一时间戳取 max(当前时间, 旧值+1) |
| `ctx.storageDomain.open` / `domain.close` | `packages/storage/storage-domain/src/index.ts:103-174`；`src/domain.ts:222-239` | `openBotStores(ctx)` 在所属 Host context 的 effect 中打开一次，返回共享 stores；关闭先拒绝新写入并排空包内队列，再 close。重复打开映射 store/unavailable，不接管诊断 get() 返回的现有句柄 |
| `Storage`、storage-json `apply`、storage-domain `apply` | `packages/storage/storage/src/index.ts`；`storage-json/src/index.ts`；`storage-domain/src/index.ts:223` | 测试挂载真实 Cordis 服务和 JSON 后端；storage/storage-json 仅为精确 rc.2 devDependency |
| Zod 4.4.3 | 参考 storage-domain manifest；本仓库 workspace override | 正式 shared schema 增加精确普通 dependency，无共享自定义注册表。Client 尚未引入 schema，未来仍须从平台取得 Zod |

接口约定与限制：

- 同一 Domain 句柄上的 Store 实例共享写队列，保护 create 的检查/写入及记忆归属检查；对外返回深克隆。调用方必须经 Store 写入，不绕过它直接 put；该队列不协调多个 Host 进程。
- Bot get 缺失时报 bot/not-found；`remove(id,{deleteMemories=true})` 默认在同一个共享写队列槽内先删除该 Bot 的记忆，再删除 Bot，避免正常删除后同 id 重建继承旧记忆。显式 false 保留按旧 botId 绑定的记忆，T04 须明确处理后续 id 复用策略。底层没有跨表事务，清理中途失败可能已删除部分记忆，但 Bot 保留且操作可重试；不能宣称崩溃时全量回滚。
- 可选字段支持显式 undefined 清空；patch 保留此意图，最终记录递归去除 undefined 属性，与 JSON 落盘形态一致。省略字段不清空；不允许将必填字段设为 undefined。
- `MemoryStore.add(input)` 要求 Bot 存在；`update(botId,id,patch)` / `remove(botId,id)` 校验归属，跨 Bot 与不存在统一报 memory/not-found。保留的记忆允许按 Bot id 读取和清理。
- `listByBot(botId,{limit,query?,tag?,pinned?,before?})` 同步返回数组；limit 为 1–200 的整数，上限导出为 `MEMORY_LIST_MAX_LIMIT`，超出报 bot/invalid。先过滤、排序、切片，再只对返回页 structuredClone。排序为 pinned 降序、updatedAt 降序、id 升序；before 为末行的 `{pinned,updatedAt,id}`，表示排他的排序位置。并发编辑时不承诺跨页快照一致性。
- 查询对内容做 NFKC/小写归一化，中文拆重叠二元组（单字保留），其它字母/数字按词拆分，全部 token 需被包含；空 token 查询等价不过滤。tag 独立精确匹配。`MemorySearch.matches` 是可替换的纯函数策略边界；自定义策略接收浅拷贝冻结视图（tags/source 也单独复制冻结），防止修改存储引用，不执行逐记录深克隆。当前未实现向量索引、相似度排序或异步检索。
- 错误统一为 `DshBotError`；参数错误由 schema 映射，底层失败保留原始 cause。评审新增 store/unavailable，后续 T04 Remote/UI 契约必须包含该码，不将其展示成表单输入错误。
- Cordis 重复调用同一 disposer 会跳过再次执行，不能据此认为首次异步清理已完成；本层另持有 closing Promise，显式 close 与 fiber 卸载共享同一次排空/关闭。

构建 rootDir 扩展为 src，新增薄 `src/index.ts` 保持 `lib/index.js` 的 bundle 入口。T03 未将 store 挂载到生产 Host，接入留给 T04；Client 和 locale 未改变。

错误码表（T03 评审后）：

| code | 含义 |
| --- | --- |
| `bot/not-found` | Bot 不存在，包括向不存在的 Bot 新增记忆 |
| `bot/conflict` | 重复创建 Bot，或 expectedUpdatedAt 乐观并发冲突 |
| `bot/invalid` | 输入参数不符合 schema，包含空记忆、字段上限、非法列表 limit；不用于底层 I/O |
| `memory/not-found` | 记忆不存在或不属于指定 Bot，二者不作区分 |
| `memory/too-large` | trim 后的记忆内容超过 2048 UTF-8 字节 |
| `memory/rejected` | T06 评审新增：model 来源内容或 tags 命中常见凭据/私钥启发式规则，拒绝保存或合并；错误不回显命中内容 |
| `store/unavailable` | already-open、closed、后端读写/关闭失败、持久记录校验失败等存储故障；原始错误保留于 cause |

运行验证：`tests/store.spec.ts` 的 **24 项**测试使用公开 npm 包和真实 JSON 后端，通过 CRUD、严格校验、字节边界、多实例竞争、同毫秒 CAS、中文检索、隔离、分页、对象副本、落盘/重开和生命周期检查。评审补充覆盖默认级联与同 id 重建、显式保留、跨 Bot update/remove、可选字段清空后严格对象一致性、trim/字段上限/列表上限、分页只深克隆返回记录；在公开 KvUnit 上注入读写失败，验证 cause、未提交更新不改变内存、级联中途失败保留 Bot 及重试成功。各测试使用并清理独立仓库内 `.dsh-dev/t03-store-*`，不触碰 T02 的领域文件。独立服务测试不替代 Desktop 或完整 Web profile 验收；本轮未启动这些环境或真实模型会话。
