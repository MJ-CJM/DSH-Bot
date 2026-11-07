# 原生复用与分阶段 API 能力门槛

状态：设计交付，未实施。核对日期：2026-11-06。代码基线：`4a0aab42a2e4e005542528ada4c985d0786e1fc9`（DSH-Bot `0.6.4`）。开发与本设计的最低 API 基线为 DSH `0.2.1-rc.2`、Cordis `4.0.5`、Schemastery `3.18.5`。本文是[总提案](../proactive-bot-and-superagent-proposal.md)的实现前门槛，不新增已经可用的产品 API，也不替代执行与验收协议。

## 证据范围与决策规则

本轮只读核对当前源码、主仓已安装 rc.2 npm 包的 `package.json` exports 与 `lib/types`，没有运行真实模型、修改安装环境或引入依赖。预定 `~/ai-workspace/deepseek-harness` 参考树不存在，因此没有声称本轮复核其 tag checkout；下列上游链接固定到 `dsh-v0.2.1-rc.2`，作为源码导航。已安装 `.d.ts` 与 bundle 可核实签名及部分行为，不能替代隔离 Host、浏览器和真实渠道运行。

历史证据来自 [API 核实记录](../../dsh-api-notes.md)、[T02 spike](../../../tasks/P1/T02-api-spike.md)和[当前计划](../../PLAN.md)。历史 PASS 不自动覆盖这次新增的协调进程、自动派工、跨进程恢复组合。旧 PLAN 的“自研 routine、新会话定时”已被 R02/R05 原生 schedule 聚合与主会话方案取代；不得据旧计划恢复第二套调度器。

采用顺序：DSH 原生服务 → DSH-Bot 已有服务 → 官方/社区公开入口薄桥 → 证明前三项不能满足后另行评审。门槛失败时保留观察、人工操作或禁用该能力；不偷偷补建第二套时钟、执行器、审批、任务核心或传输重试器。

“已具备”仅表示当前源码/公开合同存在；“新增桥接”表示还没有实现和运行验证。所有 API-G 能力实验在本文交付时均为 **FAIL（未执行）**，不是产品现有功能失败。

本轮本地证据定位（相对于所列 npm 包根；仅供阅读，禁止按此内部路径导入）：

| rc.2 安装包 | 读到的签名/约束 |
| --- | --- |
| `dsh-agent-preset-registry` `lib/types/index.d.ts:44` | register 返回异步 disposer。 |
| `dsh-storage-domain` `lib/types/domain.d.ts:36–77` | 同步 get；durable put 为 Promise；update 的原子范围是单记录 write-chain slot。 |
| `dsh-subagent` `lib/types/types.d.ts:115–170,296–341` | 四个 start capability、父上下文描述、prepareContinuable 的执行/续聊语义。 |
| `dsh-subagent` `lib/types/out-of-process.d.ts:14–20` | 标准进程外 backend 的 NO_START_CAPABILITIES；不能忽略未支持的请求字段。 |
| `dsh-experimental-agent-team` `lib/types/types.d.ts:138–145` | SpawnTeammateRequest 只有 name/description/prompt/context/provider/signal，无 agentPreset。 |
| `dsh-schedule` `lib/types/types.d.ts:170–190,224–225` | receipt 是已持久化 Inbox 投递；catalog 保留原 sessionId；Host-driven original Session。 |
| `dsh-jobs` `lib/types/index.d.ts:59–128` | JobRegistry 是作业控制；readAt 可有 lossy，kill 只返回 requested/already-finished。 |
| `dsh-api-session-controller` `lib/types/index.d.ts:101,171,211` | create/prompt/projections 的公开异步入口；prompt 带 AbortSignal。 |

rc.5 或更新宿主的历史验收不用于证明 rc.2 新组合可用。升级时重新读取实际 exports、provider capabilities、权限继承、projection 字段和 Remote 注入规则，并重跑受影响的 适用的 API-G gate；保持开发锁文件和兼容声明分离。实验性 Agent Teams、社区 IM 与原型 revision 分别记账，不用一个“兼容 DSH”标签覆盖它们。


## 逐能力复用矩阵

表中 DSH 包名省略 `@deepseek-ai/`。本包源链接相对仓库根；上游源码仅作行为核对，产品禁止 deep import `lib/types`、`src` 或内部实现。

| 能力 | 已具备与真实公开入口 | 复用/桥接决策；明确不重复实现 | 静态证据、待实测与版本门槛 |
| --- | --- | --- | --- |
| Preset / Bot 身份 | `dsh-agent-preset-registry` 根入口的 `agentPresets.register/readDocument/compositionInventory`；本包注册表、composer、BotKey 生日隔离 | 沿用 Bot→preset 组合与原生代际，任务保存 BotKey/职责版本/实际 preset；不得把更新 preset 宣称为已存在 worker 热更新 | [composer](../../../packages/dsh-bot/src/host/composer.ts)、[上游 registry](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/preset/agent-preset-registry/src/index.ts)。安装类型 `register(): Promise<() => Promise<void>>`，必须 await 注册和注销；API-G02 验证旧 Agent 与新代际。 |
| Model | `dsh-llm` 根入口的 `llm.listProviders/listModels`；公开模型选择、`agentOptions`、`agent/request` | 使用宿主模型目录和现有 Bot/群选择优先级；不得新建模型供应商配置中心，不能把模型目录存在当凭据/回复成功 | [bot-context](../../../packages/dsh-bot/src/host/bot-context.ts)、[群模型](../../../packages/dsh-bot/src/host/groups/model.ts)、[上游 LLM](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/llm/llm/src/index.ts)。rc.2 组合依赖公开 waterfall 顺序；API-G02 用 loopback 验证不回退到真实默认模型。 |
| Tools | `dsh-tools` 根入口 `defineTool`、`tools.register/restrict/guard/execute`、`tools/pre-execute/result` | 原生注册、工具可见性、执行与审批链；新增主动入口也必须经过既有数据出口。禁止私自复制 ToolRuntime、用名称前缀授予工具权限 | [原生工具边界](../../../packages/dsh-bot/src/host/data-flow/native-policy.ts)、[上游 tools](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/core/tools/src/index.ts)。rc.2 无可依赖的公开 publisher 身份；既有实现固定准确 definition，替换后拒绝。API-G04。 |
| Skills | 原生 `dsh-skill`、preset 中 `dsh-skill-filesystem` 的 `customSkillDirs/includeDefaultRoots`；本包 composer | 沿用技能加载与 Bot 技能目录，职责规则引用技能 revision；不造另一套 Skill loader/自动晋升机制 | [composer](../../../packages/dsh-bot/src/host/composer.ts)、[上游 skill-filesystem](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/skill/skill-filesystem/README.zh.md)。本轮本地有 skill 类型，未找到 filesystem 独立安装包并实测；API-G02 验证文件可见性、无跨 Bot 泄露。 |
| Session / Inbox | `dsh-api-session-controller` 根入口 `create/prompt/projections`；`dsh-agent` 与 `dsh-session` 根入口、Agent `followup`、Session events | 原生会话、历史、消息身份、Inbox、取消、持久化保持权威；任务仅保存引用和执行映射，不复制聊天日志。自动来源不得通过交互 prompt 伪装成人工 | [main-session](../../../packages/dsh-bot/src/host/main-session.ts)、[群根](../../../packages/dsh-bot/src/host/groups/roots.ts)、[上游 controller](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/session-controller/src/index.ts)。`prompt` accepted 只代表入箱；API-G03 分别记录 accepted/turn ended/artifact accepted。 |
| Projections / usage | `dsh-session-projection` 根入口注册纯 projection；Session Controller `projections`、Client `sessions.refreshProjections` 与公开 `sessionStats/subagentCatalog` | 使用原生事件切面和统计，业务任务视图来自核心记录；不向原生 usage 填外部 runner 的自报成本 | [routine outcomes](../../../packages/dsh-bot/src/host/native-schedule/outcomes.ts)、[上游 projection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/session/session-projection/src/index.ts)。缺 projection、裁剪、迁移延迟均显示 unknown；`responded` 不是业务成功。API-G03/12。 |
| Subagent | `dsh-subagent` 根入口 `getProvider/registerProvider/startActivation/sendMessage`，公开 activation `childId/result/dispose` | 首选 native spawn；外部 backend 只在公开能力全部匹配时接入，不能把 provider 字符串换成 codex/acp 就声称等价 | [delegate](../../../packages/dsh-bot/src/host/delegate/tool.ts)、[群 runner](../../../packages/dsh-bot/src/host/groups/concurrent.ts)、[上游 types](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent/src/types.ts)。rc.2 必查 agentPreset/agentOptions/depthLimit、inheritsParentContext 与 prepareContinuable；API-G05。 |
| Groups | 本包 `Groups`、GroupTurns、roots、concurrent 与原生 spawn | 复用群成员、路由、准确 child 续聊、原生过程展示；新增“受限 Host 派工适配器”须独立合同，不能直接借交互 send 写 user 来源 | [turns](../../../packages/dsh-bot/src/host/groups/turns.ts)、[state](../../../packages/dsh-bot/src/host/groups/state.ts)。现有 `Serial` 仅进程内排序，`putTurn/putDelivery` 是各次异步持久写；不能当任务核心多表事务。API-G04/05/07。 |
| Agent Teams | `dsh-experimental-agent-team` 根入口 TeamService：roster、消息、任务板、claim/update | 现有 collaboration bridge 继续拥有原生 team 映射；Lead 内部任务板可复用为执行视图，不与跨来源核心 Ticket 双写两套权威状态 | [collaboration](../../../packages/dsh-bot/src/host/collaboration/service.ts)、[上游 types](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/experimental/agent-team/src/types.ts)。`SpawnTeammateRequest` 无 agentPreset，不能充当任意 Bot 群成员；experimental 不表示未来兼容。API-G05。 |
| Schedule | `dsh-schedule` 根入口 `create/catalog/history/update/delete`；公开 `/remote`；当前 nativeSchedule aggregate | 时钟、规则、到期投原会话全部复用；只桥接 occurrence 为候选事件，不再创建 heartbeat 轮询器。Host 关闭不执行，也不承诺漏期全部补跑 | [native service](../../../packages/dsh-bot/src/host/native-schedule/service.ts)、[上游 schedule](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/schedule/schedule/src/index.ts)。history 返回 Session 投递 messageId/时间；不是完成结果。当前没有可假定的业务事件 callback API；API-G06 验证桥接时点与持久去重。 |
| Jobs | `dsh-jobs` 根入口 JobRegistry `start/list/get/read/readAt/kill/wait`，原生 jobs-local/tool-jobs | 复用进程作业输出、所有权与停止；Job 是一次执行资源，不是持续业务 Ticket、持久订阅或跨 Host 自动恢复器 | [上游 jobs](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/jobs/jobs/src/index.ts)。本地 rc.2 类型明确 caller owner、lossy 输出、kill=requested；API-G03/12 验证取消与停机，不推导 exactly-once。 |
| Webhook / Source | 原生 `dsh-webhook` / `dsh-webhook-github` 可作接入桥；当前正式包没有 webhook 依赖 | 认证、解析和原生入口能复用就复用；业务 Source 适配补认证身份绑定、事件幂等、准入与完成分离，不将 fire-and-forget HTTP 受理当成功 | [总提案现状](../proactive-bot-and-superagent-proposal.md)、[上游 webhook](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/subsystems/webhook.zh.md)。本轮未在已装包取得 webhook 类型，事实沿用前轮核对，签名待 API-G01/08；不假定已有 durable queue/replay。 |
| Storage | `dsh-storage-domain` 根入口 `defineDomain/domainTable`、`storageDomain.open`、KvTable | 原有 Bot/group/notification sidecar 继续使用；任务核心优先保留上游同步事务及持久适配器，Host 仅协议访问核心 | [stores](../../../packages/dsh-bot/src/host/stores/domain.ts)、[上游 domain](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/storage/storage-domain/src/domain.ts)。本地类型：get 同步、put/delete/update 为 Promise；update 是单条原子 RMW，不是跨表同步 atomic。API-G07。 |
| Remote | `dsh-typert-protocol` 根入口的 `Remote/TypertRemoteService`，`dsh-typert-registry` 公开注册服务；Host 注册 contribution / Client `$mount` | 复用认证/编解码/namespace，新增窄 Remote 控制面；进程协议与浏览器 Remote 分开，不假定公开给 Client 的方法可无鉴权跨进程执行 | [Host](../../../packages/dsh-bot/src/host/index.ts)、[Client](../../../packages/dsh-bot/src/client/index.tsx)、[上游 Remote cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/cookbook/adding-a-remote-api.zh.md)。动态 mount 要 await、已有 namespace 不重复 mount；`ctx.get` 避免未声明 inject 访问。API-G09。 |
| UI | 原生 slots、View、会话/子任务/权限设置；本包注册公开 main/sidebar/header/composer 扩展 | 任务控制面在现有 UI 上加任务视图，执行过程继续原生；不复制会话 renderer、权限对话框和统计公式 | [Client](../../../packages/dsh-bot/src/client/index.tsx)、[上游 slots](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/subsystems/slots.zh.md)。仅 `--dsw-alias-*`、同键中英 locale；新 View/slot 组合在 rc.2 实测，亮暗、键盘、卸载是独立门槛 API-G09。 |
| Approval / 权限 | `dsh-user-approval`、原生 tool pre-execute/Commands/permission projection；现有 bot_delegate 强制 ask | 保留交互授权入口与后台来源防递归。自动动作必须持有受限授权快照并过 Host 校验；禁止伪造 source=user、改 child never 或自动答原生 ask | [guard](../../../packages/dsh-bot/src/host/delegate/guard.ts)、[tool](../../../packages/dsh-bot/src/host/delegate/tool.ts)、[上游 child](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent/src/child-agent.ts)。现有 child approval 固定 never；root 权限变更不等于已存在 child 热更新。API-G04。 |
| Data-flow | 本包 labels、lineage、grants、managed outlets，桥到原生 tools/Agent events | 所有新 Source 输入、派工、结果和通知都通过现有准入/来源继承/出口检查；不另建可绕开现有授权的核心“可信内容”通道 | [delegate outlet](../../../packages/dsh-bot/src/host/data-flow/delegation.ts)、[outlets](../../../packages/dsh-bot/src/host/data-flow/outlets.ts)、[labels](../../../packages/dsh-bot/src/host/data-flow/labels.ts)。这是本包能力，不是 DSH 原生安全隔离；unknown/no-egress 不能因收到 schedule 而清空。API-G04/10。 |
| Notifications / IM | 本包 Notifications intent、policy、receipt；`NotificationPort.describe/send`，`attachPort(ownerContext)` | 本地中心与策略复用；社区 dsh-im 候选桥接端口。Core Outbox 与通知 intent 建稳定映射；只指定一个重试调度责任方 | [service](../../../packages/dsh-bot/src/host/notifications/service.ts)、[schema](../../../packages/dsh-bot/src/shared/notifications.ts)、[前轮 dsh-im 合同](https://github.com/xmanrui/dsh-im/blob/main/PROACTIVE_DELIVERY.md)。Port send 的 attemptId 不是业务 operationId；sending 冷恢复为 unknown，不能盲重发。真实 IM 仍独立 FAIL/未测。API-G10。 |
| Connectors / credentials | `dsh-mcp-client` 根 Config/apply；`dsh-credentials` credentialRef/resolve/reference-updated；本包 managed connector | 沿用每 Bot MCP 隔离与凭据引用，能力探测不得发真实业务调用；主动 Source 只绑定已授权连接器，不新写各平台 SDK | [connectors](../../../packages/dsh-bot/src/host/connectors/service.ts)、[connector boundary](../../../packages/dsh-bot/src/host/data-flow/connector-boundary.ts)、[上游 MCP](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/mcp/mcp-client/src/index.ts)。busy 时 pending、维护窗口重建；撤权不保证撤回已发远端请求；API-G11。 |
| Memory / 反馈 | 本包 memory kernel/admission、每 Bot 记忆、reference-memory；原生 storage/systemPrompt/skill | 任务反馈写“候选”并复用版本/来源/遗忘；不重写已确认事实、不自动晋升技能，不把外部资料当指令 | [memory](../../../packages/dsh-bot/src/host/memory)、[reference-memory](../../../packages/dsh-bot/src/host/reference-memory/service.ts)、[bot-context](../../../packages/dsh-bot/src/host/bot-context.ts)。本包记忆不是 DSH 原生长期记忆；API-G11 验证归属、撤销与冷恢复，不宣称缓存命中或学习效果。 |
| Lifecycle | Cordis `ctx.effect`、Agent-owned effect、原生 activation/disposer/domain close | 原样复用所有权；进程连接/监听/超时/lease 纳入明确 owner，关闭先拒新单再 drain/abort/reconcile；不靠未跟踪 Promise 维持后台执行 | [Host close](../../../packages/dsh-bot/src/host/index.ts)、[delegate cleanup](../../../packages/dsh-bot/src/host/delegate/tool.ts)、[T02 生命周期核实](../../dsh-api-notes.md)。API-G12 验证插件卸载、进程关闭、迟到回报与原生子进程退出；超时必须 unknown。 |

## DeepSeek Engine 复用门槛

前轮已核实的候选是 [dsh-superagent-prototype 根导出](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/index.ts)、[core](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/index.ts)、[ports](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/ports.ts)和[环境实现](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/infra/environment.ts)。这些 main 链接是前轮引用，**本轮未重新下载、未获得可运行的锁定 revision，不能直接进入生产依赖**。

首选方案是复用 Engine 与其事务语义，通过独立协调进程或经过证明的显式隔离连接 DSH Host。协调进程拥有 Ticket/Assignment/订阅/effects/outbox；Host 继续拥有模型执行、Bot、原生 Session、工具权限与既有数据出口。核心 SQLite 数据库只由协调进程写，Host 不在 KvTable 中镜像一套可写 Ticket。

M0 必须交付上游完整 revision、许可证、依赖锁、入口导出清单和启动副作用清单。原型 package 是 private、根入口连到 Runtime、依赖含 alpha；不能把仓库可 import 推导成已发布稳定 SDK。先验证公开根导出能否在不加载 worker 环境的条件下实例化 Engine；若不能，则评估有范围、记录来源的上游核心封装或推动稳定入口。未经该评审不能通过 private/internal import 偷渡。

同 Host 共装仅是备选：必须证明生产依赖闭包不混入 alpha DSH 服务实例、不改 PATH/Git 环境、不安装宽权限 preset、不启动默认 Source/worker、不修改其他 Bot 的上下文。任一项无法证明，维持独立进程或停用自动执行，不能为了方便放宽当前宿主隔离。

`Repositories.atomic` 是同步核心事务契约。DSH `KvTable.update` 虽保证同一个 key 的排队 RMW，也不能把 Ticket、Assignment、effect/outbox 多表写入变成同一次同步提交。`Serial.run(async …)` 只能减少本进程并发交错；写到第二张表前崩溃仍可留下部分状态。API-G07 必须验证提交与外部副作用顺序以及 crash cut，而非仅验证顺序调用成功。

## 拟新增合同清单（均未实现）

下列是需在 M0 固化的语义操作名，不是当前已导出的 TypeScript 方法或 HTTP 路径；最终命名由合同文档统一。

| 新增薄层 | 拟定操作 / 必需字段 | 现有复用端与限制 |
| --- | --- | --- |
| CoreBridge / Source intake | 提交事件、查询受理；protocolVersion、sourceId、eventId、sourceRevision、payloadDigest、origin/labels、correlationId | 接原型 Engine ports；认证与幂等冲突显式返回。cursor 只在事件持久受理后推进；HTTP 200 不代表任务成功。 |
| Decision / assignment bridge | 读取决定、承接派工、报告阶段/结果；ticketId、assignmentId、executionId、lease/fence、operationId、policySnapshot | 任务与授权由核心关联，Host 最后一次校验 BotKey、权限/预算/来源和 provider 能力；不直接暴露交互 Groups.send 来充当后台入口。 |
| ExecutionAdapter | 能力报告、受限执行、取消请求/回执、查询原生执行事实 | 包装 groups/subagent/jobs；准确映射 childId/runId/sessionId，保留自动来源。缺 continuable 等能力则拒绝对应模式。 |
| Reconciliation | 双方游标/状态对账、过期 lease 处置、unknown 记录、迟到结果处理 | 读原生 Session/projections 与核心持久状态；不能仅凭日志文字恢复已完成事实，也不能把 unknown 自动重跑。 |
| Notification bridge | Outbox intent→稳定 operationId→Notifications intent；attemptId/平台回执映射、查询与显式重试决策 | Port 仍只 describe/send；业务重试不得绕过 Notifications.record 的去重/策略/数据流检查。默认 retryPolicy=none；retryOwner=core 只指定未来显式启用重试时的唯一决策责任，并不启用重试。核心可在首次发送前延后/合并，通知层只执行被授权的单次发送；failed/suppressed/unknown 均不默认自动重发。若需其他归属须先改合同。 |
| Read/control Remote | 读取任务/证据、批准受限动作、停止/暂停/恢复、反馈候选 | 复用 Typert 与原生风险确认；所有写请求带稳定 operationId 与 expected revision，read model 不成为第二权威。 |

每个新 runtime import 在实现时才更新 `docs/dsh-api-notes.md` 与依赖声明；本设计未新增 npm API 使用。按真实运行时共享实例需求决定 peer，不能把仅类型/Client 平台导入全部升级为 peer。

## 分阶段可执行小实验与失败退出

这些是跨阶段能力验收规格，不是 PB00/M0 一次实施清单。PB00 仅实施任务单 A–E 所列的静态、离线和隔离 Host 最小验证，使用 fake transport 与合成模型；生产 UI、完整生命周期和真实渠道按下表后续任务分别验收。缺失的可选能力保持 FAIL/CAPABILITY，但不阻断无关能力的限定放行。本文不要求提前申请真实渠道授权。本轮不创建运行代码、不声称下列命令已经成功。实验代码建议放 `spikes/proactive-bot/`，运行产物放当前工作树 `.dsh-dev/proactive-bot/`。复用已有 [mock-profile](../../../spikes/test-tools/src/mock-profile.ts)、[P34 fixtures](../../../spikes/p34/src/run.ts)与公开测试入口，避免从内部测试文件导入。新增 runner 应支持 `--gate M0-XX` 和 `--all`，逐 gate 写 JSON 收据与退出码；这两个参数当前尚不存在。

准备流程：在工作树执行 `scripts/pnpm install --frozen-lockfile`（需要时，由编排方安排），开发包必须保持 rc.2。用仓库 `scripts/dsh` 建全新隔离 Web profile；`DSH_HOME="$PWD/.dsh-dev"`，监听 `127.0.0.1`、随机端口、`--no-open`。配置先 dump 再启动，真实 Source/遥测/标题模型禁用，模型只允许 loopback mock，凭据为 fixture sentinel。不存在或不兼容的测试包不能用内部 import 补齐，记 FAIL。运行中一旦出现非 loopback 模型请求即失败并停止测试。

每份收据包含：Git/上游 revision、依赖版本、profile 标识、gate、输入 fixture 摘要、观察到的公开事件/状态、调用次数、预期/实际、PASS/FAIL、日志路径与清理结果；不得包含 token、原始用户数据或凭据。每项至少一次正向和一次拒绝/中断场景。

| Gate / 最小操作序列 | 必须观察到的结果（全部满足才 PASS） | 失败 fallback |
| --- | --- | --- |
| **API-G01 入口与隔离**：固定原型 revision；在独立进程加载公开根/选定封装，注入 fake Source/Worker/Notification/clock；启动前后采样自身 PATH/Git env 和进程/端口清单；记录依赖闭包。另在 fixture Host 验证精确 rc.2 namespaces。 | 无真实网络/worker/模型调用；不改父 Host env，不加载 alpha Host 服务共享实例；公开 API 缺席有明确 unavailable；同 Host 候选须另做同样验证。 | 原型入口不安全时保留离线观察规格；改用评审后的隔离封装候选重做门槛，禁止直接正式 profile 安装或自研核心。 |
| **API-G02 Bot 组合**：建 A/B 两 preset；读目录与 Skill fixtures；A 修改 persona/model/deny 后保留旧 idle Agent，再创建新 Agent；只向 mock 发一轮。 | A/B 身份、技能和限制隔离；旧代际不假装热更新；显式模型选择与 Bot 默认优先级符合现状；未知模型拒绝且真实模型调用 0。 | 停用自动分配受影响 Bot，提供现有手动会话；不回退其他模型或扩大工具集。 |
| **API-G03 执行事实**：创建 Session，queue 一条 mock 输入，分别观察 Inbox accepted、turn/end、fixture artifact 验收；再制造模型错误、输出裁剪和 job kill。 | 三层结果分别记录；错误/缺投影为 unknown/failed；kill requested 不直接标 stopped；外部费用不写入原生 token projection。 | 仅显示已确认阶段，关闭自动“完成”与后续动作；保留原生会话查看。 |
| **API-G04 授权与来源**：对 user/schedule/webhook/agent-message/subagent-settled 各输一条，尝试交互 bot_delegate；执行前撤销 grant/修改 Bot 生日/改变目标；child 请求 ask。 | 后台源不能走交互委派；user 路径原生 ask 仍生效；child never 拒绝；新 Host adapter 只执行授权快照内动作并保留来源；unknown/no-egress 不被洗白。 | 新后台 adapter 全部 disable，只记录候选/待人工；禁止改现有 guard、source 或 approval policy。 |
| **API-G05 Provider / Team**：读取 spawn 能力；分别将 agentPreset、agentOptions、depthLimit、prepareContinuable 缺一的 fixture provider 注入；用 mock spawn 分别测试初始执行、busy steer、idle 续聊、cold 续聊与单 child 取消；team 用独立 fixture，每种能力独立出结果。 | 缺能力在 dispatch 前拒绝且无 child；支持的同 child 多 activation 正确按 runId 收结果，取消不误杀兄弟；cold 必须同时证明 caller delivery 的恢复，不以 resume Agent 成功代替。Team 不接受不存在的 agentPreset 字段、不冒充跨 Bot。 | 按 start/busy/idle/cold 四项分别开放：cold FAIL 只禁止旧 child 自动冷续跑，保留已验证的初始 spawn 和明确批准的新 Assignment；既有不确定副作用仍先对账。外部 runner/Team 对应模式禁用，不能改名或偷偷继承父 preset。 |
| **API-G06 Schedule 语义**：原主会话创建单次/周期 fixture；观察 history→user message→turn；重复消费同 receipt；关闭 Host 跨过到期点，再启动读取原生实际处理。 | 投递仍指向原 sessionId；重复 occurrence 不建重复业务任务；Host 关闭期间执行数为 0；重启行为按真实原生规则记录；history receipt 持久化晚于入箱的窗口不会造成误认；不把 responded 当业务成功。 | 禁用 schedule→业务事件桥，保留原生提醒；不另起 heartbeat，也不承诺漏期补跑。 |
| **API-G07 核心持久性**：对同 eventId 并发提交、同 key 不同 digest 提交；在事务提交前/后、effect dispatch 前/后、ack 前后强制结束协调子进程并重启；Host 与核心断连。 | 单个业务任务身份；冲突拒绝；事务内实体/effect 一致；外部副作用只在提交后；不确定发送可辨认并对账，不能承诺外部 exactly-once。核心 store 单写者，第二 writer 拒绝。 | 观察模式、不派工；禁止以 KvTable 多 put 或 Serial 代替同步事务，也不自动重新执行 unknown。 |
| **API-G08 Source/webhook**：只用已认证本地 fixture；无认证/错误 scope/重复/乱序/过期事件；在核心不可用时提交并观察受理与 cursor。 | 无权限事件不入业务队列；相同 eventId/digest 幂等，冲突显式失败；cursor 不越过未持久受理事件；没有鉴权/持久确认的原生 webhook 组合不被标成功。 | 关闭该 Source，保留手动 fixture/观察导入；不编造原生 queue 或静默自建平台 SDK。 |
| **API-G09 Remote/UI**：通过真实隔离 Gateway 验证 mount/strict codec/conflict；两 Client 修改同 revision；断线重连；卸载再挂载；浏览器亮暗、中英、键盘操作。 | 无重复 namespace/slot；旧请求不覆盖新状态；缺能力显示 unavailable；UI 不伪造原生权限/任务成功；卸载后无轮询/订阅。截图与实际操作分别留证。 | 新 UI 写入口禁用，仅显示可确认状态；浏览器受阻写 FAIL，不能用类型/DOM 检查冒充。 |
| **API-G10 通知与数据出口**：fake Port 计数；同 Outbox ID 重复 admission；相同 operationId 不同正文；send 已受理但 ack 丢失后重启；策略撤销/目标 digest 改变/超时；真实适配器作为 M3 之后单独获授权的独立 gate，PB00 仅做能力探测/拒绝与零真实出站。 | Outbox→operationId→intent→attemptId 可追踪；unknown 不自动重发；仅一个重试 owner；策略/数据流在发前复核；accepted 不等于到达/已读；真实平台 gate 单独记录。 | 本地通知可保留，外推禁用；无真实适配器时平台 gate FAIL，不能用 fake Port PASS 覆盖。 |
| **API-G11 连接器与记忆**：两 Bot 共享模板但独立 credentialRef，busy 时轮换再 idle；撤权；导入不可信反馈候选并尝试跨 Bot 读、覆盖 confirmed 记忆，随后遗忘/重启。 | secret 不入配置/DTO/日志；busy 保持 pending，旧连接清理后才挂新连接；跨 Bot/来源限制生效；反馈不能自行变 confirmed，撤回后不被派工继续引用。 | 停用对应 Source/反馈写入与自动执行，保留现有人工记忆管理；不得回退为共享全局凭据/全局记忆。 |
| **API-G12 生命周期与对账**：执行/等待/发送各阶段卸载插件、终止 Host/协调进程；制造迟到回报、过期 lease、旧 generation 回报；再次挂载。 | 无残留端口/监听/子进程；关闭后不接新单；已发副作用不能撤回则标 unknown；旧 fence 不能推进新 assignment；恢复仅以双方持久事实对账，取消请求与确认分开。 | 自动执行保持关闭，呈现待恢复/待人工核对，不能以无限重试或新 Agent 覆盖不确定状态。 |

阶段映射与放行如下；PB00 的 P00-01–08 是其唯一完整退出表，下列 API-G 编号不取代任务编号。

| 能力 gate | PB00/M0 最小证据 | 后续完整验收归属 |
| --- | --- | --- |
| API-G01 / G07 / G12 | 公开入口、隔离、SQLite 回滚/单写者、合成派工/重载/强杀的最小路径 | PB01 固化协议；PB09 全故障矩阵/soak；PB11 部署升级 |
| API-G02 / G03 / G04 / G05 | 一条合成 Bot 执行及身份、授权拒绝、来源保真、provider 能力；cold 单独判定 | PB04 单 Bot；PB05 群与续聊；PB07 自动授权；PB10 外部执行器 |
| API-G06 / G08 | 原生入口静态合同与最小本地到期/来源探针，零真实来源 | PB02 摄取/游标/重复故障；不支持定时则只开放 fixture/人工刷新 |
| API-G09 | 仅最小 Host 合同/卸载，不要求生产工作台 | PB03 UI；PB06 验收 UI；浏览器门槛不得提前捆绑 PB00 |
| API-G10 | 只核对既有 intent/Port 合同及后台授权拒绝，零真实出站 | PB08 fake transport 全故障；真实 adapter 独立授权与收据，未测不阻断站内能力 |
| API-G11 | 现有数据标签/凭据/记忆入口的静态核对与必要拒绝 fixture | PB02 来源；PB07 撤权；PB12 反馈采用，分别按范围验证 |

M0 放行以 PB00 兼容结论和 PB01 最小封装为准；并不要求这里 12 项全部以最终产品形态通过。后台执行、Schedule Source、Webhook、UI、外部通知分别在对应任务通过完整 gate 后开启。观察模式也需来源/存储/数据流门槛，且原型 observe 可能运行研判；开发验证必须用离线 fixtures 与 fake ports，不能把 observe 当离线保障。

## 本轮交付检查

- PASS：仅新增本设计文件；当前业务实现、依赖和公开 API 未修改。
- PASS：逐项覆盖原生复用、已有本包能力、候选桥接、静态证据与失败退出条件。
- PASS：只读核对主仓已安装 rc.2 类型；明确缺失参考树、webhook 运行证据与原型锁定 revision。
- FAIL：API-G01 至 API-G12 均未执行；本文是可派发实验规格。
- FAIL：真实模型、真实 IM、桌面 UI、跨进程 crash/recovery 未验收；不得据本文宣称主动协作已上线。
- 仓库全套检查由本次设计包编排方统一执行；本文件不将其他分支历史检查结果记作本轮 PASS。
