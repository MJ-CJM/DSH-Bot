# DSH API 核实记录

## U04–U05：IM 依赖门禁与原生 Team 任务板（2026-10-24）

执行范围和逐项 PASS/FAIL 见 [U04–U05 验收](acceptance/P34-U04-05.md)。按设计 §14：U04 依赖的 U01 consumer gate 未通过，正式包只提供可选服务/合同诊断与禁用 UI，不挂入站消费者、不连接通知端口、不开放 IM 绑定/发送 Remote。方法名/版本检测不代表已验证账号、安装 commit 或消费卸载行为。锁定 dsh-im 只在本仓库隔离 profile 打包安装，无真实平台账号。

| 公开入口 / 只读 rc.2 源码 | 本轮用法和验证边界 |
| --- | --- |
| `@deepseek-ai/dsh-experimental-agent-team` 根类型；`packages/experimental/agent-team/src/index.ts:111-219` | 产品只有 type import；真实 Host 探针从根 default 挂载 TeamService。成员/任务由原生 membership/listMembers/listTasks/createTask/updateTask 提供，不复制任务账本。宿主未挂此实验服务则任务板 unsupported，本包不接管全局服务生命周期。新增精确 devDependency，无新增 Team runtime peer。 |
| 同包 `TeamTaskView` / `UpdateTeamTaskRequest`；`src/types.ts:83-99,224-251` | Client 仅传 taskId/expectedRevision 和 claim/complete，不接受 owner/Agent/任意 action；原生 lead 权限允许完成所属 Team 任务。真实 Gateway 严格拒绝额外 sessionId；严格 codec 拒绝 agentPreset/agentId/reassign。 |
| `agentTeams.membership`；`src/roster.ts:90-113` | Team 是顶层 live lead 的隐式身份，无 createTeam API。用户显式 ensure 只关联既有 Bot 主会话；不将另一 Bot 主会话充当 teammate。实际 native child header 的 parent/preset 已核对继承 lead。 |
| `sessionController.resolveAgent` / `agents.get` / 本包 Bot binding | 从主会话关联取得 exact live Agent，再校主会话、生日、顶层 header 和 native membership；无 Client 任意 Agent 参数。关联 sidecar 冷重开与完整冷 Host 验证分开；读冷板可恢复原生 Agent/已有子代理，不作零模型恢复保证。 |
| `sessions.flush`；`packages/experimental/agent-team/src/journal.ts:67-83` | 原生事务 append 后调用 flush，本包在成功回执前另核 flush=true。false 返回 recovery-needed；不自动重放任务。原生 CAS/依赖测试使用真实服务，不把 Agent/Controller fixture 单测当完整 Host。 |
| native subagent settlement；`packages/subagent/subagent/src/continuation-messages.ts:137-169`、`src/manager.ts:675-689` | 原生 Team teammate 完成会向 lead 投递 `subagent-settled` 并唤醒。探针记录合成 worker 与 lead 的 loopback 请求，以及原生 source/childId；不能误断言 U05 的 lead 必须零模型调用，也不能把该行为套用到尚未实施的群根。 |
| `defineDomain/domainTable`、Typert 根与 `/remote-info` | 新增 `dsh_bot_collaboration` v1 的 `team_links`，仅保存 BotKey/leadSessionId/nativeTeamId/版本，不保存 roster/tasks。显式 contribution 5 端点同源编解码，Host/Client effect 注册与释放。 |
| 锁定 `xmanrui/dsh-im@4645cf7` 的公开 `dshIm` v1 | 只同步检测 contractVersion/inboundVersion 及公开方法，无读取凭据/历史/账号的诊断调用。真实隔离服务零账号；fake 公共合同验证零调用及恒定禁用。consumer 注册/注销无 fallback、去重、thread 回复和 checked 实际发送仍 FAIL/NOT_RUN，未用 mock 结果覆盖 U01。 |

全量检查通过 47 文件 / 601 测试、strict/build/lint；真实 Host/冷恢复与 Chromium 亮暗尝试另见验收收据。浏览器受系统 MachPort 权限限制的 FAIL 不以 DOM/token 测试替代；真实平台收发与 OS 通知仍未验证/不支持。


## U02–U03：产品连接器桥与通知中心（2026-10-24）

实现/命令/逐项结果见 [U02–U03 验收](acceptance/P34-U02-03.md)。参考树和 CLI 仍锁定 rc.2。正式包新增 MCP、credentials 根入口的精确 dev + 兼容 peer；不从私有 connection/transport 导入，不改变 engines/exports/发布版本。

| 公开入口 / 只读源码 | 本轮实际组合与边界 |
| --- | --- |
| `dsh-mcp-client` 根 `Config/apply`；`packages/mcp/mcp-client/src/index.ts:154-203` | Agent 私有无 config 参数 child closure；只在内存解析 credentials。真实 HTTP 两 Bot scope、认证/发现失败、stdio 原生 reconnect、PID 清理通过；fiber.config、preset/DTO/log/sidecar/lib sentinel 检查通过。不是第三方 MCP 永不泄密保证。 |
| `dsh-credentials` 根 `credentialRef` / `credentials.resolve` / `credentials/reference-updated` | provider-managed 变化标 pending；显式空闲 apply 后重新 resolve，不缓存到配置。环境仍是 CLI launch snapshot，需重启 Host。Client 复用宿主已挂载的 `remote.credentials.describe/set`：describe 只返回配置/可写状态，密码只写入原生提供者；不预填，提交或离页清空，不新增秘密 Remote。缺 namespace 时引导原生设置。 |
| Agent `runMaintenance` / `agent/status`；`core/agent/src/runtime-types.ts:185-202,280` | 真实 turn busy 时保留 pending，维护抢占失败仍 pending；关闭旧 child 后才挂新 child。新旧代际和凭据事件使用本桥 epoch 防迟到成功覆盖。主会话 ID、native Session/Inbox 保持权威。 |
| `tools.guard`；`core/tools/src/index.ts:724-732,1133-1151` | 对本桥真正拥有的工具先拒新调用，禁止 namespace 冲突时误伤宿主继承工具。已发到远端的请求不能承诺撤销；guard 和 child 归 Agent effect/preset/Host 联合停止。 |
| `tools/pre-execute` / `tools/result`、`defineTool` / `approval` | bot_notify 从当前 Agent 固定 BotKey，先持久中心意图。原生 ask 展示目标/文本/scope；execute 再核对 birthday、revision、targetDigest。真实拒绝与 native never 策略、审批中改策略均无发送。preapproved 只能由用户 Remote 管理显式确认。 |
| `setApprovalPolicy`；`interaction/user-approval/src/index.ts:99-106` | 仅新增测试的公开原生策略 helper，产品不切换或抬高 child policy。never 测试为原生 ToolRuntime/ApprovalService + Agent fixture，不冒充真实平台子代理发送。 |
| `defineDomain/domainTable` 根入口 | 两个独立 v1 sidecar；表名必须匹配 `/^[a-z][a-z0-9_]*$/`，因此采用 legacy_imports/read_state。intent 同行额度/状态为权威，无跨表/跨 Host 事务。JSON 重开恢复 sending→unknown，绝不自动重发。 |
| `TypertRemoteService` / `Remote` / `createTypertRemoteInfo` / Gateway | 新 contribution 有 8 个同源严格端点，connectors 与 notifications 使用各自 service/namespace。真实 Gateway 暴露跨 namespace 绑定不合法并已修正；Client await mount，显式 encode/decode，不增加自动 generator。 |
| 原生 `Inbox.append/remove` / `sessions.flush`；`core/agent/src/runtime-types.ts:48-88` | 完整 Host 检查外推 suppressed 不影响已有 native Inbox，flush=true。产品普通通知只写中心，不为通知再唤醒模型；未开启任意 schedule 回复的自动外推。 |

新增 `NotificationPort` 是本包 Host 能力，不是 DSH API；通过 `notifications.attachPort(port, ownerContext)` 纳入适配器 effect。生产 adapter 缺席时外推 unavailable，U04 才接 dsh-im。fake 端口仅证明策略/AbortSignal/状态，不代表平台受理或已读。

完整 `scripts/pnpm check` 通过 44 文件 / 589 测试；真实首次/冷 Web Host、2 次 loopback 模型和 0 次真实模型请求另有运行收据。浏览器因 `bootstrap_check_in Permission denied (1100)` 启动失败，亮暗实际 UI 为 FAIL；DOM/主题 token 检查不替代该验收。OS 桌面通知无公开 API，继续禁用。


## U01：P34 公开 API 组合实测（2026-10-24）

探针仅在 `spikes/p34/`，不接入正式包。逐 gate、重跑命令和失败记录见 [U01 报告](spikes/P34-api-spike.md)。参考树仍为锁定 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`；CLI 为同版。以下是实际隔离 Web Host / loopback 结果，不代表桌面或真实平台验收。

| 公开入口 / 源码（H 为只读参考树） | 实测与后续约束 |
| --- | --- |
| `dsh-mcp-client` 根 `Config/apply`；H `packages/mcp/mcp-client/src/index.ts:154-203` | 两 Bot Agent 下同名 github namespace 可隔离；无 config 参数的 child closure 中调用 apply，sentinel 不进入 preset 文档、fiber.config、真实 TypertGateway.invoke 的 Bot DTO 或 Host 日志。busy 时维护拒绝；idle 关闭旧 child、resolve、再挂新 child；guard 撤权立即拒绝调用。发现/认证失败无残留工具；stdio 退出后 native reconnect，再 dispose 验证 PID 退出。无需 deep import。 |
| `dsh-credentials` 根 `credentialRef` / `credentials.resolve/describe/set/unset`；H `packages/credentials/credentials-local/src/index.ts:557-570,624-649`；`packages/util/launch-environment/src/index.ts:78-100,114-116` | **设计修正**：CLI process 环境来自启动快照，后改 process.env 不会改变 resolve。真正热轮换使用 provider-managed set，观察 reference-updated 后维护窗口重建。探针只写运行目录的合成凭据文件，并 unset 清理；不读实际用户凭据。 |
| `agents.create/resume` / `AgentHandle.dispose` / `agentPresets.mount` / scoped `agent/pre-step`；H `packages/core/agent/src/index.ts:51-162`、`packages/core/agent/src/runtime-types.ts:309-320` | owned 群根创建、flush、第二个 Host 冷恢复通过。原生 prompt accepted 后 blocked，零根 assistant、零根模型请求。重复 resume 与 Controller 抢先拥有时拒绝；声明 preset 的 contribution fiber 真正卸载后，既有 Controller 根保留 guard。不能把裸 Agent 当 owned handle。 |
| `createUserMessage` / `Session.append('user/message', …, {surfaceOp:'append'})` / `sessions.flush` | 本地输入及 producer 来源的成员回文均持久化、冷恢复；不伪造根 assistant。这里只验证原生日志，不验证群 renderer。 |
| `subagents.getProvider/startActivation` + `delivery:'caller'`；H `packages/subagent/subagent/src/types.ts:118-182,252-277` | 两个真实 Bot preset 分别成功输出并持久回文；无 Bot.model 的 beta 使用显式 currentSelection 路由成功；caller 不唤醒根，主会话 ID 不变。仍复用 native 取消/权限/生命周期。 |
| `dsh-experimental-agent-team` 根 default `TeamService`；H `packages/experimental/agent-team/src/index.ts:111-219` | roster、同 revision 两 claimant 仅一成功、依赖阻塞/完成及第二 Host 恢复通过。teammate header 继承 lead preset；SpawnTeammateRequest 无 agentPreset，不得冒充另一个 Bot。 |
| 锁定 `xmanrui/dsh-im@4645cf7` 的公开根与 `dshIm` service | 源码 archive SHA256 校验、tarball 安装、服务方法加载通过；**消费者注册/撤销后无 fallback 的运行 gate FAIL / NOT_RUN**。无公开 fake 平台注入证据，不导入其私有工厂；U04 依赖的入站/checked 平台投递暂不可启用，U03 本地通知不受阻。 |
| `@modelcontextprotocol/server-memory@2026.7.4` 公开 CLI + SDK Client/stdio | 两个真实 server 共享文件并发 create_entities 均确认成功，但 round 0 丢一条；串行写、分文件隔离、冷重开和四个 PID 退出通过。此 PASS 是“风险复现”，绝非多写者安全证明；U10 必须具备跨主/子 Agent/代际的单写者所有权。 |

依赖只加到 private spike：DSH 精确 rc.2、Cordis 4.0.5、Schemastery 3.18.5；实际 Host runtime service imports 同时声明兼容 peer。正式产品依赖/exports/版本均未改变。最终产品回归仍为 41 文件 / 555 测试通过；IM gate 使完整 spike 命令按约定退出 1，不能报告全 gate PASS。

## R06：12 色与 6 种鲸鱼头像（2026-10-21）

**r2 返工**：无新增 DSH API；造型图块增大、单色特征加粗，截图按选择器与关闭模态框后的列表分开，测色限定各自 DOM 范围。见 [r2 报告](acceptance/P2-R06-r2.md)。

**r1 返工**：主页面把会话导航与 Bot 写入的 busy 分开；复用现有 `startBot` / `openSession` 的 AbortSignal 门禁，编辑时取消迟到导航，Host 已受理的创建/迁移不回滚。无需新增 DSH API。原生会话列表的加载相位为 `pending`（只读 `packages/api/session-controller/src/client/sessions/manager.ts:42`）。根因、验证和边界见 [r1 报告](acceptance/P2-R06-r1.md)。

无新增 DSH API、依赖、Remote 方法或存储领域版本。只读核对参考源码仍为 `dsh-v0.2.1-rc.2`；原生 `packages/client/ui-primitives/src/FishLogo.tsx:9-30` 只有单轮廓、size/className/currentColor，没有造型选择器。本包沿用现有共享 `WhaleGlyph`，保留经典路径；五种派生造型使用本次原创共用轮廓和几何装饰，不导入宿主内部实现或第三方素材。

决策：扩展既有 Bot 字段和编辑器，不增加头像服务。理由：原生图标可复用，但没有可直接包装的造型/配色选择器。`avatarVariant` 可选，允许 classic/glasses/spout/baby/hat/sleeping/auto；缺省值在渲染时解释为 classic，旧 Zod 记录仍原样解析，显式 null 清空。`avatarColor` 保留旧四个 alias ID，追加八个受限配色 ID，通过已有四个 alias 和 label-primary 做 sRGB 混合。Remote codec 从 shared schema 生成；`bot_manage` 的显式输入/输出枚举同步。

亮暗基线沿用已核实的主题 fixture，12 色非文本图形最小对比度亮色 **3.964:1**、暗色 **7.512:1**。这是锁定主题的计算验证，不是实拍或自定义主题保证。键盘/中英 accessible-name 使用 DOM 测试；真实浏览器 `--v022-avatar` 启动被系统权限拒绝，详见 [R06 验收](acceptance/P2-R06.md)。


## R05：0.2.2 单主会话与原生标题固定（2026-10-21）

主会话身份 sidecar `dsh_bot_main_session` v1、`dshBot/openConversation`、可选 `status.mainSessionId` 是本包新增契约。迁移仅元数据/投影，普通旧历史原样保留；原生 Session、标题、Inbox 与子代理继续复用。实施与限制见 [架构 R05](architecture.md#r05持久主会话与共享-bots-工作区)，实际命令见 [P2 验收](acceptance/P2.md)。

| API / 来源（只读 rc.2） | 核实结论与用法 |
| --- | --- |
| `sessionController.rename`；`packages/api/session-controller/src/commands.ts:199-207` | 通过公开 resolveAgent 取得 Session，再调用原生标题服务；本包无内部导入。 |
| `sessionTitle.rename`；`packages/session/session-title/src/index.ts:395-421,508-510` | 写 `source.kind=user`，取消已有自动生成，后续 human prompt 不再自动命名。无需关闭全局 title LLM。原生明确 refresh 会解锁，因此本包还监听主会话 title 事件合并恢复 Bot 名，自己的 rename 不递归。 |
| `sessionController.list` / `SessionSummary`；`packages/api/session-controller/src/types.ts:178-194,267-274` | 迁移按 updatedAt 降序；过滤 parentSessionId / origin，检查 preset projection。没有顶层 title，断言用公开 projections.values.title。 |
| `sessionPersistence.stat`；`packages/session/session-persistence/src/index.ts:46-55,196` | 返回轻量 header，无需完整 event log。主会话迁移与 native schedule 冷归属均使用它，移除旧 inspect().meta 用法。新增该包精确 rc.2 dev，仅类型导入，无新增 Host runtime peer。 |
| `sessionController.create/prompt` | 新主会话只在共享 Bots workspace 创建；迁移保持原 cwd。显式立即运行 mode=queue 投递主会话，delivered 表示原生 accepted=true，不能等同模型完成。 |
| `schedule_create`；`packages/schedule/tool-schedule/src/index.ts:483` | 原生绑定 agent.session.id；本包 pre-execute 校验 Bot 生日和主会话，拒绝旧多会话/子会话创建，直接复用原生工具。 |
| Client SessionSummary；`packages/api/session-controller/src/client/sessions/service.ts:27-36` | Client 的父标记实际名 parentId，Host 是 parentSessionId，header 是 parentSession。三层各按公开类型过滤。 |
| `@deepseek-ai/dsh-session-title` 根入口 | 新增精确 rc.2 dev 供真实标题服务单测；产品无此包 runtime import。测试 Session/投影/标题/JSON store 为真实公开实现，SessionController 和部分 metadata 生命周期是测试替身，不宣称完整冷 Host 重启。 |

真实 tarball profile 使用原生 SessionController、schedule、ToolRuntime、spawn、安装后的 Client 和 loopback mock。测试覆盖迁移、重开、并发打开、删除后重建、Bot 生日隔离、标题固定/改名/修复、立即运行主会话幂等投递和子代理隐藏；浏览器亮暗单独列结果。R04 的“新建立即运行会话”证据属于历史行为，不能作为 0.2.2 验收。


## R04：0.2.1 tarball 集成（2026-10-20）

统一 `scripts/p2-e2e` 改为原生定时聚合/显式立即运行/原生 spawn，按全新 profile 安装 0.2.1 包，核对安装文件与 tarball 字节一致；正式 Client factory 也读取已安装文件。旧 0.2.0 格式夹具在 Host 启动前写入，运行后检查只读保留。结果与浏览器失败边界见 [P2 验收](acceptance/P2.md)。没有新增依赖、Remote 端点或持久领域版本。

继续使用公开 `sessionController.rename` / `session/rename` 设置内容标题，去掉固定英文操作标签；通过公开 `session/projections` 的 `values.title` 核对实际持久标题。`session/list` 的 SessionSummary 没有顶层 title，不可用于该断言；源码 `packages/api/session-controller/src/{index,types}.ts`（锁定 rc.2）。此修改采用原生标题惯例，不把 UI locale 引入执行协议。

## R03：原生 spawn 委派（2026-10-20）

普通 `bot_delegate` 改为原生子代理，删除本包 delegate reporter/runtime、delegate RunRequest 与 outbox 写入；RunExecutor 仅服务显式 manual。设计和差异取舍见 [架构 R03](architecture.md#r03原生-bot-委派)，实测见 [R03 验收](acceptance/P2-R03.md)。

| 公开 API / 包 | 用法与核实边界 |
| --- | --- |
| `@deepseek-ai/dsh-subagent` `getProvider/startActivation` | 类型使用既有 rc.2 dev 包，无 runtime import/新增 peer。`index.ts:269-283,573`；核实 spawn 为本地、不继承父上下文、支持 agentPreset/depthLimit。`request={parent,agentPreset,prompt}`，`delivery=parent`；不从内部实现导入。 |
| `SubagentActivation.childId/result/dispose` | 原生 `result` 在 teardown 和 notification 后 settled；工具立即返回 accepted + childId。ctx.effect 所有权覆盖启动、取消、卸载；自然完成由原生 manager 清理。无本包 sessionController.create 或 followup。 |
| 原生 `subagent-settled`、`agent-message` 来源 | `subagent/src/continuation-messages.ts`；跳过原生 ambient context 后的最新 user/message 的 source 非 user 时本包委派拒绝，不回溯更早人工输入。native manager 对在线同对象父 Agent idle→queue/busy→steer；不支持父冷恢复补发。 |
| 原生 child preset/权限 | `child-agent.ts:135-153,220-277`；选定 preset，origin=subagent、parentSession、delegationDepth、isSeeded=false；原生 approvalPolicy=never，ask 拒绝。没有绕过或自动批准机制。 |
| `dshBots.get/status`、`tools/pre-execute` | 沿用公开注册表与审批；保存批准目标的 createdAt/updatedAt，执行前重验父身份、目标身份和 preset 可用性。同 live invocation 去重，不宣称跨重启幂等。 |

历史 T15/R02 的普通会话委派与持久报告证据不再代表当前实现；本轮测试已改用原生 spawn/settlement。


## R02：原生定时聚合、显式执行与旧库兼容（2026-10-20）

按批准方案 A，移除 Dispatcher、规则计算、单 Host 锁、额度/并发/补跑及 `dshBot.routine/*`。P1 Remote 不变；新的 automation contribution 只有 nativeSchedule aggregate/deleteLegacy/runNow、run list/get、automation status 六个端点。详见 [R02 验收](acceptance/P2-R02.md) 与[当前架构](architecture.md#r02原生定时与-bots-聚合)。

| 公开 API / 包 | 使用与核实边界 |
| --- | --- |
| `@deepseek-ai/dsh-schedule` 的 `catalog/history/update/delete` | Host 用 catalog 可靠归属，Client 直接读写同一个原生任务；`schedule/src/index.ts:285-374`。history 是 Inbox 持久投递而非模型完成；limit 1–100，`nextBefore` 为 message cursor；原生删除同时移除该任务投递历史，不撤回已入 Inbox 的消息 |
| `@deepseek-ai/dsh-schedule/remote` | 浏览器安全的生成 contribution，仅依赖 Zod 和公开 remote-info；在构建 allowlist 精确加入此文件。标准 Web 已挂载 namespace，先 `ctx.get('remote.schedule')` 判断，仅缺失时 mount，避免重复注册；本包卸载不清理宿主已有 namespace。Host 无 schedule runtime import，移除 schedule peer，保留精确 rc.2 dev |
| `ScheduleUpdateRequest.expected` | 必须是完整 **ScheduleRecord**；catalog 的 sessionId/status/lastDelivery 与本包映射字段要剔除，否则原生返回 invalid_rule。未改规则时省略 change；冲突保留编辑草稿。真实 Host 和 Client 验证标题编辑不改相位、外部编辑可见 |
| `schedule/changed`、`remote.$on`、`connection/reset` | 原生写入成功后发 changed；`schedule/src/index.ts:382-389`；Host assembly 转发白名单 `api/remotes/src/remote-events.ts:53`。新增 `@deepseek-ai/dsh-api-remotes@0.2.1-rc.2` 仅作 dev/type import，提供官方转发事件声明。真实推送需要 Connection `interactions=answer`，一条 Connection 只挂一个 Gateway generation source |
| Cordis `ctx.get` / `ctx.effect` | 正式 Client 动态 mount 的 `remote.schedule` 通过 get 访问；直接 `ctx.remote.schedule` 在未声明 inject 的插件 scope 抛错。本轮实际 profile 暴露并修复，真实 Client/Gateway 重跑通过。聚合服务、事件、领域句柄、RunExecutor 和 reporter 均有卸载清理 |
| `sessionController.inspect().meta`、本包 `getBotBinding` | `api/session-controller/src/index.ts:253-267`；存量冷会话仅按真实 agentPreset 与 registry status 的实际 presetId 匹配，并检查会话创建时间/Bot createdAt、排除子会话。活跃 Agent 优先 exact 本包绑定，无绑定不回退 header。不同 Bot 生日不重绑；标题不参与 |
| `storageDomain.open` + `domainTable(z.unknown())` | 旧 dsh_bot_automation v1 只读宽松加载，再逐 Routine 校验，坏行跳过；整文件损坏/版本不符不阻止 P1 启动。显式删除仅删指定 Routine，保留 unknown runs/control。真实 JSON 测试逐字比较读取前后文件、验证坏 JSON 保留。新映射域为 dsh_bot_native_schedule v1；显式执行域 dsh_bot_executions v1 |
| 既有 `RunExecutor` / SessionController / WorkspaceRegistry | 用户确认完整 prompt 后 operationId 幂等受理，在共享 Bots 工作区新建一次普通会话，沿用已核实的完成屏障和 flush；不改原生 schedule。没有自建调度或额度。queued 重启取消，进行中未确认链标 recovery_needed，不自动重放 |

真实隔离 Web Host + loopback mock 验证：模型调用原生工具→every60 实际到期投递→原生 history→同操作并发手动请求仅一个新会话→正式 Client 原生编辑/外部 changed 刷新/删除→相同数据引用不变。4 个 mock 请求 completed，真实请求 0；证据 `dist/screenshots/2026-10-21T03-21-08.948Z-58788/{native-seed,native-client,summary}.json`。独立 JSON/Agent 测试覆盖 cold header 回填、sidecar 重开、Bot 同 ID 重建隔离与旧数据坏行/坏文件；这些不冒充完整 Host 冷恢复测试。

`--v021` Chromium 在 `bootstrap_check_in ... MachPortRendezvousServer: Permission denied (1100)` 启动失败，亮暗截图 **FAIL**，未生成目标 PNG；保留失败证据供编排方按同命令复跑。中英 DOM 测试、主题 token 静态检查不替代真实浏览器。


## R01：原生定时工具入口（2026-10-20）

按 [P2 复用决策 §10](P2-reuse-proposal.md#10-用户批准的决策2026-10-20) 的方案 A，删除正式 `automation/tools.ts` 及 `routine_*` 注册/描述，Bot 仅提示 `Use schedule_* for scheduled tasks.`（中英 locale 同键）。现有 Dispatcher、Remote/UI、旧 automation 域与委派不在本次删除范围。完整命令和验收见 [R01](acceptance/P2-R01.md)。

| 公开 API / 包 | 本次用法、源码核实与边界 |
| --- | --- |
| `@deepseek-ai/dsh-tool-schedule` 根入口 | 使用宿主原生 preset 插件，提供 `schedule_create/list/update/delete`；锁定源码 `packages/schedule/tool-schedule/src/index.ts:443-452`，工具只在 `schedule` 服务可用时注册。新增精确 rc.2 **devDependency 供真实测试使用**；产品只有 Loader 行，不新增 runtime import/peer |
| `agentPresets.readDocument` / `PresetDefinition.plugins` | Composer 保留原生行；缺失时补入（minimal 默认没有），嵌套已有行不重复、冲突 id 明确拒绝。standard 来源 `packages/bundle/web-app/presets/standard.patch.yml:35-36`；生产继续读取运行宿主模板，保留已有 disabled 配置，不强制启用被用户关闭的原生服务 |
| `tools.restrict` / `schemas` / `execute` | rc.2 对未知 deny 名拒绝（`packages/core/tools/src/index.ts:1105-1125`）。仅过滤已退役五名；未知 `routine_typo` 仍失败，`schedule_delete` 显式 deny 继续隐藏并拒绝分发，不改写存储 |
| `systemPrompt.section` / `ctx.effect` | 新增 Agent 所属 `dsh-bot:schedule` 简短提示，沿用 Bot 双 owner 清理；完整人设覆盖其他 section 的既有语义不变 |

运行证据使用公开 AgentLoop testkit、真实 Agent 创建、ToolRuntime、原生 tool-schedule/ScheduleService 与真实 JSON schedule 存储；验证两种 Bot 模板目录、旧 deny、新原生 deny、普通会话隔离、原生 CRUD 与卸载。SessionController resolver 和 sessionPersistence 是测试替身，其他模板插件不挂载；**不把这组运行测试计为完整 Loader profile、到期投递、冷恢复、桌面 UI 或模型工具选择验收**。本次新增测试无模型调用，完整 check 的既有模型测试仍使用 loopback mock。

## T17：0.2.0 集成、timer 边界与 tarball 验证（2026-10-20）

历史命令、证据和决策汇总见 [T17 验收](acceptance/P2-T17.md)；当前版本见 [P2](acceptance/P2.md)。当时新增 `scripts/p2-e2e` 串行安装本次 tarball 到新 profile，复跑 T14 Dispatcher、T15 delegate，并增加真实 Host 的默认并发 2、每日 20、24h 时间夹具、卸载重装/独立后端恢复。DSH_HOME 仍严格为仓库 `.dsh-dev`；不清空旧 profile 或证据。只启用 loopback mock provider，没有新公开 DSH API、依赖或领域版本变更。

集成首轮实等 every60 时 80 秒无 Run、无 mock 请求；确定性测试复现 timer 扫描快照尚未到期、重设 timer 时已经到期的竞态。Dispatcher 记录最后扫描时刻：仅对该快照之后刚跨过的到期点安排零延迟唤醒；已经扫描且写入失败的旧到期点继续等周期兜底，避免热循环。旧实现对应回归测试 FAIL，修复后通过；真实每 60 秒场景另由 e2e 验证，不能用回归测试代替。

运行历史继承面板 13px 正文，标题 15px，与 Routine 卡片层级一致；every 展示优先完整天/小时/分钟，其余精确秒（90 秒不四舍五入），中英同键并区分英文单复数。不改变时间规则、表单输入或 Host 语义。本轮截图按 T17 要求由编排方复跑，未宣称亮暗视觉通过。

## T16：Routine 工具、Bots 页内 UI 与正式 Client 接入（2026-10-20）

**r2 返工（2026-10-20）**：编排方证据 `dist/screenshots/2026-10-20T15-42-56.332Z-2202/summary.json` 显示 `New routine → getByLabel('Schedule rule', exact)` 超时。RoutineEditor 使用原生 select，但原嵌套 label 把 option 文本并入标签；现改为独立 label + React useId / htmlFor / id。Modal 原有 aria-labelledby 标题命名有效，未改为宽松选择器。新增精确锁定的测试依赖 `@testing-library/dom@10.4.2`，通过实际 accessible-name 算法及精确标签查询覆盖中英新建/编辑、所有控件和五类规则。

r2 的 `--v020` 改为公开 Remote 创建暂停的 every3600 示例→两次 runNow 实际完成→启用以显示未来 nextRunAt，再打开 UI 拍摄详情/总览与导航历史；不再用表单作为截图种子入口，**不再声称截图命令验证了 UI CRUD 或 every60 调度**。`--v020-seed-only` 使用完全相同种子函数，隔离 Host 实测 2 个 mock completed、真实请求 0；没有截图。原 `--v020-host-only` 保留独立 every60 验证。截图失败时在 context 关闭前取证，并记录具体 routine 步骤。最终 r2 `scripts/pnpm check` 为 638/638；浏览器画面交由编排方复跑，详见验收报告第 8 节。以下 T16 表格与初轮运行证据仍适用，但旧截图流程由本段取代。

新增 `routine_create/list/update/delete/run_now`；复用 T12–T15 服务与独立 automation 契约，不新增 Host Remote 端点、依赖、package export 或领域版本。完整证据、失败与复跑命令见 [T16 验收](acceptance/P2-T16.md)。

| 公开入口 | 本次用法与验证边界 |
| --- | --- |
| `defineTool` / `tools.register` / `tools/pre-execute` | 五个工具在 Bot Agent scope 注册，四个写操作强制 ask，保留上游 deny/cancel；审批双语展示完整目标、规则、task 与 patch。`routine_list` 无额外审批。使用真实 ToolRuntime + ApprovalService + JSON 后端验证拒绝无写入/无 Run、CAS 冲突、deny 与卸载。参考锁定源码 `packages/core/tools/src/index.ts:154,1071,1514`；没有通过私有 API 绕过审批 |
| Cordis `ctx.get` / `ctx.effect` | Agent 回调取本包 Host stores/registry/dispatcher；验证当前 Bot createdAt 与绑定身份。复用 `assertInteractiveOrigin`，后台和回报轮次禁止写 Routine。定义/门禁/Client mount/catalog 都随 owner 清理 |
| Client `remote.$mount(AUTOMATION_REMOTE)` | 与 P1 contribution 分别 await 挂载并 effect 注销。正式 Client factory 经 Gateway 调用既有 `dshBot.routine/*`、`dshBot.run/*`、`dshBot.automation/status`；实测 create→every60→pause→同 operationId 并发 runNow 仅一个 Run→edit/conflict→delete/history |
| 公开 `main` slot + `useSyncExternalStore` | 保留现有 Bots 页面，在顶部加定时任务页签、Bot 详情加定时任务区；不增加侧栏入口，不导入原生 schedule 内部组件。沿用既有共享 polling scheduler 的可见性、reset、失效与 epoch 丢弃旧读逻辑，Client 不执行调度 |
| 既有 `uiWorkspace.openSession` | 历史走已有页面 onOpenSession（包含 activity markRead best effort），只对有 workspace 且已进入创建步骤的 Run 提供链接；未创建或丢失会话仍可能由宿主拒绝，界面显示导航失败。正式 factory 回调及组件交互实测；浏览器原生会话展示未测 |

规则表单提交本包 schema，由 Host `prepareRule` 调公开 schedule 工厂最终校验。单次时间要求显式 ISO 偏移或 Z；daily/weekly 将 `HH:mm` 补为 `HH:mm:ss`；every ≥ 60、weekly ISO 1–7、cron 五字段。更新携带原 revision，失败保留草稿；runNow 在同一确认框内重试沿用 operationId，返回受理提示，不宣称已成功。

上次状态按每 Routine 最新 Run 查询，**不使用仅代表 scheduled cursor 的 lastRunId 作为手动运行状态**。历史按 `{requestedAt,id}` 分页；新增 Client Config `routineHistoryPageSize=50`（1–200），仍使用现有轮询参数。中英 locale 同键，样式仅使用锁定主题 token。

`--v020` 目标为中英×亮暗×总览/详情共 8 张图，中文发布 `.codex/screens/v020-{light,dark}.png` 及 detail 变体，截图前必须有真实已完成 Routine 和历史。当前 Chromium 在沙箱启动阶段被 MachPort 权限拒绝；**亮暗可读性、真实浏览器操作、PNG 输出均 FAIL**。独立 `--v020-host-only` 的正式 Client/Gateway/Host + loopback mock 通过，不产生截图，也不替代浏览器验收。未修改桌面应用、全局 profile 或版本；0.2.0 打包留 T17。


## T15：委派工具、身份门禁与持久回报（2026-10-20）

正式 `bot_delegate` 接入既有 Dispatcher/RunExecutor；独立 reporter 在终态后向原会话 followup 一次。详见 [T15 验收](acceptance/P2-T15.md)，包含静态/单元/真实 Web Host 分层、失败记录和决策。未新增依赖或 Loader/package exports，P1 与 automation 领域仍各为 v1。

| 公开入口 | 用法 / 已验证边界 |
| --- | --- |
| `defineTool`、`tools/pre-execute`、`ToolExecution.callId/rootCallId/agent` | Agent scope 工具，原生 ask 审批双语展示目标/完整 task；身份来自本包 binding（botId + createdAt），禁止模型传来源。操作 UUID 按 session + 持久 step seq + rootCallId/callId 派生，避免 provider 跨 step 复用 callId 被误去重。锁定源码 `core/tools/src/index.ts:327-398`；真实 Host 模型发起工具及审批单测 |
| Cordis `ctx.get`、`ctx.effect` | Agent 回调不能直接访问未 inject 的 Host service；用公开 get 查 automation/registry。注册、门禁、订阅、关闭均有 disposer；显式 dispatcher → reporter → executor → stores 的 join。真实 scope 错误在 e2e 暴露并修正 |
| Session `header.parentSession/origin/delegationDepth`、`snapshotEvents()` | Run 历史身份禁止后台再委派/改 Routine；子会话/fork 保守禁止；report user/message 后至下一普通 user 输入禁止启动新链。源码 `core/session/src/types.ts:95-123`。后台与 report 轮次真实模型拒绝；Routine 写工具为运行时单测 |
| `createUserMessage`、MessageId、自有 `dsh-bot-delegate` source | 固定完整 message 持久保存；摘要取执行器最终回复，先沿用 credential 筛查后限长。新增 Config `automation.delegateReportMaxChars=4000`（1–8000），消息仍受 8192 schema 上限。真实目标合成秘密被整段筛成 `[redacted]` |
| `agent.followup`、Inbox `nextTurn/nextStep`、`agent/inbox/spliced`、`sessions.flush` | `followup` 排 next-turn+wake，需核对本次新增 splice 的完整消息及 flush=true 后才写 sent。立即 claim 与 user/message 提交之间有短暂空窗，不能只按当前 Inbox 是否为空判定投递失败。源码 `core/agent/src/runtime-types.ts:204-241`、`src/types.ts:96-101`、`core/agent-loop/src/agent.ts:154-165`、`src/inbox.ts:109-118,227-240`。sent 是持久投递收据，不保证模型处理；真实 e2e 另等 completed |
| `sessionController.inspect/resolveAgent`、`workspaceRegistry.archivedSessionIds` | 不创建替代原会话，不取消归档；检查原 Bot createdAt/Agent binding，冷恢复原 ID 后再核查。源码 `api/session-controller/src/index.ts:243-267`、`api/session-controller/src/agent.ts:200-242`、`workspace/workspace/src/index.ts:339-365`。三进程 profile 验证冷恢复只投一次、归档/不存在/同 ID 新 Bot blocked |

回报投递前先写 attempts=1；重启发现完整 user/message 则补 sent，只有 pending Inbox 或无确定证据则 blocked，不补发/强制唤醒。未尝试 pending 可以正常恢复投递。blocked 没有自动重试，T15 不提供手动重试 Remote。单元覆盖崩溃窗口持久状态与 flush=false；未进行逐窗口 SIGKILL。

工具立即返回的是排队受理与预分配 sessionId，实际 create ID 以 Run 为准。排队后参与 Bot 身份失效取消且不扣额度。归档/冷恢复、每 Run 固定 messageId 和主模型闭环已在真实隔离 Host + loopback mock 验证；真实请求 0，没有桌面 UI 或亮暗截图。本轮不是桌面版本升级或 T17 打包验收。


## T14：Host Dispatcher、规则游标与统一准入（2026-10-20）

在 T13 的单 Host lease、automation 域恢复和 RunExecutor 之后启动 Dispatcher。只由 Host 定时：最早 `nextRunAt` timer + 默认 60000ms 周期检查，存储成功写入触发失效通知，执行完成再唤醒队列。卸载先停 Dispatcher 的 timer/订阅及扫描，再关闭执行器、存储并释放 lease。验收、命令和证据见 [T14 报告](acceptance/P2-T14.md)。

| 公开入口 | 用法 / 证据边界 |
| --- | --- |
| `@deepseek-ai/dsh-schedule` 根入口 `resolveRecurringOccurrence` | 对已到期的 every/daily/weekly/cron，以持久 `nextRunAt` 作为 `scheduledAt` 构造公开 record；读取 `occurrenceAt` / `nextScheduledAt`，不枚举历史积压。一次性 at 消费持久绝对时间后耗尽。参考锁定源码 `packages/schedule/schedule/src/index.ts:25-61`、`src/domain.ts:129-135,791-819,909-917,945-955,1104-1141`。虚拟时钟覆盖五类、DST 缺失/重复、cron DOM/DOW OR、跨年及正反跳变 |
| Cordis `ctx.effect` / `ctx.provide` | 新增内部 `dshBotDispatcher`；所有 timer/本地订阅由 effect 清理，沿用所有权及 stores.beforeClose 的显式关闭链。没有新增 Loader export、依赖或原生 schedule 服务写入 |
| Typert `@Remote` / strict contribution | 独立 automation 增至 **9 个端点**，新增 `dshBot.routine/runNow(id, operationId)`，UUID operationId 去重；返回持久受理 Run，不保证已经开始或成功。无 dispatcher 时拒绝。原有 P1 19 端点不变；Client Gateway codec/幂等往返测试及真实 Host 服务调用验证 |
| 既有公开 SessionController / WorkspaceRegistry / session events | Dispatcher 只调用同一 RunExecutor；每次新建 Bots 工作区会话、prompt、完成屏障、flush 均沿用 T13。T14 profile 驱动实等 every60、暂停后 run_now、正常关闭/冷启动补跑及 SIGSTOP/SIGCONT 恢复；不是桌面 UI 或实际 macOS 休眠验收 |

补跑每个 Routine 最多最近一次；默认 24h（含边界），更旧记 `skipped/catch_up_expired`。暂停恢复由 RoutineService 重建未来游标，过期 at 不平移；run_now 不改锚点/游标。`misfirePolicy=skip` 将跨过多个 occurrence 或迟到至少一个 sweep 周期视作漏跑，容忍一个周期内的普通 timer 延迟。时间规则仍由公开 schedule 函数决定。

全局默认并发 2、每 Bot 每日 20、队列 64，沿用既有 Config。所有 trigger 都走同一 `RunService.reserve`；失败不返额度，quotaTimeZone 首次默认系统时区并持久固定，日桶回退仍拒绝。自动消费将额度耗尽的未收费 Run 记 `skipped/quota`，不阻塞其它 Bot；时钟/所有权/存储失败记 Host 日志，保留权威记录并等待兜底扫描，不自动重放 recovery_needed。

同 Routine 活动时到期立即记 `skipped/overlap`。全局满载时保留持久有界队列；同 Routine 的旧 scheduled queued 项记 `superseded`，只留下最新一次；scheduled 满队列记 `queue_full`，manual/delegate 满队列报 busy。先落旧项终态再写替代项，故障时宁可暂缺工作，不保留两个可执行替代项。内部 pending 视图不使用历史分页上限，以免超过 200 条历史后遗漏活动 slot。无外部依赖或版本变化。

## T13：RunExecutor、Host 所有权与完成屏障（2026-10-20）

产品 Host 现在在取得 `$DSH_HOME/dsh-bot/automation/lock` 所有权后启动 P1 注册表及独立 automation 域，提供内部 `dshBotExecutor` / `dshBotAutomationStores` 服务。没有 Dispatcher、自动排队消费、委派工具或回报投递；这些仍属 T14/T15。完整命令、证据、失败修正及验收见 [T13 报告](acceptance/P2-T13.md)。

| 公开入口 | 本轮用法 / 已验证边界 |
| --- | --- |
| `sessionController.create/inspect/rename/prompt`；`sessionController` 根类型 | 先 reservation，再 `ensureBotsWorkspace()`；按 P1 `status()` 返回的健康 preset 创建普通会话，保存 **实际返回** sessionId，核对 cwd/preset/WorkspaceRegistry 成员后改标题。create 的 sessionId 不是强幂等保证，未知恢复不再次 create/prompt。源码 `packages/api/session-controller/src/index.ts:243-267,301,431,462`；`src/agent.ts:458-505` |
| `Agent.session.snapshotEvents/status/inbox/cancel/whenIdle`、`sessions.flush` | 用 user/message.source.rpcId 关联 requestId，向前寻找 turn/start（step/start 可以更早），至少进入一步、关联 turn/end completed、无未闭合 turn、无待决审批、Agent idle、Inbox 两队列空、无自有后台工作，flush=true 后复查再提交 succeeded。error/max-tokens/blocked 不成功；未知 interrupted/forked 保留 recovery。源码 `core/session/src/types.ts:202-233,283-310`，`core/agent/src/runtime-types.ts:165-197` |
| `jobs.list/kill/attachController`、`subagents.listDescendants/drainDescendants` | 根会话及可识别后代分别按 **精确 owner** 过滤 jobs（list 还包含 unowned）；子目录条目保留不等于运行。未知诊断和 external 不足以证实停止，保守阻断成功。取消先 cancel + kill + drain，再确认 idle/Inbox/jobs/后代和 flush；超出停止宽限保留 slot、recovery_needed。源码 `jobs/jobs/src/index.ts:101-125,155-190`；`subagent/subagent/src/index.ts:364-379,405-426`、`src/list-children.ts:95-119` |
| `approval/asked` / `approval/decided` Session 审计事件 | 按公开事件 id 配对，运行中置 waiting_approval；不读取审批内部状态。源码 `interaction/user-approval/src/types.ts:31-59`。本轮为合成事件单测，未实测交互审批 UI |
| Cordis `ctx.provide`、`ctx.effect` | 自有服务用 provide 注册；set 不能替代首次 provide。effect 兄弟清理可能并发，显式 join executor→stores/registry→lease；store beforeClose 等待 executor，不依赖嵌套函数调用自动收集 effect。源码 `vendor/cordis/src/reflect.ts:254-305`、`src/fiber.ts:405-456,676`。真实 Host 激活和关闭、活动执行器卸载测试通过 |
| Node `open('wx')` / `rename` / `process.kill(pid,0)`，OS `/bin/ps -p PID -o lstart=` | 锁记录 hostname/PID/启动时间/token；仅同机 PID 不存在或可验证启动时间不符可接管。使用不可变前代 + token 指定的唯一后继文件，避免多竞争者 unlink 新 owner 的竞态；正常 release 原子写 released 收据。进程竞争/SIGKILL 死 PID 接管实测；启动时间不符分支为注入单测 |
| `dshBot.automation/status` Typert endpoint | 独立契约由 7 增至 8 个端点，公开 starting/ready/read_only/failed/stopping、原因及脱敏 owner 字段（不含 token）；严格 encode/decode，真实 Client Gateway 测试及只读 Host 验证。现有 P1 19 端点不变 |

新增 dev-only 类型包 `@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-subagent` 均精确 `0.2.1-rc.2`，没有新增 runtime imports/peer。按 T12 返工移除 package exports 的 `./automation`、`./automation-remote`；测试从相对路径引用内部构建模块。Typert 的 `package: dsh-bot/automation` 是契约标识，不是 Loader 模块入口，Host 根入口直接注册，保留它不需要 npm 子路径导出。

默认超时仍为 900000ms（15min）；新增 `automation.executorPollMs=250`、`automation.stopGraceMs=5000`，都有 Schemastery/Zod 范围校验。真实超时测试显式设 3000ms，不宣称等待了 15 分钟。未确认停止不释放并发 slot；卸载时若外部操作仍不明，不释放同进程的 Host lease，直到进程结束，避免关闭插件再启用导致重放。

环境限制：本次沙箱禁止 `/bin/ps`。此时仅记录标为 `unverified:` 的本进程近似开始时间，不用它与 OS 时间比较来判定 PID 复用；活 PID/无法查询均只读，死 PID 仍可接管。真实 OS 启动时间核验未通过环境验收，不能把注入测试当成系统实测。锁只支持同机、同一 DSH_HOME 的单 Host；不同 DSH_HOME 共享自定义后端、网络文件系统或旧版不遵守锁的 Host 不在保证范围。前代锁收据保留，不在线压缩。

只读 follower 仅开放诊断状态，P1 业务方法拒绝、automation CRUD 服务不启动，以免缓存领域句柄或启动修复写共享 JSON；不是可实时浏览全部业务历史的副本。没有本轮桌面/浏览器视觉验证，Bots 分组结论来自真实原生 WorkspaceRegistry 成员记录。


## T12：Automation v1 存储与 Remote 契约（2026-10-20）

新增独立 `dsh_bot_automation` version 1：`routines/runs/control`。P1 `dsh_bot` 的声明、四表、Host 启动及 19 个 Remote 端点保持原样。本轮结果见 [T12 验收](acceptance/P2-T12.md)；未安装插件或运行调度/模型会话。

| 公开 API / 入口 | T12 用法与实际证据 |
| --- | --- |
| `defineDomain/domainTable/storageDomain.open`、`Domain.table/close`、`KvTable.get/entries/put/delete` | 沿用既有公开 storage-domain 根入口；严格 schema 开域，写前再次校验；单 owner 服务队列串行。真实 Cordis + JSON 后端测试并发去重、跨表失败修复、独立 Node 进程重开；源码 `packages/storage/storage-domain/src/spec.ts:34-71`、`src/domain.ts:307-344` |
| schedule 根入口的五个 `create*ScheduleRecord` | 新增正式 dev `0.2.1-rc.2` + peer `>=0.2.1-rc.2 <0.3.0`；Host-only `rules.ts` 负责接受/编辑规则的校验和规范化，不在 Client 导入 schedule。源码 `packages/schedule/schedule/src/index.ts:25-61`、`src/domain.ts:1294-1507`；本轮测试五类正常输入及 every59/非法 cron/时区/时间/重复 weekday；dispatcher、DST 到期扫描仍属 T14 |
| `createTypertRemoteInfo`（公开 `/remote-info`）、`TypertRemoteService/Remote`、`ctx.typert.register`、Client `$mount` | 单独 `dsh-bot/automation-remote` contribution，7 个端点：routine list/get/create/update/delete，run list/get；Host 由 `registerAutomationRemote(ctx, stores)` 在 effect 中挂载。每个参数及结果均显式 encode/decode；真实 Gateway 结果解码失败返回 `ok:false, gateway/internal`，不保证抛异常。测试实际 Cordis services/Client Gateway，HTTP carrier 使用进程内适配器；未声称真实 Web profile HTTP e2e |
| `@deepseek-ai/dsh-llm` 的 `MessageSourceMap`、`createUserMessage` | 新增 type-only 自有来源 `dsh-bot-delegate`（notice），持久 report 的 message 限定为单 text block 的完整 user 消息；必须与 Run/session/messageId 一致。测试使用公开工厂生成消息并写入终态、重开读回；未调用 followup。源码 `packages/llm/llm/src/message.ts:109,138-163,241-253` |
| `ctx.effect` | 开域、Remote 注册/服务生命周期归所属 Host；拒绝关闭后的新写、等待已排队写入、共享一次关闭 Promise。测试 owner 门禁、duplicate open、重复 close、插件卸载与 Client unmount |

权威记录是 Run：`enqueue` 只持久排队，不收费；`reserve` 在同一 Run 行写入 quota receipt + ownerId + slotHeld，再重建 control。control/cursor 任一步失败均不删除已提交 Run；相同操作重试复用 id/sessionId/requestId。重开时所有未确认终止的已收费运行转为 `recovery_needed`、继续占位，不自动重放；未收费 queued 保留并在 reserve 时重验身份/暂停/删除状态。历史全部保留，当前没有清理或压缩接口。

`quotaTimeZone` 首次默认系统时区，之后读取持久值（control 丢失时从收费 Run 恢复）；显式更改拒绝，日期倒退拒绝新的 reservation。配额按 botId 计数，同 ID 重建不返还当天额度；Bot 身份另以 botCreatedAt 防串用。Config 默认并发 2、每日 20、队列 64、超时 15min、补跑窗口 24h、兜底 60s、委派深度固定 1；本轮只实现存储相关准入，计时/补跑/实际递归限制由后续执行器和工具负责。

决策：T12 以 `dsh-bot/automation` 导出工厂，不提前改生产 patch 激活；调用方必须先取得单 Host 锁，再提供同步 `assertOwner()`，每次持久写前重验。该回调不是锁实现，也不把单元测试的空回调当作互斥验证。锁接管政策采用已批准设计 §10（同机可证实 stale 时自动接管），在后续 Host coordinator 落地，不沿用 T11 的人工清理建议。


## T11：P2 公开 API 探针（2026-10-20）

本轮只增加独立 `spikes/p2`，不改产品代码或主 workspace 依赖。锁定参考 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`；真实 CLI `0.2.1-rc.2`。完整七项 PASS/FAIL、命令、失败历史和决策见 [T11 报告](../spikes/p2/README.md)。最终证据 `.dsh-dev/p2/t11/1792504206833-48874`：tgz 安装后真实 Web Host 激活，两次进程正常退出；4 次 loopback mock 请求、真实模型请求 0。没有桌面/浏览器可视验收。

| 公开入口 / 契约 | 本轮实际证据与后续使用边界 |
| --- | --- |
| `@deepseek-ai/dsh-schedule` 根入口 `createAt/Every/Daily/Weekly/CronScheduleRecord`、`resolveRecurringOccurrence` 及各规则 resolver 导出 | **PASS**：已安装 tgz 的 Host 调用五类创建与 recurring 分派；every59/六字段 cron/DST gap 拒绝，daily 跳过缺失日、overlap 取较早值。根含共享服务定义：dev 精确 `0.2.1-rc.2` + peer `>=0.2.1-rc.2 <0.3.0`，保留外部 import，不深导入或内联；`packages/schedule/schedule/src/index.ts:25-61` |
| P1 `ctx.dshBots.status()` + `ensureBotsWorkspace()`；`sessionController.create/rename/inspect` | **PASS**：status 是无参异步列表，按 Bot id 查实际 presetId；create 传 workspaceId 后 cwd 等于 Bots 根、原生 WorkspaceRegistry 的 Bots.sessionIds 包含会话，标题跨进程持久保留。源码 `api/session-controller/src/index.ts:243,253,301,431`。主 UI 是否实际展开分组本轮未测 |
| `sessionController.prompt`、Session snapshot、`agent.whenIdle/status`、`sessions.flush` | **PASS**：requestId → committed user/message.source.rpcId → 对应 turn/end completed，真实 step 与 idle/flush；相同 requestId 重入不增加 turn。step/start 可能在 user/message **之前**，应从所属 turn/start 开始核查；accepted 和单独 whenIdle 都不是请求完成证明。契约 `core/session/src/types.ts:283-310`、Controller `src/index.ts:462-485` |
| `@deepseek-ai/dsh-jobs` 的 `start/list/get/wait/attachController` | **PASS**：真实 jobs-local 中自有 running→completed，其他 owner 看不到；`list(sessionId)` 还含 unowned，必须精确过滤 owner。测试使用受控 producer，并先 wait 后 settle，未验证原生工具的迟到通知链。`jobs/jobs/src/index.ts:101-129,165-190`；type-only 包留 dev，controller disposer 纳入 effect |
| `@deepseek-ai/dsh-subagent` 的 `startActivation/listChildren/listDescendants/waitForChildren` | **PASS**：真实 spawn/caller 子会话在父目录可查询，另一父为空；后代 activity running→inactive、result completed，父 idle/Inbox 空。listChildren 是持久目录，条目留下不等于仍运行；使用 listDescendants activity/诊断，未知状态保守阻断成功。`subagent/subagent/src/index.ts:261-293,405-426`。parked Inbox、外部/多层后代尚未实测 |
| `@deepseek-ai/dsh-llm` 根 `createUserMessage`、公开 `MessageSourceMap` 扩展、`agent.followup`、`resolveAgent` | **PASS**：自定义 `kind:'t11-report', form:'notice', summary, sourceSessionId` 能落日志；在线与重启后 absent Agent 经 resolveAgent 恢复，各回报一次且各完成一轮。`llm/llm/src/message.ts:95-115,241-253`、`core/agent/src/runtime-types.ts:214-222`。工厂生成 messageId；**未证明重复 followup 自动去重、pending Inbox 自动续跑或跨崩溃 exactly-once** |
| Node `fs.open('wx')` 本机锁 + Host `ctx.effect` timer | **PASS**：两独立进程竞争恰一 owner，正常释放可接管，SIGKILL 残留锁拒绝接管；实际 Host effect 取得/释放。timer 双代卸载后无 tick、迟到异步提交被 active 门禁挡住。锁记录 pid/启动时间/token；存在即只读不调度，崩溃后的自动 stale 接管不提供。生产必须先获锁再打开可写 automation 域/调度 |

**决策：**继续批准的方案 A；完成屏障按 request/turn + idle + 精确 owner jobs + descendants activity + Inbox + flush 实施，未知恢复状态走 recovery_needed；回报由持久 report 和串行协调负责去重；锁采用保守人工清理 stale 策略。七项核心公开 API 范围无剩余 BLOCKER；完整自动化、busy/归档回报、故障矩阵和桌面视觉留给后续任务，不能沿用本轮四条 mock 文本回复视为产品 e2e。

## T10：0.1.6 集成收口与当前接口索引

本轮不新增生产 API、不改版本或依赖，也不重新打包；使用既有 `dist/dsh-bot-0.1.6.tgz`。参考仓库 HEAD/tag 仍为 `687f282e8625c6b8d11ff58211a90524be2e4317`，CLI 实测 `0.2.1-rc.2`。完整执行结果、包哈希及证据层级见 [T10 报告](acceptance/P1-T10.md)；当前行为汇总见 [架构](architecture.md)，桌面步骤见 [P1 清单](acceptance/P1.md)。下面的历史章节保留各轮结论，发生冲突时以较新的 T08g/T08i/T08j 和本节为准。

| 当前公开契约 | 0.1.6 实现与边界 |
| --- | --- |
| Host / Agent | Host `dshBots` 管注册表、持久化及 Remote；`dsh-bot/bot-context` 在 preset 代际内持有 Bot 快照，为每个 Agent 安装工具/提示/活动监听。所有资源由所属 effect 清理；稳定 preset 默认 `bot-<id>`，Client 使用 `status.presetId`，不拼接前缀 |
| 模板与存储 | 组合时读取宿主公开 `agentPresets.readDocument`，不使用计划中的 vendored 生产模板。领域名为 **`dsh_bot`**，version 1，四表 `bots/memories/registry_state/activities`；默认 JSON backend 位于 `$DSH_HOME/storages`，`dataDir` 只控制技能目录 |
| Remote | `src/shared/remote-contract.ts` 单一手写 spec 共 **19** 个端点：`dshBot` 的 watch/list/catalogInfo/status/get/ensureHome/ensureBotsWorkspace/create/update/duplicate/delete，memory 的 list/search/save/update/delete/count，以及 activity 的 list/markRead。Host 手动注册 `host-contract`，Client await `$mount`；不使用已移除的 `./typert` 自动发现出口 |
| 严格性与作用域 | 点号 namespace 分别通过 `ctx.get('remote.dshBot.memory')` / `ctx.get('remote.dshBot.activity')` 获取。`mode:'strict'` 和 schema factory 本身不保证 rc.2 对所有结果自动 encode/decode；activity/home/workspace 有显式 result codec，watch 两端另做帧 parse。不能泛称全部响应都由 Gateway 自动校验 |
| 工作区 | 默认以 `ensureBotsWorkspace()` 返回的 workspaceId 创建原生会话；真实 cwd 为共享 Bots 根，必须满足 `cwd===workspace.path`。`ensureHome()` 的 Bot 子目录用于文件组织/提示，不是会话 cwd 或 Bot 间安全隔离。defaultCwd 通过公开 `workspaces.create({path})` 取得其工作区 |
| 刷新 | 一个 Client 调度器共享 watch、timer 和浏览器监听；前台有主动订阅时默认从 5 秒逐步退避至 30 秒，失焦/隐藏停止周期读取与流；写后读回、聚焦、可见性恢复与 reset 刷新。watch 只发进程内 revision 提示，Bot CRUD/activity/已读提交会通知；**记忆写入未单独 invalidate watch**，本 Client 写后直接读回，其他 Client/模型记忆写依靠轮询或重新聚焦 |
| UI | 公开 main/导航、会话 utilities、原生会话行、footer 入口与 `sidebarRightTabs`/`sidebar.right.pane.tab`；主页面和右侧 tab 都导航到宿主会话。导航、默认头像和入口角标共用 `WhaleGlyph`，不导入宿主内部组件。空白会话不挂头部 utilities，原生行鲸鱼也受 blank/archived/状态与其它 slot 条件限制 |
| 记忆与恢复 | 每 Bot 工具闭包绑定身份；新建/冷恢复 Agent 读取记忆快照，存活 Agent 保持不变。`persona.complete=true` 遵循宿主抑制其它 section 的语义。删除 Bot 保留会话日志但会使缺失 preset 的冷恢复失败，不能沿用早期计划“旧会话仍可查看”作无条件恢复承诺 |

安装验证分层：`scripts/dev-profile.sh` 只证明目录安装和 dump 层，不启动 Host；独立 Registry/Composer profile 的 loaded、真实 Remote、preset 健康及进程退出才是运行证据。T10 的 `registry-profile.mjs --package` 对既有 tgz 安装进行逐文件校验，Host 解析已安装的包；Node 测试驱动在校验 Remote/shared 字节相同后复用 workspace 契约，以保持它自身的公开 peer 解析。直接从 profile 导入供宿主解析的 peer 包并不是独立 Node 消费者的受支持安装方式。首轮驱动导入失败与修正后的实际 Host 结果均保留于 T10 报告。

## T08j：导航共享鲸鱼图标（0.1.6）

本轮没有新增 Host、Remote、slot 或依赖 API。`sidebar.panellist` 仍使用原 `dsh-bot` 注册、order 20 和所属 `ctx.effect`；只替换渲染组件。锁定参考源码 `deepseek-harness@dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317` 的 `packages/client/ui-sidebar/src/client/SidebarRoot.tsx:71` 给宽/折叠导航分别传 16/18px；相邻插件、自动化任务入口的 order 为 0/10。

`components/WhaleGlyph.tsx` 从本包既有 `icon.svg` 提取唯一 Client `WHALE_PATH`，导航、默认 `BotAvatar` 和会话入口角标共用；不再依赖 `FishLogo` 渲染这三处。该路径原生范围 23.16×17.04（参考 `packages/client/ui-primitives/src/FishLogo.tsx:4`），在 `viewBox="-0.42 -3.48 24 24"` 中居中，保留长宽比。SVG/path 均 `fill="currentColor"`，没有底色矩形或固定颜色；头像沿用其既有主题 token 调色。此节更新 T08b 对头像使用平台 `FishLogo` 的历史记录，不改变静态插件 tile。

组件及 slot 单测验证 16/18px、currentColor、无 hex/rgb/hsl 颜色、无底色和路径与 package icon 一致。真实亮暗主题及截图结果另见 [T08j 验收](acceptance/P1-T08j.md)，不以单测代替视觉验证。

## T08i：共享 Bots 工作区

本节替代 T08h 主入口使用私有 home 作为 cwd 的方案。以下为实现前对只读 `deepseek-harness@dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317` 的公开面核实；实际运行结果另记 [T08i 验收](acceptance/P1-T08i.md)。源码路径相对该参考仓库。

| 公开接口 / 行为 | 源码出处 | 本轮用法与边界 |
| --- | --- | --- |
| Host `ctx.workspaceRegistry`，`resolveByPath(path)`、`create(path,title?)` | `packages/workspace/workspace/package.json:16-25` 根出口；`src/index.ts:2-5,170,222-244,495-523`；README 公开服务 API | 插件可依赖的公开服务；仅从 `@deepseek-ai/dsh-workspace` 根入口做类型引用。root 先经公开 `resolveDshHome()` 及受管目录检查创建，再按 canonical path 复用，否则 `create(path,'Bots')`。create 自带宿主串行幂等；本插件仍使用 registry 现有队列 |
| create 的 title 仅用于新纪录；同 canonical path 返回既有实体 | `workspace/workspace/src/index.ts:223-230,510-523` | 不调用 setTitle；用户手动改名及已有同路径工作区名均保留。删除后生成的是新记录，重新使用默认标题 Bots |
| 删除只移除登记及其成员列表，保留目录和所有 session logs | `workspace/workspace/src/index.ts:302-311,585-617` | 不归档、不删日志、不删目录；`archivedSessionIds` 是全局集合，delete 复制原 state，保留全局归档与固定状态。重建后不重新 attach 历史：尊重删除后的未分组/归档状态，不搬动其他工作区会话；T08h 私有 cwd 历史本来也不满足 Bots 根的精确相等规则 |
| 首次迁移按历史 cwd 建组，仅 `initialized=false` 运行 | `workspace/workspace/src/index.ts:198-219,650-690`；delete 保持 `initialized:true` 于 `:592` | 正常删除后重启不会重做迁移。只有人为清空 workspace 域才可能触发原生迁移；本插件不清空或修改该域 |
| 成员 attach 必须真实 cwd 精确等于 workspace.path；workspaceId 创建强制 cwd 为该根 | `workspace/workspace/src/entity.ts:102-149`；`api/session-controller/src/commands.ts:111-150` | 新 Bot 会话传 `{workspaceId,agentPreset}`，不再传 cwd。私有 home 仅用于提示与文件组织，不是隔离边界 |
| Client `ctx.workspaces.create({path}) → Promise<WorkspaceView>` | `api/workspace-controller/src/client/index.ts:16-23,33-36`、`service.ts:55,130-133`、`model.ts:98-99`；Host `commands.ts:44-60` | 有 defaultCwd 时经此公开 API 幂等创建/复用该目录工作区；不写用户权限设置 |
| 原生 fs 越界和提权审批 | `fs/tool-fs/src/write.ts:129-143`、`sandbox.ts:87-107`；`sandbox/sandbox/src/escalation.ts:172-218`；`interaction/user-approval/src/types.ts:91-126`；`core/session/src/types.ts:358-389` | 模型调用 write 经 resolvePolicy/fs.writeText；越界返回 FS_SANDBOX_DENIED，sandbox_permissions + justification 经 approveEscalation/ctx.approval.request。隔离测试以公开 session/event 与 approval/request 观察 tool/call/result 和 pending 请求，并由测试 responder 拒绝；实际结果以本轮验收为准 |
| 原生空白会话行不挂 leading slot | `client/ui-workspace/src/client/rows/Rows.tsx:633-635` | 空白新会话检查 Bots 归属与原生输入框可用；鲸鱼头像在同组已完成 mock 会话行回归。保持 T08e 活动身份，不绕过原生 blank/archived 条件 |

`dshBot/ensureBotsWorkspace()` 新增零参数严格 Remote，返回 `{workspaceId,path}`；`ensureHome(botId)` 仍返回 Bot 子目录。工作区 id 置于既有 `dsh_bot.registry_state` 的独立 `bots-workspace` 行，扩展 schema 兼容旧的 examples 状态行，写前 parse。每次以真实 path 查询为准并修正存储 id，不把失效 id 当作有效缓存。启动时尝试恢复；暂时失败只记录诊断，保留 Bot 管理与后续重试。跨工作区存储与 Bot 存储不存在原子事务：id 写入失败保留已经创建的工作区，下次按 path 复用并补写。

Cordis `inject` 的对象形式是服务名到 intercept config 的映射（`vendor/cordis/src/registry.ts:12-19`），rc.2 不接受 `{required,optional}` 嵌套结构。本插件保留原必需注入数组，在已有 `loader.await()` 后通过公开 `ctx.get('workspaceRegistry')` 查询；缺少该服务时 ensure 返回 `bot/unavailable`，不阻塞其他 Bot 管理。初轮误用嵌套结构导致等待名为 required/optional 的服务，已在正式实现修正，并用真实 Cordis Host 装卸及 native WorkspaceRegistry 测试通过。

私有 home 提示属于 `agent/created` 中的 Agent effect，与 memory 开关无关；路径只来自 ensureHome。T08i r1 将该段精简为三句英文：私有目录绝对路径及文件放置要求、当前 cwd 与共享 Bots 根、Bot 互不隔离及根外写入遵循原生权限/审批；失败降级为不含路径的一句英文，不阻塞会话。defaultCwd 会话提示其实际 cwd，避免错误称其当前目录仍为 Bots 根。删除 Bot 只处理原有归属检查后的 home/marker，以及空的 Bot 父目录，从不移除 Bots 根或工作区登记。

保留原生 `persona.complete=true` 语义：此设置抑制其他 system-prompt sections，包括 home 与 memory；默认 `complete=false` 时两者按通常条件生效。本插件不覆盖用户完整人设设置。源码：`packages/preset/persona/src/index.ts:42-43`、`packages/core/system-prompt/src/index.ts:653-685`。

## T08h：每 Bot 私有 home 与免工作区聊天

本节覆盖 T08/T08b/T08d 中“新会话必须选择工作区”的历史行为；工作区流程保留为次要操作。源码只读复核基线为 `deepseek-harness@dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`，下表路径相对该仓库。运行结果与截图边界见 [T08h 验收](acceptance/P1-T08h.md)。

| 公开 API / 行为 | 源码出处 | 本轮用法 |
| --- | --- | --- |
| `resolveDshHome()` 根出口；显式配置 → DSH_HOME → 平台默认目录 | `packages/util/home-paths/package.json:16-22`；`src/index.ts:101-109,124-136` | Host 使用公开无状态 helper，不再自行拼接用户 home。新增精确普通 dependency `@deepseek-ai/dsh-home-paths@0.2.1-rc.2`，无需共享 service 实例，不加 peer |
| Host `session.create` 接受 workspaceId 或 cwd，不能同时传；都不传才回退 defaultCwd | `packages/api/session-controller/src/commands.ts:111-150` | 主入口只传 cwd + Host status 返回的稳定 presetId；只有指定 workspaceId 才执行 attachSession |
| Client `ctx.sessions.create({cwd,agentPreset}) → Promise<SessionId>` | `packages/api/session-controller/src/client/contract/sessions.ts:81-93`；`sessions/manager.ts:508-535` | 成功返回后才 `ctx.uiWorkspace.openSession(id)`；不自行创建 workspace，不传权限选项 |
| `openSession`、`openWorkspace`、`pickDirectory` | `packages/client/ui-workspace/src/client/navigation.ts:38-64,117,276-305,390-394` | 主入口直接导航；更多菜单保留工作区选择与原 openWorkspace 流程；编辑器用公开目录选择器，取消返回 null、错误内联显示 |
| 未归属 workspace 的会话合入一个 Ungrouped 桶 | `packages/client/ui-workspace/src/client/tree.ts:18-31,328-372`；`src/client/rows/Rows.tsx:245` | 不为每个 home 注册 workspace。复核公开 UiWorkspace/slots 后未发现逐 Bot 隐藏原生会话的过滤扩展，保持“未分组”，不覆盖原生树或通过 DOM 隐藏 |
| displayTitle 的 cwd basename 回退 | `packages/api/session-controller/src/client/sessions/service.ts:116-125` | 原生空白会话可能显示 home；Bot 自己的列表沿用 T08g：live title → activity title → 首条用户摘要 → 本地化新会话，绝不使用 displayTitle |
| 默认权限预设 workspace-write + ask，用户默认选择固定到新会话 | `packages/interaction/permission-presets/README.zh.md:34-50,62-64` | 原样继承用户 DSH 设置，包括 danger-full-access；本插件不覆写权限、审批或 sandbox policy |
| fs-sandbox 读取不受 cwd 限制；workspace-write 写入限会话 cwd 和平台临时目录 | `packages/fs/fs-sandbox/src/index.ts:1-24,122-143`；`packages/sandbox/sandbox-policy/src/index.ts:155-170` | 这里的 home 是默认工作目录，不是读隔离区。文件读仍受操作系统/部署权限影响；本插件不增加模型路径闸门 |
| 越界写入 `FS_SANDBOX_DENIED`，sandbox_permissions + justification 经原生 ctx.approval 处理 | `packages/fs/tool-fs/src/sandbox.ts:74-107`；`packages/shell/bash-sandbox/README.zh.md:25-60,125` | 文件与 bash 提权重试沿用 DSH。源码确认，不把本轮 mock 文本对话当作真实审批弹窗或沙箱越界实测 |

**原生首次迁移边界：** `packages/workspace/workspace/src/index.ts:198-215,650-690` 在 workspace 域尚未 initialized 时扫描已有 session headers，按 cwd 为历史日志建立 workspace。正常已初始化 registry 下的 `create({cwd})` 不 attach，正常冷恢复继续未分组；若人为清空 workspace 域而保留历史日志，原生迁移可能重建目录组。集成与截图 profile 同时隔离 JSON storage 与 session-persistence-jsonl root，避免旧轮次日志污染；不修改或绕开宿主迁移。

本轮真实隔离 profile 的空白会话 title projection 为 null；禁用 `session-title-llm` 后，原生 `session-title` 仍会从首条用户文本生成五词持久标题。正式活动应跟随该公开投影，不能断言发送首条消息后 title 仍为空。真实运行 176 checks 与完整产品 505 tests 通过，截图由编排方执行，详见验收。

Host `ensureHome(botId) → {path}` 是新增严格 Remote；总返回固定 `<resolved DSH home>/dsh-bot/bots/<botId>/home`，独立于可配置的技能 `dataDir` 和用户 `defaultCwd`。已有 defaultCwd 可选字段复用，保存时校验绝对路径且目录已存在；恢复默认通过现有 `defaultCwd:null` wire 语义。home 按需创建，POSIX mode 0700，botId schema 之外再检查路径包含关系与 realpath；拒绝受管路径组件 symlink，已有无归属标记的目录不自动接管。私有目录同级归属标记记录路径与文件身份；这是本插件防误删策略，不替代 DSH 沙箱或抵御同 OS 用户恶意并发替换目录的内核安全边界。

删除选项新增 `deleteHome`，默认 false；只在显式勾选时验证归属后清理精确 home，绝不将 defaultCwd 当删除目标，也保留 skills。Bot/记忆持久存储与文件系统没有跨资源原子事务；目录清理失败不会声称回滚成功，详见验收中的失败边界。目录保留时同 id 的 Bot 可以再次使用原 home。Client 所有主入口不读取工作区选择条件，重新读取 Bot/status 后按 defaultCwd 或 ensureHome 的路径创建；失败留在当前界面，卸载/取消后的迟到结果不得触发导航。

## T08g：公开变更流与轮询兜底

刷新状态统一由同一 Client Context 的共享调度器管理（Bot catalog、activity 及打开的 memory catalog 共用 timer/浏览器监听）。默认 `pollIntervalMs=5000`、新增 `maxPollIntervalMs=30000`，无变化逐次加基础间隔至上限；为兼容原配置，最大间隔不低于基础间隔。只在 visible + focused 且存在主动订阅时周期读取/开流，focus/visibility 恢复立即读取；pointer/keyboard 交互重置基础间隔。本插件成功 CRUD、markRead、新会话立即读回，显式修改后的读回即使窗口已失焦也完成；普通周期停止。相同结构保持快照引用，不 publish；后台不进入 loading；相同错误不重复通知，恢复清错误。最后订阅/插件卸载释放资源，epoch 拒绝迟到响应。

### 真实标题来源与根因

`pod_0814` 的根因是原 `botSessionRows` 使用 `activity.title ?? session.displayTitle`。rc.2 `packages/api/session-controller/src/client/sessions/service.ts:29-32,116-126,630,639` 明确定义 `displayTitle = durable title → cwd basename → session id`；公开 `SessionSummary.title` 才是未含工作区回退的持久标题。因此改为 **Client live `title` → Host activity title → firstUserPreview → 本地化“新会话 / New conversation”**。Client live title 随公开 session list 投影更新，优先于只在消息时更新的 activity title；全部候选复用同一纯摘要/凭据筛查函数，不能让新来源绕过原有脱敏。Host title 来源仍为 `sessionProjections.snapshot(session).values.title`，定义 `packages/session/session-title/src/index.ts:267-281` 只投影 `session/title` 事件。

首条用户摘要用公开 `sessionProjections.register/stateOf` 增加 Host-only `dshBotFirstUserPreview`（stateVersion 1，`string|null`）。`packages/session/session-projection/src/index.ts:240-289` 对同 key/version 引用计数，`:313-352` 提供公开 state/snapshot，`:599-628` 在需要时惰性 materialize。注册与注销归 Agent effect，启动只注册；投影只收首个 human `user/message` append，保存已脱敏的至多 120 码点摘要，空串记录纯图片首条，不允许后续用户输入替代。记录增量加可选 `firstUserPreview`，旧数据仍可读；旧会话下一条完成消息可从公开投影补齐，没有 projection 服务时省略，绝不猜测“第一条”。不使用已 deprecated 的 `Session.snapshotEvents()`。真实 Session + ProjectionRegistry 测试覆盖恢复、共享租约、卸载、秘密 checkpoint 与空首条；真实隔离 Host mock 另验证三条首摘要，完整冷启动磁盘恢复未在本轮重复运行。

历史行无预览就不输出该行；工作区名只在能从公开 mainView retention 确认当前路径、且目标是另一个已知工作区时显示次要 meta。正常 Bot 资料没有“就绪”行。主页面和右侧栏都锁定初次成功选择，后续活动重排不自行切换；会话行和 Bot 行使用稳定 id key。组件和截图脚本的证据边界、逐项结果见 [T08g 验收](acceptance/P1-T08g.md)。

**结论：rc.2 有干净可用的公开 Remote stream，因此本轮采用 `dshBot/watch`，不修改宿主事件名单。** `dsh-bot/changed` 仍然不能直接通过 `$on` 转发；T02 的白名单结论不等于第三方插件不能提供自己的流。以下源码均为只读 `deepseek-harness@dsh-v0.2.1-rc.2`（`687f282e8625c6b8d11ff58211a90524be2e4317`）。

| 核实项 | 公开源码依据 | 正式实现与取舍 |
| --- | --- | --- |
| 第三方事件不能自行进入 `$on` 白名单 | `packages/api/remotes/src/remote-events.ts:20-55` | 保留 Host 本地 changed 事件；另提供插件自有 `watch`，不 monkey patch 宿主名单 |
| `@Remote({ mode:'stream' })` + final `AbortSignal` | `packages/api/account-controller/src/index.ts:96-119`；`packages/typert/protocol/src/types.ts:400-435` | 单一手写 spec 新增第 17 个端点：零业务参数、`mode:'stream'`、`cancellation:{parameter:'signal'}`；Host stream 由所属 registry 的 effect 清理 |
| 公开原始 stream handle 与取消 | `packages/typert/protocol/src/types.ts:137-178`；`packages/api/gateway/src/client/index.ts:476-496,508-544,550-627` | `ctx.get('remote.dshBot').watch(signal)`，每 Client 共享一个；blur/hidden/最后 polling lease 关闭。终止后由共享调度器下一周期或重新聚焦重开，没有第二套 retry timer |
| `$stream` 与 `RemoteSnapshotStream` 也公开，但前者需要 answering Client | `packages/api/gateway/src/client/index.ts:47-48`；`README.zh.md:64`；`src/client/snapshot-stream.ts:24-96` | 本业务只需 invalidation，采用兼容 passive Node probe 的 raw stream。opening 即刷新完整 catalog/activity，断线期间保留旧数据；轮询兜底覆盖断线及宿主自身 preset 健康等非本插件写入变化 |
| raw stream 不自动调用严格 result encode/decode | Host `packages/api/gateway/src/index.ts:444-471`；Client `src/client/index.ts:476-496`（对比 unary `:461-465`） | Host yield 前与 Client 收帧后均显式 `botChangeSchema.parse`，不能仅靠 spec 的 `mode:'strict'` 声称 wire 已校验 |
| Cordis 服务方法的 `ctx` 随调用者追踪 | `vendor/cordis/src/utils.ts:165-196`、`src/reflect.ts:233-234` | registry 构造期捕获自己的 owner Context，watch 注册在此 owner effect，不能把网关/root 调用方的生命周期当 Host 插件生命周期；真实 Cordis 卸载回归覆盖此差异 |

帧只携带 `{revision}`，是进程内的刷新提示，不是可恢复日志游标或数据快照。每次开流先发一帧，之后同一 watcher 最多保留一个待发通知，慢消费时合并 revision；Bot CRUD、成功的活动写入与已读变更提交后通知。活动 replay/no-op 经有界公开快照结构比较不发通知；Client 仍对真正读取结果比较后才发布。没有传输标题、预览、工作区或其它业务内容，也不以 stream 到达代替权威 list/status 的结果。取消、iterator 退出和 Host 卸载均移除 watcher 并唤醒 pending pull。

本轮自动测试已实际运行公开 Cordis + JSON storage/Registry 的开流、提交、合并、活动、已读、abort、Host 卸载；已发布 Connection + Gateway + 实际 RemoteStreamHandle 的 plugin scope、opening、严格拒绝额外帧字段、取消、Client 卸载、即开即断不自动自旋（仅 transport 为 double）。`tests/fixtures/client-activity-probe.mjs` 另增加真实隔离 Host 网络探针：通过现有鉴权 Connection 开流，创建/删除独立临时 Bot，接收两次提交通知并取消 pending pull；截图 seed 与 composer profile 均复用它。**网络探针的执行结果以本轮验收报告为准；这些测试均不等于真实浏览器 A/B 像素、DOM 身份或亮暗主题验收。**

## T08f：会话右栏 Bots tab

锁定 rc.2 公开 `sidebarRightTabs.register` + `sidebar.right.pane.tab`（key=`definition.id`，非 kind）+ `sidebarRight.openTab(kind)` 可干净扩展。正式实现 `kind:dsh-bot-bots` / `id:dsh-bot.right-bots`，复用 T08d `BotList` 紧凑模式及原 catalog/markRead/新会话动作；guide、header utilities 与空白 Hero options 为入口。只有右栏内明确点击导航才一次性跟随目标会话；其它导航及卸载取消。默认 keepMounted=false，各注册归 effect，不写宿主内部 store 或 localStorage。新增 Client dev 依赖精确 rc.2，Host peer 不变。

布局按 session 存浏览器 localStorage，非 Host 会话日志；卸载 Bot 插件保留记录，由宿主显示 unavailable。`tab.signal` 属于右栏包，Bot 自有 cleanup 不依赖其卸载时 abort。准确公开导出、源码行号、files/terminal/browser 示例、设计取舍与完整命令见 [T08f 调研及验收](spikes/P1-T08f-right-tab.md)。本轮 `check` 431 tests 与 `check:spikes` PASS；实际 Host/mock/Remote probe 完成，**真实右栏截图 0/2 FAIL**（Chromium 沙箱阻塞 + 备用浏览器 origin 审批拒绝），持久恢复及卸载占位仅源码结论。

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
