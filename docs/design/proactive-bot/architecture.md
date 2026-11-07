# 主动式 Bot：实现前技术设计

状态：待实施设计。日期：2026-11-06。DSH-Bot 核对基线：`4a0aab4`，包版本 `0.6.4`；开发依赖锁定 DSH `0.2.1-rc.2`。本文中的“新增”“必须”“默认”均是实现约束，不表示功能已经存在或通过运行验收。

本文细化[前轮研究提案](../proactive-bot-and-superagent-proposal.md)，供开发拆分模块、实现契约和编写故障测试。[总入口](README.md)、[产品与默认值](product.md)、[原生能力复用清单](native-reuse.md)和[验证方案](validation.md)共同构成实现前约束。当前 `docs/PLAN.md` 保留历史实施安排，不能把其中旧 Routine 方案当作本方案重新自建时钟的依据。

## 1. 决策与实现边界

首选业务核心是 DeepSeek MIT 研究原型的 Engine。保留它已有的 Source、Trigger、Thread、Eval、Decision、Mandate、Ticket、Assignment、持久 effect/outbox 语义；DSH-Bot 新增来源适配、受限 Host 执行桥、验收扩展和呈现。Bot 身份、preset、模型、工具、技能、原生 Session、subagent、现有群执行、schedule、Remote、slot、权限和数据流继续复用。

默认部署为**独立协调进程 + 原有 DSH Host**：协调进程拥有业务核心与 SQLite；Host 拥有 DSH 运行资源、原生会话、Bot 配置、通知传输收据和数据流策略。协调进程不加载原型完整 worker/preset，不另跑一套模型 runtime。同 Host 加载只可在 M0 证明依赖、环境副作用、阻塞和卸载均安全后另作决定。

这不是重新设计一个通用 Agent framework。新增契约围绕少数跨进程边界，优先翻译为原型现有命令；不为每个上游实体重写仓储、调度器和状态机。若原型确有缺口，仅在它的单一核心写入路径做有范围的扩展；范围扩大时回到评审。

### 1.1 M0 必须先固定的事实

前轮研究发现原型公开根入口导出核心，但其 package 为 private，根入口关联 Runtime，含 alpha 依赖。**本设计尚未固定可部署的上游 commit，也没有证明其可直接加载。** M0 交付固定 commit/hash/许可证清单、根入口加载记录、依赖树、环境副作用测试、SQLite 驱动和平台矩阵，再冻结 adapter。

允许路线依次为：公开根入口加替身 ports；上游正式支持的稳定核心门面；明确记录改动的 MIT 源码封装。禁止业务代码从 `src/core/*`、DSH 内部路径或未公开仓储字段深路径导入。源码可用于核实行为；若需维护封装，许可证与补丁必须可追踪，不把私有路径换名后宣称是公共 API。

官方管理 HTTP 的设置、状态、stop/retry 不能推导出本文所需的 submit/report/review API 已存在。本文 TypeScript 和 IPC 命令全部是 **DSH-Bot 拟新增内部契约**；只有 M0 对照公开入口确认后才能写出真实 Engine 调用。无法通过公开入口完成的操作记录为 capability gap，不用直接改数据库绕过 Engine。

### 1.2 现有代码约束

| 已核对位置 | 当前行为 | 对实现的要求 |
| --- | --- | --- |
| [delegate/guard.ts](../../../packages/dsh-bot/src/host/delegate/guard.ts) | 后台来源和子会话不能再次 `bot_delegate` | 保留；新 Host execute 不冒充交互式工具调用 |
| [groups/turns.ts](../../../packages/dsh-bot/src/host/groups/turns.ts) | `send` 写入 `source.kind='user'`，处理人工上传收据 | 自动派工不能直接复用这个入口；抽取内部执行准入并新增来源保真的入口 |
| [groups/state.ts](../../../packages/dsh-bot/src/host/groups/state.ts) | Serial 队列串行，多个 `KvTable.put` 分别 await | 队列不是跨表事务；维持恢复语义，不接到同步 `Repositories.atomic` |
| [notifications/service.ts](../../../packages/dsh-bot/src/host/notifications/service.ts) | intent 用 operationId 去重；Port 只有 describe/send；冷恢复 sending→unknown | 复用 intent；不可绕过它直接调 Port；不假设 Port 有 query/retry API |
| [shared/notifications.ts](../../../packages/dsh-bot/src/shared/notifications.ts) | source kind 当前仅 tool/manual-run/group-turn/schedule | 如关联主动 outbox，新增兼容的 proactive 来源字段和 codec，不冒用 manual-run |
| [data-flow/labels.ts](../../../packages/dsh-bot/src/host/data-flow/labels.ts) | 读者取交集，限制和来源取并集，trust 降级，grant 不扩张 | 任务正文、证据、结果继承同一标签语义 |
| [API 记录 V050](../../dsh-api-notes.md#v050自然群聊后台任务和能力入口2026-10-28) | rc.2 coldResume 不接收 caller delivery；受管恢复需要原 caller 租约 | 进程重启不能直接 coldResume 再宣称受检回传仍成立 |

上述为静态依据。当前安装的 CLI 版本、真实 Host 组合和新入口必须在独立隔离 profile 再验，不继承旧版本运行证据。

## 2. 唯一权威与系统边界

| 对象/事实 | 唯一写入权威 | 其他位置允许保留 | 禁止的复制 |
| --- | --- | --- | --- |
| Bot 身份、代际、preset、私有记忆 | 现有 DSH-Bot registry / memory | 核心存精确 BotKey、配置版本和引用 | 核心自建 Bot 配置库或将旧代际授权套给同名 Bot |
| 职责规则、Source 定义/游标、来源事件 | 核心 SQLite，经 Engine/adapter 受理 | Host 临时抓取页、无正文摄取收据 | Host 与核心分别推进独立业务游标 |
| Thread / Eval / Decision | Engine | UI 只读建议投影，缓存带核心序号 | CandidateStore 与 TaskService 双向同步 |
| Mandate、Ticket、Assignment、业务预算 | Engine，最小扩展仍在同一事务域 | Host 保存受理关联和动作围栏 | Host 收据声明业务任务验收成功 |
| 原生运行、工具事实、群 turn/delivery | DSH Session 与既有群执行收据 | 核心只保存准确 run/session/turn 引用及结果摘要 | 将原生日志整份复制为任务账本 |
| 验收规范、证据索引、评审决定 | 核心内 Ticket 关联记录 | UI 展示、Session 引用 | UI 单独维护一个完成/返工状态机 |
| 撤销意图与任务授权 | 核心 Mandate/Policy；Host 动作围栏可额外拒绝 | Host 持久 deny epoch 是执行约束，不是第二份允许授权 | 旧缓存允许在核心失联后继续新副作用 |
| 业务通知意图与何时发 | 核心 Outbox | Host 保留 outboxId→operationId 映射 | 新增另一业务通知队列重复排程 |
| 是否尝试发送、传输结果 | 现有 Notifications intent/receipt | 核心关联其 revision、attemptId、结果 | 将核心超时视为发送失败后重发 |
| 原生 Team task | 原生 Team | 可选 native task ID 引用 | 再造第三任务板并宣称它与 Ticket 同为权威 |

Ticket 是唯一业务工作身份；Assignment 是一次承接；Session 是一次或多次运行的容器。一个 Ticket 可有多个 Assignment 和多个证据版本。现有后台任务/群活动仍展示运行，新增任务视图按 Ticket 聚合它们；无需把所有普通对话与既有后台任务导入 Ticket。

### 2.1 进程与数据流

```text
原生 schedule / 已认证 webhook / 只读 Source / 用户决定
                         │ 版本化 IPC
                         ▼
协调进程：Engine + SQLite + Source checkpoint + business outbox
        │ Execute / Cancel / Notify          ▲ Receipt / Result / Review
        ▼                                   │
DSH Host：Proactive bridge + 动作围栏 + 幂等受理收据
        ├─ 现有 Bot / subagent / group runner / native Session
        ├─ 现有 data-flow / tools guard / native permissions
        └─ 现有 Notifications → NotificationPort → 外部渠道

Client → 已鉴权 DSH Remote → Host → 协调进程
Client ← 带核心序号的只读投影；真实执行过程仍取原生 Session
```

独立进程默认通过本机受限 IPC 通信：优先由 Host 启动子进程并使用继承的专用管道；若部署需要 Unix socket，目录权限 0700、socket 0600，使用启动期随机能力凭据，凭据不进任务正文/日志/Remote。首版不开放公网 TCP API。连接验证 protocolVersion、coreInstanceId、Host installation ID 与持久 storeId，进程 bootId 只用于诊断，不当业务幂等键。

协调模块按设计只读取其数据库和受管 artifact 目录，不提供任意 shell 执行接口，启动时不传入模型密钥或渠道凭据。但默认协调进程与 Host 使用同一操作系统用户，依赖和环境隔离不等于 OS sandbox；模块约束不能保证进程无法读取其他同用户文件或继承未清理的环境变量。M0 必须核对启动环境与依赖副作用；若部署需要文件系统、网络或凭据的强制隔离，应采用并验证独立用户/容器/系统沙箱等实际部署机制后再声明该边界。Host 校验每条 IPC 的 schema、大小、目标和方法白名单；IPC 可达不等于业务授权。业务数据仍需标签校验。远程常驻部署是后续能力，不因设计本地 IPC 即宣称支持跨机器。

### 2.2 拟增文件树与现有模块改动点

以下是实现落点建议，均未新增运行代码；最终包名在 M0 固定，业务核心不重复实现。

```text
packages/proactive-coordinator/             # 私有独立进程；非第二个可安装 DSH bundle
  src/main.ts                              # 生命周期、IPC、单实例锁
  src/engine-adapter.ts                     # 唯一上游根入口接线
  src/repositories.ts                      # 官方 SQLite 适配接线；非重写仓储
  src/commands.ts                          # 校验、幂等 inbox、Engine 命令翻译
  src/review-extension.ts                   # 若 M0 必要，核心内单生命周期扩展
  src/sources.ts                           # Source 准入、游标和归并策略
  src/effects.ts                           # 持久 effects/outbox 派发与对账
  src/migrations/                          # 封装扩展 schema 升级
packages/dsh-bot/src/shared/proactive/
  protocol.ts / schemas.ts                  # 协议 v1、严格 runtime codec、受限 DTO
  evidence.ts                              # PB06 证据 DTO/schema；不读取文件或授权
packages/dsh-bot/src/host/proactive/
  index.ts / config.ts                     # ctx.effect 注册，Config + schema
  coordinator-client.ts                    # IPC、重连、能力握手
  service.ts / remote.ts                    # 业务查询/决定入口；无第二任务仓储
  receipts.ts                              # 异步 Kv 受理行、结果回传和 deny epoch
  sources/ci.ts / sources/native-schedule.ts
  execution.ts / authorization.ts           # Host 受限派工与动作前检查
  notification-bridge.ts                    # outbox 与现有 intent 对账
  evidence.ts                              # PB06 Host 受管 artifact 读取、授权与版本检查
packages/dsh-bot/src/client/proactive/       # 只读投影及明确动作；交互详产品设计
packages/dsh-bot/tests/proactive/            # 契约、原生组合、崩溃注入
spikes/proactive-bot/                       # M0 离线加载和 SQLite 故障探针
```

有范围地修改现有 `groups/turns.ts` / runner，抽取“已校验输入→持久 turn→启动”的内部函数；交互式入口继续创建 user source，后台入口使用公开自定义 MessageSource 类型和 Host 绑定。`delegate/guard.ts` 不删除后台递归保护。通知 schema 增加 proactive 关联；现有 intent/recover/Port 不更换。bot-context/data-flow 的入口接线复用既有标签，需按真实缺口评估新增 API 记录。locale 中英文同键。build/exports 只增加确需的入口，Host runtime import 再按 AGENTS 规则决定 peer；不将原型 alpha 包传播到 DSH Host 的共享实例空间。

### 2.3 单 bundle 打包与协调进程启动契约

`packages/proactive-coordinator` 是开发期私有构建单元，不要求用户另装 workspace 包。发布时将其可执行 JavaScript、必要非代码资源、依赖清单和许可证构建到 `dsh-bot` 包内的受管目录，建议 `lib/proactive-coordinator/`，由既有单 bundle tarball 一并交付。入口相对于已安装包解析；发布产物不得依赖开发仓库源码、workspace 链接、开发机 `node_modules` symlink 或未打包文件。协调依赖需要内联或以可验证的私有闭包随包提供；原型 alpha 依赖不得通过 Host runtime import 进入其 Cordis/DSH 服务实例空间。

M0 固定官方 SQLite 适配所需驱动、精确版本、Node ABI 与各目标平台的构建/安装方式，验证真实事务和恢复语义；不能默认 `node:sqlite` 与官方适配等价，也不能先把原生二进制标 external 再假设用户机器已有。存在 native addon 时，必须明确预构建产物来源、校验摘要、平台支持和无匹配 ABI 时的拒绝行为；不在正式启动阶段临时联网编译或安装依赖。

启动前先评估锁定版本 DSH 原生 jobs 的公开能力是否支持长期协调进程所需的双向 IPC、准确进程归属、退出/信号、重启对账和 unload 清理。若足够则复用；若不足，M0 记录具体缺失能力和源码/探针证据，再使用最小受控 spawn，并由 `ctx.effect` 持有进程、IPC、超时与 disposer。该进程仅承载业务协调，不提供通用作业注册/工具执行/模型 runtime，避免形成第二套 jobs 系统。

解释器来自已核实的原生 runtime 能力，或明确配置并通过版本/能力探针验证的 Node 可执行文件；启动前验证所需 ESM、SQLite 驱动与 IPC 能力。不得硬编码开发机器路径，也不得盲用 Electron 环境的 `process.execPath` 当作普通 Node。验证失败只禁用主动协调并报告原因，不能降级到未经核实的解释器。启动环境显式构造最小允许集合，不将 Host 凭据环境全量透传。

M0 验证打包与启动可行性，PB01 冻结构建/启动契约并执行独立 tgz 冒烟；对应发布任务再次以最终 tgz 验证：在仓库内全新隔离安装目录、无源码/workspace 链接条件下启动核心，加载真实锁定 SQLite 驱动，完成离线命令与重开数据检查，再验证 Host unload 后进程和 IPC 释放。各声明支持平台/ABI 逐项记录结果；未覆盖平台不得从单机结果推导兼容。仅在源码树运行通过不足以关闭此门禁。

## 3. 数据契约与版本

所有时间为 UTC epoch milliseconds，界面时区仅用于展示/策略；ID 为不含正文的稳定 opaque string。跨恢复身份不使用 PID、数组下标或本地时间单独生成。每个可修改对象有 schemaVersion、revision、createdAt、updatedAt；每个事件有不可变 eventId、occurredAt、receivedAt。协议版本、存储版本、规则版本、证据版本、Bot 代际分开，不用一个 version 混合。

### 3.1 对象字段清单

| 对象 | 必需字段（除公共元数据） | 约束 |
| --- | --- | --- |
| Responsibility | id, owner: BotKey, title, scope, sourceIds, predicates, allowedActions, mode, policyRevision, validity, budgets | 自然语言不是 scope 校验器；产品 mode 仅 off/suggest/auto；关闭不删除历史 |
| Source | id, kind, connectionRef, scopeDigest, generation, filterRevision, enabled, checkpoint, lastHealthyAt | 凭据仅引用；checkpoint 是来源不透明位置；generation 区分重绑范围 |
| SourceEvent | eventId, sourceId/generation, nativeId, nativeRevision, eventType, subjectKey, origin, evidenceRefs, contentDigest, label, occurredAt/receivedAt | eventId 去重；subjectKey 归并；revision 不可比较时使用来源 ETag/快照 hash |
| Thread | id, subjectKey, responsibilityId, sourceRefs, currentTicketId?, lastEventSeq | 继承 Engine 归属与 batching；不得用模型自行命名当可靠键 |
| Eval / Decision | evalId, threadId, coveredEventIds, policyRevision, evidenceRevision, result, rationaleRef, proposedAction, expiresAt | result 为原型 accept/stop/ignore/unavailable；建议是只读 decision 投影 |
| Mandate / TaskGrant | id, ticketId, owner, issuer, policyRevision, scopeDigest, actionSet, targets, dataScope, expiresAt, budgetRef, revocationEpoch | 部分为本部署扩展；M0 映射原型已有字段，不声称原型全部已支持 |
| Ticket | id, threadId, owner, objective, scopeRef, mandateId, acceptanceSpecId, currentAssignmentIds, lifecycleRevision, reviewRevision, terminalReason? | 单一生命周期；不可由 UI 或 Host 直接 set status |
| Assignment | id, ticketId, ordinal, executionKind, targetBot/group, grantId, inputDigest, evidenceRevision, expectedMembershipRevision?, cancelEpoch, executionRefs | 重试/返工生成新 assignmentId；重复派发沿用原 ID |
| ExecutionReceipt | assignmentId, effectId, commandId, payloadDigest, phase, revision, bot/group identity, reservedChildId?, session/run/turn IDs, policyFence, resultRef?, lastAckSeq | Host 权威运输/运行收据；phase 不代表 Ticket 验收 |
| AcceptanceSpec | id, ticketId, version, requiredCriteria, reviewerPolicy, artifactConstraints | 首次接单冻结；变更需明确命令，旧证据不静默适配新标准 |
| EvidenceManifest | id, ticketId, assignmentId, resultVersion, artifactRefs, checks, environment, sourceRevisions, label | 原生证据分层；hash/产物版本/工具与退出码可追踪；无明文密钥 |
| ReviewDecision | id, ticketId, specVersion, resultVersion, reviewer, verdict, itemResults, reason, supersedes? | verdict=accept/rework/reject；精确引用被审版本；执行者不可自签人工通过 |
| CoreOutbox | id, ticketId?/decisionId?, purpose, recipientRef, bodyRef/digest, label, attentionBucket, notBefore, expiresAt, policyRevision, operationId, status | 一项业务意图一个 ID；正文更新是新 revision，经重验后重新授权 |
| NotificationLink | outboxId, operationId, notificationRevision, attemptId?, observedState, targetDigest, payloadDigest | Host 关联表可重建；真实传输结果仍在现有 intent/receipt |

原型已经有的实体与字段以固定 commit 为准。上表是所需语义，不要求逐表复制；`engine-adapter` 的字段映射表必须指出“直接复用/扩展/仅投影”。只有验收规范、证据索引、TaskGrant 细分约束等缺口新增核心关联数据。

### 3.2 TypeScript 边界示例

以下是拟新增协议示例，省略 codec 实现；实现必须采用共享 strict schema 验证外来 JSON，不允许 `as` 替代校验。`BotKey` 和 `DataLabel` 使用本仓库现有共享定义，其他名称不是 DSH 服务。

```ts
import type { BotKey } from '../identity.js';
import type { DataLabel } from '../data-flow.js';

type Id = string;
type Action = 'read' | 'analyze' | 'prepare-patch' | 'test' | 'notify';
type NativeRef = {
  sessionId: Id;
  childId?: Id;
  runId?: Id;
  groupTurnId?: Id;
  groupDeliveryId?: Id;
};
type ArtifactRef = {
  id: Id;
  storage: 'managed-local' | 'native-attachment' | 'approved-remote';
  locator: string; // 受管相对位置/原生 attachment 引用，不是任意宿主路径
  sha256: string;
  bytes: number;
  mediaType: string;
  producer: { assignmentId: Id; execution: NativeRef };
  label: DataLabel;
};
interface TaskGrantV1 {
  schemaVersion: 1;
  id: Id;
  ticketId: Id;
  owner: BotKey;
  policyRevision: number;
  revocationEpoch: number;
  actions: Action[];
  targetDigests: string[];
  dataScopeDigest: string;
  expiresAt: number;
  budgetReservationId: Id;
}
interface ExecuteRequestV1 {
  assignmentId: Id;
  effectId: Id;
  owner: BotKey;
  grantId: Id; // Host 查询/核实当前授权；不信任来报的允许位
  inputRef: Id;
  inputDigest: string;
  label: DataLabel;
  execution: { kind: 'single-bot' } | {
    kind: 'existing-group'; groupId: Id; groupCreatedAt: number;
    expectedMembershipRevision: number; memberIds: Id[];
  };
  origin: { kind: 'proactive'; sourceEventIds: Id[]; responsibilityId: Id };
  expectedRevocationEpoch: number;
}
type ExecutionPhase = 'admitted' | 'starting' | 'running' | 'result-pending'
  | 'reported' | 'cancel-requested' | 'cancelled' | 'unknown' | 'rejected';
interface ExecutionReceiptV1 {
  schemaVersion: 1;
  assignmentId: Id;
  effectId: Id;
  payloadDigest: string;
  revision: number;
  phase: ExecutionPhase;
  references: NativeRef[];
  reservedChildId?: Id;
  resultDigest?: string;
  reasonCode?: string;
}
```

`ArtifactRef.locator` 不授予读权限。Host 重新校验路径 realpath、symlink、归属根、大小及标签；远程引用只允许已配置连接器与目标。外部文件变化后 hash 不符的证据显示 stale，不能继续用于接受。文件 hash 证明版本，不证明内容正确。

### 3.3 敏感数据与出处

复用 DataLabel 的 readers、originTrust、sourceVersions、restrictions、grants。来源内容默认 candidate；认证只证明来自哪个服务，不证明正文中的指令可信。证据读取累积标签；合并读者取交集、限制和来源取并集、trust 取低值；grant 不做并集。摘要、检索索引、模型输出、通知正文均保持派生标签，不能通过“只保留总结”洗掉限制。

凭据不进核心数据库。正文按引用和保留窗口保存，审计日志只记录 ID、摘要 hash、reason code 和必要元数据；日志错误不直接打印外部响应体、prompt 或带 token URL。读取投影在 Host 过滤读者权限；未授权内容不得先发给 Client 再隐藏。数据失效和遗忘通过现有管理机制传播到证据、待发通知及模型输入引用。

## 4. 生命周期与状态转换

### 4.1 来源、研判与建议

Source：`disabled → catching-up → healthy`，失败进入 `backoff`，认证/范围失效进入 `needs-attention`；关闭进入 disabled 并停止新抓取，已持久事件保留审计。watch 是 Source 条件/检查计划，不是第五种 Decision。

Eval 沿用 Engine 的串行/批处理语义；同 Thread 的覆盖事件集合与 Eval 版本唯一。Decision 的 accept/stop/ignore/unavailable 保持原义。产品 suggest 模式下有潜在接单意愿的决定生成只读 SuggestionView（decisionId、evidenceRevision、expiry、reason）；不预建一份 Candidate Task。产品 mode 统一为 off/suggest/auto；原型 observe 只是核心适配选项，不是第四个产品模式。M0 核实 suggest 如何映射原型 observe/would-accept，并在适配层阻止未获接受的新主动执行；不能因原型 observe 仍允许某些明确请求就放宽产品语义。

“接受建议”提交 `accept-decision`：重读最新来源证据、职责、策略、Bot 代际和预算。仍有效才通过 Engine 创建或关联唯一 Ticket；已变更返回 stale/conflict 和最新投影。忽略记录原 Decision 对应的用户反馈；稍后更新 Source 再检查时间或呈现时间，不捏造已接单任务。一次双击接受只产生一次接单结果。

### 4.2 Ticket 与验收：M0 的关键决策

下表定义产品必须具备的**规范生命周期**，不是声称原型已有同名 enum。M0 必须输出每一行对应的 Engine 命令/事件，以及它如何写入同一 Ticket。原型 ready/ended 可能直接结束 Ticket；未解决此映射前不进入 M2。

| 从 | 命令/事实 | 到 | 条件 |
| --- | --- | --- | --- |
| 无 Ticket | 接受建议 / 有界规则命中 / 明确目标 | accepted | Engine 接单事务创建 Mandate、Ticket、首 Assignment/effect；引用已冻结验收规范 |
| accepted | Host 受理且 native run 开始 | active | 收据匹配 assignment、owner、grant；仅受理不能显示正在执行 |
| active | 等待 CI/输入/外部结果 | waiting | 登记 Source/订阅及期限；释放模型轮次，不忙等 |
| waiting | 新的可处理输入 | active | 原 Ticket 新 Assignment 或受管续输入；重验预算/授权 |
| active | 执行结束且结果与证据清单齐全 | review-required | 原生 ended/ready 只是触发评审检查；不能直接 accepted-result |
| review-required | 人工接受，或已明确授权的确定性验收策略通过 | accepted-result | 当前 spec/resultVersion 匹配；必需项有证据，独立 reviewer 有权限 |
| review-required | 返工 | active / waiting | 在原 Ticket 新增 resultVersion、Assignment；保留旧评审 |
| 任意非终态 | 撤销/取消 | cancelling → cancelled | 先禁新动作，再尽力取消，收据记录已发生/未知；晚到结果不复活 |
| 任意非终态 | 预算不足/能力缺失/证据无法对账 | blocked | 明确原因和恢复动作；不自动等同失败或通过 |
| 任意非终态 | 明确失败决定 / 范围关闭 | failed / rejected | 终止原因可追踪；需要用户接受部分结果时另有明确评审 |

首选用原型可支持的“结果待处理/等待输入”语义维持非终态；如果公开能力不支持，在核心一处最小扩展 hold-for-review 与 rework 命令，并持久化在同一 SQLite 事务域。**不允许** Engine ended 后 UI 另挂一个可写“仍运行中”状态来掩盖冲突，也不为返工创建无关联的第二任务。

accepted-result、cancelled、failed、rejected 为首版终态。验收前返工保留原 Ticket；验收后新要求创建显式 successor Ticket，并保留 relation，避免篡改已接受历史。如果用户要求重开已验收工作，需要新增可审计 reopen 决策和 M0 能力验证，首版不隐式重开。

### 4.3 执行状态与业务状态分开

Host receipt 的 `admitted` 表示持久受理，`starting` 表示准备调用 native，`running` 要有准确 activation/run 引用，`result-pending` 表示结果已持久待核心确认，`reported` 表示核心已持久受理回报。原生 stopReason 单独保存，不把 `reported` 或 `stopReason='completed'` 映射为验收通过。

`starting` 与 `running` 崩溃后先对账，不能通用地重置成 admitted 再启动；无法证明 native 副作用未发生时为 unknown。取消可发生于任一未终结 phase；reported 后晚到 cancel 是业务范围决定，不能删除已执行事实。

## 5. 命令、事件与幂等协议

协议采用请求/回执 + 可重放的增量事件；传输至少一次，处理尽量按稳定键幂等。**不承诺跨 SQLite、异步 Kv 和外部服务 exactly-once。** 同一幂等键不同 payloadDigest 必须 conflict，不能“后到覆盖”。

```ts
// 全部是拟新增内部协议；不是 DSH Remote 或原型既有 HTTP 接口。
type CommandBody =
  | { kind: 'ingest-batch'; sourceId: string; generation: number;
      expectedCheckpointDigest: string; nextCheckpoint: string; events: unknown[] }
  | { kind: 'accept-decision'; decisionId: string; expectedEvidenceRevision: number }
  | { kind: 'execute'; request: ExecuteRequestV1 }
  | { kind: 'report-result'; assignmentId: string; receiptRevision: number;
      resultDigest: string; manifestId: string; references: NativeRef[] }
  | { kind: 'cancel'; ticketId: string; cancelEpoch: number; reasonCode: string }
  | { kind: 'review'; ticketId: string; specVersion: number; resultVersion: number;
      verdict: 'accept' | 'rework' | 'reject'; reason: string }
  | { kind: 'notify'; outboxId: string; operationId: string; payloadDigest: string };
interface CommandEnvelope {
  protocolVersion: 1;
  commandId: string;
  storeId: string;
  actorRef: string; // 来自受信通道映射，不接受模型自报 actor
  expectedRevision?: number;
  payloadDigest: string;
  body: CommandBody;
}
type FailedCommandReply =
  | { scope: 'core' | 'host'; status: 'rejected'; commandId: string;
      code: 'invalid' | 'forbidden' | 'conflict' | 'stale' | 'unsupported' }
  | { scope: 'core' | 'host'; status: 'unknown'; commandId: string; reconciliationKey: string };
type CoreCommittedReply = {
  scope: 'core'; status: 'committed' | 'duplicate'; commandId: string;
  receiptId: string; committedSeq: number; // 仅核心 SQLite 提交事件水位
};
type HostReceiptReply = {
  scope: 'host'; status: 'admitted' | 'duplicate'; commandId: string;
  receiptId: string; receiptRevision: number; // Host Kv 收据版本，不是核心事件序号
};
type CommandReply = CoreCommittedReply | HostReceiptReply | FailedCommandReply;
interface CoreEvent {
  protocolVersion: 1;
  storeId: string;
  seq: number;
  eventId: string;
  aggregate: { kind: 'ticket' | 'decision' | 'source' | 'outbox'; id: string; revision: number };
  kind: string;
  bodyRef: string; // 读取仍经过授权，不把敏感正文广播
}
```

真实实现的 `events` 和 `kind/body` 使用判别联合与 strict schema，此处 `unknown[]` 表示边界待解析，不允许原样落库后信任。核心摄取、决定、结果和评审命令返回 CoreCommittedReply；Host execute/notify 受理返回 HostReceiptReply，只证明对应收据已持久。两类水位不可互换，Host ACK 不推进 CoreEvent 消费水位；核心收到并提交 Host 回报后才产生自己的 committedSeq。actorRef 必须由已鉴权 Client Remote/Host 能力上下文补齐；普通 `source.kind='user'` 或模型文本不是可信人工证明。授权 UI 请求走明确管理方法；同方法若暴露模型工具，必须另加原生审批路径，不能继承 UI caller 权限。

| 操作 | 幂等键与冲突域 | 应答含义 |
| --- | --- | --- |
| ingest-batch | sourceId + generation + checkpoint-before + page digest | 覆盖事件及 nextCheckpoint 在核心同事务提交 |
| 单来源事件 | sourceId + generation + nativeId + nativeRevision | 同 ID 改正文报警/隔离；不静默改旧事实 |
| 接受建议 | decisionId + evidenceRevision + operationId | 同次操作重复返回同 Ticket；不同操作并发由核心 Thread/Ticket 约束去重 |
| execute | effectId、assignmentId、payloadDigest | Host 已持久收据；不代表 native 已开始 |
| report-result | assignmentId + receiptRevision + resultDigest | 核心 result 与后续 effect 同事务；重复不重复评审/通知 |
| review | ticketId + specVersion + resultVersion + operationId | CAS 当前评审版本；旧结果的接受不能覆盖新返工 |
| cancel/revoke | ticketId/grantId + 单调 cancel/revocation epoch | 重复安全，较小 epoch 无效；取消完成另有收据 |
| notify | coreOutboxId → 稳定 operationId | 返回现有 intent；不同正文/来源/目标冲突 |

commandId 在业务操作首次提交前生成，重连沿用；明确修改操作才生成新 ID。上表 UI 接受建议/评审的 operationId 就是该次管理动作持久使用的 `CommandEnvelope.commandId`，不另设第二标识；双击、刷新后的重试和查询均沿用它。通知 operationId 则由核心 outbox 独立稳定派生并持久化，用于现有 Notifications intent，不能与其 IPC commandId 或单次传输 attemptId 混淆。使用标准 canonical encoding 计算 digest，不依赖 JSON 键偶然顺序；字段默认值标准化。IPC 超时返回 unknown，发送者查询 receipt，不能换 commandId 重发造成第二动作。

事件增量按 storeId/seq 消费，客户端仅在成功应用后更新本地水位；允许重复，禁止倒序覆盖较新 revision。超过保留窗口返回 snapshot-required，从一致快照及其 seq 恢复。实时通知只作刷新提示，丢通知不丢业务状态。CoreEvent 是投影更新流，不替代原生 Session 事件。

## 6. SQLite、Host Kv 与副作用提交

### 6.1 核心事务

原型 `Repositories.atomic` 为同步事务接口，保留官方 SQLite 适配及其真实 transaction 语义。每次准入在一个事务内提交：命令 inbox 去重记录、领域变化、预算预留、effects/outbox、事件序号/结果回执。Source 游标只在同一事务中提交全部覆盖事件后推进。事务内禁止 await、调用模型、网络、Host、文件工具和通知；副作用仅在提交后派发。

数据库位置来自实例数据目录 Config；开发位于当前仓库 `.dsh-dev`。禁止 Host 直接打开同一 SQLite 或以 Kv 镜像覆盖。协调进程持有单 writer 锁，记录 storeId/schemaVersion，锁丢失后停止派工；文件锁能力、WAL/同步级别、备份方式由 M0 实测，不能单靠 PID 文件证明无双主。默认不降低持久性换速度；数据库磁盘满/写失败进入 degraded，停止新准入。

### 6.2 Host 收据

Host 使用公开 storageDomain/KvTable，所有 put await；Serial 仅保护进程内顺序。尽量把一次受理的关键字段放同一 receipt 行；跨行失败通过阶段和查询修复，绝不宣称原子。

派工顺序：

1. 核心事务创建 Assignment 和 execute effect；提交后派发稳定 effectId。
2. Host 验证协议、Bot 代际、职责/TaskGrant、native 权限和数据范围；查同 assignmentId 收据，重复只返回现有状态。
3. Host 预留准确 childId/执行关联，持久 admitted 收据与 payloadDigest；没有持久成功不启动 native。
4. Host 写 starting，执行前再次检查围栏；经原有 subagent/group 能力启动，记录真实 session/run/turn 标识。任何中间错误先持久分类；unknown 不释放为可重试队列。
5. Host 将结果摘要和证据引用持久为 result-pending，再报告核心。核心提交 result 并确认 committedSeq 后，Host 标记 reported。
6. 任一应答丢失，使用 assignmentId/effectId 查询对账。Host 收据与 native 事实不能解释时阻塞，不能用“没查到 Agent 对象”证明从未执行。

Host 若在 native 调用返回与收据写入之间崩溃，只有预留 childId/现有原生或群收据能证明归属时才可补链。M0 应实测 startActivation 的 childId 可检索性和结果保留窗口；没有公开可靠对账能力的动作保持 unknown 并要求明确处理。一个启动 lease 过期不代表副作用不存在。

### 6.3 单写者与背压

核心同 Thread Eval 串行，执行并发按 Bot、项目和全局预算控制，沿用现有群内部并发。Host 同 assignmentId 串行受理。一次只能有一个核心连接拥有某 storeId 的派工租约；连接重建后先握手/对账再派发。租约只是避免并发执行，不替代幂等记录。

队列长度、最大事件页、正文 bytes、并发、超时、预算、保留期均进入 Config/schema。达到上限返回明确 backpressure，不丢事件后推进游标，不无限堆内存。全局与新职责默认关闭；来源可预览并保存为禁用，启用后默认建议模式。并发、日额、候选有效期、冷却、静默时间的提议默认值统一由[产品设计](product.md)定义，不在适配器重复硬编码。首次启用明确时区；真实模型预算未配置或缺计量能力时不开放自动执行。期限、权限和外部出站没有默认授权。自动处理仅在 PB07 门禁通过后启用。

## 7. Source 摄取、游标与事项归并

首个来源选 CI/Issue 的只读事件适配，具体 provider 与 scope 由实施计划固定。Source 负责取得事实，Engine 负责事件归并与研判。原生 webhook 仅认证/唤醒提示；只有持久摄取命令成功才能作业务受理。如果上游没有重放，需本包持久入口再响应成功，或承认可能丢事件并以周期补拉兜底；不能用 fire-and-forget 作可靠队列。

轮询过程：从核心读取 sourceId/generation/checkpoint → 最小 scope 抓取一页 → 标准化 native ID/revision → 核心 ingest-batch → 核心原子入库+推进 checkpoint。Host 崩溃在提交前重抓同页；提交后应答丢失同命令返回既有结果。页内任一事件无法解析，默认保留失败元数据、阻止该页检查点前进并提示；显式 quarantine 规则可在核心提交隔离记录后推进，不能静默跳过。

游标是数据源定义的不透明位置，不把 occurredAt 当可靠高水位。按“时间 + 稳定 ID”分页的来源保留重叠窗口和去重；延迟/乱序事件追加历史，最新对象 revision 决定现状。历史删除/失效用 tombstone。来源范围变更增加 generation，重新授权和补拉，不沿用旧范围的授权或游标。

稳定事项键优先用 provider/repository/object identity，例如 repo immutable ID + CI workflow/run/head SHA。Thread 归并需固定规则：同一次失败的多个通知合并；新 commit 的独立失败不是仅凭相同标题就并单。初版禁止模型自动跨项目合并；疑似关联只生成建议或 evidence relation。

过滤顺序：认证与 scope → 重复/过期 → 自发回声 → 无实质变化 → 现有 Thread/Ticket 关联 → 职责规则 → 研判预算 → 模型研判。自发回声依据外部 message/run ID 和本包 effect/outbox 关联，不靠“看起来像 Bot 文字”。群进度、感谢和相同结果不得唤醒全组；仅新增可处理事实/问题/到期条件触发后续 Eval。

原生 schedule 继续唯一拥有时间规则。新增适配从其公开投递历史和来源证据产生幂等检查信号，不能在 schedule 消息到来时假定已有 history receipt；现有记录明确 history 可能晚于 Inbox followup。M0 验证能否在不会触发真实模型的方式下消费检查信号；若公开组合不支持，记录缺口，首版只做显式 refresh/webhook 补拉，不私接内部 scheduler 或开第二相同定时器。周期来源检查所用网络抓取与模型研判分别计量。

## 8. 执行适配与持续跟进

### 8.1 Host 受限 execute

Host adapter 接受核心 Assignment，先解析现有 BotKey，复用 registry/preset，预留 child 标识和 `delivery:'caller'`，沿用受管数据流读取、工具限制、结果检查与 disposer。单 Bot 首先接通；已有群作为第二阶段 executor，保持 groupId/groupCreatedAt/membershipRevision，并按成员精确 Bot 代际核验。

交互式 `bot_delegate`、`assertInteractiveOrigin` 和群 `send` 保持当前行为。后台新增服务方法不作为任意模型工具暴露，只能由通过协议认证并通过 TaskGrant 的协调客户端调用。自动输入写为明确 proactive source，不能调用会统一生成 user source 的通用 prompt 后以另存 metadata“补回”权限。使用公开 MessageSource 扩展的组合需要 spike；原生 caller、审批、日志、数据流各层都必须识别自动来源。

现有群输入入口把 source 构造成 user，必须抽取后续已校验执行段，不能直接复用 `GroupTurns.send` 传入一个“特殊用户”。后台入口禁止接受人工 fileUpload receipt 或任意宿主路径，改用受管 evidence refs；现有交互式上传链不动。每个群成员均继承任务上限和数据交集，群自身权限不能扩大授权。

成员输出回到既有 group runner 汇总，核心只收到准确 Assignment 结果；不要把每个 group_message 当作独立 Ticket。任务协调器决定业务下一步，群 runner 决定一次执行内部的成员接续；两层不得同时为同一反馈安排新一轮。

### 8.2 续跑与取消

有原 caller activation 租约时，继续输入可复用公开 subagent prompt 与现有受管续聊检查。冷恢复没有该租约时，rc.2 不支持直接恢复 caller delivery；先读取已持久结果和原生事实。需要继续目标时，明确生成新 Assignment/child，关联 predecessor；旧 unknown 副作用先解决，不能以“换会话继续”掩盖重复执行风险。

等待 CI 或外部决定时结束当前轮次，Source 保留跟进条件和期限。只有新的事实、明确返工或尚未满足的确定性步骤驱动续跑；普通状态心跳不调用模型。取消信号送达准确 assignment/child/group turn，取消父任务不无差别取消同一 Bot 的无关会话。

### 8.3 专项执行器扩展

首版只开放 DSH native 执行。后续 executor 必须显式声明 submit/get/events/cancel/artifacts、externalRunId、幂等/查询/取消能力、数据出站范围和成本来源；这些是待适配的本包契约。MCP client 能力不等于远端提供 MCP server。外部 provider 缺 preset/agentOptions/depthLimit/续聊能力时拒绝对应群模式，不模拟这些属性。外部费用独立显示，不能写进伪造的原生 token projection。

## 9. 授权、撤销与成本

有效行动许可 = **职责 scope ∩ 当前 TaskGrant/Mandate ∩ DSH native tool/sandbox/approval ∩ Bot 数据与目标出站许可**。任何一层拒绝即拒绝；模型 confidence、源服务认证、通知 preapproved、普通 user source 都不能替代其余授权。

scope 使用可验证目标：仓库/项目身份、受管根目录、动作枚举、连接器/目标摘要、Bot 代际、截止时间和预算。自然语言规则只辅助研判。Bot 删除重建、成员代际变化、目标重绑、数据版本遗忘使相关授权失效；已有运行不自动继承新扩大权限。暂停职责只停止该职责的摄取、研判和新接单，已经受理的 Ticket 可在其独立 TaskGrant 的期限、预算和原 scope 内继续，暂停本身不撤销 grant。显式 revoke，或用户选择“暂停并同时停止已接任务”，才提升相关撤销围栏。共享 Source 仍可为其他启用职责工作，但不得再向已暂停职责投递新机会；活动 Ticket 必需的后续输入按其已有任务订阅和独立授权处理。

动作前检查至少发生在：接单、Host admitted、native 启动、工具真实派发、MCP/文件/网络数据出口、结果返还、通知 send。同步检查或短暂不可中断区保证“检查完成→派发开始”的次序；不可把远端 policy 读取缓存一分钟后直接用。核心不可用或围栏无法核实时停止新副作用。已开始的外部请求可能无法撤回，界面显示 started/unknown/confirmed，而非保证零外部影响。

撤销步骤：Host 管理入口先持久提升 grant/task deny epoch，阻止本 Host 新派发；请求核心持久 revoke/cancel，并取消活跃执行；两侧确认后显示已撤销。中断时显示“本机已停止新动作，核心同步待确认”。核心自身触发撤销先提交 epoch 再通知 Host；Host 每次动作必须读取现行 fence，失联 fail closed。撤销生效线性点是相应执行平面围栏提交，之前已派发动作单独审计。原型 Policy 更新仅通知/恢复重验，不宣传它自带即时全局 revoke。

这里新增的是拒绝能力和受限任务授权桥，不能通过它覆盖 native `ask` / `never`。受委派 child 仍沿用原来的 `approvalPolicy=never`；需要 native approval 的动作变为 blocked/needs-user，由用户在有效交互上下文处理，不自动切 never→allow。现有出站机制需要 live approval 时，无人值守发送仍不可用；M3 若要扩展持久 TaskGrant 出站，必须单独验证准确正文/来源/目标/代际绑定与撤销，不能复用通知 preapproved 代替。

三本预算分别记录：来源检查/研判、执行、注意力。核心准入事务先预留，再按真实收据结算；失败/unknown 不自动退款，保守占用至对账。模型 tokens 与费用估计分列，真实费用缺失时不编造。计费与上限基于固定时区/日桶和单调高水位，跨重启不清零；软上限提前停止准入，硬截止发送取消但不能保证远端立即停止计费。规则放宽必须明确配置变更，不从“接受过一次建议”推出长期授权。

## 10. 通知 Outbox 与现有 Notifications

核心 Outbox 决定业务消息是否仍需要、何时呈现、合并和静默；现有 Notifications 决定一次实际 intent 的受理和传输。默认**核心 effect pump 是唯一业务重试/延后责任方**；Host 不新增另一个重发定时器，Port 也不得暗中重复有副作用发送。

映射固定为 `outboxId → operationId → intent.id → attemptId/platformMessageId`。operationId 在核心创建 outbox 时一次生成并持久化，符合现有 resourceId 长度；重连、查询、同一内容再请求均沿用。正文/target/来源改变必须重验，新业务修订先取消旧未发送 intent，再明确创建新意图。UI 建议通知合并只更改尚未投递的呈现投影；已经 accepted 的外部消息不假装被撤回。

Host 流程为：取 outbox 最小授权 DTO → 调现有 `Notifications.record` → 返回 intent 收据 → 按有效授权调用 deliver → 读取 intent 状态 → 回报核心。新增 proactive 来源 schema 后仍记录同一数据流。Port 的 `attemptId` 是一次传输标识，不是业务幂等键；即使某平台可接 idempotency key，也必须显式证明映射，不能只传 attemptId 就宣称去重成立。

| intent 当前状态 | 核心行为 |
| --- | --- |
| recorded | 可在到期且授权仍有效时请求 deliver；站内 recorded 只表示可呈现，不等于已读 |
| waiting_approval | 等用户，过期取消；进程重启按现有规则 cancelled |
| sending | 查询，不启动第二 send；Host 冷恢复变 unknown |
| accepted | 记录平台受理与可用 messageId；不等于用户阅读 |
| suppressed | 解释 quiet-hours/daily-limit/cooldown 等；现有 deliver 不会自动重开该 intent |
| failed | 首版不自动重发；只有证明未发送且有显式 retry 设计后才开放 |
| unknown | 保持 unknown，显示人工核对/平台查询；禁止换 operationId 盲重发 |
| cancelled | 结束该意图，不能因旧 outbox 重放复活 |

首版在核心 notBefore 阶段完成静默/合并，大幅减少到 Host 才 suppressed 的情况。到发送时 Host 仍有最终策略检查；若因竞态 suppressed，则保留该次结果，后续是否创建新业务提醒须明确策略和新的授权，不自动重置 intent。

`record` 当前先写 read_state tombstone，再写 intent，部分失败可能只有 tombstone。此时 recovery-needed 是保守去重结果；核心不能删 tombstone 或换 operationId 修复。需要管理修复工具核验没有实际发送，再补齐同一意图或终止。当前 Port 无 query 方法，所以没有平台查询适配时 unknown 只能等待人工确认。SDK 自带重试若不能证明无重复，发送层必须关闭该重试或将能力标为不支持自动发送。

## 11. 结果、验收与返工

任务接单时冻结目标、范围、交付物、验收项、reviewer policy、输入版本与已知限制。结果提交含 EvidenceManifest，不接受单独一句“已完成”。检查项记录 `id, layer, status, reason?, command/toolRef, exitCode?, artifactVersion, evidenceRefs, checkedAt, environment, limitation`；status 仅为 PASS/FAIL，未执行写 `FAIL + reason=NOT_RUN`，环境受阻写 `FAIL + reason=ENVIRONMENT`，证据过期写 `FAIL + reason=STALE`，实际检查失败写明对应失败原因。NOT_RUN 不作为第三个状态。不从静态检查推导设备/E2E 成功。

证据层依次为：静态/源码核查、单测/构建、安装/启动、真实浏览器/设备流程、业务验收。截图相似度只支持视觉项；工具退出 0 不自动证明业务目标。模型可以组织报告和建议判定，但不能签署必须人工完成的项。独立验收可以是用户，或用户明确授权且与执行总结独立的确定性 checker；模型 reviewer 的结论注明自动评审，不冒充人工。

接受命令绑定 ticketId、specVersion、resultVersion 和 expectedRevision。任何相关 artifact hash、源码 revision、环境变化导致 stale；UI 先刷新证据，再允许决定。返工明确失败项/新增要求/期限，在原 Ticket 添加新 Assignment 和结果版本；旧证据和旧评审只读保留。执行失败并不自动创建新任务；可在原目标允许的范围内重试，但预算和 unknown 效果必须先处理。

外部 Acceptance 工具只作为可选证据生成器。首版不依赖其云端发布，不默认登录、上传或安装其完整 runtime。反馈分四类：本次返工、规则误报候选、记忆偏好候选、Skill/流程修改候选。后三类不自动采用，更不能扩大权限；需要独立版本、冻结回归集和可撤销采用记录。

## 12. 故障恢复、运行与可观测性

| 注入点 | 持久事实 | 恢复行为 / 禁止行为 |
| --- | --- | --- |
| Source 抓取后、ingest 前退出 | 游标未前进 | 同页重拉、eventId 去重 |
| 核心事务中退出 | SQLite 未提交或完整提交 | 重放同 commandId；没有半个 Ticket |
| 核心提交、effect 未送出 | 持久 effect pending | 重连后送同 effectId |
| Host admitted 后、启动前退出 | 同行 receipt | 对账后只在证明 native 未开始时继续；缺证据 unknown |
| native 已开始、收据未更新 | child/run 可能存在 | 精确保留 ID 查询；不能凭 Agents 内存空就二次 spawn |
| result-pending 后核心离线 | Host 持久结果 | 重发同 report-result；没有第二评审/通知 |
| 核心收到 result、确认丢失 | inbox/结果已提交 | 返回 duplicate 与原 committedSeq |
| 工具/外部写入中 SIGKILL | 可能已发生副作用 | unknown；可靠外部查询或人工决定，不能盲重试 |
| 撤销期间核心/Host 失联 | deny epoch / cancel intent | 新副作用 fail closed；显示同步未完成 |
| 旧 Assignment 晚到结果 | 旧 ID/epoch 可定位 | 存为迟到事实，不覆盖新结果、不复活终态 |
| Bot 删除再建/群成员变化 | 精确身份版本冲突 | 拒绝旧授权；历史保持原身份，不自动迁移 |
| Notification sending 后崩溃 | 现有 sending intent | 冷恢复 unknown，查询同 operationId |
| 存储满/数据损坏 | 最后确认水位 | 停止新准入/派工，提供受控恢复；禁止清库重试 |
| 双协调进程误启动 | store lock / owner fence | 第二个拒绝接管；进程存在不证明 lease 有效 |

启动顺序：校验 Config/版本 → 打开 Host receipt domain → 核心锁和 SQLite schema → 能力握手 → 恢复 deny epochs 与 unknown → 双向对账 → 注册 Source/Remote/投影 → 允许新准入。任何核心能力缺失时保持旧 Bot/群功能可用，但主动模式明确 degraded；不要全包假装已启用。

卸载顺序：停止入口/Source → 持久停止新派工围栏 → 取消/排空当前传输和本服务所持有 activation → 持久 pending/unknown → 释放监听/定时器/进程/socket/锁。注册与异步 disposer 全部纳入所属 `ctx.effect`；不取消不属于本服务的原生会话。协调进程退出不删除数据库。

指标至少包括 source lag、重复/隔离事件、Eval 延迟和模型消耗、建议接受/失效、Ticket 各态数量、执行受理/运行延迟、验收通过及返工原因、unknown、取消时延、outbox 年龄、通知数、存储体积。健康检查区分 core reachable、Host ready、source healthy、executor capable、egress available；“进程在线”不等于业务闭环成功。日志 correlation chain 为 sourceEventId→threadId→ticketId→assignmentId→native ref→manifest/review→outbox/operationId，默认无正文。

本地版随 Host 生命周期，不承诺关机继续。后续常驻版需要受监督 Host 和协调进程、配置/升级/备份方案与独立验收；watchdog 只恢复进程，不以“超时卡住”为由重放 unknown 副作用。

## 13. 迁移、保留与清理

首版主动数据新建，不扫描普通聊天自动建单，不自动迁移现有 routine、group turn 或 Team task。用户显式关联旧运行时只存 native ref，并说明历史证据可能不完整。关闭功能不影响原有 Bot/群/定时；删除 Source 与停止监听分开。

协议、核心 SQLite、Host receipt domain 分别版本化。升级前停准入、排空可结束传输、持久 unknown、备份核心数据库及 Host 关联元数据；按 version 顺序迁移，记录 migration ID/hash/开始/完成。SQLite 扩展在原型官方迁移机制支持处注册；若不能支持，M0 明确方案，不能随意 ALTER 上游私有 schema。Host Kv 迁移使用 copy/verify/ready 阶段收据，部分失败重入不覆盖已确认新数据。

升级后对账后才启用新版本。未知较新 schema 或协议 major 拒绝写入；不强行降级。回滚只能用已验证兼容包或一致快照恢复；恢复旧快照前必须核对之后可能发出的外部动作，否则会重放。未知副作用与 operationId 去重墓碑不能因回滚丢失。

保留策略按数据类进入 Config：来源原始正文短窗、受理事件元数据和去重键较长窗、活跃 Ticket/unknown 不自动删、已结束任务按用户策略归档、产物大文件引用管理、通知沿用既有 retention。去重记录至少覆盖来源可重放窗口和业务恢复窗口；窗口过期后的重放必须重新审批/显式隔离，不能默认为新事件直接执行。墓碑过期不能导致旧命令恢复可执行。

遗忘先 fence 所有涉及 sourceVersions 的新读取/出站，再标记核心引用失效、取消未发送 outbox、排空在途执行、擦除受管正文/索引/摘要、验证副本和保留最小审计墓碑。现有 memory 遗忘与 managed copies 机制仍是数据授权权威，主动层登记自己的副本和清理回执。已经对外发送的内容只能记录可撤回能力与结果，不承诺普遍可删除。历史验收若依赖已删除证据，保留“曾接受、证据已删除”的记录，不伪造当前可复核。

## 14. 实施前门禁与未决问题

| 门禁 | 必须得到的证据 | 不通过时 |
| --- | --- | --- |
| G1 核心可复用 | 固定上游 commit、MIT 归属、公开根导出加载、alpha 依赖隔离、环境副作用和平台矩阵 | 不共装到 Host；先上游门面/有范围封装评审 |
| G2 单一生命周期 | ready/ended 的实际转换、hold-for-review、原 Ticket 返工的命令与事务测试 | M2 禁止开工；不能以 UI 状态弥补 |
| G3 持久语义 | SQLite 事务失败/强杀、同 Thread 串行、command 去重、Host Kv 部分写对账 | 禁止宣称可靠接单/自动恢复 |
| G4 自动来源执行 | 新 Host 入口不铸造 user；native caller 回传、数据流、never/ask、精确 run 归属测试 | 维持交互式执行，建议模式只读 |
| G5 撤销与出站 | 每次动作复检、跨进程失联 fail closed、Bot 重建、准确正文/目标和权限交集 | 自动执行/无人值守外发保持关闭 |
| G6 通知关联 | outbox→operationId→intent/attemptId、部分写、unknown、单一 retry owner 故障矩阵 | 仅站内可解释状态；外部发送不开启 |
| G7 Source 原生时钟 | 公开 schedule/webhook 组合、不误触模型、重放/游标/回声 | 用显式刷新/已有可靠来源；不补第二时钟冒充完成 |

仍待 M0 决策的重点是：固定哪个上游 commit、根入口与 SQLite 适配是否足够公开、验收等待如何保留同一 Ticket、Host 自动来源如何在锁定 rc.2 合法表达、可查询 native 启动标识是否足以收敛 unknown、后台 TaskGrant 是否能在不放宽现有出站边界下实施。默认路线和禁止项已定，缺口不能靠假设补齐。

设计完成仅说明契约和门禁可评审；M0 离线探针、真实 Host 合成模型、强杀恢复、浏览器主题与实际用户业务验收分别记录。实际运行与质量门槛未执行前均不得记 PASS。
